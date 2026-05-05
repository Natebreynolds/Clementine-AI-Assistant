/**
 * Commitments — schema, regex detector, relative-due parsing, fingerprint
 * dedup, status transitions, and active-context surfacing prioritization.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import {
  detectCommitmentInTurn,
  fingerprintCommitment,
  parseRelativeDue,
  recordDetectedCommitment,
} from '../src/gateway/commitments.js';
import { buildActiveContextSnapshot } from '../src/gateway/active-context.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-commit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('schema migrations for commitments', () => {
  it('creates commitments table with expected columns and indexes', () => {
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare("PRAGMA table_info('commitments')").all() as Array<{ name: string }>).map(c => c.name);
    db.close();
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'fingerprint', 'source', 'owner', 'text', 'session_key',
      'transcript_id', 'episode_id', 'due_at', 'due_hint', 'status',
      'created_at', 'completed_at', 'snoozed_until',
    ]));
  });
});

describe('detectCommitmentInTurn', () => {
  it("matches 'I'll <verb> ... <when>' from a user turn", () => {
    const got = detectCommitmentInTurn("I'll fix the dashboard tomorrow morning, sound good?", 'user');
    expect(got).not.toBeNull();
    expect(got!.owner).toBe('user');
    expect(got!.text.toLowerCase()).toContain('fix the dashboard');
    expect(got!.dueHint).toBeTruthy();
    expect(got!.dueAt).toBeTruthy();
  });

  it("matches 'remind me to ...' phrasing", () => {
    const got = detectCommitmentInTurn('please remind me to call the vendor on Friday', 'user');
    expect(got).not.toBeNull();
    expect(got!.dueHint?.toLowerCase()).toContain('friday');
    expect(got!.dueAt).toBeTruthy();
  });

  it("classifies assistant commitments with owner='clementine'", () => {
    const got = detectCommitmentInTurn("OK, I'll send you the recap by tomorrow.", 'assistant');
    expect(got).not.toBeNull();
    expect(got!.owner).toBe('clementine');
  });

  it("does NOT match hedged phrases like 'I'll think about it'", () => {
    expect(detectCommitmentInTurn("I'll think about it", 'user')).toBeNull();
    expect(detectCommitmentInTurn("I'll see what I can do", 'user')).toBeNull();
  });

  it('returns null for trivial / short turns', () => {
    expect(detectCommitmentInTurn('ok', 'user')).toBeNull();
    expect(detectCommitmentInTurn('', 'user')).toBeNull();
  });
});

describe('parseRelativeDue', () => {
  const fixedNow = new Date('2026-05-04T10:00:00Z'); // Monday

  it('parses tomorrow / today / EOD', () => {
    expect(parseRelativeDue('tomorrow', fixedNow)).toBeTruthy();
    expect(parseRelativeDue('today', fixedNow)).toBeTruthy();
    expect(parseRelativeDue('end of day', fixedNow)).toBeTruthy();
  });

  it('parses next week and end of week', () => {
    const nextWeek = parseRelativeDue('next week', fixedNow);
    expect(nextWeek).toBeTruthy();
    expect(new Date(nextWeek!).getTime()).toBeGreaterThan(fixedNow.getTime());
  });

  it('parses weekday names', () => {
    const friday = parseRelativeDue('by Friday', fixedNow);
    expect(friday).toBeTruthy();
    expect(new Date(friday!).getDay()).toBe(5);
  });

  it('parses "in N days/weeks/hours"', () => {
    const inThree = parseRelativeDue('in 3 days', fixedNow);
    expect(inThree).toBeTruthy();
    const delta = new Date(inThree!).getTime() - fixedNow.getTime();
    expect(delta).toBeGreaterThan(2 * 86_400_000);
    expect(delta).toBeLessThan(4 * 86_400_000);
  });

  it('returns null for unknown phrasings', () => {
    expect(parseRelativeDue('whenever', fixedNow)).toBeNull();
    expect(parseRelativeDue('', fixedNow)).toBeNull();
  });
});

describe('fingerprint dedup via upsertCommitment', () => {
  it('returns the same id when the same fingerprint is inserted twice', () => {
    const fp = fingerprintCommitment('discord:dm:owner', 'user', 'fix dashboard tomorrow');
    const first = store.upsertCommitment({
      fingerprint: fp, source: 'turn-detector', owner: 'user',
      text: "I'll fix dashboard tomorrow", sessionKey: 'discord:dm:owner',
    });
    const second = store.upsertCommitment({
      fingerprint: fp, source: 'episode-extractor', owner: 'user',
      text: 'fix dashboard tomorrow', sessionKey: 'discord:dm:owner',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const list = store.listCommitments({});
    expect(list.length).toBe(1);
  });
});

describe('updateCommitmentStatus + listCommitments', () => {
  it('moves rows between open / done / cancelled', () => {
    const fp = fingerprintCommitment('discord:dm:owner', 'user', 'do thing');
    const inserted = store.upsertCommitment({
      fingerprint: fp, source: 'manual', owner: 'user', text: 'do thing', sessionKey: 'discord:dm:owner',
    });
    expect(store.listCommitments({ status: 'open' }).length).toBe(1);
    store.updateCommitmentStatus(inserted.id, { status: 'done' });
    expect(store.listCommitments({ status: 'open' }).length).toBe(0);
    expect(store.listCommitments({ status: 'done' }).length).toBe(1);
    expect(store.listCommitments({ status: 'done' })[0].completedAt).not.toBeNull();
  });

  it('snooze suppresses from default open list until expiry', () => {
    const fp = fingerprintCommitment('discord:dm:owner', 'user', 'snooze me');
    const { id } = store.upsertCommitment({
      fingerprint: fp, source: 'manual', owner: 'user', text: 'snooze me', sessionKey: 'discord:dm:owner',
    });
    const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
    store.updateCommitmentStatus(id, { snoozeUntilIso: futureIso });
    expect(store.listCommitments({ status: 'open' }).length).toBe(0);
    // Past snooze should reappear.
    const pastIso = new Date(Date.now() - 60 * 60_000).toISOString();
    store.updateCommitmentStatus(id, { snoozeUntilIso: pastIso });
    expect(store.listCommitments({ status: 'open' }).length).toBe(1);
  });

  it("overdueOnly returns only past-due open rows", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    store.upsertCommitment({ fingerprint: 'a', source: 'manual', owner: 'user', text: 'old', dueAt: past });
    store.upsertCommitment({ fingerprint: 'b', source: 'manual', owner: 'user', text: 'soon', dueAt: future });
    const overdue = store.listCommitments({ overdueOnly: true });
    expect(overdue.length).toBe(1);
    expect(overdue[0].text).toBe('old');
  });
});

describe('recordDetectedCommitment integration', () => {
  it('persists a detector hit through the full path', () => {
    const detected = detectCommitmentInTurn("I'll ship the redesign by Friday", 'user');
    expect(detected).not.toBeNull();
    const result = recordDetectedCommitment(store, 'discord:dm:owner', detected!, { source: 'turn-detector' });
    expect(result?.created).toBe(true);
    const list = store.listCommitments({ status: 'open', sessionKey: 'discord:dm:owner' });
    expect(list.length).toBe(1);
    expect(list[0].text.toLowerCase()).toContain('redesign');
  });

  it('is idempotent on repeated identical input', () => {
    const detected = detectCommitmentInTurn("I'll ship the redesign by Friday", 'user');
    recordDetectedCommitment(store, 'discord:dm:owner', detected!, { source: 'turn-detector' });
    recordDetectedCommitment(store, 'discord:dm:owner', detected!, { source: 'turn-detector' });
    expect(store.listCommitments({}).length).toBe(1);
  });
});

describe('active-context surfacing for commitments', () => {
  it('overdue + due-within-24h commitments become greetingEligible with elevated priority', () => {
    const past = new Date(Date.now() - 6 * 3600_000).toISOString();
    const soon = new Date(Date.now() + 6 * 3600_000).toISOString();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const snapshot = buildActiveContextSnapshot('discord:dm:owner', {
      baseDir: testDir,
      openCommitments: [
        { id: 1, owner: 'user', text: 'overdue thing', dueAt: past, dueHint: null, sessionKey: 'discord:dm:owner' },
        { id: 2, owner: 'user', text: 'due soon thing', dueAt: soon, dueHint: null, sessionKey: 'discord:dm:owner' },
        { id: 3, owner: 'user', text: 'far-future thing', dueAt: later, dueHint: null, sessionKey: 'discord:dm:owner' },
      ],
    });
    const overdueItem = snapshot.items.find(i => i.detail.includes('overdue thing'));
    const soonItem = snapshot.items.find(i => i.detail.includes('due soon thing'));
    const laterItem = snapshot.items.find(i => i.detail.includes('far-future thing'));
    expect(overdueItem?.priority).toBe(90);
    expect(overdueItem?.greetingEligible).toBe(true);
    expect(soonItem?.priority).toBe(80);
    expect(soonItem?.greetingEligible).toBe(true);
    expect(laterItem?.greetingEligible).toBe(false);
  });

  it("ownership label distinguishes user from clementine commitments", () => {
    const snapshot = buildActiveContextSnapshot('discord:dm:owner', {
      baseDir: testDir,
      openCommitments: [
        { id: 1, owner: 'clementine', text: 'send recap', dueAt: null, dueHint: 'tomorrow', sessionKey: 'discord:dm:owner' },
      ],
    });
    const item = snapshot.items.find(i => i.detail.includes('send recap'));
    expect(item?.label).toContain('I committed');
  });
});
