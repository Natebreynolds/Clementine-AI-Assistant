/**
 * Clementine TypeScript — Adaptive Prompt Evolution.
 *
 * Evolves static cron prompts by enriching them with lessons from
 * reflections, progress state, and goal context. Returns the enrichment
 * string to be appended to the original prompt.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CRON_REFLECTIONS_DIR, CRON_PROGRESS_DIR, GOALS_DIR } from '../config.js';
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
  if (!existsSync(GOALS_DIR)) return null;

  try {
    const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
    const linkedGoals: PersistentGoal[] = [];

    for (const f of files) {
      try {
        const goal: PersistentGoal = JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8'));
        if (goal.status !== 'active') continue;
        if (goal.linkedCronJobs?.includes(jobName)) {
          linkedGoals.push(goal);
        }
      } catch { continue; }
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
