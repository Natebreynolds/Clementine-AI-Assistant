/**
 * Clementine TypeScript — Execution Advisor.
 *
 * Analyzes recent run history and reflection data to adaptively tune
 * cron job execution parameters: turn limits, models, timeouts, prompt
 * enrichment, escalation, and circuit-breaking.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { CRON_REFLECTIONS_DIR, ADVISOR_LOG_PATH } from '../config.js';
import { CronRunLog } from '../gateway/heartbeat.js';
import { evolvePrompt } from './prompt-evolver.js';
import type { CronJobDefinition, ExecutionAdvice } from '../types.js';

const logger = pino({ name: 'clementine.execution-advisor' });

// ── Tier caps for maxTurns ──────────────────────────────────────────

const TIER_MAX_TURNS: Record<number, number> = {
  1: 15,
  2: 50,
};

const DEFAULT_TIMEOUT_MS = 600_000;       // 10 minutes
const MAX_TIMEOUT_MS = 20 * 60 * 1000;    // 20 minutes
const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between retry probes

// ── Reflection entry shape (from JSONL) ─────────────────────────────

interface ReflectionEntry {
  jobName: string;
  timestamp: string;
  existence: boolean;
  substance: boolean;
  actionable: boolean;
  communication: boolean;
  criteriaMet: boolean | null;
  quality: number;
  gap: string;
  commNote: string;
}

// ── Core function ───────────────────────────────────────────────────

export function getExecutionAdvice(jobName: string, job: CronJobDefinition): ExecutionAdvice {
  const advice: ExecutionAdvice = {
    adjustedMaxTurns: null,
    adjustedModel: null,
    adjustedTimeoutMs: null,
    promptEnrichment: '',
    shouldEscalate: false,
    shouldSkip: false,
  };

  try {
    const runLog = new CronRunLog();
    const recentRuns = runLog.readRecent(jobName, 10);
    const reflections = readReflections(jobName);
    const consecutiveErrors = runLog.consecutiveErrors(jobName);

    // ── Rule 1: Circuit breaker — 5+ consecutive errors ──────────
    // Allow a recovery probe once per hour so the breaker can self-heal.
    if (consecutiveErrors >= 5) {
      const lastRun = recentRuns[0];
      // If no runs exist (shouldn't happen with 5+ errors, but be safe), skip immediately
      if (!lastRun) {
        advice.shouldSkip = true;
        advice.skipReason = `${consecutiveErrors} consecutive errors — circuit breaker engaged`;
        return advice;
      }
      const lastRunTime = new Date(lastRun.finishedAt).getTime();
      const elapsed = Date.now() - lastRunTime;

      if (elapsed < CIRCUIT_BREAKER_COOLDOWN_MS) {
        advice.shouldSkip = true;
        advice.skipReason = `${consecutiveErrors} consecutive errors — circuit breaker engaged (next probe in ${Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 60_000)}m)`;
        logger.debug({ job: jobName, consecutiveErrors, nextProbeMin: Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 60_000) }, 'Circuit breaker — cooling down');
        return advice;
      }

      // Cooldown elapsed — allow a recovery probe
      logger.info({ job: jobName, consecutiveErrors }, 'Circuit breaker — allowing recovery probe after cooldown');
    }

    // ── Learn from past outcomes ────────────────────────────────
    const outcomeStats = getInterventionStats(jobName);

    // ── Rule 2: Turn-limit hits → increase maxTurns ──────────────
    checkTurnLimitHits(recentRuns, job, advice);
    // Suppress if turn adjustments have proven ineffective
    if (advice.adjustedMaxTurns && outcomeStats.turnAdjustSuccessRate !== null && outcomeStats.turnAdjustSuccessRate < 0.2) {
      logger.info({ job: jobName, rate: outcomeStats.turnAdjustSuccessRate }, 'Suppressing turn adjustment — historically ineffective');
      advice.adjustedMaxTurns = null;
    }

    // ── Rule 3: Low reflection quality → prompt enrichment ───────
    checkReflectionQuality(reflections, job, advice);
    // Suppress if enrichment has proven ineffective
    if (advice.promptEnrichment && outcomeStats.enrichmentSuccessRate !== null && outcomeStats.enrichmentSuccessRate < 0.2) {
      logger.info({ job: jobName, rate: outcomeStats.enrichmentSuccessRate }, 'Suppressing prompt enrichment — historically ineffective');
      advice.promptEnrichment = '';
    }

    // ── Rule 4: Repeated failures on haiku → upgrade to sonnet ───
    checkModelUpgrade(recentRuns, job, advice);
    // Suppress if model upgrades have proven ineffective
    if (advice.adjustedModel && outcomeStats.modelUpgradeSuccessRate !== null && outcomeStats.modelUpgradeSuccessRate < 0.2) {
      logger.info({ job: jobName, rate: outcomeStats.modelUpgradeSuccessRate }, 'Suppressing model upgrade — historically ineffective');
      advice.adjustedModel = null;
    }

    // ── Rule 5: Timeout hits → increase timeout ─────────────────
    checkTimeoutHits(recentRuns, job, advice);

    // ── Rule 6: Sonnet still failing → escalate to unleashed ─────
    checkEscalation(recentRuns, reflections, job, advice);

  } catch (err) {
    logger.warn({ err, job: jobName }, 'Execution advisor error — proceeding with defaults');
  }

  return advice;
}

// ── Rule helpers ────────────────────────────────────────────────────

function checkTurnLimitHits(
  runs: ReturnType<CronRunLog['readRecent']>,
  job: CronJobDefinition,
  advice: ExecutionAdvice,
): void {
  // Use precise TerminalReason when available, fall back to regex on error text
  const turnLimitHits = runs.slice(0, 5).filter(r => {
    if (r.status !== 'error' && r.status !== 'retried') return false;
    // Precise check via SDK TerminalReason
    if (r.terminalReason === 'max_turns') return true;
    // Fallback: regex on error text
    const errorLower = (r.error ?? '').toLowerCase();
    return errorLower.includes('turn') || errorLower.includes('max_turns') || errorLower.includes('maxturns');
  });

  // Check for prompt_too_long — this needs a DIFFERENT fix (not more turns)
  const promptTooLong = runs.slice(0, 5).filter(r =>
    r.terminalReason === 'prompt_too_long'
  );
  if (promptTooLong.length >= 1) {
    // Don't increase turns — the prompt itself is the problem
    advice.promptEnrichment = (advice.promptEnrichment || '') +
      '\n\n⚠ Previous runs hit prompt length limits. Be concise. Minimize system prompt injection.';
    logger.debug({ job: job.name, hits: promptTooLong.length }, 'Prompt too long detected — adding conciseness guidance');
    return; // skip turn adjustment
  }

  if (turnLimitHits.length >= 2) {
    const currentMax = job.maxTurns ?? 5;
    const tierCap = TIER_MAX_TURNS[job.tier] ?? TIER_MAX_TURNS[1];
    const proposed = Math.ceil(currentMax * 1.5);
    advice.adjustedMaxTurns = Math.min(proposed, tierCap);
    logger.debug({ job: job.name, from: currentMax, to: advice.adjustedMaxTurns }, 'Adjusting maxTurns due to turn-limit hits');
  }
}

function checkReflectionQuality(
  reflections: ReflectionEntry[],
  job: CronJobDefinition,
  advice: ExecutionAdvice,
): void {
  const recent = reflections.slice(0, 5); // already newest-first
  if (recent.length < 3) return;

  const avgQuality = recent.reduce((sum, r) => sum + r.quality, 0) / recent.length;
  if (avgQuality >= 3.0) return;

  // Delegate to prompt evolver for comprehensive enrichment
  const enrichment = evolvePrompt({
    jobName: job.name,
    originalPrompt: job.prompt,
    agentSlug: job.agentSlug,
  });

  if (enrichment) {
    advice.promptEnrichment = enrichment;
    logger.debug({ job: job.name, avgQuality: avgQuality.toFixed(1) }, 'Built prompt enrichment via prompt evolver');
  }
}

function checkModelUpgrade(
  runs: ReturnType<CronRunLog['readRecent']>,
  job: CronJobDefinition,
  advice: ExecutionAdvice,
): void {
  if (!job.model || !job.model.toLowerCase().includes('haiku')) return;

  // Precise: model_error from SDK means the model itself is the problem
  const modelErrors = runs.slice(0, 5).filter(r => r.terminalReason === 'model_error');
  if (modelErrors.length >= 1) {
    advice.adjustedModel = 'sonnet';
    logger.debug({ job: job.name, modelErrors: modelErrors.length }, 'Upgrading model — SDK reported model_error');
    return;
  }

  // Fallback: generic failure count
  const recentFailures = runs.slice(0, 5).filter(r => r.status === 'error');
  if (recentFailures.length >= 3) {
    advice.adjustedModel = 'sonnet';
    logger.debug({ job: job.name, failures: recentFailures.length }, 'Upgrading model from haiku to sonnet due to repeated failures');
  }
}

function checkTimeoutHits(
  runs: ReturnType<CronRunLog['readRecent']>,
  job: CronJobDefinition,
  advice: ExecutionAdvice,
): void {
  const timeoutMs = DEFAULT_TIMEOUT_MS; // standard cron timeout
  const threshold = timeoutMs * 0.95;

  const timeoutHits = runs.slice(0, 5).filter(r => {
    if (r.status !== 'error') return false;
    return r.durationMs >= threshold;
  });

  if (timeoutHits.length >= 2) {
    const proposed = Math.ceil(timeoutMs * 1.5);
    advice.adjustedTimeoutMs = Math.min(proposed, MAX_TIMEOUT_MS);
    logger.debug({ job: job.name, from: timeoutMs, to: advice.adjustedTimeoutMs }, 'Adjusting timeout due to timeout hits');
  }
}

function checkEscalation(
  runs: ReturnType<CronRunLog['readRecent']>,
  reflections: ReflectionEntry[],
  job: CronJobDefinition,
  advice: ExecutionAdvice,
): void {
  if (job.mode === 'unleashed') return;

  // Check if we already upgraded to sonnet and still failing
  const isSonnet = job.model?.toLowerCase().includes('sonnet') || advice.adjustedModel === 'sonnet';
  if (!isSonnet) return;

  const recentFailures = runs.slice(0, 5).filter(r => r.status === 'error');
  const lowQualityReflections = reflections.slice(0, 5).filter(r => r.quality <= 2);

  if (recentFailures.length >= 3 || lowQualityReflections.length >= 3) {
    advice.shouldEscalate = true;
    advice.escalationReason = recentFailures.length >= 3
      ? `${recentFailures.length} recent failures on sonnet-tier model`
      : `${lowQualityReflections.length} low-quality reflections despite sonnet-tier model`;
    logger.debug({ job: job.name, reason: advice.escalationReason }, 'Recommending escalation to unleashed');
  }
}

// ── Outcome learning ─────────────────────────────────────────────────

interface InterventionStats {
  modelUpgradeSuccessRate: number | null;
  turnAdjustSuccessRate: number | null;
  enrichmentSuccessRate: number | null;
  sampleSize: number;
}

/**
 * Read past advisor outcomes to learn which interventions actually work
 * for a given job. Returns null rates when insufficient data exists.
 */
