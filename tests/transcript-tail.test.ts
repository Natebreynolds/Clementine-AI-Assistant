/**
 * MemoryStore.getTranscriptTail: verifies offset/limit semantics for
 * pulling older user/assistant turns from the transcripts table to bridge
 * conversational memory across daemon restarts and SDK session death.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;
const SESSION = 'test:session:1';

function seedTurns(count: number, prefix = 't'): void {
  // Even index = user, odd = assistant. Stagger created_at by inserting one at a time.
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    // Use the sync path so created_at column timestamps advance reliably.
    (store as any)._saveTurnSync(SESSION, role, `${prefix}-${i}`, '');
  }
}

beforeEach(() => {
  testDir = path.join(
    os.tmpdir(),
    'clem-transcript-tail-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  );
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('MemoryStore.getTranscriptTail', () => {
  it('returns chronological turns with no offset', () => {
    seedTurns(30);
    const all = store.getTranscriptTail(SESSION, 0, 40);
    expect(all.length).toBe(30);
    expect(all[0].content).toBe('t-0');
    expect(all[all.length - 1].content).toBe('t-29');
  });

  it('skipFromTail removes the most recent N turns and returns chronologically', () => {
    seedTurns(30);
    const older = store.getTranscriptTail(SESSION, 10, 40);
    expect(older.length).toBe(20);
    expect(older[0].content).toBe('t-0');
    expect(older[older.length - 1].content).toBe('t-19');
    // None of the cached tail
    for (const turn of older) {
      const idx = Number(turn.content.split('-')[1]);
      expect(idx).toBeLessThan(20);
    }
  });

  it('limit caps the result size', () => {
    seedTurns(30);
    const limited = store.getTranscriptTail(SESSION, 0, 10);
    expect(limited.length).toBe(10);
    // Returns the most recent 10 chronologically
    expect(limited[0].content).toBe('t-20');
    expect(limited[limited.length - 1].content).toBe('t-29');
  });

  it('returns empty when offset >= total turns', () => {
    seedTurns(10);
    expect(store.getTranscriptTail(SESSION, 100, 40)).toEqual([]);
  });

  it('returns empty for unknown session', () => {
    seedTurns(10);
    expect(store.getTranscriptTail('nonexistent', 0, 40)).toEqual([]);
  });

  it('excludes system rows', () => {
    seedTurns(4);
    (store as any)._saveTurnSync(SESSION, 'system', '[Tool calls: foo]', '');
    seedTurns(2, 'after');
    const all = store.getTranscriptTail(SESSION, 0, 40);
    for (const turn of all) {
      expect(turn.role).not.toBe('system');
    }
    // 4 + 2 user/assistant = 6 rows
    expect(all.length).toBe(6);
  });

  it('handles negative skipFromTail as zero', () => {
    seedTurns(5);
    const out = store.getTranscriptTail(SESSION, -3, 40);
    expect(out.length).toBe(5);
  });
});
