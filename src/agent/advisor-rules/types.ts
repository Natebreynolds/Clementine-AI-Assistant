/**
 * Advisor Rule Engine — schema types.
 *
 * Rules are data, not code. They live as YAML files in ~/.clementine/advisor-rules/
 * and replace the hardcoded TS rule helpers in execution-advisor.ts. Engine builtins
 * ship in src/agent/advisor-rules/builtin/ and get copied to user-space on first init.
 *
 * Design constraints:
 *   - No expression language. All `then` actions are named operations with explicit fields.
 *     Anything more complex stays as a TS hook (then.invokeBuiltin).
 *   - Closed-set conditions and operations. Adding a new one requires an engine update,
 *     never an `eval()`.
 *   - User-authored rules in user/ override engine builtins of the same id.
 */

import type { CronJobDefinition, CronRunEntry, ExecutionAdvice, TerminalReason } from '../../types.js';

// ── Predicate language ───────────────────────────────────────────────

/** Scoping — at least one field must match (or be null/absent) for the rule to apply. */
export interface AppliesTo {
  agentSlug?: string | null;
  jobName?: string | null;
  /** "standard" | "unleashed" | null (null means any mode, including unset) */
  jobMode?: 'standard' | 'unleashed' | null;
  tier?: number[];
}

/** Conditions are a closed set. The engine knows how to evaluate each kind. */
export type WhenCondition =
  // Count of recent runs whose terminalReason matches
  | { kind: 'recentTerminalReason'; reason: TerminalReason; window: number; atLeast: number }
  // Count of recent error runs (regardless of terminalReason)
  | { kind: 'recentErrorCount'; window: number; atLeast: number }
  // Count of recent runs that hit timeout (durationMs >= threshold)
  | { kind: 'recentTimeoutHits'; window: number; atLeast: number; thresholdRatio?: number }
  // Average reflection quality threshold
  | { kind: 'avgReflectionQualityBelow'; window: number; threshold: number; minSamples: number }
  // Count of low-quality reflections
  | { kind: 'lowQualityReflectionCount'; window: number; maxQuality: number; atLeast: number }
  // Consecutive errors (for circuit breaker)
  | { kind: 'consecutiveErrorsAtLeast'; count: number }
  // Time since last run, for circuit breaker cooldown probe.
  // True iff lastRun exists AND elapsed > ms.
  | { kind: 'lastRunOlderThanMs'; ms: number }
  // True iff lastRun exists AND elapsed <= ms.
  | { kind: 'lastRunWithinMs'; ms: number }
  // True iff there are no recent runs at all.
  | { kind: 'noRecentRuns' }
  // Model contains substring (case-insensitive)
  | { kind: 'modelContains'; substring: string }
  // Like modelContains but also matches advice.adjustedModel from earlier rules
  | { kind: 'effectiveModelContains'; substring: string }
  // Count of recent ok runs (for "completes but quality is low" patterns)
  | { kind: 'recentSuccessCountAtLeast'; window: number; atLeast: number }
  // Already-in-advice check (lets later rules act on earlier rules' output)
  | { kind: 'adviceFieldSet'; field: keyof ExecutionAdvice }
  // Outcome stat from past advisor decisions
  | { kind: 'interventionStatBelow'; stat: 'modelUpgradeSuccessRate' | 'turnAdjustSuccessRate' | 'enrichmentSuccessRate'; threshold: number; minSamples?: number };

/** Actions are also a closed set. */
export type ThenAction =
  // Bump maxTurns by multiplier, capped to tier max
  | { kind: 'bumpMaxTurns'; multiplier?: number; baseDefault?: number }
  // Bump timeout by multiplier, capped to MAX_TIMEOUT_MS
  | { kind: 'bumpTimeoutMs'; multiplier?: number; baseMs?: number }
  // Set adjustedModel
  | { kind: 'setModel'; model: string }
  // Append to promptEnrichment
  | { kind: 'appendPromptEnrichment'; text: string }
  // Delegate to TS prompt evolver (the 10% — anything not data-expressible)
  | { kind: 'invokePromptEvolver' }
  // Skip the run with reason
  | { kind: 'skipWithReason'; reason: string; reasonTemplate?: string }
  // Escalate with reason
  | { kind: 'escalateWithReason'; reason: string; reasonTemplate?: string }
  // Clear an advice field that was set by an earlier rule
  | { kind: 'clearAdviceField'; field: 'adjustedMaxTurns' | 'adjustedModel' | 'adjustedTimeoutMs' | 'promptEnrichment' };

// ── Rule shape ──────────────────────────────────────────────────────

export interface AdvisorRule {
  schemaVersion: 1;
  id: string;
  description: string;
  /** Lower runs first. Builtin priorities convention: 10, 20, ... 90; user rules at 100+ override. */
  priority: number;
  appliesTo?: AppliesTo;
  /** All conditions in skipIf cause the rule to be skipped (logical OR — any match skips). */
  skipIf?: WhenCondition[];
  /** All conditions in `when` must be true for the rule to fire (logical AND). */
  when: WhenCondition[];
  /** Actions to apply when the rule fires. Applied in array order. */
  then: ThenAction[];
  /** If true, no further rules run when this one fires (mirrors TS `return advice` patterns like the circuit breaker). */
  stopOnFire?: boolean;
  /** Optional metadata for logging. */
  log?: { reason?: string };
  /** Source path (filled by loader, not in YAML). */
  _sourcePath?: string;
}

// ── Evaluation context ──────────────────────────────────────────────

/** Built once per getExecutionAdvice call; passed to every rule. */
export interface RuleContext {
  job: CronJobDefinition;
  jobName: string;
  recentRuns: CronRunEntry[];
  reflections: ReadonlyArray<{ quality: number }>;
  consecutiveErrors: number;
  interventionStats: {
    modelUpgradeSuccessRate: number | null;
    turnAdjustSuccessRate: number | null;
    enrichmentSuccessRate: number | null;
    sampleSize: number;
  };
  /** Shared mutable advice — rules read and write it. */
  advice: ExecutionAdvice;
  /** Current time, injectable for tests. */
  nowMs: number;
  /** Tier turn cap lookup (from execution-advisor.ts). */
  tierMaxTurns: Record<number, number>;
  /** Default standard-cron timeout. */
  defaultTimeoutMs: number;
  /** Hard ceiling for adjusted timeout. */
  maxTimeoutMs: number;
  /** Default for missing job.maxTurns. */
  defaultMaxTurns: number;
}

export type RulesLoaderMode = 'off' | 'shadow' | 'primary';
