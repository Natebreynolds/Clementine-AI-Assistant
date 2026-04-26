/**
 * Advisor Rule Engine — evaluation.
 *
 * Pure functions: `evaluateWhen(condition, ctx)` and `applyThen(action, ctx)`.
 * Both operate on a RuleContext that holds the job, run history, reflections,
 * outcome stats, and a mutable ExecutionAdvice.
 *
 * No expression language. No eval. Each predicate and action is a closed-set
 * tag with explicit fields.
 */

import { evolvePrompt } from '../prompt-evolver.js';
import type { ExecutionAdvice } from '../../types.js';
import type {
  AdvisorRule,
  RuleContext,
  ThenAction,
  WhenCondition,
} from './types.js';

// ── Scoping ──────────────────────────────────────────────────────────

export function ruleApplies(rule: AdvisorRule, ctx: RuleContext): boolean {
  const a = rule.appliesTo;
  if (!a) return true;

  if (a.agentSlug != null && ctx.job.agentSlug !== a.agentSlug) return false;
  if (a.jobName != null && ctx.job.name !== a.jobName) return false;

  if (a.jobMode !== undefined) {
    const jobMode = ctx.job.mode ?? null;
    // null in appliesTo.jobMode means "any mode"
    if (a.jobMode !== null && jobMode !== a.jobMode) return false;
  }

  if (a.tier && a.tier.length > 0 && !a.tier.includes(ctx.job.tier)) return false;

  return true;
}

// ── Condition evaluation ─────────────────────────────────────────────

export function evaluateWhen(c: WhenCondition, ctx: RuleContext): boolean {
  switch (c.kind) {
    case 'recentTerminalReason': {
      const window = ctx.recentRuns.slice(0, c.window);
      const hits = window.filter(r => {
        if (r.status !== 'error' && r.status !== 'retried') return false;
        return r.terminalReason === c.reason;
      });
      return hits.length >= c.atLeast;
    }

    case 'recentErrorCount': {
      const window = ctx.recentRuns.slice(0, c.window);
      const errors = window.filter(r => r.status === 'error');
      return errors.length >= c.atLeast;
    }

    case 'recentTimeoutHits': {
      const ratio = c.thresholdRatio ?? 0.95;
      const threshold = ctx.defaultTimeoutMs * ratio;
      const window = ctx.recentRuns.slice(0, c.window);
      const hits = window.filter(r => r.status === 'error' && r.durationMs >= threshold);
      return hits.length >= c.atLeast;
    }

    case 'avgReflectionQualityBelow': {
      const recent = ctx.reflections.slice(0, c.window);
      if (recent.length < c.minSamples) return false;
      const avg = recent.reduce((sum, r) => sum + r.quality, 0) / recent.length;
      return avg < c.threshold;
    }

    case 'lowQualityReflectionCount': {
      const recent = ctx.reflections.slice(0, c.window);
      const low = recent.filter(r => r.quality <= c.maxQuality);
      return low.length >= c.atLeast;
    }

    case 'consecutiveErrorsAtLeast':
      return ctx.consecutiveErrors >= c.count;

    case 'lastRunOlderThanMs': {
      const lastRun = ctx.recentRuns[0];
      if (!lastRun) return false;
      const lastRunTime = new Date(lastRun.finishedAt).getTime();
      return ctx.nowMs - lastRunTime > c.ms;
    }

    case 'lastRunWithinMs': {
      const lastRun = ctx.recentRuns[0];
      if (!lastRun) return false;
      const lastRunTime = new Date(lastRun.finishedAt).getTime();
      return ctx.nowMs - lastRunTime <= c.ms;
    }

    case 'noRecentRuns':
      return ctx.recentRuns.length === 0;

    case 'modelContains': {
      const model = ctx.job.model?.toLowerCase() ?? '';
      return model.includes(c.substring.toLowerCase());
    }

    case 'effectiveModelContains': {
      const sub = c.substring.toLowerCase();
      const baseModel = ctx.job.model?.toLowerCase() ?? '';
      const adjusted = (ctx.advice.adjustedModel ?? '').toLowerCase();
      return baseModel.includes(sub) || adjusted.includes(sub);
    }

    case 'recentSuccessCountAtLeast': {
      const window = ctx.recentRuns.slice(0, c.window);
      const ok = window.filter(r => r.status === 'ok');
      return ok.length >= c.atLeast;
    }

    case 'adviceFieldSet': {
      const v = ctx.advice[c.field];
      // truthy check matches the existing TS suppression pattern
      return v !== null && v !== undefined && v !== false && v !== '';
    }

    case 'interventionStatBelow': {
      const stat = ctx.interventionStats[c.stat];
      if (stat === null) return false; // null = no data, do not suppress
      const minSamples = c.minSamples ?? 0;
      if (ctx.interventionStats.sampleSize < minSamples) return false;
      return stat < c.threshold;
    }
  }
}

// ── Action application ───────────────────────────────────────────────

