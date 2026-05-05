import { describe, expect, it } from 'vitest';
import { analyzeLongTaskPreflight, formatLongTaskPromptPrefix, shouldDowngradeUnleashed } from '../src/gateway/long-task-preflight.js';
import type { CronJobDefinition, CronRunEntry } from '../src/types.js';

function job(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    name: 'market-leader-followup',
    schedule: '30 8 * * *',
    prompt: 'Check new replies and summarize them.',
    enabled: true,
    tier: 2,
    mode: 'standard',
    ...overrides,
  };
}

function contextOverflowRun(): CronRunEntry {
  return {
    jobName: 'market-leader-followup',
    startedAt: '2026-05-04T08:00:00.000Z',
    finishedAt: '2026-05-04T08:20:00.000Z',
    status: 'ok',
    durationMs: 1_200_000,
    terminalReason: 'rapid_refill_breaker',
    outputPreview: 'Autocompact is thrashing.',
    attempt: 1,
  };
}

describe('long-task preflight', () => {
  it('leaves small routine cron jobs on the standard route', () => {
    const decision = analyzeLongTaskPreflight(job(), 'Check new replies and summarize them.', [], {
      claudePlan: 'max',
      oneMillionMode: 'auto',
      sonnetModel: 'claude-sonnet-4-6',
    });

    expect(decision.risk).toBe('normal');
    expect(decision.route).toBe('standard');
    expect(decision.modelOverride).toBeUndefined();
    expect(decision.modeOverride).toBeUndefined();
  });

  it('routes recent context-overflow jobs to Opus long context in auto mode', () => {
    const decision = analyzeLongTaskPreflight(
      job({
        prompt: 'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      }),
      'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      [contextOverflowRun()],
      { claudePlan: 'max', oneMillionMode: 'auto', opusModel: 'claude-opus-4-7', sonnetModel: 'claude-sonnet-4-6' },
    );

    expect(decision.risk).toBe('huge');
    expect(decision.route).toBe('opus_1m');
    expect(decision.modelOverride).toBe('claude-opus-4-7[1m]');
    expect(decision.modeOverride).toBe('unleashed');
    expect(decision.maxHoursOverride).toBe(2);
    expect(decision.requiresUserRefinement).toBe(false);
    expect(formatLongTaskPromptPrefix(decision)).toContain('Long Task Operating Mode');
  });

  it('keeps broad jobs checkpointed on Pro/unknown plans before they show context failure', () => {
    const decision = analyzeLongTaskPreflight(
      job({
        mode: 'unleashed',
        prompt: 'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      }),
      'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      [],
      { claudePlan: 'pro', oneMillionMode: 'auto', opusModel: 'claude-opus-4-7', sonnetModel: 'claude-sonnet-4-6' },
    );

    expect(decision.risk).toBe('huge');
    expect(decision.route).toBe('checkpointed');
    expect(decision.modelOverride).toBeUndefined();
    expect(decision.modeOverride).toBeUndefined();
    expect(decision.shouldSkipBeforeRun).toBe(false);
  });

  it('offers owner approval instead of constrained retry after recent context overflow on Pro/unknown plans', () => {
    const decision = analyzeLongTaskPreflight(
      job({
        prompt: 'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      }),
      'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      [contextOverflowRun()],
      { claudePlan: 'pro', oneMillionMode: 'auto', opusModel: 'claude-opus-4-7', sonnetModel: 'claude-sonnet-4-6' },
    );

    expect(decision.risk).toBe('huge');
    expect(decision.route).toBe('split_required');
    expect(decision.modelOverride).toBeUndefined();
    expect(decision.modeOverride).toBeUndefined();
    expect(decision.shouldSkipBeforeRun).toBe(true);
    expect(decision.canProceedWithApproval).toBe(true);
    expect(decision.approvalModelOverride).toBe('claude-opus-4-7[1m]');
  });

  it('continues preferring Opus long context when 1M mode is explicitly enabled', () => {
    const decision = analyzeLongTaskPreflight(
      job({
        prompt: 'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      }),
      'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      [contextOverflowRun()],
      { claudePlan: 'unknown', oneMillionMode: 'on', opusModel: 'claude-opus-4-7', sonnetModel: 'claude-sonnet-4-6' },
    );

    expect(decision.risk).toBe('huge');
    expect(decision.route).toBe('opus_1m');
    expect(decision.modelOverride).toBe('claude-opus-4-7[1m]');
    expect(decision.modeOverride).toBe('unleashed');
  });

  it('honors an explicit Sonnet 1M job model even in auto mode', () => {
    const decision = analyzeLongTaskPreflight(
      job({
        model: 'claude-sonnet-4-6[1m]',
        prompt: 'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      }),
      'Analyze all logs and the full run history, identify root cause, and fix everything end-to-end.',
      [contextOverflowRun()],
      { claudePlan: 'unknown', oneMillionMode: 'auto', sonnetModel: 'claude-sonnet-4-6' },
    );

    expect(decision.route).toBe('sonnet_1m');
    expect(decision.modelOverride).toBeUndefined();
  });

  it('uses checkpointed unleashed mode when 1M is off and the prompt is large but still runnable', () => {
    const prompt = `${'Summarize all customer records in batches. '.repeat(6000)}`;
    const decision = analyzeLongTaskPreflight(job({ prompt }), prompt, [], {
      claudePlan: 'unknown',
      oneMillionMode: 'off',
      sonnetModel: 'claude-sonnet-4-6',
    });

    expect(decision.risk).toBe('long');
    expect(decision.route).toBe('checkpointed');
    expect(decision.modelOverride).toBeUndefined();
    expect(decision.modeOverride).toBe('unleashed');
    expect(decision.shouldSkipBeforeRun).toBe(false);
  });

  it('blocks prompts that are already too large for a 200k route when 1M is off', () => {
    const prompt = 'x'.repeat(760_000);
    const decision = analyzeLongTaskPreflight(job({ prompt }), prompt, [], {
      claudePlan: 'unknown',
      oneMillionMode: 'off',
      sonnetModel: 'claude-sonnet-4-6',
    });

    expect(decision.risk).toBe('unsafe');
    expect(decision.route).toBe('split_required');
    expect(decision.requiresUserRefinement).toBe(true);
    expect(decision.canProceedWithApproval).toBe(false);
    expect(decision.shouldSkipBeforeRun).toBe(true);
  });

  it('offers a one-time Opus 1M approval path for unsafe Pro/unknown auto-mode runs', () => {
    const prompt = 'x'.repeat(760_000);
    const decision = analyzeLongTaskPreflight(job({ prompt }), prompt, [], {
      claudePlan: 'pro',
      oneMillionMode: 'auto',
      opusModel: 'claude-opus-4-7',
      sonnetModel: 'claude-sonnet-4-6',
    });

    expect(decision.risk).toBe('unsafe');
    expect(decision.route).toBe('split_required');
    expect(decision.requiresUserRefinement).toBe(true);
    expect(decision.canProceedWithApproval).toBe(true);
    expect(decision.approvalModelOverride).toBe('claude-opus-4-7[1m]');
    expect(decision.approvalReason).toContain('owner approves');
  });
});

describe('shouldDowngradeUnleashed', () => {
  function quietRun(when: string): CronRunEntry {
    return {
      jobName: 'audit-inbox-check',
      startedAt: when,
      finishedAt: when,
      status: 'ok',
      durationMs: 30_000,
      outputPreview: '__NOTHING__',
      terminalReason: 'completed',
      attempt: 1,
    };
  }

  function workRun(when: string, durationMs = 600_000): CronRunEntry {
    return {
      jobName: 'audit-inbox-check',
      startedAt: when,
      finishedAt: when,
      status: 'ok',
      durationMs,
      // Long preview — over 200 chars — to avoid triggering the quiet pattern.
      outputPreview: [
        'Posted 4 audit requests to #audit-queue with full company details and competitor lists.',
        'Marquardt Law (Las Vegas) — pre-discovery, services: SEO/PPC/Content, competitors: Sweet, Adams.',
        'Finizio Law Group (Hartford) — post-discovery, services: SEO + Local Service Ads, competitors: Tinari Law.',
        'Bromberg Insurance (Phoenix) — pre-discovery, services: Local SEO + Reviews.',
        'Hawkins Construction (Boise) — post-discovery, services: full digital + GMB.',
      ].join(' '),
      terminalReason: 'completed',
      attempt: 1,
    };
  }

  function overflowRun(when: string): CronRunEntry {
    return {
      jobName: 'audit-inbox-check',
      startedAt: when,
      finishedAt: when,
      status: 'error',
      durationMs: 700_000,
      outputPreview: '',
      terminalReason: 'rapid_refill_breaker',
      attempt: 1,
    };
  }

  it('downgrades when 60%+ of recent runs returned __NOTHING__', () => {
    const runs = [
      quietRun('2026-05-05T16:00:00.000Z'),
      quietRun('2026-05-05T14:00:00.000Z'),
      quietRun('2026-05-05T12:00:00.000Z'),
      quietRun('2026-05-05T10:00:00.000Z'),
    ];
    const decision = shouldDowngradeUnleashed(runs, Date.parse('2026-05-05T17:00:00.000Z'));
    expect(decision.downgrade).toBe(true);
    expect(decision.reason).toMatch(/^quiet_pattern_/);
  });

  it('downgrades when all runs complete fast (<60s avg, <90s max)', () => {
    const runs = [
      workRun('2026-05-05T16:00:00.000Z', 25_000),
      workRun('2026-05-05T14:00:00.000Z', 30_000),
      workRun('2026-05-05T12:00:00.000Z', 35_000),
    ];
    const decision = shouldDowngradeUnleashed(runs, Date.parse('2026-05-05T17:00:00.000Z'));
    expect(decision.downgrade).toBe(true);
    expect(decision.reason).toMatch(/^fast_completion_/);
  });

  it('refuses to downgrade when a recent run hit context overflow', () => {
    const runs = [
      quietRun('2026-05-05T16:00:00.000Z'),
      overflowRun('2026-05-05T14:00:00.000Z'),
      quietRun('2026-05-05T12:00:00.000Z'),
      quietRun('2026-05-05T10:00:00.000Z'),
    ];
    const decision = shouldDowngradeUnleashed(runs, Date.parse('2026-05-05T17:00:00.000Z'));
    expect(decision.downgrade).toBe(false);
    expect(decision.reason).toBe('recent_context_overflow_protect_unleashed');
  });

  it('keeps unleashed when output is consistently substantive', () => {
    const runs = [
      workRun('2026-05-05T16:00:00.000Z'),
      workRun('2026-05-05T14:00:00.000Z'),
      workRun('2026-05-05T12:00:00.000Z'),
      workRun('2026-05-05T10:00:00.000Z'),
    ];
    const decision = shouldDowngradeUnleashed(runs, Date.parse('2026-05-05T17:00:00.000Z'));
    expect(decision.downgrade).toBe(false);
    expect(decision.reason).toBe('workload_warrants_unleashed');
  });

  it('does not downgrade with insufficient history (less than 3 runs)', () => {
    const runs = [
      quietRun('2026-05-05T16:00:00.000Z'),
      quietRun('2026-05-05T14:00:00.000Z'),
    ];
    const decision = shouldDowngradeUnleashed(runs, Date.parse('2026-05-05T17:00:00.000Z'));
    expect(decision.downgrade).toBe(false);
    expect(decision.reason).toBe('insufficient_history');
  });

  it('ignores overflow runs older than 48h (no longer "recent")', () => {
    const runs = [
      quietRun('2026-05-08T16:00:00.000Z'),
      quietRun('2026-05-08T14:00:00.000Z'),
      quietRun('2026-05-08T12:00:00.000Z'),
      // 5 days ago — not recent.
      overflowRun('2026-05-03T08:00:00.000Z'),
    ];
    const decision = shouldDowngradeUnleashed(runs, Date.parse('2026-05-08T17:00:00.000Z'));
    expect(decision.downgrade).toBe(true);
    expect(decision.reason).toMatch(/^quiet_pattern_/);
  });
});
