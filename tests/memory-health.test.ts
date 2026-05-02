/**
 * Memory Health snapshot — read-only aggregate over the existing tables.
 * Verifies the shape and the key stats the dashboard relies on.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';

describe('Memory Health snapshot', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-health-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function withRaw(fn: (db: Database.Database) => void): void {
    const db = new Database(dbPath);
    try { fn(db); } finally { db.close(); }
  }

  it('reports baseline shape on an empty store', () => {
    store.fullSync();
    const h = store.getMemoryHealth();
    expect(h.chunks.total).toBe(0);
    expect(h.chunks.consolidated).toBe(0);
    expect(h.chunks.pinned).toBe(0);
    expect(h.chunks.softDeleted).toBe(0);
    expect(h.chunks.zombieCount).toBe(0);
    expect(h.dbSizeBytes).toBeGreaterThan(0);
    expect(h.tableRowCounts).toHaveProperty('chunks', 0);
    expect(h.tableRowCounts).toHaveProperty('recall_traces', 0);
    expect(h.recentActivity.recallTracesLast7d).toBe(0);
    expect(h.recentActivity.recallTracesLast30d).toBe(0);
    expect(h.recentActivity.extractionSkipsLast30d).toBe(0);
    expect(h.userModelSlots.total).toBe(0);
    expect(h.selfImprovePlateausLast7d).toBeGreaterThanOrEqual(0);
    expect(h.topCitedLast30d).toEqual([]);
  });

  it('counts pinned, consolidated, and zombie chunks correctly', () => {
    writeFileSync(path.join(vaultDir, 'a.md'), '# A\n\nbody a\n');
    writeFileSync(path.join(vaultDir, 'b.md'), '# B\n\nbody b\n');
    writeFileSync(path.join(vaultDir, 'c.md'), '# C\n\nbody c\n');
    store.fullSync();

    const ids = (() => {
      const db = new Database(dbPath);
      const rows = db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>;
      db.close();
      return rows.map((r) => r.id);
    })();

    withRaw((db) => {
      // [0] pinned
      db.prepare('UPDATE chunks SET pinned = 1 WHERE id = ?').run(ids[0]);
      // [1] consolidated, no recent access → zombie
      db.prepare('UPDATE chunks SET consolidated = 1 WHERE id = ?').run(ids[1]);
      // [2] consolidated AND recently accessed → not zombie
      db.prepare('UPDATE chunks SET consolidated = 1 WHERE id = ?').run(ids[2]);
      db.prepare(`INSERT INTO access_log (chunk_id, access_type) VALUES (?, 'read')`).run(ids[2]);
    });

    const h = store.getMemoryHealth();
    expect(h.chunks.total).toBeGreaterThanOrEqual(3);
    expect(h.chunks.pinned).toBe(1);
    expect(h.chunks.consolidated).toBe(2);
    expect(h.chunks.zombieCount).toBe(1);
  });

  it('exposes write queue stats and integrity report when present', () => {
    store.fullSync();
    store.enableWriteQueue();
    store.saveTurn('s', 'u', 'hi');
    store.setMaintenanceMeta('last_integrity_report', JSON.stringify({
      ftsOk: true, ftsRebuilt: false, orphanRefsNulled: 0, missingEmbeddings: 3,
      ranAt: new Date().toISOString(),
    }));

    const h = store.getMemoryHealth();
    expect(h.writeQueue).not.toBeNull();
    expect(h.writeQueue!.size).toBeGreaterThanOrEqual(1);
    expect(h.lastIntegrityReport).not.toBeNull();
    expect(h.lastIntegrityReport!.ftsOk).toBe(true);
    expect(h.lastIntegrityReport!.missingEmbeddings).toBe(3);
  });

  it('writeQueue is null in default sync mode', () => {
    store.fullSync();
    const h = store.getMemoryHealth();
    expect(h.writeQueue).toBeNull();
  });

  it('surfaces top cited chunks within the 30d window', () => {
    writeFileSync(path.join(vaultDir, 'cited.md'), '# C\n\ncited body\n');
    store.fullSync();
    const id = (() => {
      const db = new Database(dbPath);
      const row = db.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: number };
      db.close();
      return row.id;
    })();
    withRaw((db) => {
      const ins = db.prepare('INSERT INTO outcomes (chunk_id, referenced) VALUES (?, 1)');
      ins.run(id); ins.run(id); ins.run(id);
    });
    const h = store.getMemoryHealth({ topCitedLimit: 5 });
    expect(h.topCitedLast30d.length).toBe(1);
    expect(h.topCitedLast30d[0].chunkId).toBe(id);
    expect(h.topCitedLast30d[0].refCount).toBe(3);
  });

  it('uses recall_traces.retrieved_at and extraction skip statuses for recent activity', () => {
    store.fullSync();
    withRaw((db) => {
      db.prepare(
        `INSERT INTO recall_traces (session_key, query, chunk_ids, scores, retrieved_at)
         VALUES ('recent', 'q', '[]', '[]', datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO recall_traces (session_key, query, chunk_ids, scores, retrieved_at)
         VALUES ('old', 'q', '[]', '[]', datetime('now', '-40 days'))`,
      ).run();
      db.prepare(
        `INSERT INTO memory_extractions (session_key, user_message, tool_name, tool_input, status, extracted_at)
         VALUES ('s', 'short', 'auto_memory_skip', '{"reason":"too_short"}', 'skipped:too_short', datetime('now'))`,
      ).run();
    });

    const h = store.getMemoryHealth();
    expect(h.recentActivity.recallTracesLast7d).toBe(1);
    expect(h.recentActivity.recallTracesLast30d).toBe(1);
    expect(h.recentActivity.extractionSkipsLast30d).toBe(1);
  });

  it('reports user model slot counts', () => {
    store.fullSync();
    store.setUserModelBlock({ slot: 'user_facts', content: 'global facts' });
    store.setUserModelBlock({ slot: 'goals', content: 'agent goal', agentSlug: 'sdr' });

    const h = store.getMemoryHealth();
    expect(h.userModelSlots.total).toBe(2);
    expect(h.userModelSlots.populated).toBe(2);
    expect(h.userModelSlots.global).toBe(1);
    expect(h.userModelSlots.agentScoped).toBe(1);
  });
});
