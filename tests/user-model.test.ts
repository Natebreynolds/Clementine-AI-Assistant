/**
 * User mental model — MemGPT-style core memory blocks. Verifies schema,
 * slot CRUD, char_limit truncation, per-agent layering, render output,
 * and that the context-assembler picks up the rendered block at priority -1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { assembleContext } from '../src/memory/context-assembler.js';
import Database from 'better-sqlite3';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-usermodel-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('user_model_blocks schema', () => {
  it('creates the user_model_blocks table on initialize', () => {
    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_blocks'",
    ).get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('user_model_blocks');
  });

  it('enforces uniqueness on (slot, agent_slug) so a single slot has one row per scope', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'one' });
    store.setUserModelBlock({ slot: 'user_facts', content: 'two' });
    const block = store.getUserModelBlock('user_facts');
    expect(block?.content).toBe('two');
    // Verify only one row exists for global scope
    const db = new Database(dbPath);
    const cnt = db.prepare(
      "SELECT COUNT(*) as c FROM user_model_blocks WHERE slot = 'user_facts' AND agent_slug IS NULL",
    ).get() as { c: number };
    db.close();
    expect(cnt.c).toBe(1);
  });
});

describe('CRUD on slots', () => {
  it('reads back a freshly written slot', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'Nathan is a coach' });
    const block = store.getUserModelBlock('user_facts');
    expect(block?.content).toBe('Nathan is a coach');
    expect(block?.charLimit).toBe(2000);
    expect(block?.agentSlug).toBeNull();
  });

  it('returns null for an unset slot', () => {
    expect(store.getUserModelBlock('goals')).toBeNull();
  });

  it('replaces existing content', () => {
    store.setUserModelBlock({ slot: 'goals', content: 'ship feature A' });
    store.setUserModelBlock({ slot: 'goals', content: 'ship feature B' });
    expect(store.getUserModelBlock('goals')?.content).toBe('ship feature B');
  });

  it('appends with newline separator', () => {
    store.appendUserModelBlock({ slot: 'goals', content: 'first goal' });
    store.appendUserModelBlock({ slot: 'goals', content: 'second goal' });
    expect(store.getUserModelBlock('goals')?.content).toBe('first goal\nsecond goal');
  });

  it('appending to an empty slot does not prepend a newline', () => {
    store.appendUserModelBlock({ slot: 'goals', content: 'only goal' });
    expect(store.getUserModelBlock('goals')?.content).toBe('only goal');
  });

  it('truncates content over char_limit on replace', () => {
    const big = 'x'.repeat(3000);
    const result = store.setUserModelBlock({ slot: 'user_facts', content: big });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(2000);
    expect(store.getUserModelBlock('user_facts')?.content.length).toBe(2000);
  });

  it('rolls off the oldest content on append when char_limit would be exceeded', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'OLD'.repeat(700) });
    const result = store.appendUserModelBlock({ slot: 'user_facts', content: 'NEW_TAIL_MARKER' });
    expect(result.truncated).toBe(true);
    // The new content is preserved at the tail
    expect(result.content.endsWith('NEW_TAIL_MARKER')).toBe(true);
    expect(result.content.length).toBe(2000);
  });

  it('clears a slot', () => {
    store.setUserModelBlock({ slot: 'goals', content: 'something' });
    expect(store.deleteUserModelBlock('goals')).toBe(true);
    expect(store.getUserModelBlock('goals')).toBeNull();
    expect(store.deleteUserModelBlock('goals')).toBe(false); // already gone
  });

  it('list returns all populated slots', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'a' });
    store.setUserModelBlock({ slot: 'goals', content: 'b' });
    const blocks = store.getAllUserModelBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks.map(b => b.slot).sort()).toEqual(['goals', 'user_facts']);
  });
});

describe('per-agent isolation with global fallback', () => {
  it('separates global and per-agent slots', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'global facts' });
    store.setUserModelBlock({ slot: 'user_facts', content: 'sdr facts', agentSlug: 'sdr' });
    expect(store.getUserModelBlock('user_facts')?.content).toBe('global facts');
    expect(store.getUserModelBlock('user_facts', 'sdr')?.content).toBe('sdr facts');
  });

  it('agent view falls back to global slots that aren\'t agent-customized', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'global facts' });
    store.setUserModelBlock({ slot: 'goals', content: 'sdr-specific goal', agentSlug: 'sdr' });
    const sdrView = store.getAllUserModelBlocks('sdr');
    const facts = sdrView.find(b => b.slot === 'user_facts');
    const goals = sdrView.find(b => b.slot === 'goals');
    expect(facts?.content).toBe('global facts');
    expect(facts?.agentSlug).toBeNull(); // came from global
    expect(goals?.content).toBe('sdr-specific goal');
    expect(goals?.agentSlug).toBe('sdr');
  });

  it('agent override takes precedence in agent view', () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'global' });
    store.setUserModelBlock({ slot: 'user_facts', content: 'agent-specific', agentSlug: 'sdr' });
    const sdrView = store.getAllUserModelBlocks('sdr');
    const block = sdrView.find(b => b.slot === 'user_facts');
    expect(block?.content).toBe('agent-specific');
    expect(block?.agentSlug).toBe('sdr');
  });
});

describe('renderUserModel formatting', () => {
  it('returns empty string when no slots populated', () => {
    expect(store.renderUserModel()).toBe('');
  });

  it('emits sections in canonical order with friendly labels', () => {
    store.setUserModelBlock({ slot: 'goals', content: 'ship the memory feature' });
    store.setUserModelBlock({ slot: 'user_facts', content: 'name: Nathan' });
    const out = store.renderUserModel();
    // user_facts comes before goals per USER_MODEL_SLOTS order
    const userFactsIdx = out.indexOf('User Facts');
    const goalsIdx = out.indexOf('Active Goals');
    expect(userFactsIdx).toBeGreaterThan(-1);
    expect(goalsIdx).toBeGreaterThan(-1);
    expect(userFactsIdx).toBeLessThan(goalsIdx);
    expect(out).toContain('## User Model');
  });

  it('skips empty slots', () => {
    store.setUserModelBlock({ slot: 'goals', content: '   ' }); // whitespace only
    store.setUserModelBlock({ slot: 'user_facts', content: 'something' });
    const out = store.renderUserModel();
    expect(out).not.toContain('Active Goals');
    expect(out).toContain('User Facts');
  });
});

describe('context-assembler integration', () => {
  it('places user model at priority -1 above identity', async () => {
    store.setUserModelBlock({ slot: 'user_facts', content: 'Nathan prefers terse responses' });
    const block = store.renderUserModel();
    const result = await assembleContext({
      totalBudget: 10000,
      userModelBlock: block,
      identityPath: null,
    });
    expect(result.text).toContain('User Facts');
    expect(result.text).toContain('Nathan prefers terse responses');
    expect(result.slotsIncluded).toContain('user-model');
  });

  it('skips slot when userModelBlock is empty', async () => {
    const result = await assembleContext({
      totalBudget: 10000,
      userModelBlock: '',
      identityPath: null,
    });
    expect(result.slotsIncluded).not.toContain('user-model');
  });
});
