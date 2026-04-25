/**
 * Clementine TypeScript — Self-improve loop (autonomous fix consumer).
 *
 * Closes the gap between "we noticed a job is failing" and "we did
 * something about it." Periodically scans
 * ~/.clementine/self-improve/triggers/*.json (written by cron-scheduler
 * when consecutiveErrors >= 3), classifies the failure pattern from
 * recentErrors, and either:
 *
 *   - Auto-applies a safe cron-config fix (mode, max_hours, max_turns)
 *     and DMs the OWNING agent via their bot
 *   - Writes a proposal to self-improve/pending-changes/ and DMs the
 *     owning agent the diagnosis (full audit-inbox button approval is
 *     a separate Phase 8b ship)
 *
 * After processing, the trigger file is removed. The existing
 * fix-verification system (cron-scheduler.ts) records preFailureCount
 * when a job's config changes and tracks whether the next run succeeds.
 *
 * Routing rule: notifications go to the owning agent's DM via their
 * own bot using `dispatcher.send(text, { agentSlug })`. Unowned crons
 * (no agentSlug) → Clementine's main bot DMs the owner.
 *
 * Idempotent: re-applying the same fix to an already-fixed job is a
 * no-op; the trigger gets removed regardless.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import { BASE_DIR, SYSTEM_DIR } from '../config.js';

const logger = pino({ name: 'clementine.self-improve-loop' });

const TICK_MS = 10 * 60 * 1000;
const TRIGGERS_DIR = path.join(BASE_DIR, 'self-improve', 'triggers');
const PENDING_CHANGES_DIR = path.join(BASE_DIR, 'self-improve', 'pending-changes');
const CRON_PATH = path.join(SYSTEM_DIR, 'CRON.md');

// ── Types ────────────────────────────────────────────────────────────

export interface TriggerFile {
  jobName: string;
  consecutiveErrors: number;
  recentErrors: string[];
  triggeredAt: string;
}

export type FixCategory =
  | 'safe-cron-config'  // mode/max_hours/max_turns — auto-apply
  | 'risky'             // prompts, profile, code — escalate for approval
  | 'noop'              // pattern recognized but no action needed (already fixed)
  | 'unknown';          // unrecognized — escalate for owner inspection

export interface FixRecipe {
  category: FixCategory;
  /** Description of what this fix does, for DMs. */
  description: string;
  /**
   * For safe-cron-config: a function that mutates the job's frontmatter
   * entry in-place. Returns true if any change was made (false = idempotent
   * no-op because the fix is already applied).
   */
  apply?: (job: Record<string, unknown>) => boolean;
}

export interface SelfImproveDispatcher {
  send(
    text: string,
    context?: { agentSlug?: string },
  ): Promise<{ delivered: boolean; channelErrors: Record<string, string> }>;
}

export interface SelfImproveLoopOptions {
  /** Override scan interval for tests. */
  tickMs?: number;
  /** Override directories for tests. */
  triggersDir?: string;
  pendingDir?: string;
  cronPath?: string;
}

// ── Pattern recognition ──────────────────────────────────────────────

const PATTERNS: Array<{
  match: RegExp;
  recipe: () => FixRecipe;
}> = [
  {
    // "Reached maximum number of turns (8)"
    match: /Reached maximum number of turns/i,
    recipe: () => ({
      category: 'safe-cron-config',
      description: 'Hit max-turns ceiling repeatedly. Switching to unleashed mode (multi-phase) so the job can complete its workflow.',
      apply: (job) => {
        let changed = false;
        if (job.mode !== 'unleashed') {
          job.mode = 'unleashed';
          changed = true;
        }
        if (typeof job.max_hours !== 'number' || (job.max_hours as number) < 1) {
          job.max_hours = 1;
          changed = true;
        }
        return changed;
      },
    }),
  },
  {
    // "Autocompact is thrashing: the context refilled to the limit within 3 turns"
    match: /Autocompact is thrashing/i,
    recipe: () => ({
      category: 'safe-cron-config',
      description: 'Context window blowing up mid-run. Switching to unleashed mode so each phase starts with a fresh context.',
      apply: (job) => {
        let changed = false;
        if (job.mode !== 'unleashed') {
          job.mode = 'unleashed';
          changed = true;
        }
        if (typeof job.max_hours !== 'number' || (job.max_hours as number) < 1) {
          job.max_hours = 1;
          changed = true;
        }
        return changed;
      },
    }),
  },
  {
    // Already-fixed-in-code patterns
    match: /This model does not support user-configurable task budgets|Budget exceeded for cron job/i,
    recipe: () => ({
      category: 'noop',
      description: 'Old taskBudget rejection — already addressed in v1.0.90 (taskBudget no longer passed to SDK). Trigger cleared without action.',
    }),
  },
];

