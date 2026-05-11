/**
 * Tests for tool-call-dedup — the PreToolUse hook that breaks the
 * "refetch-after-compaction" loop class.
 */

import { describe, it, expect } from 'vitest';

import {
  buildDedupHook,
  hashToolInput,
} from '../src/agent/tool-call-dedup.js';

const FAKE_SIGNAL = { signal: new AbortController().signal };

function makeEvt(toolName: string, input: unknown, useId = 'tu_1') {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: input,
    tool_use_id: useId,
    session_id: 'sess',
  };
}

describe('hashToolInput', () => {
  it('returns the same hash for objects with reordered keys', () => {
    const a = hashToolInput({ limit: 20, folder: 'inbox' });
    const b = hashToolInput({ folder: 'inbox', limit: 20 });
    expect(a).toBe(b);
  });

  it('returns different hashes for different inputs', () => {
    expect(hashToolInput({ limit: 20 })).not.toBe(hashToolInput({ limit: 50 }));
    expect(hashToolInput('a')).not.toBe(hashToolInput('b'));
  });

  it('handles primitives, arrays, and null', () => {
    expect(typeof hashToolInput(null)).toBe('string');
    expect(typeof hashToolInput([1, 2, 3])).toBe('string');
    expect(typeof hashToolInput('hello')).toBe('string');
  });
});

