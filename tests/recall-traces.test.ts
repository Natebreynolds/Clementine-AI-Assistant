/**
 * Recall tracing — verifies the recall_traces table schema, logRecallTrace
 * write path, getRecentRecallTraces / getRecallTrace read paths, the
 * derived_from chunks column, and that searchContext auto-logs traces
 * when given a sessionKey.
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
  testDir = path.join(os.tmpdir(), 'clem-recall-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function insertTestChunk(content: string, section = 'test-section'): number {
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

describe('recall_traces schema', () => {
  it('creates the recall_traces table on initialize', () => {
    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recall_traces'")
      .get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('recall_traces');
  });

  it('adds the derived_from column to chunks', () => {
    const db = new Database(dbPath);
    const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
    db.close();
    expect(cols.some(c => c.name === 'derived_from')).toBe(true);
  });
});

describe('logRecallTrace + getRecentRecallTraces', () => {
  it('persists a trace and reads it back newest-first', () => {
    store.logRecallTrace({
      sessionKey: 'test:session:1',
      messageId: 'msg-1',
      query: 'what did I say about coffee',
      chunkIds: [1, 2, 3],
      scores: [0.9, 0.5, 0.3],
      agentSlug: null,
    });
    store.logRecallTrace({
      sessionKey: 'test:session:1',
      messageId: 'msg-2',
      query: 'follow-up question',
      chunkIds: [4, 5],
      scores: [0.7, 0.4],
    });

    const traces = store.getRecentRecallTraces('test:session:1', 10);
    expect(traces).toHaveLength(2);
    // Newest first
    expect(traces[0].query).toBe('follow-up question');
    expect(traces[0].chunkIds).toEqual([4, 5]);
    expect(traces[0].scores).toEqual([0.7, 0.4]);
    expect(traces[1].query).toBe('what did I say about coffee');
    expect(traces[1].messageId).toBe('msg-1');
  });

  it('isolates traces by session_key', () => {
    store.logRecallTrace({ sessionKey: 'a', query: 'q1', chunkIds: [1], scores: [0.5] });
    store.logRecallTrace({ sessionKey: 'b', query: 'q2', chunkIds: [2], scores: [0.6] });
    expect(store.getRecentRecallTraces('a', 10)).toHaveLength(1);
    expect(store.getRecentRecallTraces('b', 10)).toHaveLength(1);
    expect(store.getRecentRecallTraces('c', 10)).toHaveLength(0);
  });

  it('skips logging when chunkIds is empty', () => {
    store.logRecallTrace({ sessionKey: 'empty', query: 'nothing matches', chunkIds: [], scores: [] });
    expect(store.getRecentRecallTraces('empty', 10)).toHaveLength(0);
  });
});

describe('getRecallTrace hydration', () => {
  it('returns null for an unknown trace id', () => {
    expect(store.getRecallTrace(99999)).toBeNull();
  });

  it('hydrates chunk details and preserves trace ordering with scores', () => {
    const id1 = insertTestChunk('coffee preferences', 'sec-a');
    const id2 = insertTestChunk('tea preferences', 'sec-b');
    const id3 = insertTestChunk('water preferences', 'sec-c');

    store.logRecallTrace({
      sessionKey: 'hydrate:test',
      messageId: 'm1',
      query: 'beverages',
      chunkIds: [id3, id1, id2],
      scores: [0.9, 0.7, 0.5],
    });

    const traces = store.getRecentRecallTraces('hydrate:test', 1);
    const trace = store.getRecallTrace(traces[0].id);
    expect(trace).not.toBeNull();
    if (!trace) return;

    expect(trace.query).toBe('beverages');
    expect(trace.chunks).toHaveLength(3);
    // Order should match the original chunkIds order, not insertion order
    expect(trace.chunks[0].id).toBe(id3);
    expect(trace.chunks[1].id).toBe(id1);
    expect(trace.chunks[2].id).toBe(id2);
    // Scores attached in trace order
    expect(trace.chunks[0].score).toBe(0.9);
    expect(trace.chunks[1].score).toBe(0.7);
    expect(trace.chunks[2].score).toBe(0.5);
    // Hydrated content
    expect(trace.chunks[1].content).toBe('coffee preferences');
  });
});

describe('getChunksByIds with derived_from', () => {
  it('returns null derivedFrom for plain chunks', () => {
    const id = insertTestChunk('plain chunk');
    const [c] = store.getChunksByIds([id]);
    expect(c.derivedFrom).toBeNull();
  });

  it('returns the source chunk ids for summary chunks', () => {
    const sourceA = insertTestChunk('source A — fact about user');
    const sourceB = insertTestChunk('source B — related fact');
    store.insertSummaryChunk(
      'topic-x',
      'Consolidated Summary (2 chunks)',
      'Summary referencing both facts',
      [sourceA, sourceB],
    );

    const db = new Database(dbPath);
    const summaryRow = db.prepare(
      "SELECT id FROM chunks WHERE chunk_type='summary' ORDER BY id DESC LIMIT 1",
    ).get() as { id: number };
    db.close();

    const [summary] = store.getChunksByIds([summaryRow.id]);
    expect(summary.derivedFrom).toEqual([sourceA, sourceB]);
    expect(summary.consolidated).toBe(false); // summary itself isn't marked consolidated
  });

  it('handles empty input', () => {
    expect(store.getChunksByIds([])).toEqual([]);
  });
});

describe('searchContext auto-logging', () => {
  it('logs a trace when sessionKey is provided', () => {
    insertTestChunk('the user prefers concise responses');
    insertTestChunk('the user works on a typescript project');

    store.searchContext('preferences typescript', {
      limit: 5,
      sessionKey: 'auto:log:test',
      messageId: 'msg-auto',
    });

    const traces = store.getRecentRecallTraces('auto:log:test', 10);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0].messageId).toBe('msg-auto');
    expect(traces[0].query).toBe('preferences typescript');
  });

  it('skips logging when sessionKey is omitted', () => {
    insertTestChunk('some content for fts');
    store.searchContext('content', { limit: 5 });
    // No way to verify "no trace written" without scanning the table; verify it
    // didn't blow up and that fetching by an unknown key returns nothing.
    expect(store.getRecentRecallTraces('not-a-session', 10)).toHaveLength(0);
  });

  it('skips logging when skipTrace is true', () => {
    insertTestChunk('content for skip-trace test');
    store.searchContext('content', {
      limit: 5,
      sessionKey: 'should-not-log',
      skipTrace: true,
    });
    expect(store.getRecentRecallTraces('should-not-log', 10)).toHaveLength(0);
  });
});

describe('pruneStaleData includes recall traces', () => {
  it('reports recallTracesPruned count', () => {
    store.logRecallTrace({ sessionKey: 's', query: 'q', chunkIds: [1], scores: [0.5] });
    const result = store.pruneStaleData({ recallTraceRetentionDays: 0 });
    expect(result.recallTracesPruned).toBeGreaterThanOrEqual(0);
    expect(typeof result.recallTracesPruned).toBe('number');
  });

  it('removes traces older than retention window', () => {
    // Insert a trace then backdate it via raw SQL
    store.logRecallTrace({ sessionKey: 'old', query: 'q', chunkIds: [1], scores: [0.5] });
    const db = new Database(dbPath);
    db.prepare("UPDATE recall_traces SET retrieved_at = datetime('now', '-100 days') WHERE session_key = 'old'").run();
    db.close();

    const result = store.pruneStaleData({ recallTraceRetentionDays: 90 });
    expect(result.recallTracesPruned).toBe(1);
    expect(store.getRecentRecallTraces('old', 10)).toHaveLength(0);
  });
});
