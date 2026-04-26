import { describe, expect, it } from 'vitest';
import {
  checkTurnLimitHits,
  checkTimeoutHits,
  checkReflectionQuality,
} from '../src/agent/execution-advisor.js';
import type { CronJobDefinition, CronRunEntry, ExecutionAdvice } from '../src/types.js';

function emptyAdvice(): ExecutionAdvice {
  return {
    adjustedMaxTurns: null,
    adjustedModel: null,
    adjustedTimeoutMs: null,
    promptEnrichment: '',
    shouldEscalate: false,
    shouldSkip: false,
  };
}

function maxTurnsRun(jobName: string): CronRunEntry {
  return {
    jobName,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'error',
    durationMs: 30_000,
    error: 'Reached maximum number of turns (8)',
    terminalReason: 'max_turns',
    attempt: 1,
  };
}

function timeoutRun(jobName: string): CronRunEntry {
  return {
    jobName,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'error',
    durationMs: 600_000, // exceeds 95% of 600s default timeout
    error: 'Timed out',
    attempt: 1,
  };
}

function unleashedJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    name: 'market-leader-followup',
    schedule: '30 8 * * *',
    prompt: '',
    enabled: true,
    tier: 2,
    mode: 'unleashed',
    maxHours: 1,
    ...overrides,
  };
}

function standardJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    name: 'audit-inbox-check',
    schedule: '0 */2 * * *',
    prompt: '',
    enabled: true,
    tier: 2,
    mode: 'standard',
    ...overrides,
  };
}

describe('checkTurnLimitHits — unleashed mode guard', () => {
  it('does NOT bump maxTurns for unleashed jobs hitting max_turns repeatedly', () => {
    // Regression: today's bug. market-leader-followup is unleashed,
    // its turn budget is UNLEASHED_PHASE_TURNS (75) per phase, not job.maxTurns.
    // The advisor was clamping to ceil(5 * 1.5) = 8 and breaking every run.
    const job = unleashedJob();
    const runs = [maxTurnsRun(job.name), maxTurnsRun(job.name), maxTurnsRun(job.name)];
    const advice = emptyAdvice();

    checkTurnLimitHits(runs, job, advice);

    expect(advice.adjustedMaxTurns).toBeNull();
    expect(advice.promptEnrichment).toBe('');
  });

  it('still bumps maxTurns for standard-mode jobs hitting max_turns', () => {
    const job = standardJob({ maxTurns: 10 });
    const runs = [maxTurnsRun(job.name), maxTurnsRun(job.name)];
    const advice = emptyAdvice();

    checkTurnLimitHits(runs, job, advice);

    expect(advice.adjustedMaxTurns).toBeGreaterThan(10);
  });
});

describe('checkTimeoutHits — unleashed mode guard', () => {
  it('does NOT adjust timeout for unleashed jobs', () => {
    const job = unleashedJob();
    const runs = [timeoutRun(job.name), timeoutRun(job.name), timeoutRun(job.name)];
    const advice = emptyAdvice();

    checkTimeoutHits(runs, job, advice);

    expect(advice.adjustedTimeoutMs).toBeNull();
  });

  it('still adjusts timeout for standard-mode jobs', () => {
    const job = standardJob();
    const runs = [timeoutRun(job.name), timeoutRun(job.name)];
    const advice = emptyAdvice();

    checkTimeoutHits(runs, job, advice);

    expect(advice.adjustedTimeoutMs).toBeGreaterThan(0);
  });
});

describe('checkReflectionQuality — unleashed mode guard', () => {
  it('does NOT enrich prompts for unleashed jobs based on reflection quality', () => {
    const job = unleashedJob();
    const reflections = [
      { jobName: job.name, timestamp: '', existence: false, substance: false, actionable: false, communication: false, criteriaMet: false, quality: 1, gap: '', commNote: '' },
      { jobName: job.name, timestamp: '', existence: false, substance: false, actionable: false, communication: false, criteriaMet: false, quality: 1, gap: '', commNote: '' },
      { jobName: job.name, timestamp: '', existence: false, substance: false, actionable: false, communication: false, criteriaMet: false, quality: 1, gap: '', commNote: '' },
    ];
    const advice = emptyAdvice();

    checkReflectionQuality(reflections as any, job, advice);

    expect(advice.promptEnrichment).toBe('');
  });
});
