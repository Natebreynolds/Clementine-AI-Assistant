import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRouteCache, classifyRoute } from '../src/agent/route-classifier.js';
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
