import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRouteCache, classifyRoute, isAskingAboutAgent } from '../src/agent/route-classifier.js';
import type { AgentProfile } from '../src/types.js';
import type { Gateway } from '../src/gateway/router.js';

function makeAgent(slug: string, name: string, description = ''): AgentProfile {
  return { slug, name, tier: 1, description, systemPromptBody: '', status: 'active' };
}

describe('route classifier — LRU cache', () => {
  beforeEach(() => {
    _resetRouteCache();
  });

  afterEach(() => {
    _resetRouteCache();
  });

  it('returns cached decision for identical messages without re-invoking the classifier', async () => {
    const handleCronJob = vi.fn(async () => JSON.stringify({ targetAgent: 'ross-the-sdr', confidence: 0.9, reasoning: 'Outbound SDR work.' }));
    const gateway = { handleCronJob } as unknown as Gateway;
    const agents = [makeAgent('ross-the-sdr', 'Ross', 'Outbound SDR for Acme')];

    // Use a long message so we bypass the short-message and question fast paths
    const msg = 'Help me draft a follow-up sequence for the Acme decision-maker who went silent after the demo last week.';

    const first = await classifyRoute(msg, agents, gateway);
    const second = await classifyRoute(msg, agents, gateway);
    const third = await classifyRoute(msg, agents, gateway);

    expect(first?.targetAgent).toBe('ross-the-sdr');
    expect(second?.targetAgent).toBe('ross-the-sdr');
    expect(third?.targetAgent).toBe('ross-the-sdr');
    // Only ONE LLM call across three identical messages
    expect(handleCronJob).toHaveBeenCalledTimes(1);
  });

  it('treats different rosters as separate cache entries', async () => {
    const handleCronJob = vi.fn(async () => JSON.stringify({ targetAgent: 'ross-the-sdr', confidence: 0.9, reasoning: 'SDR work.' }));
    const gateway = { handleCronJob } as unknown as Gateway;
    const msg = 'Help me draft a follow-up sequence for the Acme decision-maker who went silent after the demo.';

    const rosterA = [makeAgent('ross-the-sdr', 'Ross', 'Outbound SDR')];
    const rosterB = [
      makeAgent('ross-the-sdr', 'Ross', 'Outbound SDR'),
      makeAgent('sasha-the-cmo', 'Sasha', 'CMO'),
    ];

    await classifyRoute(msg, rosterA, gateway);
    await classifyRoute(msg, rosterB, gateway);
    // Different rosters → different cache keys → 2 LLM calls
    expect(handleCronJob).toHaveBeenCalledTimes(2);
  });

  it('does not cache classifier failures (next call retries)', async () => {
    const handleCronJob = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(JSON.stringify({ targetAgent: 'ross-the-sdr', confidence: 0.9, reasoning: 'SDR work.' }));
    const gateway = { handleCronJob: handleCronJob as unknown as Gateway['handleCronJob'] } as unknown as Gateway;
    const agents = [makeAgent('ross-the-sdr', 'Ross', 'SDR')];
    const msg = 'Help me draft a follow-up sequence for the Acme decision-maker who went silent.';

    const first = await classifyRoute(msg, agents, gateway);
    expect(first).toBeNull(); // failure returned null
    const second = await classifyRoute(msg, agents, gateway);
    expect(second?.targetAgent).toBe('ross-the-sdr');
    // Both calls fired the LLM — failure wasn't cached
    expect(handleCronJob).toHaveBeenCalledTimes(2);
  });

  it('does not auto-route when the user is asking ABOUT an agent', async () => {
    const handleCronJob = vi.fn(async () => JSON.stringify({ targetAgent: 'clementine', confidence: 0.9, reasoning: 'meta question' }));
    const gateway = { handleCronJob } as unknown as Gateway;
    const agents = [makeAgent('ross-the-sdr', 'Ross', 'Outbound SDR')];

    // Long enough to bypass short-message; opens with "got it" so question-opener
    // also doesn't catch it. Pre-fix this routed to ross at confidence 1.0 because
    // the bare word "ross" matched the explicit-mention regex.
    const msg = 'got it how is ross crons looking are they fixed today';
    const decision = await classifyRoute(msg, agents, gateway);
    // Should NOT be the auto-route to ross — either falls through to the LLM
    // (which routes back to clementine) or returns clementine outright.
    expect(decision?.targetAgent).not.toBe('ross-the-sdr');
  });

  it('still routes when the user addresses the agent vocatively', async () => {
    const handleCronJob = vi.fn();
    const gateway = { handleCronJob } as unknown as Gateway;
    const agents = [makeAgent('ross-the-sdr', 'Ross', 'Outbound SDR')];

    const msg = 'ross please send a follow-up to the Acme decision-maker about the demo';
    const decision = await classifyRoute(msg, agents, gateway);
    expect(decision?.targetAgent).toBe('ross-the-sdr');
    expect(decision?.confidence).toBe(1.0);
    expect(handleCronJob).not.toHaveBeenCalled(); // fast-path, no LLM
  });

  it('isAskingAboutAgent — recognizes meta shapes, not vocatives', () => {
    // Asking-about (true)
    expect(isAskingAboutAgent('how is ross crons looking', 'ross', 'ross-the-sdr')).toBe(true);
    expect(isAskingAboutAgent("ross's tasks for today", 'ross', 'ross-the-sdr')).toBe(true);
    expect(isAskingAboutAgent('did ross handle the followups', 'ross', 'ross-the-sdr')).toBe(true);
    expect(isAskingAboutAgent('any update on ross from yesterday', 'ross', 'ross-the-sdr')).toBe(true);
    expect(isAskingAboutAgent('what about ross', 'ross', 'ross-the-sdr')).toBe(true);
    // Vocative (false)
    expect(isAskingAboutAgent('ross please draft a followup', 'ross', 'ross-the-sdr')).toBe(false);
    expect(isAskingAboutAgent('hey ross can you check Acme', 'ross', 'ross-the-sdr')).toBe(false);
    expect(isAskingAboutAgent('ross, are you done with that', 'ross', 'ross-the-sdr')).toBe(false);
  });

  it('normalizes whitespace so trailing-newline variants share the cache', async () => {
    const handleCronJob = vi.fn(async () => JSON.stringify({ targetAgent: 'ross-the-sdr', confidence: 0.9, reasoning: 'SDR.' }));
    const gateway = { handleCronJob } as unknown as Gateway;
    const agents = [makeAgent('ross-the-sdr', 'Ross', 'SDR')];

    const a = 'Help me draft a follow-up sequence for the Acme decision-maker who went silent.';
    const b = 'Help me draft a follow-up sequence for the Acme decision-maker who went silent.\n\n';
    const c = 'Help me   draft   a follow-up sequence for the Acme decision-maker who went silent.';

    await classifyRoute(a, agents, gateway);
    await classifyRoute(b, agents, gateway);
    await classifyRoute(c, agents, gateway);
    // All three normalize to the same key → 1 LLM call
    expect(handleCronJob).toHaveBeenCalledTimes(1);
  });
});
