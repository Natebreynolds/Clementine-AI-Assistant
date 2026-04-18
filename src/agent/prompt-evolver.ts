/**
 * Clementine TypeScript — Adaptive Prompt Evolution.
 *
 * Evolves static cron prompts by enriching them with lessons from
 * reflections, progress state, and goal context. Returns the enrichment
 * string to be appended to the original prompt.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, CRON_REFLECTIONS_DIR, CRON_PROGRESS_DIR } from '../config.js';
import { listAllGoals } from '../tools/shared.js';
import type { PersistentGoal, CronProgress } from '../types.js';

const logger = pino({ name: 'clementine.prompt-evolver' });

interface PromptEvolutionContext {
  jobName: string;
  originalPrompt: string;
  agentSlug?: string;
}

/**
 * Evolve a static cron prompt by enriching it with lessons from reflections,
 * progress state, and goal context. Returns the enrichment string (not the full prompt).
 */
export function evolvePrompt(ctx: PromptEvolutionContext): string {
  const parts: string[] = [];

  try {
    const reflectionLessons = extractReflectionLessons(ctx.jobName);
    if (reflectionLessons) parts.push(reflectionLessons);
  } catch (err) {
    logger.debug({ err, job: ctx.jobName }, 'Failed to extract reflection lessons');
  }

  try {
    const strategyInsights = extractStrategyInsights(ctx.jobName);
    if (strategyInsights) parts.push(strategyInsights);
  } catch (err) {
    logger.debug({ err, job: ctx.jobName }, 'Failed to extract strategy insights');
  }

  try {
    const progressInsights = extractProgressInsights(ctx.jobName);
    if (progressInsights) parts.push(progressInsights);
  } catch (err) {
    logger.debug({ err, job: ctx.jobName }, 'Failed to extract progress insights');
  }

  try {
    const goalGuidance = extractGoalGuidance(ctx.jobName);
    if (goalGuidance) parts.push(goalGuidance);
  } catch (err) {
    logger.debug({ err, job: ctx.jobName }, 'Failed to extract goal guidance');
  }

  return parts.join('\n\n');
}

/**
 * Log a strategy observation after a cron run completes.
 * Called by the cron scheduler to track which approaches work/fail.
 */
export function logStrategyObservation(jobName: string, observation: {
  toolsUsed: string[];
  quality: number;
  status: 'ok' | 'error';
}): void {
  try {
    const strategyDir = path.join(BASE_DIR, 'cron', 'strategies');
    mkdirSync(strategyDir, { recursive: true });
    const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const logFile = path.join(strategyDir, `${safe}.strategy.jsonl`);
    appendFileSync(logFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      toolsUsed: observation.toolsUsed.slice(0, 20),
      quality: observation.quality,
      status: observation.status,
    }) + '\n');
  } catch {
    // non-fatal
  }
}

/**
 * Extract lessons from past reflections where quality was low or gaps were noted.
 * Deduplicates gap strings and formats them as guidance.
 */