function getInterventionStats(jobName: string): InterventionStats {
  const stats: InterventionStats = {
    modelUpgradeSuccessRate: null,
    turnAdjustSuccessRate: null,
    enrichmentSuccessRate: null,
    sampleSize: 0,
  };

  if (!existsSync(ADVISOR_LOG_PATH)) return stats;

  try {
    const lines = readFileSync(ADVISOR_LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    // Only scan recent entries to avoid expensive parsing on large logs
    const outcomes = lines.slice(-200)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter((d): d is any => d !== null && d.type === 'outcome' && d.jobName === jobName);

    if (outcomes.length < 3) return stats;
    stats.sampleSize = outcomes.length;

    // Model upgrade effectiveness
    const modelOuts = outcomes.filter(o => o.interventions?.adjustedModel);
    if (modelOuts.length >= 2) {
      const successes = modelOuts.filter(o => o.outcome === 'ok').length;
      stats.modelUpgradeSuccessRate = successes / modelOuts.length;
    }

    // Turn adjustment effectiveness
    const turnOuts = outcomes.filter(o => o.interventions?.adjustedMaxTurns);
    if (turnOuts.length >= 2) {
      const successes = turnOuts.filter(o => o.outcome === 'ok').length;
      stats.turnAdjustSuccessRate = successes / turnOuts.length;
    }

    // Enrichment effectiveness
    const enrichOuts = outcomes.filter(o => o.interventions?.enriched);
    if (enrichOuts.length >= 2) {
      const successes = enrichOuts.filter(o => o.outcome === 'ok').length;
      stats.enrichmentSuccessRate = successes / enrichOuts.length;
    }
  } catch { /* ignore */ }

  return stats;
}

// ── Reflection file reader ──────────────────────────────────────────

function readReflections(jobName: string): ReflectionEntry[] {
  try {
    const safeJob = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const reflPath = path.join(CRON_REFLECTIONS_DIR, `${safeJob}.jsonl`);
    if (!existsSync(reflPath)) return [];

    const lines = readFileSync(reflPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-10)
      .map(l => { try { return JSON.parse(l) as ReflectionEntry; } catch { return null; } })
      .filter((r): r is ReflectionEntry => r !== null)
      .reverse(); // newest first
  } catch {
    return [];
  }
}
