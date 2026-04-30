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
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import { AGENTS_DIR, BASE_DIR, SYSTEM_DIR } from '../config.js';

const logger = pino({ name: 'clementine.self-improve-loop' });

/**
 * Fallback tick interval. The loop is primarily event-driven via fs.watch
 * on the triggers directory — this is just a slow safety net for cases
 * where fs.watch dropped an event (rare but possible) or where the
 * daemon booted with triggers already in place from before fs.watch was
 * registered. 1h is plenty: the upstream cron scheduler runs at most
 * once per minute, and a job needs 3+ consecutive errors to even produce
 * a trigger, so the situation is already hours-stale by the time we see
 * a trigger.
 */
const FALLBACK_TICK_MS = 60 * 60 * 1000;

/** Coalesce a burst of fs.watch events into a single tick. */
const WATCH_DEBOUNCE_MS = 2000;
const TRIGGERS_DIR = path.join(BASE_DIR, 'self-improve', 'triggers');
const PENDING_CHANGES_DIR = path.join(BASE_DIR, 'self-improve', 'pending-changes');
const CRON_PATH = path.join(SYSTEM_DIR, 'CRON.md');
const AGENTS_ROOT = AGENTS_DIR;

// ── Types ────────────────────────────────────────────────────────────

export interface TriggerFile {
  jobName: string;
  /**
   * Bare job name (without `{agentSlug}:` prefix). Set by cron-scheduler
   * for agent-scoped jobs so the loop can look the job up in
   * agents/{agentSlug}/CRON.md. Optional for backward compat with
   * triggers written before this field existed.
   */
  bareName?: string;
  /**
   * Owning agent slug, set by cron-scheduler. When present, the loop
   * applies fixes to vault/00-System/agents/{agentSlug}/CRON.md instead
   * of the central CRON.md. Falls back to scanning if absent (older triggers).
   */
  agentSlug?: string;
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
   * Frontmatter keys this recipe may touch. Used to snapshot prior values
   * before apply() runs so an ineffective fix can be reverted by post-fix
   * verification without restoring fields the recipe never owned. Required
   * for safe-cron-config recipes that participate in autoApply verification.
   */
  fields?: readonly string[];
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
  /**
   * Override the fallback safety-net tick interval. The loop is primarily
   * event-driven; this is just a backstop. Used by tests to disable the
   * timer entirely (set to 0 or a very large number).
   */
  tickMs?: number;
  /** Override directories for tests. */
  triggersDir?: string;
  pendingDir?: string;
  cronPath?: string;
  /**
   * Override the agents root (vault/00-System/agents). When a trigger
   * has agentSlug, the loop reads/writes `${agentsDir}/${agentSlug}/CRON.md`.
   */
  agentsDir?: string;
  /**
   * Disable the fs.watch event-driven path. Tests use this so they can
   * call tick() directly without racing the watcher.
   */
  disableWatch?: boolean;
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
      fields: ['mode', 'max_hours'] as const,
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
  /** Path to the CRON.md the job was found in (central or agent-scoped). */
  cronPath: string;
  /** The bare name as written in that file (no agent prefix). */
  bareName: string;
  job: Record<string, unknown>;
  raw: string;
  parsed: ReturnType<typeof matter>;
}

function readJobsFromFile(cronPath: string): {
  raw: string;
  parsed: ReturnType<typeof matter>;
  jobs: Array<Record<string, unknown>>;
} | null {
  if (!existsSync(cronPath)) return null;
  const raw = readFileSync(cronPath, 'utf-8');
  const parsed = matter(raw);
  const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
  return { raw, parsed, jobs };
}

function readAgentSlug(job: Record<string, unknown>): string | undefined {
  if (typeof job.agentSlug === 'string') return job.agentSlug;
  if (typeof job.agent_slug === 'string') return job.agent_slug;
  return undefined;
}

