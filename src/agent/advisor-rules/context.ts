/**
 * Advisor Rule Engine — context builder.
 *
 * Builds a `RuleContext` from the same data sources the legacy TS advisor reads:
 *   - CronRunLog for recent run history and consecutive errors
 *   - readReflections() for reflection JSONL
 *   - getInterventionStats() for past advisor outcome stats
 *
 * Both shadow mode and (eventually) primary mode share this builder so the
 * data pipeline is identical and any divergence is purely rule-evaluation.
 */

import { CronRunLog } from '../../gateway/cron-scheduler.js';
import {
  DEFAULT_MAX_TURNS_FALLBACK,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TIER_MAX_TURNS,
  getInterventionStats,
  readReflections,
} from '../execution-advisor.js';
import type { CronJobDefinition, ExecutionAdvice } from '../../types.js';
import type { RuleContext } from './types.js';

// NOTE: Phase 9c (commit 4451f36) made execution-advisor.ts static-import
// THIS module, creating a circular dep. The previous module-init line
// `void CIRCUIT_BREAKER_COOLDOWN_MS as _COOLDOWN_MS` was deferring access
// in source comment terms but actually FORCED a TDZ access at context.ts
// module-init — which is BEFORE execution-advisor.ts has reached line 38
// where the const is declared. That produced "Cannot access '_COOLDOWN_MS'
// before initialization" errors on every cron run after Phase 9c shipped.
// Removed the import + the void line. The cooldown duration is encoded as
// a literal in the builtin YAML rules, so this module never actually
// needed the constant — the import was documentation noise.

/**
 * Build a fresh RuleContext for a job. Pass an existing `advice` if you want
 * to mutate it (e.g. shadow mode passes a clone so the TS path's advice is
 * preserved unchanged).
 */
export function buildRuleContext(
  jobName: string,
  job: CronJobDefinition,
  options?: { advice?: ExecutionAdvice; nowMs?: number; runLog?: CronRunLog },
): RuleContext {
  const runLog = options?.runLog ?? new CronRunLog();
  const recentRuns = runLog.readRecent(jobName, 10);
  const consecutiveErrors = runLog.consecutiveErrors(jobName);
  const reflections = readReflections(jobName);
  const interventionStats = getInterventionStats(jobName);

  const advice: ExecutionAdvice = options?.advice ?? {
    adjustedMaxTurns: null,
    adjustedModel: null,
    adjustedTimeoutMs: null,
    promptEnrichment: '',
    shouldEscalate: false,
    shouldSkip: false,
  };

  return {
    job,
    jobName,
    recentRuns,
    reflections,
    consecutiveErrors,
    interventionStats,
    advice,
    nowMs: options?.nowMs ?? Date.now(),
    tierMaxTurns: TIER_MAX_TURNS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    defaultMaxTurns: DEFAULT_MAX_TURNS_FALLBACK,
  };
}
