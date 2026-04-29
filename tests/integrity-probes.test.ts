/**
 * Integrity probes — orphan derived_from nullification, missing-embedding
 * surfacing, FTS5 ok-path. (FTS5 corruption is hard to reliably induce in
 * a portable test, so we just assert the ok-path doesn't trip false alarms.)
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import { runIntegrityProbes } from '../src/memory/integrity.js';

describe('Integrity probes', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-int-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
    writeFileSync(path.join(vaultDir, 'a.md'), '# A\n\nbody a\n');
    writeFileSync(path.join(vaultDir, 'b.md'), '# B\n\nbody b\n');
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

  it('reports clean state on a healthy store', () => {
    const r = runIntegrityProbes(store as any);
    expect(r.ftsOk).toBe(true);
    expect(r.ftsRebuilt).toBe(false);
    expect(r.orphanRefsNulled).toBe(0);
    // Fresh chunks lack dense embeddings (no model loaded in test) — that's expected.
    expect(r.missingEmbeddings).toBeGreaterThanOrEqual(0);
  });

  it('nullifies derived_from refs that point at deleted chunks', () => {
    let summaryId = 0;
    let liveId = 0;
    withRaw((db) => {
      const ids = db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>;
      liveId = ids[0].id;
      const deletedId = ids[1].id;
      // Insert a fake summary chunk that references one live + one deleted id.
      const result = db.prepare(
        `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, derived_from)
         VALUES ('summary.md', 'sum', 'summary body', 'paragraph', 'h1', ?)`,
      ).run(JSON.stringify([liveId, deletedId, 9999]));
      summaryId = Number(result.lastInsertRowid);
      // Now physically delete the second chunk.
      db.prepare('DELETE FROM chunks WHERE id = ?').run(deletedId);
    });

    const r = runIntegrityProbes(store as any);
    expect(r.orphanRefsNulled).toBe(1);

    withRaw((db) => {
      const row = db.prepare('SELECT derived_from FROM chunks WHERE id = ?').get(summaryId) as { derived_from: string };
      const arr = JSON.parse(row.derived_from);
      // Only the still-live id remains.
      expect(arr).toEqual([liveId]);
    });
  });

  it('sets derived_from to NULL when no live ids remain', () => {
    let summaryId = 0;
    withRaw((db) => {
      const result = db.prepare(
        `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, derived_from)
         VALUES ('summary.md', 'sum', 'body', 'paragraph', 'h2', ?)`,
      ).run(JSON.stringify([9999, 8888]));
      summaryId = Number(result.lastInsertRowid);
    });
    const r = runIntegrityProbes(store as any);
    expect(r.orphanRefsNulled).toBe(1);
    withRaw((db) => {
      const row = db.prepare('SELECT derived_from FROM chunks WHERE id = ?').get(summaryId) as { derived_from: string | null };
      expect(row.derived_from).toBeNull();
    });
  });

  it('counts chunks missing dense embeddings', () => {
    const r = runIntegrityProbes(store as any);
    // Fresh store: at least the two chunks we seeded have content but no
    // dense embedding (no model in test), so count is at least the chunk count.
    expect(r.missingEmbeddings).toBeGreaterThan(0);
  });
});
