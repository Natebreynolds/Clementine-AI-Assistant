/**
 * Learned facts — schema, upsert dedup, supersession lineage, fuzzy lookup,
 * and end-to-end persistence via the consolidation flow with a stub LLM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import {
  parseEpisodeJson,
  fingerprintLearnedFact,
  consolidateOneSession,
  type EpisodeExtraction,
} from '../src/gateway/episodic-consolidation.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-learned-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe('learned_facts schema', () => {
  it('creates the table with expected columns', () => {
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare("PRAGMA table_info('learned_facts')").all() as Array<{ name: string }>).map(c => c.name);
    db.close();
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'fingerprint', 'kind', 'text', 'source_episode_id', 'status',
      'created_at', 'superseded_at', 'superseded_by_id', 'cancelled_at',
    ]));
  });

  it('adds superseded_by_id and superseded_at to episodes', () => {
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare("PRAGMA table_info('episodes')").all() as Array<{ name: string }>).map(c => c.name);
    db.close();
    expect(cols).toContain('superseded_by_id');
    expect(cols).toContain('superseded_at');
  });
});

describe('upsertLearnedFact', () => {
  it('inserts new facts and dedupes by fingerprint', () => {
    const fp = fingerprintLearnedFact('preference', 'user prefers terse responses');
    const first = store.upsertLearnedFact({ fingerprint: fp, kind: 'preference', text: 'user prefers terse responses' });
    expect(first.created).toBe(true);
    const second = store.upsertLearnedFact({ fingerprint: fp, kind: 'preference', text: 'user prefers terse responses' });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('produces stable, kind-aware fingerprints', () => {
    const a = fingerprintLearnedFact('preference', 'User Prefers TypeScript');
    const b = fingerprintLearnedFact('preference', 'user prefers typescript');
    const c = fingerprintLearnedFact('fact', 'user prefers typescript');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('supersedeLearnedFact + listActiveLearnedFacts', () => {
  it('marks the old row superseded and excludes it from active list', () => {
    const oldFp = fingerprintLearnedFact('preference', 'user prefers detailed responses');
    const old = store.upsertLearnedFact({ fingerprint: oldFp, kind: 'preference', text: 'user prefers detailed responses' });
    const newFp = fingerprintLearnedFact('preference', 'user prefers terse responses');
    const fresh = store.upsertLearnedFact({ fingerprint: newFp, kind: 'preference', text: 'user prefers terse responses' });

    const ok = store.supersedeLearnedFact(old.id, fresh.id);
    expect(ok).toBe(true);

    const active = store.listActiveLearnedFacts({});
    expect(active.find(f => f.id === old.id)).toBeUndefined();
    expect(active.find(f => f.id === fresh.id)).toBeTruthy();

    const all = store.listAllLearnedFacts({});
    const oldRow = all.find(f => f.id === old.id);
    expect(oldRow?.status).toBe('superseded');
    expect(oldRow?.supersededById).toBe(fresh.id);
    expect(oldRow?.supersededAt).toBeTruthy();
  });

  it('idempotent — running supersedes twice is a no-op', () => {
    const a = store.upsertLearnedFact({ fingerprint: 'a', kind: 'fact', text: 'x' });
    const b = store.upsertLearnedFact({ fingerprint: 'b', kind: 'fact', text: 'y' });
    expect(store.supersedeLearnedFact(a.id, b.id)).toBe(true);
    expect(store.supersedeLearnedFact(a.id, b.id)).toBe(false);
  });
});

describe('setLearnedFactStatus', () => {
  it('cancels and reinstates rows', () => {
    const f = store.upsertLearnedFact({ fingerprint: 'fp1', kind: 'fact', text: 'something' });
    expect(store.setLearnedFactStatus(f.id, 'cancelled')).toBe(true);
    expect(store.listActiveLearnedFacts({}).length).toBe(0);
    expect(store.setLearnedFactStatus(f.id, 'active')).toBe(true);
    expect(store.listActiveLearnedFacts({}).length).toBe(1);
  });
});

describe('findActiveLearnedFactByPhrase', () => {
  it('matches by substring and word overlap, ignoring superseded rows', () => {
    const old = store.upsertLearnedFact({ fingerprint: 'old', kind: 'preference', text: 'user prefers detailed responses with examples' });
    const decoy = store.upsertLearnedFact({ fingerprint: 'd1', kind: 'fact', text: 'user works in TypeScript on macOS' });

    const hit = store.findActiveLearnedFactByPhrase('user prefers detailed responses');
    expect(hit?.id).toBe(old.id);

    // Unrelated phrase shouldn't match the decoy.
    const miss = store.findActiveLearnedFactByPhrase('agent should be more proactive');
    expect(miss).toBeNull();

    // Once superseded, shouldn't be found.
    const fresh = store.upsertLearnedFact({ fingerprint: 'new', kind: 'preference', text: 'user prefers terse responses' });
    store.supersedeLearnedFact(old.id, fresh.id);
    const after = store.findActiveLearnedFactByPhrase('user prefers detailed responses');
    expect(after?.id).not.toBe(old.id);
    void decoy;
  });
});

describe('parseEpisodeJson with learnedFacts', () => {
  it('parses learnedFacts entries and clamps invalid kinds', () => {
    const out = parseEpisodeJson(JSON.stringify({
      summary: 'something happened',
      topics: [],
      entities: [],
      outcome: 'discussed',
      openLoops: [],
      commitments: [],
      learnedFacts: [
        { kind: 'preference', text: 'user prefers terse responses' },
        { kind: 'invalid_kind', text: 'should be dropped' },
        { kind: 'workflow', text: 'deploy steps: build then push then publish', supersedes: 'old deploy procedure' },
      ],
    }));
    expect(out?.learnedFacts.length).toBe(2);
    expect(out?.learnedFacts[1].supersedes).toBe('old deploy procedure');
  });

  it('defaults learnedFacts to [] when absent', () => {
    const out = parseEpisodeJson(JSON.stringify({ summary: 'x', topics: [], entities: [], outcome: '', openLoops: [], commitments: [] }));
    expect(out?.learnedFacts).toEqual([]);
  });
});

describe('end-to-end consolidateOneSession with learned facts', () => {
  function seedSession() {
    store.saveTurn('discord:dm:owner', 'user', 'I think I prefer when you give me detailed answers', '');
    store.saveTurn('discord:dm:owner', 'assistant', 'Understood — I will go deeper.', '');
    store.saveTurn('discord:dm:owner', 'user', 'Actually, on reflection, I prefer terse responses.', '');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT id FROM transcripts WHERE session_key = ? ORDER BY id').all('discord:dm:owner') as Array<{ id: number }>;
    db.close();
    // Backdate so the candidate query treats the session as idle.
    const dbW = new Database(dbPath);
    const ts = new Date(Date.now() - 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    for (const r of rows) {
      dbW.prepare('UPDATE transcripts SET created_at = ? WHERE id = ?').run(ts, r.id);
      dbW.prepare(`UPDATE transcripts_fts SET created_at = ? WHERE rowid = ?`).run(ts, r.id);
    }
    dbW.close();
    return rows.map(r => r.id);
  }

  it('persists extracted learnedFacts and supersedes the contradicting old one', async () => {
    seedSession();
    // Pre-seed an existing belief that should get superseded.
    store.upsertLearnedFact({
      fingerprint: fingerprintLearnedFact('preference', 'user prefers detailed responses'),
      kind: 'preference',
      text: 'user prefers detailed responses',
    });

    const stubExtraction: EpisodeExtraction = {
      summary: 'User flipped preference from detailed to terse.',
      topics: ['response style'],
      entities: [],
      outcome: 'decided',
      openLoops: [],
      commitments: [],
      learnedFacts: [
        { kind: 'preference', text: 'user prefers terse responses', supersedes: 'user prefers detailed responses' },
      ],
    };
    const client = {
      messages: {
        create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(stubExtraction) }] })),
      },
    } as any;

    const candidates = store.getIdleSessionsForEpisodicConsolidation({ idleMinutes: 20, minExchanges: 3, maxResults: 5 });
    expect(candidates.length).toBe(1);
    const result = await consolidateOneSession(store, candidates[0], { anthropicClient: client });
    expect(result).not.toBeNull();

    const active = store.listActiveLearnedFacts({});
    expect(active.length).toBe(1);
    expect(active[0].text).toBe('user prefers terse responses');
    expect(active[0].sourceEpisodeId).toBe(result!.episodeId);

    const all = store.listAllLearnedFacts({});
    const supersededRow = all.find(f => f.text === 'user prefers detailed responses');
    expect(supersededRow?.status).toBe('superseded');
    expect(supersededRow?.supersededById).toBe(active[0].id);
  });

  it('does not supersede when the LLM does not emit a hint', async () => {
    seedSession();
    store.upsertLearnedFact({
      fingerprint: fingerprintLearnedFact('preference', 'user prefers morning notifications'),
      kind: 'preference',
      text: 'user prefers morning notifications',
    });

    const stubExtraction: EpisodeExtraction = {
      summary: 'A new fact unrelated to the morning preference.',
      topics: [],
      entities: [],
      outcome: 'discussed',
      openLoops: [],
      commitments: [],
      learnedFacts: [
        { kind: 'fact', text: 'user works in TypeScript on macOS' },
      ],
    };
    const client = {
      messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(stubExtraction) }] })) },
    } as any;

    const candidates = store.getIdleSessionsForEpisodicConsolidation({ idleMinutes: 20, minExchanges: 3, maxResults: 5 });
    await consolidateOneSession(store, candidates[0], { anthropicClient: client });
    const active = store.listActiveLearnedFacts({});
    expect(active.length).toBe(2);
    const all = store.listAllLearnedFacts({});
    expect(all.find(f => f.status === 'superseded')).toBeUndefined();
  });
});
