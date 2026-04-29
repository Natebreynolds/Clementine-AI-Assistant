/**
 * Staleness nudges — surface user-model slots that haven't been touched in
 * a while, and chunks where salience and outcome EMA disagree (ranked
 * high but never cited).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';

describe('Staleness nudges', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-stale-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
    writeFileSync(path.join(vaultDir, 'a.md'), '# A\n\nbody a\n');
    store.fullSync();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function withRaw(fn: (db: Database.Database) => void): void {
    const db = new Database(dbPath);
    try { fn(db); } finally { db.close(); }
  }

  it('findStaleUserModelSlots ignores fresh, empty, and missing slots', () => {
    store.setUserModelBlock({ slot: 'goals', content: 'ship the v2 release' });
    expect(store.findStaleUserModelSlots({ maxAgeDays: 30 })).toEqual([]);
  });

  it('findStaleUserModelSlots surfaces slots older than maxAgeDays', () => {
    store.setUserModelBlock({ slot: 'goals', content: 'old goal' });
    store.setUserModelBlock({ slot: 'persona', content: 'fresh persona' });
    withRaw((db) => {
      db.prepare(`UPDATE user_model_blocks SET updated_at = datetime('now', '-100 days') WHERE slot = 'goals'`).run();
    });
    const stale = store.findStaleUserModelSlots({ maxAgeDays: 90 });
    expect(stale.map((s) => s.slot)).toEqual(['goals']);
    expect(stale[0].ageDays).toBeGreaterThanOrEqual(99);
  });

  it('findStaleUserModelSlots skips empty-content slots', () => {
    store.setUserModelBlock({ slot: 'empty', content: '' });
    withRaw((db) => {
      db.prepare(`UPDATE user_model_blocks SET updated_at = datetime('now', '-200 days') WHERE slot = 'empty'`).run();
    });
    const stale = store.findStaleUserModelSlots({ maxAgeDays: 30 });
    expect(stale.length).toBe(0);
  });

  it('findStaleHighSalienceChunks returns chunks with high salience but negative EMA', () => {
    let stale = 0; let healthy = 0;
    withRaw((db) => {
      const ins = db.prepare(
        `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, salience, last_outcome_score)
         VALUES (?, 'sec', 'body', 'paragraph', ?, ?, ?)`,
      );
      stale = Number(ins.run('s.md', 'h1', 0.9, -0.5).lastInsertRowid);
      healthy = Number(ins.run('h.md', 'h2', 0.9, 0.5).lastInsertRowid);
    });
    const result = store.findStaleHighSalienceChunks({ salienceFloor: 0.8, outcomeCeiling: 0 });
    const ids = result.map((r) => r.chunkId);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(healthy);
  });

  it('getStalenessNudges renders prompt-ready text or null when nothing is stale', () => {
    expect(store.getStalenessNudges()).toBeNull();

    store.setUserModelBlock({ slot: 'goals', content: 'old' });
    withRaw((db) => {
      db.prepare(`UPDATE user_model_blocks SET updated_at = datetime('now', '-120 days') WHERE slot = 'goals'`).run();
    });

    const nudge = store.getStalenessNudges({ maxSlotAgeDays: 90 });
    expect(nudge).toBeTruthy();
    expect(nudge).toContain('User-model maintenance');
    expect(nudge).toContain('`goals`');
  });
});
