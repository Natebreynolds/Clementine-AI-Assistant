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
  CIRCUIT_BREAKER_COOLDOWN_MS as _COOLDOWN_MS,
  DEFAULT_MAX_TURNS_FALLBACK,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TIER_MAX_TURNS,
  getInterventionStats,
  readReflections,
} from '../execution-advisor.js';
import type { CronJobDefinition, ExecutionAdvice } from '../../types.js';
import type { RuleContext } from './types.js';

void _COOLDOWN_MS; // currently encoded as a literal in builtin YAMLs; re-export hook

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
