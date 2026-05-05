/**
 * Episodic consolidation — schema, idle session detection, cursor mechanics,
 * JSON parsing tolerance, full pass with a stub Anthropic client.
 *
 * No network calls: tests inject a fake `messages.create` that returns a
 * canned JSON payload, so the LLM extraction path is exercised without the
 * real model.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import {
  parseEpisodeJson,
  consolidateOneSession,
  runEpisodicConsolidationPass,
  type EpisodeExtraction,
} from '../src/gateway/episodic-consolidation.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-ep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

function backdateTranscript(id: number, isoMinutesAgo: number) {
  const db = new Database(dbPath);
  const ts = new Date(Date.now() - isoMinutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('UPDATE transcripts SET created_at = ? WHERE id = ?').run(ts, id);
  // Keep FTS index consistent.
  db.prepare(`UPDATE transcripts_fts SET created_at = ? WHERE rowid = ?`).run(ts, id);
  db.close();
}

function seedSession(sessionKey: string, turns: Array<{ role: string; content: string }>, minutesAgoStart = 60) {
  const ids: number[] = [];
  for (const t of turns) {
    store.saveTurn(sessionKey, t.role, t.content, '');
  }
  // Newly inserted ids: read them back ordered by id desc, then re-order asc.
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id FROM transcripts WHERE session_key = ? ORDER BY id ASC').all(sessionKey) as Array<{ id: number }>;
  db.close();
  for (let i = 0; i < rows.length; i++) ids.push(rows[i].id);
  // Backdate so the session appears idle.
  for (let i = 0; i < ids.length; i++) {
    backdateTranscript(ids[i], minutesAgoStart - i);
  }
  return ids;
}

const STUB_EXTRACTION: EpisodeExtraction = {
  summary: 'Decided to use session-token middleware; deferred refresh-token rotation.',
  topics: ['auth', 'middleware'],
  entities: ['session-token middleware', 'refresh tokens'],
  outcome: 'decided',
  openLoops: ['Implement refresh-token rotation by Friday'],
  commitments: [
    { text: "I'll wire the middleware tomorrow", owner: 'user', dueHint: 'tomorrow' },
  ],
};

function stubClient(extraction: EpisodeExtraction = STUB_EXTRACTION) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(extraction) }],
      })),
    },
  } as any; // The Anthropic SDK type is fully stubbed in our wrapper
}

describe('parseEpisodeJson', () => {
  it('parses a clean JSON payload', () => {
    const out = parseEpisodeJson(JSON.stringify(STUB_EXTRACTION));
    expect(out?.summary).toContain('session-token');
    expect(out?.topics).toContain('auth');
    expect(out?.openLoops.length).toBe(1);
  });

  it('strips ```json fences', () => {
    const fenced = '```json\n' + JSON.stringify(STUB_EXTRACTION) + '\n```';
    const out = parseEpisodeJson(fenced);
    expect(out?.summary).toContain('session-token');
  });

  it('rejects empty or invalid output', () => {
    expect(parseEpisodeJson('')).toBeNull();
    expect(parseEpisodeJson('not json')).toBeNull();
    expect(parseEpisodeJson('{}')).toBeNull();
  });

  it('coerces missing arrays to empty', () => {
    const out = parseEpisodeJson(JSON.stringify({ summary: 'x' }));
    expect(out?.summary).toBe('x');
    expect(out?.topics).toEqual([]);
    expect(out?.entities).toEqual([]);
    expect(out?.openLoops).toEqual([]);
  });
});

describe('schema migrations for episodes', () => {
  it('creates episodes + consolidation_cursors with expected columns', () => {
    const db = new Database(dbPath, { readonly: true });
    const epCols = (db.prepare("PRAGMA table_info('episodes')").all() as Array<{ name: string }>).map(c => c.name);
    const curCols = (db.prepare("PRAGMA table_info('consolidation_cursors')").all() as Array<{ name: string }>).map(c => c.name);
    db.close();
    expect(epCols).toEqual(expect.arrayContaining([
      'id', 'session_key', 'started_at', 'ended_at', 'summary', 'topics', 'entities',
      'outcome', 'open_loops', 'transcript_ids', 'chunk_id', 'created_at',
    ]));
    expect(curCols).toEqual(expect.arrayContaining([
      'session_key', 'last_transcript_id', 'last_attempted_at', 'last_success_at', 'fail_count',
    ]));
  });
});

describe('getIdleSessionsForEpisodicConsolidation', () => {
  it('finds idle sessions with enough new turns', () => {
    seedSession('discord:dm:owner', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'sure' },
    ], 60);
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5,
    });
    expect(candidates.length).toBe(1);
    expect(candidates[0].sessionKey).toBe('discord:dm:owner');
    expect(candidates[0].exchanges).toBe(4);
  });

  it('skips sessions still active within idleMinutes', () => {
    seedSession('discord:dm:owner', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    ], 5); // 5 minutes ago — too fresh
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5,
    });
    expect(candidates.length).toBe(0);
  });

  it('skips sessions with too few exchanges', () => {
    seedSession('discord:dm:owner', [
      { role: 'user', content: 'just one' },
    ], 60);
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5,
    });
    expect(candidates.length).toBe(0);
  });

  it('respects the cursor — only returns sessions with new turns', () => {
    const ids = seedSession('discord:dm:owner', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    ], 60);
    store.updateConsolidationCursor('discord:dm:owner', { lastTranscriptId: ids[ids.length - 1], success: true });
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5,
    });
    expect(candidates.length).toBe(0);
  });

  it('honors fail backoff after a failure', () => {
    seedSession('discord:dm:owner', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ], 60);
    store.updateConsolidationCursor('discord:dm:owner', { success: false });
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5, failBackoffMinutes: 60,
    });
    expect(candidates.length).toBe(0);
  });
});

describe('consolidateOneSession', () => {
  it('persists episode + summary chunk + advances cursor on success', async () => {
    const ids = seedSession('discord:dm:owner', [
      { role: 'user', content: 'should we use session tokens?' },
      { role: 'assistant', content: 'session-token middleware sounds right.' },
      { role: 'user', content: 'ok lets do it.' },
    ], 60);
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5,
    });
    expect(candidates.length).toBe(1);

    const client = stubClient();
    const result = await consolidateOneSession(store, candidates[0], { anthropicClient: client });
    expect(result).not.toBeNull();
    expect(result!.episodeId).toBeGreaterThan(0);
    expect(client.messages.create).toHaveBeenCalledTimes(1);

    const episodes = store.listRecentEpisodes({});
    expect(episodes.length).toBe(1);
    expect(episodes[0].summary).toContain('session-token');
    expect(episodes[0].topics).toContain('auth');
    expect(episodes[0].chunkId).toBeGreaterThan(0);
    expect(episodes[0].transcriptIds).toEqual(ids);

    const cursor = store.getConsolidationCursor('discord:dm:owner');
    expect(cursor?.lastTranscriptId).toBe(ids[ids.length - 1]);
    expect(cursor?.failCount).toBe(0);

    // Extracted commitments should also be persisted via the shared
    // fingerprint-deduped path.
    const commitments = store.listCommitments({ status: 'open', sessionKey: 'discord:dm:owner' });
    expect(commitments.length).toBe(1);
    expect(commitments[0].source).toBe('episode-extractor');
    expect(commitments[0].text.toLowerCase()).toContain('middleware');
  });

  it('returns null and the caller path will mark failure when JSON is malformed', async () => {
    seedSession('discord:dm:owner', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ], 60);
    const candidates = store.getIdleSessionsForEpisodicConsolidation({
      idleMinutes: 20, minExchanges: 3, maxResults: 5,
    });
    const badClient = {
      messages: {
        create: vi.fn(async () => ({ content: [{ type: 'text', text: 'this is not json' }] })),
      },
    } as any;
    const result = await consolidateOneSession(store, candidates[0], { anthropicClient: badClient });
    expect(result).toBeNull();
  });
});

describe('runEpisodicConsolidationPass', () => {
  it('processes up to maxSessionsPerPass and reports counts', async () => {
    seedSession('discord:dm:a', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ], 60);
    seedSession('discord:dm:b', [
      { role: 'user', content: 'd' }, { role: 'assistant', content: 'e' }, { role: 'user', content: 'f' },
    ], 70);
    seedSession('discord:dm:c', [
      { role: 'user', content: 'g' }, { role: 'assistant', content: 'h' }, { role: 'user', content: 'i' },
    ], 80);

    const client = stubClient();
    const result = await runEpisodicConsolidationPass(store, {
      anthropicClient: client,
      maxSessionsPerPass: 2,
      idleMinutes: 20,
      minExchanges: 3,
    });
    expect(result.consolidated).toBe(2);
    expect(result.candidates).toBe(2);
    expect(client.messages.create).toHaveBeenCalledTimes(2);

    const episodes = store.listRecentEpisodes({});
    expect(episodes.length).toBe(2);
  });

  it('marks failures on the cursor and does not advance lastTranscriptId', async () => {
    seedSession('discord:dm:a', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ], 60);
    const failClient = {
      messages: {
        create: vi.fn(async () => { throw new Error('LLM down'); }),
      },
    } as any;
    const result = await runEpisodicConsolidationPass(store, {
      anthropicClient: failClient,
      maxSessionsPerPass: 5,
      idleMinutes: 20,
      minExchanges: 3,
    });
    expect(result.consolidated).toBe(0);
    expect(result.failed).toBe(1);
    const cursor = store.getConsolidationCursor('discord:dm:a');
    expect(cursor?.failCount).toBeGreaterThan(0);
    expect(cursor?.lastTranscriptId).toBe(0);
  });
});
