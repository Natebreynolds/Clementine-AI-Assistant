/**
 * PRD §11 Phase 5b / 1.18.105 — Draft store tests.
 *
 * Covers: hashing stability, save/get/delete round-trip, list, badge state
 * machine across all 5 states (none / draft / ready / up_to_date / rebase_needed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CronJobDefinition } from '../src/types.js';

let tmpHome: string;
let prevHome: string | undefined;

function freshDef(name: string, prompt = 'do thing'): CronJobDefinition {
  return {
    name,
    schedule: '0 9 * * *',
    prompt,
    enabled: true,
  } as CronJobDefinition;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'clem-draft-'));
  mkdirSync(path.join(tmpHome, 'cron-drafts'), { recursive: true });
  prevHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = tmpHome;
  // Reset the module so it picks up the new env var. The store reads BASE_DIR
  // at import time, so we use a dynamic import of a fresh copy in each test.
});

afterEach(() => {
  if (prevHome) process.env.CLEMENTINE_HOME = prevHome; else delete process.env.CLEMENTINE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('hashJobDef', () => {
  it('is deterministic for the same input', async () => {
    const { hashJobDef } = await import('../src/agent/draft-store.js');
    const def = freshDef('a');
    expect(hashJobDef(def)).toBe(hashJobDef(def));
  });

  it('changes when fields change', async () => {
    const { hashJobDef } = await import('../src/agent/draft-store.js');
    const a = freshDef('a', 'one');
    const b = freshDef('a', 'two');
    expect(hashJobDef(a)).not.toBe(hashJobDef(b));
  });

  it('is order-independent for object keys', async () => {
    const { hashJobDef } = await import('../src/agent/draft-store.js');
    const a = { name: 'a', schedule: '0 9 * * *', prompt: 'p', enabled: true } as CronJobDefinition;
    const b = { enabled: true, prompt: 'p', name: 'a', schedule: '0 9 * * *' } as CronJobDefinition;
    expect(hashJobDef(a)).toBe(hashJobDef(b));
  });
});

describe('save / get / delete', () => {
  it('returns null when no draft exists', async () => {
    const { getDraft } = await import('../src/agent/draft-store.js');
    expect(getDraft('nope')).toBeNull();
  });

  it('round-trips a save', async () => {
    const { saveDraft, getDraft, hashJobDef } = await import('../src/agent/draft-store.js');
    const draft = {
      name: 't',
      draft: freshDef('t'),
      savedAt: new Date().toISOString(),
      changedBy: 'dashboard',
      basedOnPublishedHash: hashJobDef(freshDef('t')),
    };
    saveDraft(draft);
    const loaded = getDraft('t');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('t');
    expect(loaded!.draft.prompt).toBe('do thing');
  });

  it('delete removes the file', async () => {
    const { saveDraft, deleteDraft, getDraft } = await import('../src/agent/draft-store.js');
    saveDraft({ name: 'd', draft: freshDef('d'), savedAt: new Date().toISOString(), changedBy: 'dashboard', basedOnPublishedHash: null });
    expect(getDraft('d')).not.toBeNull();
    expect(deleteDraft('d')).toBe(true);
    expect(getDraft('d')).toBeNull();
  });

  it('delete of nonexistent draft returns false', async () => {
    const { deleteDraft } = await import('../src/agent/draft-store.js');
    expect(deleteDraft('never-was')).toBe(false);
  });

  it('save sanitizes the filename', async () => {
    const { saveDraft, getDraft } = await import('../src/agent/draft-store.js');
    saveDraft({ name: 'with/slash spaces', draft: freshDef('with/slash spaces'), savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: null });
    expect(getDraft('with/slash spaces')).not.toBeNull();
  });

  it('save throws when name is missing', async () => {
    const { saveDraft } = await import('../src/agent/draft-store.js');
    expect(() => saveDraft({ name: '', draft: freshDef('x'), savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: null }))
      .toThrow();
  });
});

describe('listDraftNames', () => {
  it('returns empty when no drafts', async () => {
    const { listDraftNames } = await import('../src/agent/draft-store.js');
    expect(listDraftNames()).toEqual([]);
  });

  it('returns sanitized names of all drafts', async () => {
    const { saveDraft, listDraftNames } = await import('../src/agent/draft-store.js');
    saveDraft({ name: 'a', draft: freshDef('a'), savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: null });
    saveDraft({ name: 'b', draft: freshDef('b'), savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: null });
    const names = (await import('../src/agent/draft-store.js')).listDraftNames();
    expect(names.sort()).toEqual(['a', 'b']);
    void listDraftNames;
  });
});

describe('computeBadgeState', () => {
  it('returns "none" when no draft exists', async () => {
    const { computeBadgeState } = await import('../src/agent/draft-store.js');
    expect(computeBadgeState('x', freshDef('x'))).toBe('none');
  });

  it('returns "draft" when a draft exists but no published peer', async () => {
    const { saveDraft, computeBadgeState } = await import('../src/agent/draft-store.js');
    saveDraft({ name: 'x', draft: freshDef('x'), savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: null });
    expect(computeBadgeState('x', null)).toBe('draft');
  });

  it('returns "up_to_date" when draft hash matches published', async () => {
    const { saveDraft, computeBadgeState, hashJobDef } = await import('../src/agent/draft-store.js');
    const def = freshDef('x');
    saveDraft({ name: 'x', draft: def, savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: hashJobDef(def) });
    expect(computeBadgeState('x', def)).toBe('up_to_date');
  });

  it('returns "ready" when draft differs from published', async () => {
    const { saveDraft, computeBadgeState, hashJobDef } = await import('../src/agent/draft-store.js');
    const published = freshDef('x', 'old');
    const draft = freshDef('x', 'new');
    saveDraft({ name: 'x', draft, savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: hashJobDef(published) });
    expect(computeBadgeState('x', published)).toBe('ready');
  });

  it('returns "rebase_needed" when published drifted since draft was created', async () => {
    const { saveDraft, computeBadgeState, hashJobDef } = await import('../src/agent/draft-store.js');
    const oldPublished = freshDef('x', 'one');
    const newPublished = freshDef('x', 'two');  // someone else edited
    const myDraft = freshDef('x', 'three');
    saveDraft({ name: 'x', draft: myDraft, savedAt: 'now', changedBy: 'dashboard', basedOnPublishedHash: hashJobDef(oldPublished) });
    expect(computeBadgeState('x', newPublished)).toBe('rebase_needed');
  });
});