/**
 * Locate a job's frontmatter entry in either the central CRON.md or an
 * agent-scoped CRON.md. Search priority:
 *
 *   1. If trigger.agentSlug is set, look in agents/{slug}/CRON.md by bareName.
 *   2. Otherwise look in central CRON.md by exact name.
 *   3. Fall back to scanning agents/* for the bareName (covers older triggers
 *      that lack agentSlug — the cron-scheduler-prefixed jobName like
 *      `slug:name` lets us recover the slug).
 */
function loadCronJob(
  trigger: Pick<TriggerFile, 'jobName' | 'bareName' | 'agentSlug'>,
  cronPath: string,
  agentsDir: string,
): CronJobLookup | null {
  const explicitSlug = trigger.agentSlug;
  const bare = trigger.bareName ?? (
    explicitSlug && trigger.jobName.startsWith(`${explicitSlug}:`)
      ? trigger.jobName.slice(explicitSlug.length + 1)
      : trigger.jobName
  );

  // 1. Agent-scoped file when slug is known
  if (explicitSlug) {
    const agentCronPath = path.join(agentsDir, explicitSlug, 'CRON.md');
    const file = readJobsFromFile(agentCronPath);
    if (file) {
      const job = file.jobs.find((j) => String(j.name ?? '') === bare);
      if (job) {
        return {
          agentSlug: explicitSlug,
          cronPath: agentCronPath,
          bareName: bare,
          job,
          raw: file.raw,
          parsed: file.parsed,
        };
      }
    }
  }

  // 2. Central CRON.md by full jobName (handles globally-defined jobs and
  //    legacy jobs tagged with agentSlug field directly in the central file)
  const central = readJobsFromFile(cronPath);
  if (central) {
    const job = central.jobs.find((j) => String(j.name ?? '') === trigger.jobName);
    if (job) {
      return {
        agentSlug: explicitSlug ?? readAgentSlug(job),
        cronPath,
        bareName: String(job.name ?? ''),
        job,
        raw: central.raw,
        parsed: central.parsed,
      };
    }
  }

  // 3. Recover via scan: trigger jobName follows `{slug}:{bareName}` for
  //    agent-scoped jobs even when older triggers omit agentSlug.
  if (!explicitSlug && trigger.jobName.includes(':')) {
    const [slug, ...rest] = trigger.jobName.split(':');
    const inferredBare = rest.join(':');
    if (slug && inferredBare) {
      const agentCronPath = path.join(agentsDir, slug, 'CRON.md');
      const file = readJobsFromFile(agentCronPath);
      if (file) {
        const job = file.jobs.find((j) => String(j.name ?? '') === inferredBare);
        if (job) {
          return {
            agentSlug: slug,
            cronPath: agentCronPath,
            bareName: inferredBare,
            job,
            raw: file.raw,
            parsed: file.parsed,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Apply the recipe's mutator to the job's frontmatter and write the CRON.md
 * (central or agent-scoped, whichever the lookup resolved to) back atomically.
 * Returns the captured prevFields snapshot when a change was written, or
 * null when no change was needed (idempotent re-apply). prevFields uses
 * `null` to represent "field was absent before the fix" — the revert path
 * deletes the key in that case.
 */
function applyCronEdit(
  lookup: CronJobLookup,
  recipe: FixRecipe,
): Record<string, unknown> | null {
  if (!recipe.apply) return null;
  // Snapshot only the fields the recipe declared it would touch — over-broad
  // snapshots would clobber concurrent edits during a revert.
  const prevFields: Record<string, unknown> = {};
  for (const key of recipe.fields ?? []) {
    prevFields[key] = key in lookup.job ? lookup.job[key] : null;
  }
  const changed = recipe.apply(lookup.job);
  if (!changed) return null;
  const updated = matter.stringify(lookup.parsed.content, lookup.parsed.data);
  writeFileSync(lookup.cronPath, updated);
  return prevFields;
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
  private readonly agentsDir: string;
  private readonly dispatcher: SelfImproveDispatcher;
  private readonly watchEnabled: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;

  constructor(dispatcher: SelfImproveDispatcher, opts: SelfImproveLoopOptions = {}) {
    this.dispatcher = dispatcher;
    this.tickMs = opts.tickMs ?? FALLBACK_TICK_MS;
    this.triggersDir = opts.triggersDir ?? TRIGGERS_DIR;
    this.pendingDir = opts.pendingDir ?? PENDING_CHANGES_DIR;
    this.cronPath = opts.cronPath ?? CRON_PATH;
    this.agentsDir = opts.agentsDir ?? AGENTS_ROOT;
    this.watchEnabled = opts.disableWatch !== true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Run immediately so any backlog from the prior daemon gets handled
    // without a long wait.
    this.tick().catch((err) => logger.error({ err }, 'Initial self-improve tick failed'));

    // Event-driven primary path: watch the triggers dir. cron-scheduler
    // writes a file when a job hits consErrors >= 3; we react within
    // ~2 seconds (debounce window) instead of polling every 10 minutes
    // for a directory that's empty 99% of the time.
    if (this.watchEnabled) {
      try {
        mkdirSync(this.triggersDir, { recursive: true });
        this.watcher = watch(this.triggersDir, (eventType, filename) => {
          if (eventType !== 'rename' || !filename || !filename.endsWith('.json')) return;
          this.scheduleDebouncedTick();
        });
      } catch (err) {
        logger.warn({ err, dir: this.triggersDir }, 'Failed to watch triggers dir — falling back to polling only');
      }
    }

    // Slow fallback safety net — covers fs.watch event drops + boot-with-backlog.
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error({ err }, 'Self-improve fallback tick failed'));
    }, this.tickMs);

    logger.info(
      { fallbackTickMs: this.tickMs, watchEnabled: this.watchEnabled && this.watcher !== null },
      'Self-improve loop started',
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    logger.info('Self-improve loop stopped');
  }

  /** Coalesce a burst of fs.watch events (multiple triggers landing in
   * quick succession) into a single tick. */
  private scheduleDebouncedTick(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tick().catch((err) => logger.error({ err }, 'Self-improve event-driven tick failed'));
    }, WATCH_DEBOUNCE_MS);
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
    const lookup = loadCronJob(trigger, this.cronPath, this.agentsDir);
    const agentSlug = trigger.agentSlug ?? lookup?.agentSlug;

    if (recipe.category === 'safe-cron-config') {
      if (!lookup) {
        // Job vanished from CRON files (renamed/deleted). Nothing to fix.
        counts.noop++;
        logger.warn({ jobName: trigger.jobName, agentSlug }, 'Job not found in any CRON.md — cannot apply fix');
        return;
      }
      const prevFields = applyCronEdit(lookup, recipe);
      if (prevFields) {
        counts.applied++;

        // Register the edit for post-fix verification. The verifier watches
        // the next AUTOAPPLY_VERDICT_WINDOW non-skipped runs and reverts
        // prevFields if 0 succeed. Lazy import avoids pulling the gateway
        // graph into the agent layer at module-load time.
        try {
          const { recordAutoApplyForVerification } = await import('../gateway/fix-verification.js');
          recordAutoApplyForVerification(trigger.jobName, {
            kind: 'cron-config',
            file: lookup.cronPath,
            bareName: lookup.bareName,
            prevFields,
          });
        } catch (err) {
          logger.warn({ err, jobName: trigger.jobName }, 'Failed to register cron-config autoApply for verification (non-fatal)');
        }

        const where = lookup.agentSlug
          ? `\`agents/${lookup.agentSlug}/CRON.md\``
          : '`CRON.md`';
        await this.notifyAgent(agentSlug, [
          `🔧 **Auto-fixed** \`${trigger.jobName}\` after ${trigger.consecutiveErrors} consecutive failures.`,
          '',
          recipe.description,
          '',
          `Edit applied to ${where}. Verifying over the next 3 runs — I'll revert automatically if it doesn't help.`,
        ].join('\n'));
      } else {
        counts.noop++;
        logger.info({ jobName: trigger.jobName, agentSlug }, 'Fix recipe applied is already in place — trigger removed without further action');
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
