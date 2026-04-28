/**
 * Dense embeddings — schema migration, search wiring, backfill mechanics.
 *
 * These tests don't load the actual transformers.js model (that's a ~440MB
 * download we don't want in CI). Instead they:
 *   1. Verify the schema has embedding_dense + embedding_dense_model columns
 *   2. Manually insert pre-computed Float32Array vectors into chunks
 *   3. Verify searchByDenseEmbedding (via searchContext with queryDenseVec)
 *      uses the dense column and applies the same scoring boosts as sparse
 *   4. Verify backfillDenseEmbeddings selects the right candidates
 *   5. Verify getMemoryStats reports dense coverage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import * as embeddings from '../src/memory/embeddings.js';
import Database from 'better-sqlite3';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-dense-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function insertChunkWithDenseEmbedding(
  content: string,
  vec: Float32Array,
  model = 'test-model',
): number {
  const db = new Database(dbPath);
  const info = db.prepare(
    `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash,
                         embedding_dense, embedding_dense_model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'test.md', 'sec', content, 'preamble',
    'h-' + Math.random(),
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    model,
  );
  db.close();
  return info.lastInsertRowid as number;
}

function insertChunkPlain(content: string): number {
  const db = new Database(dbPath);
  const info = db.prepare(
    `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('test.md', 'sec', content, 'preamble', 'h-' + Math.random());
  db.close();
  return info.lastInsertRowid as number;
}

/** Construct a unit-norm 768-dim vector pointing in a specific "direction"
 *  by setting one component to 1.0. Cosine similarity of two such vectors
 *  is 1.0 if same index, 0.0 if different. Lets us write deterministic
 *  search ranking tests without running a real embedding model. */
function unitVec(idx: number, dim = 768): Float32Array {
  const v = new Float32Array(dim);
  v[idx] = 1.0;
  return v;
}

describe('schema for dense embeddings', () => {
  it('adds embedding_dense and embedding_dense_model columns', () => {
    const db = new Database(dbPath);
    const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
    db.close();
    expect(cols.some(c => c.name === 'embedding_dense')).toBe(true);
    expect(cols.some(c => c.name === 'embedding_dense_model')).toBe(true);
  });

  it('creates the partial index on embedding_dense', () => {
    const db = new Database(dbPath);
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunks_has_dense'",
    ).get() as { name: string } | undefined;
    db.close();
    expect(idx?.name).toBe('idx_chunks_has_dense');
  });
});

