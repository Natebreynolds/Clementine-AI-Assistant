import { describe, expect, it } from 'vitest';
import { analyzeLongTaskPreflight, formatLongTaskPromptPrefix } from '../src/gateway/long-task-preflight.js';
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
