import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock the config exports so the file paths used by buildChatSystemAppend
// are sandbox tmp paths, not the live vault.
vi.mock('../src/config.js', () => ({
  SOUL_FILE: '/tmp/clementine-test-soul.md',
  AGENTS_FILE: '/tmp/clementine-test-agents.md',
  MEMORY_FILE: '/tmp/clementine-test-memory.md',
  AGENTS_DIR: '/tmp/clementine-test-agents-dir',
}));

import fs from 'node:fs';
import { buildChatSystemAppend } from '../src/agent/run-agent-context.js';

beforeEach(() => {
  for (const f of [
    '/tmp/clementine-test-soul.md',
    '/tmp/clementine-test-agents.md',
    '/tmp/clementine-test-memory.md',
  ]) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
});

describe('buildChatSystemAppend — 1.18.184 behavioral posture', () => {
  it('always includes the trust + recall + persistence posture, even with no vault files', () => {
    // No SOUL.md / MEMORY.md / AGENTS.md present — the behavioral
    // directives still get appended. They are who Clementine is, not
    // optional decoration.
    const out = buildChatSystemAppend();
    expect(out).toContain('Trust posture');
    expect(out).toContain('Recall posture');
    expect(out).toContain('Persistence posture');
  });

  it('the recall directive mentions memory_search and transcript_search', () => {
    // Re-anchored from the orphan 1.18.181 directive in assistant.ts:1382.
    // Tools by name MUST appear — without them, the directive is too vague
    // for the model to act on.
    const out = buildChatSystemAppend();
    expect(out).toContain('memory_search');
    expect(out).toContain('transcript_search');
    // Phrasing in the directive: "I don't see any record of that"
    // (matches what the model would naturally say when failing to recall).
    expect(out).toContain("I don't see any record");
  });

  it('the trust posture mentions "trusted local machine" and "do not ask permission"', () => {
    const out = buildChatSystemAppend();
    expect(out).toContain('trusted local machine');
    // The user-facing promise: chat doesn't feel like Claude Code default;
    // it feels like bypass mode.
    expect(out.toLowerCase()).toContain('permission');
  });

  it('the persistence posture tells the model to run jobs to completion', () => {
    const out = buildChatSystemAppend();
    expect(out).toContain('run it to completion');
    // And tells the model NOT to trail off silently.
    expect(out.toLowerCase()).toContain('never trail off');
  });

  it('vault content (SOUL/MEMORY/AGENTS) comes BEFORE the behavioral posture', () => {
    // Order matters for the prompt cache: stable identity files first,
    // posture last so future identity edits don't invalidate the
    // posture's cache position.
    fs.writeFileSync('/tmp/clementine-test-soul.md', 'I am Clementine.');
    fs.writeFileSync('/tmp/clementine-test-memory.md', 'Remember: cats > dogs.');
    fs.writeFileSync('/tmp/clementine-test-agents.md', 'Team: Sasha, Otto.');
    const out = buildChatSystemAppend();
    const soulPos = out.indexOf('I am Clementine');
    const posturePos = out.indexOf('Trust posture');
    expect(soulPos).toBeGreaterThan(-1);
    expect(posturePos).toBeGreaterThan(soulPos);
  });

  it('returns posture-only when no profile/files exist (no empty-string regression)', () => {
    const out = buildChatSystemAppend();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('How you operate');
  });
});
