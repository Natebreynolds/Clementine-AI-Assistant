/**
 * Parity tests: build a RuleContext for a representative scenario, run it
 * through the shipped builtin rule set, and assert the resulting
 * ExecutionAdvice matches what the legacy TS path produces.
 *
 * These are the regression-proof for shadow → primary cutover (Phase 2b).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdvisorRules, _resetLoaderState } from '../src/agent/advisor-rules/loader.js';
import { applyRules } from '../src/agent/advisor-rules/engine.js';
import type { RuleContext } from '../src/agent/advisor-rules/types.js';
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

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    name: 'test-job',
    schedule: '* * * * *',
    prompt: '',
    enabled: true,
    tier: 2,
    ...overrides,
  };
}

function maxTurnsRun(): CronRunEntry {
  return {
    jobName: 'test-job',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'error',
    durationMs: 30_000,
    error: 'max turns',
    terminalReason: 'max_turns',
    attempt: 1,
  };
}

function errRun(reason?: import('../src/types.js').TerminalReason, durationMs = 30_000): CronRunEntry {
  return {
    jobName: 'test-job',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'error',
    durationMs,
    error: 'err',
    terminalReason: reason,
    attempt: 1,
  };
}

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  const job = overrides.job ?? makeJob();
  return {
    job,
    jobName: job.name,
    recentRuns: [],
    reflections: [],
    consecutiveErrors: 0,
    interventionStats: { modelUpgradeSuccessRate: null, turnAdjustSuccessRate: null, enrichmentSuccessRate: null, sampleSize: 0 },
    advice: emptyAdvice(),
    nowMs: Date.parse('2026-04-25T17:30:00Z'),
    tierMaxTurns: { 1: 15, 2: 50 },
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 1_200_000,
    defaultMaxTurns: 5,
    ...overrides,
  };
}

describe('advisor rules parity — shipped builtin set', () => {
  let baseDir: string;

  beforeEach(() => {
    _resetLoaderState();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-rules-parity-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("today's bug — unleashed job hitting max_turns gets NO maxTurns adjustment", () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ name: 'market-leader-followup', mode: 'unleashed' }),
      recentRuns: [maxTurnsRun(), maxTurnsRun(), maxTurnsRun()],
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.adjustedMaxTurns).toBeNull();
    expect(advice.shouldSkip).toBe(false);
  });

  it('standard job hitting max_turns → bumps to ceil(currentMax * 1.5) capped at tier', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ mode: 'standard', maxTurns: 10, tier: 2 }),
      recentRuns: [maxTurnsRun(), maxTurnsRun()],
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.adjustedMaxTurns).toBe(15);
  });

  it('prompt_too_long takes precedence — no turn bump, enrichment added', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ mode: 'standard' }),
      recentRuns: [errRun('prompt_too_long'), maxTurnsRun(), maxTurnsRun()],
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.adjustedMaxTurns).toBeNull();
    expect(advice.promptEnrichment).toContain('prompt length limits');
  });

  it('circuit breaker fires when 5+ consecutive errors with recent run', () => {
    const rules = loadAdvisorRules({ baseDir });
    const recent = errRun();
    recent.finishedAt = new Date(Date.parse('2026-04-25T17:25:00Z')).toISOString();
    const ctx = makeContext({
      consecutiveErrors: 6,
      recentRuns: [recent, errRun(), errRun(), errRun(), errRun(), errRun()],
    });
    const { advice, traces } = applyRules(rules, ctx);
    expect(advice.shouldSkip).toBe(true);
    expect(advice.skipReason).toContain('circuit breaker engaged');
    expect(advice.skipReason).toContain('6');
    // stopOnFire — turn-bump should not have run even though 5+ max_turns errors are present
    expect(advice.adjustedMaxTurns).toBeNull();
    // Confirm only the circuit-breaker rule fired
    const fired = traces.filter(t => t.fired).map(t => t.ruleId);
    expect(fired).toEqual(['circuit-breaker-cooldown']);
  });

  it('haiku model with model_error → upgrade to sonnet', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ mode: 'standard', model: 'claude-haiku-4-5' }),
      recentRuns: [errRun('model_error')],
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.adjustedModel).toBe('sonnet');
  });

  it('haiku with 3+ generic errors but no model_error → still upgrades to sonnet', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ mode: 'standard', model: 'claude-haiku-4-5' }),
      recentRuns: [errRun(), errRun(), errRun()],
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.adjustedModel).toBe('sonnet');
  });

  it('turn bump is suppressed when turnAdjustSuccessRate < 0.2', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ mode: 'standard', maxTurns: 10 }),
      recentRuns: [maxTurnsRun(), maxTurnsRun()],
      interventionStats: { modelUpgradeSuccessRate: null, turnAdjustSuccessRate: 0.1, enrichmentSuccessRate: null, sampleSize: 5 },
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.adjustedMaxTurns).toBeNull();
  });

  it('escalates when sonnet-tier has 3+ recent failures', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ctx = makeContext({
      job: makeJob({ mode: 'standard', model: 'claude-sonnet-4-6' }),
      recentRuns: [errRun(), errRun(), errRun()],
      // need at least 3 consecutive errors from prior, but not enough for circuit breaker
      consecutiveErrors: 3,
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.shouldEscalate).toBe(true);
    expect(advice.escalationReason).toContain('sonnet');
  });

  it('low-confidence-completion fires when 2+ ok runs but 2+ low quality reflections', () => {
    const rules = loadAdvisorRules({ baseDir });
    const ok = (): CronRunEntry => ({
      jobName: 'test-job', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      status: 'ok', durationMs: 5_000, attempt: 1,
    });
    const ctx = makeContext({
      recentRuns: [ok(), ok(), ok()],
      reflections: [{ quality: 1 }, { quality: 2 }, { quality: 5 }],
    });
    const { advice } = applyRules(rules, ctx);
    expect(advice.shouldEscalate).toBe(true);
    expect(advice.escalationReason).toContain('quality is consistently low');
  });
});
