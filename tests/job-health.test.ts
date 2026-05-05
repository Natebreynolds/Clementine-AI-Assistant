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
  it('treats rapid_refill_breaker as context overflow even when raw status is ok', () => {
    const entry = run({ terminalReason: 'rapid_refill_breaker', outputPreview: 'Task aborted.' });
    const health = classifyRunHealth(entry);
    expect(health.status).toBe('context_overflow');
    expect(health.requiresApproval).toBe(true);
    expect(isRunHealthFailure(entry)).toBe(true);
  });

  it('treats prompt-too-long text as a failure even when raw status is ok', () => {
    const entry = run({ outputPreview: 'Prompt is too long' });
    const health = classifyRunHealth(entry);
    expect(health.status).toBe('prompt_too_large');
    expect(health.recommendedAction).toMatch(/Reduce injected context/);
    expect(isRunHealthFailure(entry)).toBe(true);
  });

  it('treats unleashed phase abort text as a failure even when raw status is ok', () => {
    const entry = run({
      outputPreview: 'Task "market-leader-followup" aborted after 3 consecutive phase errors.',
    });
    const health = classifyRunHealth(entry);
    expect(health.status).toBe('failed');
    expect(isRunHealthFailure(entry)).toBe(true);
  });

  it('classifies monthly usage limits as account blockers, not job fixes', () => {
    const entry = run({
      status: 'error',
      error: "Claude Code returned an error result: You've hit your org's monthly usage limit",
    });
    const health = classifyRunHealth(entry);
    expect(health.status).toBe('usage_blocked');
    expect(health.recommendedAction).toContain('usage or billing limit');
    expect(health.requiresApproval).toBe(false);
  });

  it('does not count credit-block skip entries as job health failures', () => {
    const entry = run({
      status: 'skipped',
      attempt: 0,
      durationMs: 0,
      outputPreview: 'Claude account usage or credit limit is active. Background jobs are paused until 2026-05-02T20:00:00.000Z.',
    });
    expect(classifyRunHealth(entry).status).toBe('usage_blocked');
    expect(isRunHealthFailure(entry)).toBe(false);
  });

  it('leaves ordinary ok runs healthy', () => {
    const entry = run({ outputPreview: 'No new replies found.' });
    expect(classifyRunHealth(entry).status).toBe('healthy');
    expect(isRunHealthFailure(entry)).toBe(false);
  });
});