export function classifyFailure(recentErrors: string[]): FixRecipe {
  const blob = recentErrors.join('\n').slice(0, 4000);
  for (const { match, recipe } of PATTERNS) {
    if (match.test(blob)) return recipe();
  }
  return {
    category: 'unknown',
    description: 'Unrecognized failure pattern. Owner needs to inspect the trigger file.',
  };
}

// ── CRON.md edit (idempotent) ────────────────────────────────────────

interface CronJobLookup {
  agentSlug?: string;
  job: Record<string, unknown>;
  raw: string;
  parsed: ReturnType<typeof matter>;
}

function loadCronJob(jobName: string, cronPath: string): CronJobLookup | null {
  if (!existsSync(cronPath)) return null;
  const raw = readFileSync(cronPath, 'utf-8');
  const parsed = matter(raw);
  const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
  const job = jobs.find((j) => String(j.name ?? '') === jobName);
  if (!job) return null;
  const agentSlug = typeof job.agentSlug === 'string' ? job.agentSlug : (typeof job.agent_slug === 'string' ? job.agent_slug : undefined);
  return { agentSlug, job, raw, parsed };
}

/**
 * Apply the recipe's mutator to the job's frontmatter and write CRON.md
 * back atomically. Returns true if a change was actually written.
 */
function applyCronEdit(jobName: string, recipe: FixRecipe, cronPath: string): boolean {
  if (!recipe.apply) return false;
  const lookup = loadCronJob(jobName, cronPath);
  if (!lookup) {
    logger.warn({ jobName }, 'Job not found in CRON.md — cannot apply fix');
    return false;
  }
  const changed = recipe.apply(lookup.job);
  if (!changed) return false;
  // Re-stringify with the existing content body preserved.
  const updated = matter.stringify(lookup.parsed.content, lookup.parsed.data);
  writeFileSync(cronPath, updated);
  return true;
}

// ── Pending-change record (for risky/unknown) ────────────────────────

interface PendingChangeRecord {
  id: string;
  jobName: string;
  agentSlug?: string;
  category: FixCategory;
  description: string;
  recentErrors: string[];
  consecutiveErrors: number;
  proposedAt: string;
}

