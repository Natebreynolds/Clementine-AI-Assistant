/**
 * Restart conversational memory bridge: verifies that
 * - buildOlderTurnsContext pulls older turns from transcripts when the cache is short
 * - buildSessionDeathRecoveryPrompt reconstructs context from transcripts on stale-session retry
 * - pairTranscriptTurns pairs adjacent user/assistant rows and drops orphans
 * - buildLocalSummaryFromTurns continues to format like the original buildLocalSummary
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let testDir: string;

// Isolate the entire clementine home for the test process so the assistant
// constructor doesn't read/write the developer's real ~/.clementine.
beforeAll(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'clem-restart-bridge-'));
  process.env.CLEMENTINE_HOME = testDir;
  // Nested vault dir so MEMORY_DB_PATH (= VAULT_DIR/.memory.db) lands inside testDir
  mkdirSync(path.join(testDir, 'vault'), { recursive: true });
});

let assistantModule: typeof import('../src/agent/assistant.js');
let storeModule: typeof import('../src/memory/store.js');

beforeAll(async () => {
  assistantModule = await import('../src/agent/assistant.js');
  storeModule = await import('../src/memory/store.js');
});

function makeAssistantWithStore() {
  const dbPath = path.join(testDir, `db-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  const store = new storeModule.MemoryStore(dbPath, testDir);
  store.initialize();
  const assistant = new assistantModule.PersonalAssistant();
  // Force-attach our isolated store rather than waiting for async init.
  (assistant as any).memoryStore = store;
  return { assistant, store };
}

function seedPairs(store: any, sessionKey: string, count: number, prefix = 't'): void {
  for (let i = 0; i < count; i++) {
    store._saveTurnSync(sessionKey, 'user', `${prefix}-user-${i}`, '');
    store._saveTurnSync(sessionKey, 'assistant', `${prefix}-asst-${i}`, '');
  }
}

afterEach(() => {
  // Per-file cleanup in beforeAll — nothing to do here.
});

describe('pairTranscriptTurns', () => {
  it('pairs adjacent user/assistant rows', () => {
    const { assistant } = makeAssistantWithStore();
    const turns = [
      { role: 'user', content: 'hi 1' },
      { role: 'assistant', content: 'hello 1' },
      { role: 'user', content: 'hi 2' },
      { role: 'assistant', content: 'hello 2' },
    ];
    const pairs = (assistant as any).pairTranscriptTurns(turns);
    expect(pairs.length).toBe(2);
    expect(pairs[0]).toEqual({ user: 'hi 1', assistant: 'hello 1' });
    expect(pairs[1]).toEqual({ user: 'hi 2', assistant: 'hello 2' });
  });

  it('drops orphan tail user turns and system rows', () => {
    const { assistant } = makeAssistantWithStore();
    const turns = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: '[Tool calls: x]' },
      { role: 'user', content: 'orphan' }, // no matching assistant — must drop
    ];
    const pairs = (assistant as any).pairTranscriptTurns(turns);
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toEqual({ user: 'q', assistant: 'a' });
  });

  it('returns empty for empty input', () => {
    const { assistant } = makeAssistantWithStore();
    expect((assistant as any).pairTranscriptTurns([])).toEqual([]);
  });
});

describe('buildLocalSummaryFromTurns', () => {
  it('formats turns matching the legacy buildLocalSummary output', () => {
    const { assistant } = makeAssistantWithStore();
    const turns = Array.from({ length: 7 }, (_, i) => ({
      user: `user-${i}`,
      assistant: `asst-${i}`,
    }));
    const out = (assistant as any).buildLocalSummaryFromTurns(turns);
    // Default take=5, so exchanges 3..7 of 7
    const lines = out.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('Exchange 3:');
    expect(lines[0]).toContain('user-2'); // 0-indexed: turns[2]
    expect(lines[4]).toContain('Exchange 7:');
    expect(lines[4]).toContain('user-6');
  });

  it('respects take/userMax/assistantMax options', () => {
    const { assistant } = makeAssistantWithStore();
    const turns = [{ user: 'a'.repeat(500), assistant: 'b'.repeat(500) }];
    const out = (assistant as any).buildLocalSummaryFromTurns(turns, {
      take: 1,
      userMax: 10,
      assistantMax: 20,
    });
    expect(out).toContain('"' + 'a'.repeat(10) + '"');
    expect(out).toContain('"' + 'b'.repeat(20) + '"');
    expect(out).not.toContain('a'.repeat(11));
  });

  it('returns empty for empty turns', () => {
    const { assistant } = makeAssistantWithStore();
    expect((assistant as any).buildLocalSummaryFromTurns([])).toBe('');
  });
});

describe('buildOlderTurnsContext', () => {
  it('returns a summary of older turns when transcripts has more than the cache', () => {
    const { assistant, store } = makeAssistantWithStore();
    const sessionKey = 'discord:user:abc';
    seedPairs(store, sessionKey, 15);
    const cached = Array.from({ length: 5 }, (_, i) => ({
      user: `cache-u-${i}`,
      assistant: `cache-a-${i}`,
    }));

    const summary = (assistant as any).buildOlderTurnsContext(sessionKey, cached);
    expect(summary).not.toBe('');
    // Older content (turns 0..9 in transcripts) should appear; cache content shouldn't.
    expect(summary).toContain('t-user-');
    expect(summary).not.toContain('cache-u-');
    expect(summary.length).toBeLessThanOrEqual(600);
  });

  it('returns empty when there are no older turns beyond the cache', () => {
    const { assistant, store } = makeAssistantWithStore();
    const sessionKey = 'dashboard:web';
    seedPairs(store, sessionKey, 5);
    // Cache reports 5 pairs = 10 turns, transcripts has 5 pairs = 10 turns. Nothing older.
    const cached = Array.from({ length: 5 }, (_, i) => ({
      user: `c-${i}`,
      assistant: `r-${i}`,
    }));
    const summary = (assistant as any).buildOlderTurnsContext(sessionKey, cached);
    expect(summary).toBe('');
  });

  it('returns empty when cache is empty (lets the existing fallback handle it)', () => {
    const { assistant, store } = makeAssistantWithStore();
    seedPairs(store, 'k', 20);
    const summary = (assistant as any).buildOlderTurnsContext('k', []);
    expect(summary).toBe('');
  });
});

describe('buildSessionDeathRecoveryPrompt', () => {
  it('reconstructs context from transcripts when cache is empty', () => {
    const { assistant, store } = makeAssistantWithStore();
    const sessionKey = 'slack:team:T:user:U';
    seedPairs(store, sessionKey, 12);

    const original = 'follow-up question';
    const result = (assistant as any).buildSessionDeathRecoveryPrompt(original, sessionKey);

    expect(result).not.toBe(original);
    expect(result).toContain('[Recovering context after session expired.');
    expect(result).toContain('Recent messages:');
    expect(result).toContain(original);
    // Original prompt is at the tail
    expect(result.endsWith(original)).toBe(true);
  });

  it('falls through to the original prompt when no transcripts and no cache', () => {
    const { assistant } = makeAssistantWithStore();
    const original = 'orphan prompt';
    const result = (assistant as any).buildSessionDeathRecoveryPrompt(original, 'never:seen');
    expect(result).toBe(original);
  });

  it('uses cached lastExchanges when present and skips hydration', () => {
    const { assistant, store } = makeAssistantWithStore();
    const sessionKey = 'discord:user:cached';
    seedPairs(store, sessionKey, 6);

    // Pre-populate the cache with content that differs from the transcript so we can detect
    // whether the cache was used vs hydrated from disk.
    const cached = Array.from({ length: 4 }, (_, i) => ({
      user: `CACHE-U-${i}`,
      assistant: `CACHE-A-${i}`,
    }));
    (assistant as any).lastExchanges.set(sessionKey, cached);

    const result = (assistant as any).buildSessionDeathRecoveryPrompt('next', sessionKey);
    expect(result).toContain('CACHE-U-');
  });

  it('returns the original prompt when sessionKey is empty', () => {
    const { assistant } = makeAssistantWithStore();
    expect((assistant as any).buildSessionDeathRecoveryPrompt('p', '')).toBe('p');
  });
});

describe('MemoryStore wiring (sanity)', () => {
  it('exposes getTranscriptTail on the store assigned to the assistant', () => {
    const { assistant } = makeAssistantWithStore();
    expect(typeof (assistant as any).memoryStore.getTranscriptTail).toBe('function');
  });
});
