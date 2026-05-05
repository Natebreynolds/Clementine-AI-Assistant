/**
 * Hybrid conversation recall — schema, dense + FTS5 search over transcripts,
 * backfill, coverage, and recall telemetry.
 *
 * Like dense-embeddings.test.ts, these tests don't load the actual ~440MB
 * transformers.js model. They insert pre-computed unit vectors and assert
 * the store-level wiring works. Router-level fusion is exercised in
 * router/gateway tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import * as embeddings from '../src/memory/embeddings.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-recall-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

function insertTranscriptWithVec(
  sessionKey: string,
  role: string,
  content: string,
  vec: Float32Array,
  model = 'test-model',
): number {
  const db = new Database(dbPath);
  const info = db.prepare(
    `INSERT INTO transcripts (session_key, role, content, model, embedding_dense, embedding_dense_model)
     VALUES (?, ?, ?, '', ?, ?)`,
  ).run(
    sessionKey, role, content,
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    model,
  );
  db.close();
  return info.lastInsertRowid as number;
}

function unitVec(idx: number, dim = 768): Float32Array {
  const v = new Float32Array(dim);
  v[idx] = 1.0;
  return v;
}

describe('schema migrations for hybrid recall', () => {
  it('adds embedding_dense + embedding_dense_model columns to transcripts', () => {
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("PRAGMA table_info('transcripts')").all() as Array<{ name: string }>;
    db.close();
    const names = cols.map(c => c.name);
    expect(names).toContain('embedding_dense');
    expect(names).toContain('embedding_dense_model');
  });

  it('creates recall_telemetry table', () => {
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("PRAGMA table_info('recall_telemetry')").all() as Array<{ name: string }>;
    db.close();
    const names = cols.map(c => c.name);
    expect(names).toContain('session_key');
    expect(names).toContain('mode');
    expect(names).toContain('semantic_hits');
    expect(names).toContain('lexical_hits');
    expect(names).toContain('fused_hits');
  });
});

describe('searchTranscriptsByDense', () => {
  it('ranks transcripts by cosine similarity to query vector', () => {
    insertTranscriptWithVec('discord:dm:owner', 'user', 'auth middleware decision', unitVec(0));
    insertTranscriptWithVec('discord:dm:owner', 'assistant', 'use session tokens', unitVec(1));
    insertTranscriptWithVec('discord:dm:owner', 'user', 'unrelated dashboard chatter', unitVec(50));

    const results = store.searchTranscriptsByDense(unitVec(0), 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].turn.content).toBe('auth middleware decision');
  });

  it('scopes results to a session key when provided', () => {
    insertTranscriptWithVec('discord:dm:owner', 'user', 'shared phrase', unitVec(10));
    insertTranscriptWithVec('slack:other:user', 'user', 'shared phrase', unitVec(10));

    const scoped = store.searchTranscriptsByDense(unitVec(10), 5, 'discord:dm:owner');
    expect(scoped.length).toBe(1);
    expect(scoped[0].turn.sessionKey).toBe('discord:dm:owner');

    const global = store.searchTranscriptsByDense(unitVec(10), 5);
    expect(global.length).toBe(2);
  });

  it('returns an empty array when no transcripts have embeddings', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO transcripts (session_key, role, content, model) VALUES (?, ?, ?, '')`)
      .run('discord:dm:owner', 'user', 'unembedded turn');
    db.close();

    const results = store.searchTranscriptsByDense(unitVec(0), 5);
    expect(results.length).toBe(0);
  });
});

describe('searchTranscripts (FTS5) — exposes id for dedup', () => {
  it('returns row id alongside content', () => {
    store.saveTurn('discord:dm:owner', 'user', 'paraphrase the auth decision', '');
    const rows = store.searchTranscripts('paraphrase', 5, 'discord:dm:owner');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].id).toBeTypeOf('number');
  });
});

describe('backfillTranscriptDenseEmbeddings', () => {
  it('embeds candidates and updates rows; respects current model marker', async () => {
    store.saveTurn('discord:dm:owner', 'user', 'first turn', '');
    store.saveTurn('discord:dm:owner', 'assistant', 'second turn', '');

    // Mock the dense model so we don't load anything heavy.
    const fake = unitVec(7);
    const spy = vi.spyOn(embeddings, 'embedDense').mockResolvedValue(fake);
    vi.spyOn(embeddings, 'currentDenseModel').mockReturnValue('test-model');

    const result = await store.backfillTranscriptDenseEmbeddings({});
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.model).toBe('test-model');
    expect(spy).toHaveBeenCalledTimes(2);

    // Subsequent run should embed nothing because the model marker matches.
    spy.mockClear();
    const second = await store.backfillTranscriptDenseEmbeddings({});
    expect(second.embedded).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats embedDense returning null as a failure, not an embed', async () => {
    store.saveTurn('discord:dm:owner', 'user', 'turn that the model rejects', '');
    vi.spyOn(embeddings, 'embedDense').mockResolvedValue(null);
    vi.spyOn(embeddings, 'currentDenseModel').mockReturnValue('test-model');

    const result = await store.backfillTranscriptDenseEmbeddings({});
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe('getTranscriptDenseCoverage', () => {
  it('reports total + embedded counts', () => {
    insertTranscriptWithVec('discord:dm:owner', 'user', 'embedded one', unitVec(0));
    store.saveTurn('discord:dm:owner', 'assistant', 'unembedded one', '');

    const cov = store.getTranscriptDenseCoverage();
    expect(cov.total).toBe(2);
    expect(cov.embedded).toBe(1);
    expect(cov.model).toBe('test-model');
  });

  it('reports zero coverage when no transcripts exist', () => {
    const cov = store.getTranscriptDenseCoverage();
    expect(cov.total).toBe(0);
    expect(cov.embedded).toBe(0);
    expect(cov.model).toBeNull();
  });
});

describe('recall telemetry', () => {
  it('logRecallTelemetry persists rows that summary aggregates', () => {
    store.logRecallTelemetry({
      sessionKey: 'discord:dm:owner',
      query: 'auth decision',
      mode: 'hybrid',
      semanticHits: 3,
      lexicalHits: 2,
      fusedHits: 4,
      topScore: 0.82,
    });
    store.logRecallTelemetry({
      sessionKey: 'discord:dm:owner',
      query: 'cron status',
      mode: 'lexical',
      semanticHits: 0,
      lexicalHits: 1,
      fusedHits: 1,
      topScore: 0.5,
    });
    store.logRecallTelemetry({
      sessionKey: 'discord:dm:owner',
      query: 'embedding-only hit',
      mode: 'dense',
      semanticHits: 1,
      lexicalHits: 0,
      fusedHits: 1,
      topScore: 0.71,
    });

    const summary = store.getRecallTelemetrySummary(7);
    expect(summary.total).toBe(3);
    expect(summary.semanticOnly).toBe(1);
    expect(summary.lexicalOnly).toBe(1);
    expect(summary.bothModes).toBe(1);
    expect(summary.avgTopScore).toBeGreaterThan(0);
  });

  it('logRecallTelemetry never throws even with bad input', () => {
    expect(() => store.logRecallTelemetry({
      sessionKey: '',
      query: '',
      mode: 'hybrid',
      semanticHits: 0,
      lexicalHits: 0,
      fusedHits: 0,
      topScore: 0,
    })).not.toThrow();
  });
});