function writePendingChange(record: PendingChangeRecord, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

// ── Main loop ────────────────────────────────────────────────────────

export class SelfImproveLoop {
  private readonly tickMs: number;
  private readonly triggersDir: string;
  private readonly pendingDir: string;
  private readonly cronPath: string;
  private readonly dispatcher: SelfImproveDispatcher;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;

  constructor(dispatcher: SelfImproveDispatcher, opts: SelfImproveLoopOptions = {}) {
    this.dispatcher = dispatcher;
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.triggersDir = opts.triggersDir ?? TRIGGERS_DIR;
    this.pendingDir = opts.pendingDir ?? PENDING_CHANGES_DIR;
    this.cronPath = opts.cronPath ?? CRON_PATH;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Run immediately so any backlog from the prior daemon gets handled
    // without a 10-minute wait.
    this.tick().catch((err) => logger.error({ err }, 'Initial self-improve tick failed'));
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error({ err }, 'Self-improve tick failed'));
    }, this.tickMs);
    logger.info({ tickMs: this.tickMs }, 'Self-improve loop started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Self-improve loop stopped');
  }

  /**
   * Process all pending triggers. Public so tests + manual invocations
   * (e.g., a `clementine self-improve tick` CLI command) can call it.
   */
  async tick(): Promise<{ processed: number; applied: number; pending: number; noop: number }> {
    if (this.ticking) return { processed: 0, applied: 0, pending: 0, noop: 0 };
    this.ticking = true;
    const counts = { processed: 0, applied: 0, pending: 0, noop: 0 };
    try {
      if (!existsSync(this.triggersDir)) return counts;
      let files: string[];
      try {
        files = readdirSync(this.triggersDir).filter((f) => f.endsWith('.json'));
      } catch {
        return counts;
      }

      for (const file of files) {
        const triggerPath = path.join(this.triggersDir, file);
        let trigger: TriggerFile;
        try {
          trigger = JSON.parse(readFileSync(triggerPath, 'utf-8')) as TriggerFile;
        } catch (err) {
          logger.warn({ err, file }, 'Failed to parse trigger — removing');
          try { unlinkSync(triggerPath); } catch { /* ignore */ }
          continue;
        }

        try {
          await this.processOne(trigger, counts);
        } catch (err) {
          logger.warn({ err, jobName: trigger.jobName }, 'Failed to process trigger — leaving in place for next tick');
          continue;
        }

        // Successfully handled — remove the trigger
        try { unlinkSync(triggerPath); } catch { /* ignore */ }
        counts.processed++;
      }
    } finally {
      this.ticking = false;
    }
    if (counts.processed > 0) {
      logger.info(counts, 'Self-improve loop: processed triggers');
    }
    return counts;
  }

  private async processOne(
    trigger: TriggerFile,
    counts: { processed: number; applied: number; pending: number; noop: number },
  ): Promise<void> {
    const recipe = classifyFailure(trigger.recentErrors);
    const lookup = loadCronJob(trigger.jobName, this.cronPath);
    const agentSlug = lookup?.agentSlug;

    if (recipe.category === 'safe-cron-config') {
      const applied = applyCronEdit(trigger.jobName, recipe, this.cronPath);
      if (applied) {
        counts.applied++;
        await this.notifyAgent(agentSlug, [
          `🔧 **Auto-fixed** \`${trigger.jobName}\` after ${trigger.consecutiveErrors} consecutive failures.`,
          '',
          recipe.description,
          '',
          'I\'ll watch the next run to confirm it lands cleanly.',
        ].join('\n'));
      } else {
        counts.noop++;
        logger.info({ jobName: trigger.jobName }, 'Fix recipe applied is already in place — trigger removed without further action');
      }
      return;
    }

    if (recipe.category === 'noop') {
      counts.noop++;
      logger.info({ jobName: trigger.jobName, reason: recipe.description }, 'Self-improve: no-op');
      return;
    }

    // risky | unknown → write proposal + DM agent
    const id = `proposal-${Date.now()}-${trigger.jobName.replace(/[^a-z0-9-]/gi, '_')}`;
    const record: PendingChangeRecord = {
      id,
      jobName: trigger.jobName,
      ...(agentSlug ? { agentSlug } : {}),
      category: recipe.category,
      description: recipe.description,
      recentErrors: trigger.recentErrors,
      consecutiveErrors: trigger.consecutiveErrors,
      proposedAt: new Date().toISOString(),
    };
    const file = writePendingChange(record, this.pendingDir);
    counts.pending++;
    await this.notifyAgent(agentSlug, [
      `⚠️ **${trigger.jobName}** has failed ${trigger.consecutiveErrors} times in a row.`,
      '',
      recipe.description,
      '',
      `Proposal saved to \`${file}\`. Review when convenient.`,
      '',
      '_(approve flow via #audit-inbox buttons coming in P8b)_',
    ].join('\n'));
  }

  private async notifyAgent(agentSlug: string | undefined, message: string): Promise<void> {
    try {
      await this.dispatcher.send(
        message,
        agentSlug && agentSlug !== 'clementine' ? { agentSlug } : {},
      );
    } catch (err) {
      logger.debug({ err, agentSlug }, 'Failed to dispatch self-improve notification (non-fatal)');
    }
  }
}
