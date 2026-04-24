/**
 * Artifact memory: schema, storeArtifact, searchArtifacts (keyword + recent),
 * getArtifact access bookkeeping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(
    os.tmpdir(),
    'clem-artifact-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  );
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('artifact schema', () => {
  it('creates tool_artifacts table and FTS', () => {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const base = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_artifacts'")
      .get() as { name: string } | undefined;
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_artifacts_fts'")
      .get() as { name: string } | undefined;
    db.close();
    expect(base?.name).toBe('tool_artifacts');
    expect(fts?.name).toBe('tool_artifacts_fts');
  });
});

describe('storeArtifact + getArtifact', () => {
  it('round-trips content and metadata', () => {
    const id = store.storeArtifact({
      toolName: 'web_search',
      summary: 'Top 5 results for "clementine framework"',
      content: 'RESULT BODY: long json blob...',
      tags: 'search,clementine',
      sessionKey: 'session-x',
      agentSlug: null,
    });
    expect(id).toBeGreaterThan(0);

    const got = store.getArtifact(id);
    expect(got).not.toBeNull();
    expect(got!.toolName).toBe('web_search');
    expect(got!.summary).toContain('clementine framework');
    expect(got!.content).toContain('RESULT BODY');
    expect(got!.tags).toBe('search,clementine');
    expect(got!.sessionKey).toBe('session-x');
  });

  it('bumps access_count on each fetch', () => {
    const id = store.storeArtifact({
      toolName: 't',
      summary: 's',
      content: 'c',
    });
    store.getArtifact(id);
    store.getArtifact(id);
    const third = store.getArtifact(id);
    expect(third!.accessCount).toBe(3);
  });

  it('returns null for unknown id', () => {
    expect(store.getArtifact(99999)).toBeNull();
  });
});

describe('searchArtifacts', () => {
  it('FTS search matches on summary', () => {
    store.storeArtifact({
      toolName: 'stripe_api',
      summary: 'Customer record for Acme Corp with annual billing',
      content: '{"id":"cus_123"}',
    });
    store.storeArtifact({
      toolName: 'stripe_api',
      summary: 'Invoice details for Initech',
      content: '{"id":"in_456"}',
    });

    const results = store.searchArtifacts({ query: 'acme' });
    expect(results.length).toBe(1);
    expect(results[0].summary).toContain('Acme');
  });

  it('FTS search matches on content body', () => {
    store.storeArtifact({
      toolName: 'notes',
      summary: 'meeting notes',
      content: 'discussed pricing tiers and contract renewal',
    });
    const results = store.searchArtifacts({ query: 'renewal' });
    expect(results.length).toBe(1);
  });

  it('falls back to recency when no query', () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(store.storeArtifact({ toolName: 't', summary: `s${i}`, content: `c${i}` }));
    }
    const results = store.searchArtifacts({ limit: 10 });
    expect(results.length).toBe(3);
    // Newest first
    expect(results[0].id).toBe(ids[2]);
  });

  it('filters by session_key', () => {
    store.storeArtifact({ toolName: 't', summary: 's1', content: 'c1', sessionKey: 'a' });
    store.storeArtifact({ toolName: 't', summary: 's2', content: 'c2', sessionKey: 'b' });
    const aOnly = store.searchArtifacts({ sessionKey: 'a' });
    expect(aOnly.length).toBe(1);
    expect(aOnly[0].summary).toBe('s1');
  });

  it('returns empty array when no matches', () => {
    expect(store.searchArtifacts({ query: 'nothing-matches-this' })).toEqual([]);
  });
});
