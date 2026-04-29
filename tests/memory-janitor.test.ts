/**
 * Memory janitor — bounded-growth pass.
 *
 * Verifies:
 *  - expireConsolidated soft-deletes only chunks meeting all criteria
 *  - pinned and high-salience chunks are protected
 *  - recently-accessed chunks are protected
 *  - phase 2 physically deletes chunks past the grace period
 *  - pruneOutcomes / capExtractions trim by their respective rules
 *  - maybeVacuum skips when interval not elapsed or store is busy
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import { runJanitor, maybeVacuum } from '../src/memory/maintenance.js';

describe('Memory janitor — bounded-growth maintenance', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-janitor-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Seed N markdown files via fullSync, then return their chunk ids in
  // insertion order. Each file becomes one paragraph chunk. Always calls
  // fullSync so the store is initialized even when count = 0.
  function seedChunks(count: number): number[] {
    for (let i = 0; i < count; i++) {
      writeFileSync(
        path.join(vaultDir, `note-${i}.md`),
        `# Note ${i}\n\nBody content for chunk number ${i}.\n`,
      );
    }
    store.fullSync();
    // Ensure tables exist via a touch — getChunkCount triggers init.
    store.getChunkCount();
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT id FROM chunks ORDER BY id ASC').all() as Array<{ id: number }>;
    db.close();
    return rows.map((r) => r.id);
  }

  // Direct SQL mutator — closes the writer handle before yielding control
  // back to the store so WAL doesn't deadlock.
  function withRaw(fn: (db: Database.Database) => void): void {
    const db = new Database(dbPath);
    try { fn(db); } finally { db.close(); }
  }

  it('soft-deletes consolidated low-salience chunks past expiry', () => {
    const ids = seedChunks(2);
    // Mark both as consolidated; backdate created_at; first is junk, second is pinned.
    withRaw((db) => {
      db.prepare(
        `UPDATE chunks SET consolidated = 1, salience = 0.05, pinned = 0,
         created_at = datetime('now', '-90 days') WHERE id = ?`,
      ).run(ids[0]);
      db.prepare(
        `UPDATE chunks SET consolidated = 1, salience = 0.05, pinned = 1,
         created_at = datetime('now', '-90 days') WHERE id = ?`,
      ).run(ids[1]);
    });

    const result = store.expireConsolidated({ expireDays: 60, salienceFloor: 0.2, graceDays: 14 });
    expect(result.softDeleted).toBe(1);

    // Pinned chunk untouched.
    withRaw((db) => {
      const sd = db.prepare('SELECT chunk_id FROM chunk_soft_deletes ORDER BY chunk_id').all() as Array<{ chunk_id: number }>;
      expect(sd.map((r) => r.chunk_id)).toEqual([ids[0]]);
    });
  });

  it('protects high-salience and recently-accessed chunks', () => {
    const ids = seedChunks(3);
    withRaw((db) => {
      // [0] high salience — protected by salience floor.
      db.prepare(
        `UPDATE chunks SET consolidated = 1, salience = 0.9, pinned = 0,
         created_at = datetime('now', '-90 days') WHERE id = ?`,
      ).run(ids[0]);
      // [1] low salience but recently accessed — protected by access_log.
      db.prepare(
        `UPDATE chunks SET consolidated = 1, salience = 0.05, pinned = 0,
         created_at = datetime('now', '-90 days') WHERE id = ?`,
      ).run(ids[1]);
      db.prepare(`INSERT INTO access_log (chunk_id, access_type) VALUES (?, 'read')`).run(ids[1]);
      // [2] eligible — should get soft-deleted.
      db.prepare(
        `UPDATE chunks SET consolidated = 1, salience = 0.05, pinned = 0,
         created_at = datetime('now', '-90 days') WHERE id = ?`,
      ).run(ids[2]);
    });

    const result = store.expireConsolidated({ expireDays: 60, salienceFloor: 0.2, graceDays: 14 });
    expect(result.softDeleted).toBe(1);

    withRaw((db) => {
      const deleted = (db.prepare('SELECT chunk_id FROM chunk_soft_deletes').all() as Array<{ chunk_id: number }>)
        .map((r) => r.chunk_id);
      expect(deleted).toEqual([ids[2]]);
    });
  });

  it('physically deletes chunks past the grace period', () => {
    const ids = seedChunks(1);
    // Soft-delete the chunk with a backdated soft-delete timestamp.
    expect(store.softDeleteChunk(ids[0], 'test')).toBe(true);
    withRaw((db) => {
      db.prepare(`UPDATE chunk_soft_deletes SET deleted_at = datetime('now', '-30 days') WHERE chunk_id = ?`)
        .run(ids[0]);
      // Add an access_log row to verify cascade.
      db.prepare(`INSERT INTO access_log (chunk_id, access_type) VALUES (?, 'read')`).run(ids[0]);
    });

    const result = store.expireConsolidated({ expireDays: 60, salienceFloor: 0.2, graceDays: 14 });
    expect(result.physicallyDeleted).toBe(1);

    withRaw((db) => {
      const remaining = (db.prepare('SELECT id FROM chunks WHERE id = ?').get(ids[0]) as unknown);
      expect(remaining).toBeUndefined();
      const sd = db.prepare('SELECT chunk_id FROM chunk_soft_deletes WHERE chunk_id = ?').get(ids[0]);
      expect(sd).toBeUndefined();
      const access = db.prepare('SELECT chunk_id FROM access_log WHERE chunk_id = ?').get(ids[0]);
      expect(access).toBeUndefined();
    });
  });

  it('keeps recently soft-deleted chunks during grace period', () => {
    const ids = seedChunks(1);
    expect(store.softDeleteChunk(ids[0], 'test')).toBe(true);
    // Default deleted_at is now() — within 14-day grace.
    const result = store.expireConsolidated({ expireDays: 60, salienceFloor: 0.2, graceDays: 14 });
    expect(result.physicallyDeleted).toBe(0);
  });

  it('pruneOutcomes trims by age', () => {
    const ids = seedChunks(1);
    withRaw((db) => {
      db.prepare(`INSERT INTO outcomes (chunk_id, session_key, referenced, created_at) VALUES (?, 'old', 1, datetime('now', '-45 days'))`).run(ids[0]);
      db.prepare(`INSERT INTO outcomes (chunk_id, session_key, referenced, created_at) VALUES (?, 'new', 1, datetime('now', '-1 days'))`).run(ids[0]);
    });
    const pruned = store.pruneOutcomes(30);
    expect(pruned).toBe(1);
    withRaw((db) => {
      const rows = db.prepare('SELECT session_key FROM outcomes').all() as Array<{ session_key: string }>;
      expect(rows.map((r) => r.session_key)).toEqual(['new']);
    });
  });

  it('capExtractions deletes oldest non-active when over cap', () => {
    // Touch the store so initialize() runs and creates memory_extractions.
    seedChunks(0);
    withRaw((db) => {
      const ins = db.prepare(
        `INSERT INTO memory_extractions
         (session_key, user_message, tool_name, tool_input, status, extracted_at)
         VALUES ('s', 'msg', 'tool', '{}', ?, datetime('now', ?))`,
      );
      ins.run('completed', '-10 days');
      ins.run('completed', '-5 days');
      ins.run('active', '-20 days');
      ins.run('completed', '-1 days');
    });
    // Cap to 2 — overflow is 2, both must come from non-active.
    const removed = store.capExtractions(2);
    expect(removed).toBe(2);
    withRaw((db) => {
      const rows = db.prepare('SELECT status FROM memory_extractions ORDER BY extracted_at ASC').all() as Array<{ status: string }>;
      // 'active' (-20d) is preserved despite being oldest; the two oldest non-active (-10d, -5d) go.
      expect(rows.map((r) => r.status)).toEqual(['active', 'completed']);
    });
  });

  it('runJanitor returns aggregate counts', () => {
    const ids = seedChunks(1);
    withRaw((db) => {
      db.prepare(
        `UPDATE chunks SET consolidated = 1, salience = 0.05, pinned = 0,
         created_at = datetime('now', '-90 days') WHERE id = ?`,
      ).run(ids[0]);
      db.prepare(`INSERT INTO outcomes (chunk_id, referenced, created_at) VALUES (?, 1, datetime('now', '-60 days'))`).run(ids[0]);
    });
    const result = runJanitor(store as any);
    expect(result.softDeleted).toBe(1);
    expect(result.outcomesPruned).toBe(1);
  });

  it('maybeVacuum skips when last vacuum is recent', () => {
    seedChunks(1);
    store.setMaintenanceMeta('last_vacuum_at', new Date().toISOString());
    const result = maybeVacuum(store as any);
    expect(result).toBeNull();
  });

  it('maybeVacuum runs when interval has elapsed and store is idle', () => {
    seedChunks(2);
    // Backdate last vacuum way past the 7-day default.
    store.setMaintenanceMeta('last_vacuum_at', new Date(Date.now() - 30 * 86_400_000).toISOString());
    // Backdate the only activity (transcripts/recall_traces/access_log) past the idle gate.
    withRaw((db) => {
      db.prepare(`INSERT INTO transcripts (session_key, role, content, created_at) VALUES ('s', 'user', 'hi', datetime('now', '-1 hour'))`).run();
    });

    const result = maybeVacuum(store as any);
    expect(result).not.toBeNull();
    expect(result!.sizeAfterBytes).toBeGreaterThan(0);
    // Meta should be bumped.
    const newLast = store.getMaintenanceMeta('last_vacuum_at');
    expect(newLast).toBeTruthy();
  });

  it('lastActivityAt returns most recent across the high-write tables', () => {
    seedChunks(1);
    const before = store.lastActivityAt();
    // Empty fixture → may be null.
    expect(before === null || typeof before === 'number').toBe(true);
    withRaw((db) => {
      db.prepare(`INSERT INTO recall_traces (session_key, query, chunk_ids, scores, retrieved_at) VALUES ('s', 'q', '[]', '[]', datetime('now'))`).run();
    });
    const after = store.lastActivityAt();
    expect(after).not.toBeNull();
    expect(Date.now() - (after as number)).toBeLessThan(60_000);
  });
});
