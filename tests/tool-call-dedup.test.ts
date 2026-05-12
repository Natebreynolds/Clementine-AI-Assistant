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

describe('buildDedupHook — burst-window discrimination (1.18.184)', () => {
  // The 1.18.184 refinement: hard-block fires ONLY when ≥ hardBlockAt
  // identical calls happen within HARD_BLOCK_BURST_WINDOW_MS (8s) of
  // the first call. Legitimate polling ("wait 30s, check again") with
  // identical args spread out over the TTL should warn (so the model
  // notices) but NOT block — that's user intent, not a refetch loop.
  it('does NOT hard-block identical calls spread over a long window (polling case)', async () => {
    // Use a generous ttlMs so all calls stay within the entry lifetime,
    // but the inter-call delay is longer than HARD_BLOCK_BURST_WINDOW_MS (8s).
    // We simulate the 8s+ gap by stubbing the clock — that's what the
    // burst window check uses (Date.now()-derived sinceFirstMs).
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date.now = () => fakeNow;
    try {
      const { hooks, stats } = buildDedupHook({ runId: 'poll-test' });
      const cb = hooks.PreToolUse![0].hooks[0];
      // Call 1 — first, allowed.
      fakeNow = 1_000_000;
      await cb(makeEvt('check_inbox', { folder: 'inbox' }), 'tu_1', FAKE_SIGNAL);
      // Call 2 — 10s later (>8s burst window, but within 60s TTL).
      fakeNow = 1_010_000;
      await cb(makeEvt('check_inbox', { folder: 'inbox' }), 'tu_2', FAKE_SIGNAL);
      // Call 3 — 20s after call 1. Still within TTL, still outside burst.
      fakeNow = 1_020_000;
      const r3 = await cb(makeEvt('check_inbox', { folder: 'inbox' }), 'tu_3', FAKE_SIGNAL) as {
        hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
      };
      // Critically: NO hard block. The model gets a warning hint
      // but the call goes through — polling preserved.
      expect(r3.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(stats.blocked).toBe(0);
      // Soft warnings still fire so the model knows it's repeating itself.
      expect(stats.warned).toBeGreaterThan(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date.now = realNow;
    }
  });

  it('still hard-blocks tight-burst identical calls (≤8s from first)', async () => {
    // The classic refetch-after-compact failure pattern: 3 identical
    // calls within ~2s. Burst window catches this.
    const realNow = Date.now;
    let fakeNow = 2_000_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date.now = () => fakeNow;
    try {
      const { hooks, stats } = buildDedupHook({ runId: 'burst-test' });
      const cb = hooks.PreToolUse![0].hooks[0];
      fakeNow = 2_000_000;
      await cb(makeEvt('refetch', { x: 1 }), 'tu_1', FAKE_SIGNAL);
      fakeNow = 2_000_500; // +0.5s
      await cb(makeEvt('refetch', { x: 1 }), 'tu_2', FAKE_SIGNAL);
      fakeNow = 2_001_500; // +1.5s
      const r3 = await cb(makeEvt('refetch', { x: 1 }), 'tu_3', FAKE_SIGNAL) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(r3.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(r3.hookSpecificOutput?.permissionDecisionReason).toContain('tight-burst');
      expect(stats.blocked).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date.now = realNow;
    }
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