export function applyThen(a: ThenAction, ctx: RuleContext): void {
  switch (a.kind) {
    case 'bumpMaxTurns': {
      const baseDefault = a.baseDefault ?? ctx.defaultMaxTurns;
      const multiplier = a.multiplier ?? 1.5;
      const currentMax = ctx.job.maxTurns ?? baseDefault;
      const tierCap = ctx.tierMaxTurns[ctx.job.tier] ?? ctx.tierMaxTurns[1];
      const proposed = Math.ceil(currentMax * multiplier);
      ctx.advice.adjustedMaxTurns = Math.min(proposed, tierCap);
      return;
    }

    case 'bumpTimeoutMs': {
      const baseMs = a.baseMs ?? ctx.defaultTimeoutMs;
      const multiplier = a.multiplier ?? 1.5;
      const proposed = Math.ceil(baseMs * multiplier);
      ctx.advice.adjustedTimeoutMs = Math.min(proposed, ctx.maxTimeoutMs);
      return;
    }

    case 'setModel':
      ctx.advice.adjustedModel = a.model;
      return;

    case 'appendPromptEnrichment':
      ctx.advice.promptEnrichment = (ctx.advice.promptEnrichment || '') + a.text;
      return;

    case 'invokePromptEvolver': {
      const enrichment = evolvePrompt({
        jobName: ctx.job.name,
        originalPrompt: ctx.job.prompt,
        agentSlug: ctx.job.agentSlug,
      });
      if (enrichment) ctx.advice.promptEnrichment = enrichment;
      return;
    }

    case 'skipWithReason':
      ctx.advice.shouldSkip = true;
      ctx.advice.skipReason = renderReason(a.reasonTemplate ?? a.reason, ctx);
      return;

    case 'escalateWithReason':
      ctx.advice.shouldEscalate = true;
      ctx.advice.escalationReason = renderReason(a.reasonTemplate ?? a.reason, ctx);
      return;

    case 'clearAdviceField': {
      switch (a.field) {
        case 'promptEnrichment': ctx.advice.promptEnrichment = ''; return;
        case 'adjustedMaxTurns': ctx.advice.adjustedMaxTurns = null; return;
        case 'adjustedModel': ctx.advice.adjustedModel = null; return;
        case 'adjustedTimeoutMs': ctx.advice.adjustedTimeoutMs = null; return;
      }
      return;
    }
  }
}

// ── Reason templating (tiny — only context vars, no expressions) ─────

const TEMPLATE_VARS: Record<string, (ctx: RuleContext) => string | number> = {
  consecutiveErrors: (ctx) => ctx.consecutiveErrors,
  jobName: (ctx) => ctx.job.name,
  recentErrorCount: (ctx) => ctx.recentRuns.slice(0, 5).filter(r => r.status === 'error').length,
  lowQualityReflectionCount: (ctx) => ctx.reflections.slice(0, 5).filter(r => r.quality <= 2).length,
  cooldownProbeMin: (ctx) => {
    const lastRun = ctx.recentRuns[0];
    if (!lastRun) return 0;
    const lastRunTime = new Date(lastRun.finishedAt).getTime();
    const elapsed = ctx.nowMs - lastRunTime;
    const cooldown = 60 * 60 * 1000;
    return Math.max(0, Math.ceil((cooldown - elapsed) / 60_000));
  },
};

function renderReason(template: string, ctx: RuleContext): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => {
    const fn = TEMPLATE_VARS[name];
    return fn ? String(fn(ctx)) : match;
  });
}

// ── Top-level rule application ───────────────────────────────────────

export interface AppliedRuleTrace {
  ruleId: string;
  fired: boolean;
  reason?: string;
  skippedBy?: string; // condition kind that suppressed
}

/** Run a single rule against the context, mutating ctx.advice if it fires. */
export function applyRule(rule: AdvisorRule, ctx: RuleContext): AppliedRuleTrace {
  const trace: AppliedRuleTrace = { ruleId: rule.id, fired: false };

  if (!ruleApplies(rule, ctx)) {
    trace.skippedBy = 'appliesTo';
    return trace;
  }

  if (rule.skipIf && rule.skipIf.length > 0) {
    for (const cond of rule.skipIf) {
      if (evaluateWhen(cond, ctx)) {
        trace.skippedBy = `skipIf:${cond.kind}`;
        return trace;
      }
    }
  }

  for (const cond of rule.when) {
    if (!evaluateWhen(cond, ctx)) {
      trace.skippedBy = `when:${cond.kind}`;
      return trace;
    }
  }

  for (const action of rule.then) {
    applyThen(action, ctx);
  }

  trace.fired = true;
  if (rule.log?.reason) trace.reason = rule.log.reason;
  return trace;
}

/** Apply all rules in order (already sorted by priority by the loader). */
export function applyRules(
  rules: AdvisorRule[],
  ctx: RuleContext,
): { advice: ExecutionAdvice; traces: AppliedRuleTrace[] } {
  const traces: AppliedRuleTrace[] = [];
  for (const rule of rules) {
    const trace = applyRule(rule, ctx);
    traces.push(trace);
    if (trace.fired && rule.stopOnFire) break;
  }
  return { advice: ctx.advice, traces };
}