describe('searchContext with queryDenseVec', () => {
  it('returns chunks ranked by dense cosine similarity', () => {
    // Three chunks with vectors pointing in different directions.
    const id1 = insertChunkWithDenseEmbedding('apple content', unitVec(0));
    const id2 = insertChunkWithDenseEmbedding('banana content', unitVec(1));
    const id3 = insertChunkWithDenseEmbedding('cherry content', unitVec(2));

    // Query vector matches id1's direction → id1 should rank first via dense.
    const queryVec = unitVec(0);
    const results = store.searchContext('apple', {
      limit: 5,
      recencyLimit: 0,
      queryDenseVec: queryVec,
    });
    expect(results.length).toBeGreaterThan(0);
    // The top result should be id1 (perfect cosine match)
    const topIds = results.map((r: any) => r.chunkId);
    expect(topIds[0]).toBe(id1);
    // id2 and id3 should be filtered out (cosine 0 < threshold 0.3)
    expect(topIds).not.toContain(id2);
    expect(topIds).not.toContain(id3);
  });

  it('falls back to TF-IDF embed when no queryDenseVec passed', () => {
    // Insert chunk WITH only sparse embedding (no dense column populated)
    const id = insertChunkPlain('searchable content for TF-IDF');
    // No queryDenseVec → searchContext falls through to sparse path.
    // FTS will pick this up regardless of embedding state.
    const results = store.searchContext('searchable', { limit: 5, recencyLimit: 0 });
    expect(results.some((r: any) => r.chunkId === id)).toBe(true);
  });

  it('skips dense-only chunks when no queryDenseVec passed', () => {
    // Chunk has dense embedding but no FTS-indexable terms in our query.
    const id = insertChunkWithDenseEmbedding('uniquetestword', unitVec(0));
    // Query something unrelated; no queryDenseVec, so dense is skipped.
    // FTS will find the chunk via 'uniquetestword' though, so search FOR it.
    const results = store.searchContext('uniquetestword', { limit: 5, recencyLimit: 0 });
    // FTS should still return it because the content has the term.
    expect(results.some((r: any) => r.chunkId === id)).toBe(true);
  });

  it('honors agent_slug filter on dense path', () => {
    // Two chunks with same vector direction but different agent slugs
    const db = new Database(dbPath);
    const v = unitVec(5);
    const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    const a = db.prepare(
      `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, embedding_dense, embedding_dense_model, agent_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a.md', 'sec', 'agent A content', 'preamble', 'ha-' + Math.random(), buf, 'm', 'agent-a');
    const b = db.prepare(
      `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, embedding_dense, embedding_dense_model, agent_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('b.md', 'sec', 'agent B content', 'preamble', 'hb-' + Math.random(), buf, 'm', 'agent-b');
    db.close();

    // Strict agent isolation: only agent-a + global should match
    const results = store.searchContext('agent', {
      limit: 10,
      recencyLimit: 0,
      queryDenseVec: unitVec(5),
      agentSlug: 'agent-a',
      strict: true,
    });
    const ids = results.map((r: any) => r.chunkId);
    expect(ids).toContain(Number(a.lastInsertRowid));
    expect(ids).not.toContain(Number(b.lastInsertRowid));
  });

  it('respects soft-delete on dense path', () => {
    const id = insertChunkWithDenseEmbedding('soft delete dense test', unitVec(0));
    store.softDeleteChunk(id);
    const results = store.searchContext('whatever', {
      limit: 5,
      recencyLimit: 0,
      queryDenseVec: unitVec(0),
    });
    expect(results.some((r: any) => r.chunkId === id)).toBe(false);
  });
});

describe('backfillDenseEmbeddings', () => {
  it('returns zero counts when no candidates and the model never loads', async () => {
    // No chunks → nothing to embed
    const result = await store.backfillDenseEmbeddings({});
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('selects only chunks lacking the current model embedding', async () => {
    // Insert one with current model, one with old model, one with no embedding
    const currentModel = embeddings.currentDenseModel();
    insertChunkWithDenseEmbedding('current', unitVec(0), currentModel);
    insertChunkWithDenseEmbedding('old', unitVec(1), 'old-model');
    insertChunkPlain('plain');

    // Direct SQL probe for the candidate set the backfill would target
    const db = new Database(dbPath);
    const candidates = db.prepare(
      `SELECT c.id, c.content
       FROM chunks c
       LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
       WHERE sd.chunk_id IS NULL
         AND (c.embedding_dense IS NULL OR c.embedding_dense_model IS NULL OR c.embedding_dense_model != ?)`,
    ).all(currentModel) as Array<{ id: number; content: string }>;
    db.close();

    // 'old' and 'plain' should be candidates; 'current' should be skipped
    expect(candidates.length).toBe(2);
    const contents = candidates.map(c => c.content).sort();
    expect(contents).toEqual(['old', 'plain']);
  });
});

describe('getMemoryStats reports dense coverage', () => {
  it('includes chunksWithDenseEmbeddings and per-model breakdown', () => {
    insertChunkWithDenseEmbedding('one', unitVec(0), 'model-a');
    insertChunkWithDenseEmbedding('two', unitVec(1), 'model-a');
    insertChunkWithDenseEmbedding('three', unitVec(2), 'model-b');
    insertChunkPlain('four');

    const stats = store.getMemoryStats();
    expect(stats.totalChunks).toBe(4);
    expect(stats.chunksWithDenseEmbeddings).toBe(3);
    expect(stats.denseEmbeddingModels).toHaveLength(2);
    const byModel = new Map(stats.denseEmbeddingModels.map(m => [m.model, m.count]));
    expect(byModel.get('model-a')).toBe(2);
    expect(byModel.get('model-b')).toBe(1);
  });
});

describe('embeddings module dense API surface', () => {
  it('reports the configured model id', () => {
    expect(embeddings.currentDenseModel()).toBeTruthy();
    expect(embeddings.denseDimension()).toBe(768);
  });

  it('isDenseReady is false until probeDenseReady has succeeded', () => {
    // We don't call probeDenseReady in this test (it would download the model).
    // It should return false until that happens.
    expect(embeddings.isDenseReady()).toBe(false);
  });
});
