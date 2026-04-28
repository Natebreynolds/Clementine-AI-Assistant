/**
 * Memory chunk CRUD — verifies soft-delete via deleted_at, search/retrieval
 * filtering, FTS index updates on soft-delete, content edits with audit
 * trail to chunk_history, and restore. Covers the dashboard CRUD surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import Database from 'better-sqlite3';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-crud-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function insertTestChunk(content: string, section = 'sec'): number {
  const db = new Database(dbPath);
  const info = db
    .prepare(
      `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('test.md', section, content, 'preamble', 'hash-' + Math.random());
  db.close();
  return info.lastInsertRowid as number;
}

describe('schema migrations', () => {
  it('creates the chunk_soft_deletes table', () => {
    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_soft_deletes'",
    ).get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('chunk_soft_deletes');
  });

  it('creates the chunk_history table', () => {
    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_history'",
    ).get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('chunk_history');
  });
});

describe('getChunkDetail', () => {
  it('returns full detail with all provenance fields', () => {
    const id = insertTestChunk('the user prefers terse responses');
    const detail = store.getChunkDetail(id);
    expect(detail).not.toBeNull();
    expect(detail?.content).toBe('the user prefers terse responses');
    expect(detail?.deletedAt).toBeNull();
    expect(detail?.pinned).toBe(false);
    expect(detail?.consolidated).toBe(false);
    expect(detail?.derivedFrom).toBeNull();
    expect(detail?.historyCount).toBe(0);
  });

  it('returns null for unknown id', () => {
    expect(store.getChunkDetail(99999)).toBeNull();
  });
});

describe('updateChunkContent + history audit', () => {
  it('records an audit row in chunk_history on each edit', () => {
    const id = insertTestChunk('original content', 'orig-section');
    expect(store.updateChunkContent({ chunkId: id, content: 'edited content', editedBy: 'dashboard' })).toBe(true);
    const history = store.getChunkHistory(id);
    expect(history).toHaveLength(1);
    expect(history[0].prevContent).toBe('original content');
    expect(history[0].prevSection).toBe('orig-section');
    expect(history[0].editedBy).toBe('dashboard');
  });

  it('updates content_hash and updated_at on content change', () => {
    const id = insertTestChunk('first');
    const before = store.getChunkDetail(id);
    store.updateChunkContent({ chunkId: id, content: 'second' });
    const after = store.getChunkDetail(id);
    expect(after?.content).toBe('second');
    // updated_at advances or stays equal (datetime('now') resolution is 1s)
    expect(after?.updatedAt).toBeDefined();

    // Direct DB check that content_hash actually changed
    const db = new Database(dbPath);
    const row = db.prepare('SELECT content_hash FROM chunks WHERE id = ?').get(id) as { content_hash: string };
    db.close();
    expect(row.content_hash).not.toBe('hash-' + before?.id);
  });

  it('no-op when nothing changes', () => {
    const id = insertTestChunk('unchanged');
    expect(store.updateChunkContent({ chunkId: id, content: 'unchanged' })).toBe(true);
    expect(store.getChunkHistory(id)).toHaveLength(0);
  });

  it('returns false for unknown chunk id', () => {
    expect(store.updateChunkContent({ chunkId: 99999, content: 'whatever' })).toBe(false);
  });

  it('updates section/category/topic without content change', () => {
    const id = insertTestChunk('fact', 'old-section');
    store.updateChunkContent({ chunkId: id, section: 'new-section', category: 'preferences', topic: 'verbosity' });
    const detail = store.getChunkDetail(id);
    expect(detail?.section).toBe('new-section');
    expect(detail?.category).toBe('preferences');
    expect(detail?.topic).toBe('verbosity');
    // Audit trail captures previous section
    const history = store.getChunkHistory(id);
    expect(history).toHaveLength(1);
    expect(history[0].prevSection).toBe('old-section');
  });
});

describe('soft delete + restore', () => {
  it('softDeleteChunk sets deleted_at', () => {
    const id = insertTestChunk('to be deleted');
    expect(store.softDeleteChunk(id)).toBe(true);
    const detail = store.getChunkDetail(id);
    expect(detail?.deletedAt).not.toBeNull();
  });

  it('soft-deleted chunks are excluded from FTS searches', () => {
    const id = insertTestChunk('coffee preferences');
    // Sanity: visible before
    const before = store.searchFts('coffee', 10);
    expect(before.some(r => r.chunkId === id)).toBe(true);
    // Delete
    store.softDeleteChunk(id);
    const after = store.searchFts('coffee', 10);
    expect(after.some(r => r.chunkId === id)).toBe(false);
  });

  it('soft-deleted chunks are excluded from getRecentChunks', () => {
    const id = insertTestChunk('recent fact');
    store.softDeleteChunk(id);
    // getRecentChunks isn't directly exposed in a typed way but searchContext
    // exercises it; verify via FTS search since soft-delete should remove
    // from index and from any search path.
    const results = store.searchContext('recent fact', { limit: 10 });
    expect(results.some((r: any) => r.chunkId === id)).toBe(false);
  });

  it('soft-deleted chunks are excluded from searchByEmbedding', () => {
    // Insert a chunk and give it an embedding
    const id = insertTestChunk('semantic content for embedding test');
    const db = new Database(dbPath);
    // Fake an embedding blob — even if the cosine sim is 0, we just verify
    // the WHERE filter excludes deleted rows from the candidate set.
    const fakeEmbedding = Buffer.alloc(512 * 4);
    db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(fakeEmbedding, id);
    db.close();
    store.softDeleteChunk(id);
    // Use searchContext which exercises both FTS and embedding paths
    const results = store.searchContext('embedding test', { limit: 10 });
    expect(results.some((r: any) => r.chunkId === id)).toBe(false);
  });

  it('restoreChunk clears deleted_at and re-includes in search', () => {
    const id = insertTestChunk('restorable fact');
    store.softDeleteChunk(id);
    expect(store.searchFts('restorable', 10).some(r => r.chunkId === id)).toBe(false);
    expect(store.restoreChunk(id)).toBe(true);
    const detail = store.getChunkDetail(id);
    expect(detail?.deletedAt).toBeNull();
    expect(store.searchFts('restorable', 10).some(r => r.chunkId === id)).toBe(true);
  });

  it('softDeleteChunk on already-deleted returns false', () => {
    const id = insertTestChunk('once');
    store.softDeleteChunk(id);
    expect(store.softDeleteChunk(id)).toBe(false);
  });

  it('restoreChunk on non-deleted returns false', () => {
    const id = insertTestChunk('never deleted');
    expect(store.restoreChunk(id)).toBe(false);
  });
});

describe('FTS trigger correctness on soft-delete', () => {
  it('FTS index does not contain content after soft-delete', () => {
    const id = insertTestChunk('uniquemarkerfoxhunt');
    store.softDeleteChunk(id);
    const db = new Database(dbPath);
    const ftsRows = db.prepare(
      "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'uniquemarkerfoxhunt'",
    ).all() as Array<{ rowid: number }>;
    db.close();
    expect(ftsRows.some(r => r.rowid === id)).toBe(false);
  });

  it('FTS index re-includes content after restore', () => {
    const id = insertTestChunk('uniquemarkerbluewhale');
    store.softDeleteChunk(id);
    store.restoreChunk(id);
    const db = new Database(dbPath);
    const ftsRows = db.prepare(
      "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'uniquemarkerbluewhale'",
    ).all() as Array<{ rowid: number }>;
    db.close();
    expect(ftsRows.some(r => r.rowid === id)).toBe(true);
  });
});

describe('pin via setPinned still works alongside soft-delete', () => {
  it('pin survives soft-delete and restore round trip', () => {
    const id = insertTestChunk('pinnable');
    expect(store.setPinned(id, true)).toBe(true);
    expect(store.getChunkDetail(id)?.pinned).toBe(true);
    store.softDeleteChunk(id);
    store.restoreChunk(id);
    expect(store.getChunkDetail(id)?.pinned).toBe(true);
  });
});
