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
    'clem-transcript-search-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  );
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('MemoryStore transcript search and lineage', () => {
  it('searches transcripts through the FTS-backed path with session isolation', () => {
    store.saveTurn('s-one', 'user', 'The insight check crashed on task T-019 with sqlite variables.', '');
    store.saveTurn('s-two', 'user', 'Unrelated email approval conversation.', '');

    const scoped = store.searchTranscripts('sqlite variables', 10, 's-one');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].sessionKey).toBe('s-one');
    expect(scoped[0].content).toContain('sqlite variables');

    expect(store.searchTranscripts('sqlite variables', 10, 's-two')).toHaveLength(0);
  });

  it('records compaction lineage without replacing session summaries', () => {
    store.saveSessionSummary('s-one', 'older summary', 2);
    store.recordSessionLineage({
      sessionKey: 's-one',
      parentSessionId: 'sdk-parent',
      reason: 'manual_operator_command',
      summary: 'structured handoff',
      exchangeCount: 7,
    });

    expect(store.getRecentSummariesForSession('s-one', 1)[0].summary).toBe('older summary');
    const lineage = store.getSessionLineage('s-one', 1);
    expect(lineage[0].parentSessionId).toBe('sdk-parent');
    expect(lineage[0].reason).toBe('manual_operator_command');
    expect(lineage[0].exchangeCount).toBe(7);
  });
});
