/**
 * Outcome-driven salience: verifies the schema migration, recordOutcome
 * EMA update, and the chunkReferencedInResponse heuristic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { chunkReferencedInResponse } from '../src/agent/assistant.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-outcome-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function insertTestChunk(content: string): number {
  // Direct insert via the same db file; we need a raw handle since the store
  // doesn't expose a generic chunk-insert outside of the indexer.
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const info = db
    .prepare(
      `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('test.md', 'test-section', content, 'preamble', 'hash-' + Math.random());
  db.close();
  return info.lastInsertRowid as number;
}

function readOutcomeScore(chunkId: number): number {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const row = db
    .prepare('SELECT last_outcome_score FROM chunks WHERE id = ?')
    .get(chunkId) as { last_outcome_score: number } | undefined;
  db.close();
  return row?.last_outcome_score ?? 0;
}

describe('outcome-driven salience schema', () => {
  it('creates the outcomes table and last_outcome_score column', () => {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outcomes'")
      .get() as { name: string } | undefined;
    expect(tables?.name).toBe('outcomes');

    const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'last_outcome_score')).toBe(true);
    db.close();
  });
});

describe('recordOutcome EMA update', () => {
  it('pushes score toward +1 when chunks are repeatedly referenced', () => {
    const cid = insertTestChunk('some content');

    for (let i = 0; i < 5; i++) {
      store.recordOutcome([{ chunkId: cid, referenced: true }], 'test-session');
    }
    const score = readOutcomeScore(cid);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('pushes score toward -1 when chunks are repeatedly ignored', () => {
    const cid = insertTestChunk('some content');

    for (let i = 0; i < 5; i++) {
      store.recordOutcome([{ chunkId: cid, referenced: false }], 'test-session');
    }
    const score = readOutcomeScore(cid);
    expect(score).toBeLessThan(-0.5);
    expect(score).toBeGreaterThanOrEqual(-1);
  });

  it('stays bounded to [-1, 1] under heavy positive feedback', () => {
    const cid = insertTestChunk('some content');
    for (let i = 0; i < 100; i++) {
      store.recordOutcome([{ chunkId: cid, referenced: true }], null);
    }
    const score = readOutcomeScore(cid);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.99); // effectively saturated
  });

  it('logs each outcome to the outcomes table', () => {
    const cid = insertTestChunk('some content');
    store.recordOutcome(
      [{ chunkId: cid, referenced: true }, { chunkId: cid, referenced: false }],
      'test-session',
    );
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT chunk_id, referenced FROM outcomes WHERE chunk_id = ?').all(cid);
    db.close();
    expect(rows.length).toBe(2);
  });

  it('is a no-op on empty input', () => {
    expect(() => store.recordOutcome([], 'test-session')).not.toThrow();
  });
});

describe('chunkReferencedInResponse heuristic', () => {
  it('detects a proper-noun citation', () => {
    const chunk = 'Nathan prefers terse replies.';
    const response = 'as nathan asked, keeping it short';
    expect(chunkReferencedInResponse(chunk, response.toLowerCase())).toBe(true);
  });

  it('detects a number citation', () => {
    const chunk = 'The deadline is 2026-03-05.';
    const response = 'noting 2026 as the cutoff.';
    expect(chunkReferencedInResponse(chunk, response.toLowerCase())).toBe(true);
  });

  it('returns false when no distinctive tokens overlap', () => {
    const chunk = 'Nathan prefers terse replies.';
    const response = 'sure, got it.';
    expect(chunkReferencedInResponse(chunk, response.toLowerCase())).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(chunkReferencedInResponse('', 'anything')).toBe(false);
    expect(chunkReferencedInResponse('Something', '')).toBe(false);
  });

  it('ignores common stopwords that happen to be capitalized', () => {
    const chunk = 'There are three options.'; // "There" is a stopword
    const response = 'there are many paths forward.';
    expect(chunkReferencedInResponse(chunk, response.toLowerCase())).toBe(false);
  });
});
