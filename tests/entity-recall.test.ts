/**
 * Entity-driven proactive recall — registry snapshot, text matching with
 * word boundaries, specificity-preferring sort, and context-policy
 * elevation when a known entity appears in the user's turn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import {
  findEntitiesInText,
  getEntityRegistry,
  invalidateEntityRegistry,
  type RegistryEntity,
} from '../src/gateway/entity-registry.js';
import { decideContextPolicy } from '../src/gateway/context-policy.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-entity-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
  invalidateEntityRegistry();
});

afterEach(() => {
  invalidateEntityRegistry();
  rmSync(testDir, { recursive: true, force: true });
});

function insertChunkWithTopic(content: string, topic: string) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, topic)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('t.md', 'sec', content, 'preamble', 'h-' + Math.random(), topic);
  db.close();
}

function insertEpisode(opts: { topics: string[]; entities: string[]; sessionKey?: string }) {
  store.insertEpisode({
    sessionKey: opts.sessionKey ?? 'discord:dm:owner',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    summary: 'test episode',
    topics: opts.topics,
    entities: opts.entities,
    outcome: 'discussed',
    openLoops: [],
    transcriptIds: [],
  });
}

describe('getEntityRegistrySnapshot', () => {
  it('aggregates topics from chunks and topics+entities from episodes', () => {
    insertChunkWithTopic('content one', 'auth middleware');
    insertChunkWithTopic('content two', 'auth middleware');
    insertChunkWithTopic('content three', 'dashboard refactor');
    insertEpisode({ topics: ['auth middleware'], entities: ['session tokens'] });
    insertEpisode({ topics: ['dashboard refactor', 'cron jobs'], entities: ['heartbeat scheduler'] });

    const snapshot = store.getEntityRegistrySnapshot({ minCount: 1 });
    const byName = Object.fromEntries(snapshot.map(e => [e.name, e]));
    expect(byName['auth middleware']).toBeTruthy();
    expect(byName['dashboard refactor']).toBeTruthy();
    expect(byName['session tokens']).toBeTruthy();
    expect(byName['cron jobs']).toBeTruthy();
    expect(byName['heartbeat scheduler']).toBeTruthy();
    expect(byName['session tokens'].kind).toBe('entity');
    expect(byName['auth middleware'].kind).toBe('topic');
  });

  it('respects the minCount filter', () => {
    insertEpisode({ topics: ['solo topic'], entities: [] });
    insertEpisode({ topics: ['repeat topic'], entities: [] });
    insertEpisode({ topics: ['repeat topic'], entities: [] });

    const filtered = store.getEntityRegistrySnapshot({ minCount: 2 });
    const names = filtered.map(e => e.name);
    expect(names).toContain('repeat topic');
    expect(names).not.toContain('solo topic');
  });

  it('drops entries shorter than 3 chars', () => {
    insertEpisode({ topics: ['ai', 'qa'], entities: ['db'] });
    const snapshot = store.getEntityRegistrySnapshot({ minCount: 1 });
    expect(snapshot.find(e => e.name === 'ai')).toBeUndefined();
  });
});

describe('getEntityRegistry caching', () => {
  it('returns cached entries within TTL and reloads after invalidation', () => {
    insertEpisode({ topics: ['first topic'], entities: [] });
    const first = getEntityRegistry(store);
    expect(first.find(e => e.name === 'first topic')).toBeTruthy();

    insertEpisode({ topics: ['second topic'], entities: [] });
    // Without invalidation, cache holds the original snapshot.
    const second = getEntityRegistry(store);
    expect(second).toBe(first);

    invalidateEntityRegistry();
    const third = getEntityRegistry(store);
    expect(third.find(e => e.name === 'second topic')).toBeTruthy();
  });
});

describe('findEntitiesInText', () => {
  const registry: RegistryEntity[] = [
    { name: 'dashboard', display: 'dashboard', kind: 'topic', count: 5 },
    { name: 'dashboard refactor', display: 'dashboard refactor', kind: 'topic', count: 3 },
    { name: 'auth middleware', display: 'auth middleware', kind: 'topic', count: 4 },
    { name: 'cron', display: 'cron', kind: 'topic', count: 8 },
    { name: 'auth', display: 'auth', kind: 'topic', count: 2 },
  ];

  it('matches exact word-boundary entities', () => {
    const matches = findEntitiesInText('how are we doing on the cron jobs?', registry);
    expect(matches.find(m => m.name === 'cron')).toBeTruthy();
  });

  it('does NOT match substrings inside larger words', () => {
    // "auth" should not match inside "author"
    const matches = findEntitiesInText('the author wrote a long post', registry);
    expect(matches.find(m => m.name === 'auth')).toBeUndefined();
  });

  it('prefers the more specific multi-word match over the contained single-word', () => {
    const matches = findEntitiesInText('what was the dashboard refactor outcome?', registry);
    expect(matches[0].name).toBe('dashboard refactor');
    // The bare "dashboard" should be deduped out as already covered.
    expect(matches.find(m => m.name === 'dashboard')).toBeUndefined();
  });

  it('returns multiple distinct matches when the user mentions several', () => {
    const matches = findEntitiesInText('how about cron and auth middleware?', registry);
    const names = matches.map(m => m.name);
    expect(names).toContain('cron');
    expect(names).toContain('auth middleware');
  });

  it('returns nothing on empty / trivial text', () => {
    expect(findEntitiesInText('', registry).length).toBe(0);
    expect(findEntitiesInText('ok', registry).length).toBe(0);
  });

  it('returns nothing when registry is empty', () => {
    expect(findEntitiesInText('the dashboard refactor', []).length).toBe(0);
  });
});

describe('decideContextPolicy with entity matches', () => {
  it('elevates requiredRetrieval to transcript when an entity is mentioned', () => {
    const decision = decideContextPolicy({
      text: 'tell me about the dashboard refactor',
      entityMatches: [{ name: 'dashboard refactor', display: 'dashboard refactor', kind: 'topic' }],
    });
    expect(decision.requiredRetrieval).toBe('transcript');
    expect(decision.retrievalQueries[0]).toBe('dashboard refactor');
    expect(decision.triggeredEntities.length).toBe(1);
    expect(decision.debugReasons).toContain('entity:elevated-retrieval');
  });

  it('does NOT elevate retrieval on greetings even if entity matches', () => {
    const decision = decideContextPolicy({
      text: 'hey clementine',
      entityMatches: [{ name: 'dashboard', display: 'dashboard', kind: 'topic' }],
    });
    expect(decision.turnIntent).toBe('greeting');
    expect(decision.requiredRetrieval).toBe('none');
  });

  it('keeps existing retrieval level when an entity match would also trigger it', () => {
    // Repair-request intent already requires transcript retrieval; entities
    // should not change that, just contribute their queries.
    const decision = decideContextPolicy({
      text: 'how do we fix the auth middleware that broke?',
      entityMatches: [{ name: 'auth middleware', display: 'auth middleware', kind: 'topic' }],
    });
    expect(decision.requiredRetrieval).toBe('transcript');
    expect(decision.retrievalQueries[0]).toBe('auth middleware');
    // The intent should have been classified as repair, not entity-driven.
    expect(decision.turnIntent).toBe('repair_request');
  });

  it('preserves an empty triggeredEntities array when no matches are passed', () => {
    const decision = decideContextPolicy({ text: 'just a status check' });
    expect(decision.triggeredEntities).toEqual([]);
  });
});