describe('buildDedupHook', () => {
  it('allows the first call through (no warning, no block)', async () => {
    const { hooks, stats } = buildDedupHook({ runId: 'r1' });
    const cb = hooks.PreToolUse![0].hooks[0];
    const result = await cb(makeEvt('mcp__imessage__read', { limit: 20 }), 'tu_1', FAKE_SIGNAL);
    expect((result as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();
    expect(stats.inspected).toBe(1);
    expect(stats.warned).toBe(0);
    expect(stats.blocked).toBe(0);
  });

  it('warns on the second identical call (lets it through with hint)', async () => {
    const { hooks, stats } = buildDedupHook({ runId: 'r2' });
    const cb = hooks.PreToolUse![0].hooks[0];
    await cb(makeEvt('imessage_read', { limit: 20 }), 'tu_a', FAKE_SIGNAL);
    const second = await cb(makeEvt('imessage_read', { limit: 20 }), 'tu_b', FAKE_SIGNAL) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext?: string; permissionDecision?: string };
    };
    expect(stats.warned).toBe(1);
    expect(stats.blocked).toBe(0);
    expect(second.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(second.hookSpecificOutput?.additionalContext).toContain('already called');
    // Soft warn must NOT include a deny — the call must still execute
    expect(second.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('hard-blocks the third identical call within the TTL', async () => {
    const { hooks, stats } = buildDedupHook({ runId: 'r3' });
    const cb = hooks.PreToolUse![0].hooks[0];
    await cb(makeEvt('outlook_inbox', { top: 50 }), 'tu_x', FAKE_SIGNAL);
    await cb(makeEvt('outlook_inbox', { top: 50 }), 'tu_y', FAKE_SIGNAL);
    const third = await cb(makeEvt('outlook_inbox', { top: 50 }), 'tu_z', FAKE_SIGNAL) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(stats.blocked).toBe(1);
    expect(third.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(third.hookSpecificOutput?.permissionDecisionReason).toContain('outlook_inbox');
    expect(third.hookSpecificOutput?.permissionDecisionReason).toContain('STOP');
  });

  it('treats different inputs to the same tool as separate calls', async () => {
    const { hooks, stats } = buildDedupHook({ runId: 'r4' });
    const cb = hooks.PreToolUse![0].hooks[0];
    await cb(makeEvt('search', { q: 'cats' }), 'tu_1', FAKE_SIGNAL);
    await cb(makeEvt('search', { q: 'dogs' }), 'tu_2', FAKE_SIGNAL);
    await cb(makeEvt('search', { q: 'birds' }), 'tu_3', FAKE_SIGNAL);
    expect(stats.warned).toBe(0);
    expect(stats.blocked).toBe(0);
    expect(stats.inspected).toBe(3);
  });

  it('treats different tools with same input as separate calls', async () => {
    const { hooks, stats } = buildDedupHook({ runId: 'r5' });
    const cb = hooks.PreToolUse![0].hooks[0];
    await cb(makeEvt('imessage_read', { limit: 20 }), 'tu_1', FAKE_SIGNAL);
    await cb(makeEvt('outlook_inbox', { limit: 20 }), 'tu_2', FAKE_SIGNAL);
    expect(stats.warned).toBe(0);
    expect(stats.blocked).toBe(0);
  });

  it('expires cache entries past TTL', async () => {
    // Use a tiny TTL so the third call falls outside the window
    const { hooks, stats } = buildDedupHook({ runId: 'r6', ttlMs: 10 });
    const cb = hooks.PreToolUse![0].hooks[0];
    await cb(makeEvt('tool_x', { a: 1 }), 'tu_1', FAKE_SIGNAL);
    await cb(makeEvt('tool_x', { a: 1 }), 'tu_2', FAKE_SIGNAL);
    expect(stats.warned).toBe(1);
    // Wait past TTL
    await new Promise(r => setTimeout(r, 30));
    const fresh = await cb(makeEvt('tool_x', { a: 1 }), 'tu_3', FAKE_SIGNAL);
    expect((fresh as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();
    expect(stats.warned).toBe(1); // still 1; the post-TTL call started fresh
    expect(stats.blocked).toBe(0);
  });

  it('respects custom soft/hard thresholds', async () => {
    const { hooks, stats } = buildDedupHook({
      runId: 'r7',
      softWarnAt: 3,
      hardBlockAt: 5,
    });
    const cb = hooks.PreToolUse![0].hooks[0];
    // Calls 1 + 2 — under soft threshold
    await cb(makeEvt('t', { x: 1 }), 'tu_1', FAKE_SIGNAL);
    await cb(makeEvt('t', { x: 1 }), 'tu_2', FAKE_SIGNAL);
    expect(stats.warned).toBe(0);
    // Call 3 — soft warn
    await cb(makeEvt('t', { x: 1 }), 'tu_3', FAKE_SIGNAL);
    expect(stats.warned).toBe(1);
    // Call 4 — still soft warn (under hard)
    await cb(makeEvt('t', { x: 1 }), 'tu_4', FAKE_SIGNAL);
    expect(stats.warned).toBe(2);
    expect(stats.blocked).toBe(0);
    // Call 5 — hard block
    await cb(makeEvt('t', { x: 1 }), 'tu_5', FAKE_SIGNAL);
    expect(stats.blocked).toBe(1);
  });

  it('fires onDecision for every inspection', async () => {
    const decisions: string[] = [];
    const { hooks } = buildDedupHook({
      runId: 'r8',
      onDecision: (info) => decisions.push(info.decision),
    });
    const cb = hooks.PreToolUse![0].hooks[0];
    await cb(makeEvt('t', { x: 1 }), 'tu_1', FAKE_SIGNAL);
    await cb(makeEvt('t', { x: 1 }), 'tu_2', FAKE_SIGNAL);
    await cb(makeEvt('t', { x: 1 }), 'tu_3', FAKE_SIGNAL);
    expect(decisions).toEqual(['allow', 'warn', 'block']);
  });
});

describe('buildDedupHook — refetch-loop scenario (regression)', () => {
  it('blocks the imessage-triage 4×-same-call loop from 2026-05-11', async () => {
    // Reproduces the actual failure: 4 identical calls to
    // get_unread_imessages({limit:20}) within ~115 seconds.
    const { hooks, stats } = buildDedupHook({ runId: 'regression-imsg' });
    const cb = hooks.PreToolUse![0].hooks[0];

    const call = (id: string) => cb(
      makeEvt('mcp__imessage__get_unread_imessages', { limit: 20 }),
      id,
      FAKE_SIGNAL,
    );

    const r1 = await call('toolu_01PWA');
    const r2 = await call('toolu_01LRM');
    const r3 = await call('toolu_01XR1');
    const r4 = await call('toolu_01KYN');

    // 1st call: allowed
    expect((r1 as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();
    // 2nd call: soft warn — model gets a hint but call goes through
    expect((r2 as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext).toContain('already called');
    // 3rd + 4th: hard blocked — loop broken before SDK can thrash
    const r3Out = (r3 as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    const r4Out = (r4 as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    expect(r3Out?.permissionDecision).toBe('deny');
    expect(r4Out?.permissionDecision).toBe('deny');

    expect(stats.warned).toBe(1);
    expect(stats.blocked).toBe(2);
    expect(stats.inspected).toBe(4);
  });
});
