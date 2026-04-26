import { describe, expect, it } from 'vitest';
import { applyRule, applyRules, evaluateWhen, applyThen } from '../src/agent/advisor-rules/engine.js';
import type { AdvisorRule, RuleContext } from '../src/agent/advisor-rules/types.js';
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

function maxTurnsRun(name: string): CronRunEntry {
  return {
    jobName: name,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'error',
    durationMs: 30_000,
    error: 'max turns',
    terminalReason: 'max_turns',
    attempt: 1,
  };
}

function okRun(name: string): CronRunEntry {
  return {
    jobName: name,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'ok',
    durationMs: 10_000,
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
    nowMs: Date.now(),
    tierMaxTurns: { 1: 15, 2: 50 },
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 1_200_000,
    defaultMaxTurns: 5,
    ...overrides,
  };
}

// ── Predicates ───────────────────────────────────────────────────────

describe('evaluateWhen', () => {
  it('recentTerminalReason matches when window has enough hits', () => {
    const ctx = makeContext({
      recentRuns: [maxTurnsRun('x'), maxTurnsRun('x'), okRun('x')],
    });
    expect(evaluateWhen({ kind: 'recentTerminalReason', reason: 'max_turns', window: 5, atLeast: 2 }, ctx)).toBe(true);
    expect(evaluateWhen({ kind: 'recentTerminalReason', reason: 'max_turns', window: 5, atLeast: 3 }, ctx)).toBe(false);
  });

  it('consecutiveErrorsAtLeast threshold', () => {
    const ctx = makeContext({ consecutiveErrors: 5 });
    expect(evaluateWhen({ kind: 'consecutiveErrorsAtLeast', count: 5 }, ctx)).toBe(true);
    expect(evaluateWhen({ kind: 'consecutiveErrorsAtLeast', count: 6 }, ctx)).toBe(false);
  });

  it('lastRunWithinMs returns false when no runs', () => {
    const ctx = makeContext({ recentRuns: [] });
    expect(evaluateWhen({ kind: 'lastRunWithinMs', ms: 60_000 }, ctx)).toBe(false);
  });

  it('lastRunWithinMs returns true for fresh run', () => {
    const recent = okRun('x');
    recent.finishedAt = new Date(Date.now() - 1000).toISOString();
    const ctx = makeContext({ recentRuns: [recent], nowMs: Date.now() });
    expect(evaluateWhen({ kind: 'lastRunWithinMs', ms: 60_000 }, ctx)).toBe(true);
  });

  it('lastRunWithinMs returns false when run is older than window', () => {
    const old = okRun('x');
    old.finishedAt = new Date(Date.now() - 120_000).toISOString();
    const ctx = makeContext({ recentRuns: [old], nowMs: Date.now() });
    expect(evaluateWhen({ kind: 'lastRunWithinMs', ms: 60_000 }, ctx)).toBe(false);
  });

  it('noRecentRuns', () => {
    expect(evaluateWhen({ kind: 'noRecentRuns' }, makeContext({ recentRuns: [] }))).toBe(true);
    expect(evaluateWhen({ kind: 'noRecentRuns' }, makeContext({ recentRuns: [okRun('x')] }))).toBe(false);
  });

  it('avgReflectionQualityBelow respects minSamples', () => {
    const lowQuality = [{ quality: 1 }, { quality: 1 }];
    const ctx = makeContext({ reflections: lowQuality });
    expect(evaluateWhen({ kind: 'avgReflectionQualityBelow', window: 5, threshold: 3, minSamples: 3 }, ctx)).toBe(false);
    expect(evaluateWhen({ kind: 'avgReflectionQualityBelow', window: 5, threshold: 3, minSamples: 2 }, ctx)).toBe(true);
  });

  it('modelContains and effectiveModelContains', () => {
    const ctx = makeContext({ job: makeJob({ model: 'claude-haiku-4-5' }) });
    expect(evaluateWhen({ kind: 'modelContains', substring: 'haiku' }, ctx)).toBe(true);
    expect(evaluateWhen({ kind: 'modelContains', substring: 'sonnet' }, ctx)).toBe(false);

    const ctx2 = makeContext({ job: makeJob({ model: 'claude-haiku-4-5' }), advice: { ...emptyAdvice(), adjustedModel: 'sonnet' } });
    expect(evaluateWhen({ kind: 'effectiveModelContains', substring: 'sonnet' }, ctx2)).toBe(true);
  });

  it('interventionStatBelow ignores null stats', () => {
    const ctx = makeContext({ interventionStats: { modelUpgradeSuccessRate: null, turnAdjustSuccessRate: null, enrichmentSuccessRate: null, sampleSize: 0 } });
    expect(evaluateWhen({ kind: 'interventionStatBelow', stat: 'turnAdjustSuccessRate', threshold: 0.2 }, ctx)).toBe(false);
  });

  it('interventionStatBelow fires when below threshold', () => {
    const ctx = makeContext({ interventionStats: { modelUpgradeSuccessRate: null, turnAdjustSuccessRate: 0.1, enrichmentSuccessRate: null, sampleSize: 5 } });
    expect(evaluateWhen({ kind: 'interventionStatBelow', stat: 'turnAdjustSuccessRate', threshold: 0.2 }, ctx)).toBe(true);
  });
});