function extractReflectionLessons(jobName: string): string | null {
  if (!existsSync(CRON_REFLECTIONS_DIR)) return null;

  const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const reflectionFile = path.join(CRON_REFLECTIONS_DIR, `${safe}.jsonl`);
  if (!existsSync(reflectionFile)) return null;

  try {
    const lines = readFileSync(reflectionFile, 'utf-8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-10);

    const gaps = new Set<string>();
    const commNotes: string[] = [];

    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        if (entry.quality < 3 && entry.gap) {
          gaps.add(entry.gap.trim());
        }
        if (entry.commNote) {
          commNotes.push(entry.commNote.trim());
        }
      } catch { continue; }
    }

    if (gaps.size === 0 && commNotes.length === 0) return null;

    const parts: string[] = ['## Lessons from Previous Runs', 'Based on past performance reviews:'];

    if (gaps.size > 0) {
      for (const gap of gaps) {
        parts.push(`- ${gap}`);
      }
      parts.push('Avoid these pitfalls in this run.');
    }

    if (commNotes.length > 0) {
      parts.push('Communication notes:');
      for (const note of commNotes.slice(-3)) {
        parts.push(`- ${note}`);
      }
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}

/**
 * Extract strategy insights by correlating tool usage patterns with quality scores.
 * Identifies which approaches (tool combinations) tend to succeed vs. fail.
 */
function extractStrategyInsights(jobName: string): string | null {
  const strategyDir = path.join(BASE_DIR, 'cron', 'strategies');
  const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const logFile = path.join(strategyDir, `${safe}.strategy.jsonl`);
  if (!existsSync(logFile)) return null;

  try {
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length < 3) return null; // need enough data

    const recent = lines.slice(-15);
    // Tally quality by top tool used
    const toolStats = new Map<string, { total: number; successCount: number; qualitySum: number }>();

    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        const topTools = (entry.toolsUsed ?? []).slice(0, 3) as string[];
        const key = topTools.sort().join('+') || 'no-tools';
        const stats = toolStats.get(key) ?? { total: 0, successCount: 0, qualitySum: 0 };
        stats.total++;
        if (entry.status === 'ok' && entry.quality >= 3) stats.successCount++;
        stats.qualitySum += entry.quality ?? 3;
        toolStats.set(key, stats);
      } catch { continue; }
    }

    if (toolStats.size === 0) return null;

    // Find best and worst approaches
    const ranked = [...toolStats.entries()]
      .filter(([, s]) => s.total >= 2)
      .map(([approach, s]) => ({
        approach,
        successRate: s.successCount / s.total,
        avgQuality: s.qualitySum / s.total,
        total: s.total,
      }))
      .sort((a, b) => b.avgQuality - a.avgQuality);

    if (ranked.length === 0) return null;

    const parts: string[] = ['## Strategy Insights'];

    const best = ranked[0];
    if (best.successRate >= 0.7) {
      parts.push(`Recommended approach: **${best.approach}** (${Math.round(best.successRate * 100)}% success rate over ${best.total} runs, avg quality: ${best.avgQuality.toFixed(1)})`);
    }

    const worst = ranked[ranked.length - 1];
    if (ranked.length > 1 && worst.successRate < 0.5) {
      parts.push(`Avoid: **${worst.approach}** (${Math.round(worst.successRate * 100)}% success rate — consider alternative tools)`);
    }

    return parts.length > 1 ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

/**
 * Extract insights from progress history — what's been done and what remains.
 */
function extractProgressInsights(jobName: string): string | null {
  if (!existsSync(CRON_PROGRESS_DIR)) return null;

  const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const progressFile = path.join(CRON_PROGRESS_DIR, `${safe}.json`);
  if (!existsSync(progressFile)) return null;

  try {
    const progress: CronProgress = JSON.parse(readFileSync(progressFile, 'utf-8'));
    const parts: string[] = ['## Progress Continuity'];

    if (progress.completedItems?.length > 0) {
      const recentCompleted = progress.completedItems.slice(-5);
      parts.push(`Recently completed (${progress.completedItems.length} total):`);
      for (const item of recentCompleted) {
        parts.push(`- Done: ${item}`);
      }
    }

    if (progress.pendingItems?.length > 0) {
      parts.push(`Still pending (${progress.pendingItems.length}):`);
      for (const item of progress.pendingItems.slice(0, 5)) {
        parts.push(`- TODO: ${item}`);
      }
    }

    if (progress.notes) {
      parts.push(`Previous notes: ${progress.notes.slice(0, 300)}`);
    }

    if (parts.length <= 1) return null;
    return parts.join('\n');
  } catch {
    return null;
  }
}

/**
 * Find goals that reference this cron job and inject alignment guidance.
 */
function extractGoalGuidance(jobName: string): string | null {
  try {
    const linkedGoals: PersistentGoal[] = [];
    for (const { goal } of listAllGoals()) {
      if (goal.status !== 'active') continue;
      if (goal.linkedCronJobs?.includes(jobName)) {
        linkedGoals.push(goal as unknown as PersistentGoal);
      }
    }

    if (linkedGoals.length === 0) return null;

    const parts: string[] = ['## Goal Alignment'];

    for (const goal of linkedGoals) {
      parts.push(`This job contributes to goal: "${goal.title}" (${goal.priority} priority)`);

      if (goal.nextActions?.length) {
        parts.push('Goal next actions to consider:');
        for (const action of goal.nextActions.slice(0, 3)) {
          parts.push(`- ${action}`);
        }
      }

      if (goal.blockers?.length) {
        parts.push('Known blockers:');
        for (const blocker of goal.blockers) {
          parts.push(`- Blocker: ${blocker}`);
        }
      }

      if (goal.targetDate) {
        const daysLeft = Math.floor((new Date(goal.targetDate).getTime() - Date.now()) / 86_400_000);
        if (daysLeft <= 7 && daysLeft >= 0) {
          parts.push(`Target date approaching: ${goal.targetDate} (${daysLeft} day(s) left)`);
        } else if (daysLeft < 0) {
          parts.push(`Target date OVERDUE: ${goal.targetDate} (${Math.abs(daysLeft)} day(s) past)`);
        }
      }
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}
