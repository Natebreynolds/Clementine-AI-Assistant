import { describe, expect, it } from 'vitest';
import { classifyRunHealth, isRunHealthFailure } from '../src/gateway/job-health.js';
import type { CronRunEntry } from '../src/types.js';

function run(overrides: Partial<CronRunEntry>): CronRunEntry {
  return {
    jobName: 'market-leader-followup',
    startedAt: '2026-05-02T10:00:00.000Z',
    finishedAt: '2026-05-02T10:01:00.000Z',
    status: 'ok',
    durationMs: 60_000,
    attempt: 1,
    ...overrides,
  };
}

describe('job health classification', () => {
  it('treats ok rapid_refill_breaker runs as context-overflow failures', () => {
    const entry = run({ status: 'ok', terminalReason: 'rapid_refill_breaker' });
    const health = classifyRunHealth(entry);

    expect(health.status).toBe('context_overflow');
    expect(health.requiresApproval).toBe(true);
    expect(isRunHealthFailure(entry)).toBe(true);
  });

  it('classifies prompt-too-long as prompt_too_large', () => {
    const entry = run({ status: 'error', terminalReason: 'prompt_too_long', error: 'Prompt is too long' });
    const health = classifyRunHealth(entry);

    expect(health.status).toBe('prompt_too_large');
    expect(health.recommendedAction).toMatch(/Reduce injected context/);
  });

  it('leaves ordinary ok runs healthy', () => {
    const entry = run({ status: 'ok', outputPreview: 'No new replies found.' });

    expect(classifyRunHealth(entry).status).toBe('healthy');
    expect(isRunHealthFailure(entry)).toBe(false);
  });
});