// ── Actions ──────────────────────────────────────────────────────────

describe('applyThen', () => {
  it('bumpMaxTurns respects tier cap', () => {
    const ctx = makeContext({ job: makeJob({ tier: 1, maxTurns: 12 }) });
    applyThen({ kind: 'bumpMaxTurns', multiplier: 1.5 }, ctx);
    // ceil(12*1.5)=18, capped to tier 1 = 15
    expect(ctx.advice.adjustedMaxTurns).toBe(15);
  });

  it('bumpMaxTurns uses defaultMaxTurns when job.maxTurns is undefined', () => {
    const ctx = makeContext({ job: makeJob({ tier: 2 }), defaultMaxTurns: 5 });
    applyThen({ kind: 'bumpMaxTurns', multiplier: 1.5 }, ctx);
    // ceil(5*1.5)=8, under tier-2 cap of 50
    expect(ctx.advice.adjustedMaxTurns).toBe(8);
  });

  it('appendPromptEnrichment concatenates', () => {
    const ctx = makeContext();
    applyThen({ kind: 'appendPromptEnrichment', text: 'A' }, ctx);
    applyThen({ kind: 'appendPromptEnrichment', text: 'B' }, ctx);
    expect(ctx.advice.promptEnrichment).toBe('AB');
  });

  it('clearAdviceField on adjustedMaxTurns', () => {
    const ctx = makeContext({ advice: { ...emptyAdvice(), adjustedMaxTurns: 10 } });
    applyThen({ kind: 'clearAdviceField', field: 'adjustedMaxTurns' }, ctx);
    expect(ctx.advice.adjustedMaxTurns).toBeNull();
  });

  it('skipWithReason renders template', () => {
    const ctx = makeContext({ consecutiveErrors: 7 });
    applyThen({ kind: 'skipWithReason', reason: 'fallback', reasonTemplate: '{{ consecutiveErrors }} errs' }, ctx);
    expect(ctx.advice.shouldSkip).toBe(true);
    expect(ctx.advice.skipReason).toBe('7 errs');
  });
});

// ── applyRule integration ────────────────────────────────────────────

describe('applyRule scoping & flow', () => {
  it('scopes by jobMode = unleashed', () => {
    const rule: AdvisorRule = {
      schemaVersion: 1, id: 'r', description: '', priority: 1,
      appliesTo: { jobMode: 'standard' },
      when: [{ kind: 'consecutiveErrorsAtLeast', count: 0 }],
      then: [{ kind: 'skipWithReason', reason: 'x' }],
    };
    const ctx = makeContext({ job: makeJob({ mode: 'unleashed' }), consecutiveErrors: 5 });
    const trace = applyRule(rule, ctx);
    expect(trace.fired).toBe(false);
    expect(ctx.advice.shouldSkip).toBe(false);
  });

  it('skipIf prevents firing', () => {
    const rule: AdvisorRule = {
      schemaVersion: 1, id: 'r', description: '', priority: 1,
      skipIf: [{ kind: 'recentTerminalReason', reason: 'prompt_too_long', window: 5, atLeast: 1 }],
      when: [{ kind: 'recentTerminalReason', reason: 'max_turns', window: 5, atLeast: 1 }],
      then: [{ kind: 'bumpMaxTurns' }],
    };
    const promptTooLongRun: CronRunEntry = { ...maxTurnsRun('x'), terminalReason: 'prompt_too_long' };
    const ctx = makeContext({ recentRuns: [maxTurnsRun('x'), promptTooLongRun] });
    const trace = applyRule(rule, ctx);
    expect(trace.fired).toBe(false);
    expect(trace.skippedBy).toContain('skipIf');
  });

  it('stopOnFire halts subsequent rules', () => {
    const r1: AdvisorRule = {
      schemaVersion: 1, id: 'first', description: '', priority: 1,
      when: [{ kind: 'consecutiveErrorsAtLeast', count: 5 }],
      then: [{ kind: 'skipWithReason', reason: 'breaker' }],
      stopOnFire: true,
    };
    const r2: AdvisorRule = {
      schemaVersion: 1, id: 'second', description: '', priority: 2,
      when: [{ kind: 'consecutiveErrorsAtLeast', count: 0 }],
      then: [{ kind: 'setModel', model: 'sonnet' }],
    };
    const ctx = makeContext({ consecutiveErrors: 5 });
    const { traces } = applyRules([r1, r2], ctx);
    expect(traces.find(t => t.ruleId === 'first')?.fired).toBe(true);
    expect(traces.find(t => t.ruleId === 'second')).toBeUndefined();
    expect(ctx.advice.adjustedModel).toBeNull();
  });
});
