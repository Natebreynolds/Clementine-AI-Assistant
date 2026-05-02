import { describe, expect, it } from 'vitest';
import { diagnoseKnownFailurePattern } from '../src/gateway/failure-diagnostics.js';
import type { BrokenJob } from '../src/gateway/failure-monitor.js';

function brokenJob(overrides: Partial<BrokenJob>): BrokenJob {
  return {
    jobName: 'market-leader-followup',
    errorCount48h: 1,
    totalRuns48h: 1,
    lastErrorAt: '2026-05-02T15:46:01.354Z',
    lastErrors: [],
    circuitBreakerEngagedAt: null,
    lastAdvisorOpinion: null,
    ...overrides,
  };
}

describe('known failure diagnostics', () => {
  it('diagnoses context overflow without requiring an LLM diagnostic job', () => {
    const diagnosis = diagnoseKnownFailurePattern(
      brokenJob({}),
      '  - name: market-leader-followup\n    mode: unleashed',
      '2026-05-02T15:30:00.655Z ok (961s) terminal=rapid_refill_breaker preview="Autocompact is thrashing"',
    );

    expect(diagnosis?.confidence).toBe('high');
    expect(diagnosis?.rootCause).toContain('context window');
    expect(diagnosis?.proposedFix.type).toBe('prompt_override');
    expect(diagnosis?.proposedFix.details).toContain('cap batches at 20');
    expect(diagnosis?.proposedFix.autoApply).toMatchObject({
      kind: 'prompt-override',
      scope: 'job',
      scopeKey: 'market-leader-followup',
    });
  });

  it('does not propose a prompt override for pseudo-jobs without a cron definition', () => {
    const diagnosis = diagnoseKnownFailurePattern(
      brokenJob({ jobName: 'insight-check' }),
      null,
      '2026-05-02T13:02:00.000Z error (1s) error="Prompt is too long"',
    );

    expect(diagnosis?.proposedFix.type).toBe('prompt_change');
    expect(diagnosis?.proposedFix.autoApply).toBeUndefined();
  });
});
