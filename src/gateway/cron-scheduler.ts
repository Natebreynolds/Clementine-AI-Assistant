/**
 * Clementine TypeScript — Cron scheduler (autonomous execution).
 *
 * CronScheduler: precise scheduled tasks using node-cron
 *
 * Also contains shared parsers (parseCronJobs, parseAgentCronJobs, validateCronYaml),
 * retry helpers, CronRunLog, and daily-note logging utilities used by both schedulers.
 */

import { execSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import matter from 'gray-matter';
import pino from 'pino';
import {
  CRON_FILE,
  WORKFLOWS_DIR,
  AGENTS_DIR,
  DAILY_NOTES_DIR,
  BASE_DIR,
  DISCORD_OWNER_ID,
  GOALS_DIR,
  CRON_REFLECTIONS_DIR,
  ADVISOR_LOG_PATH,
  TIMEZONE,
} from '../config.js';
import type { CronJobDefinition, CronRunEntry, SelfImproveConfig, SelfImproveExperiment, SelfImproveState, WorkflowDefinition } from '../types.js';
import type { NotificationDispatcher } from './notifications.js';
import type { Gateway } from './router.js';
import { scanner } from '../security/scanner.js';
import { parseAllWorkflows as parseAllWorkflowsSync } from '../agent/workflow-runner.js';
import { SelfImproveLoop } from '../agent/self-improve.js';

const logger = pino({ name: 'clementine.cron' });

/** Default timeout for standard cron jobs (10 minutes). */
const CRON_STANDARD_TIMEOUT_MS = 10 * 60 * 1000;

/** Timezone for cron scheduling — uses config (user-overridable) or system-detected. */
const SYSTEM_TIMEZONE = TIMEZONE;

// ── Daily Note Activity Logger ───────────────────────────────────────

/** Local-time YYYY-MM-DD for daily note path. */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Append a line to today's daily note under ## Interactions.
 * Creates the section if it doesn't exist. Non-fatal — never throws.
 */
export function logToDailyNote(line: string): void {
  try {
    const notePath = path.join(DAILY_NOTES_DIR, `${todayISO()}.md`);
    if (!existsSync(notePath)) return; // template hasn't created the note yet

    let content = readFileSync(notePath, 'utf-8');
    const marker = '## Interactions';
    const idx = content.indexOf(marker);
    if (idx === -1) {
      // No Interactions section — append one
      content += `\n\n${marker}\n\n- ${line}`;
    } else {
      // Find the end of the marker line and insert after it
      const afterMarker = idx + marker.length;
      const nextNewline = content.indexOf('\n', afterMarker);
      const insertAt = nextNewline === -1 ? content.length : nextNewline;
      const nextSection = content.indexOf('\n## ', insertAt + 1);
      // Insert at the end of the section (before next ## or EOF)
      const insertPoint = nextSection === -1 ? content.length : nextSection;
      content = content.slice(0, insertPoint) + `\n- ${line}` + content.slice(insertPoint);
    }
    writeFileSync(notePath, content);
  } catch (err) {
    logger.warn({ err }, 'Daily note logging failed');
  }
}

// ── Shared CRON.md parser ────────────────────────────────────────────

/**
 * Parse cron job definitions from vault/00-System/CRON.md frontmatter.
 * Used by both the in-process CronScheduler and the standalone CLI runner.
 */
export function parseCronJobs(): CronJobDefinition[] {
  if (!existsSync(CRON_FILE)) return [];

  const raw = readFileSync(CRON_FILE, 'utf-8');
  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    logger.error({ err }, 'CRON.md YAML parse error — keeping previous jobs. Fix the file manually.');
    return [];
  }
  const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
  const jobs: CronJobDefinition[] = [];

  for (const job of jobDefs) {
    const name = String(job.name ?? '');
    const schedule = String(job.schedule ?? '');
    const prompt = String(job.prompt ?? '');
    const enabled = job.enabled !== false;
    const tier = Number(job.tier ?? 1);
    const maxTurns = job.max_turns != null ? Number(job.max_turns) : undefined;
    const model = job.model != null ? String(job.model) : undefined;
    const workDir = job.work_dir != null ? String(job.work_dir) : undefined;
    const mode = job.mode === 'unleashed' ? 'unleashed' as const : 'standard' as const;
    const maxHours = job.max_hours != null ? Number(job.max_hours) : undefined;
    const maxRetries = job.max_retries != null ? Number(job.max_retries) : undefined;
    const after = job.after != null ? String(job.after) : undefined;
    const successCriteria = Array.isArray(job.success_criteria)
      ? (job.success_criteria as unknown[]).map(c => String(c))
      : undefined;
    const alwaysDeliver = job.always_deliver === true ? true : undefined;
    const preCheck = job.pre_check != null ? String(job.pre_check) : undefined;

    if (!name || !schedule || !prompt) {
      logger.warn({ job }, 'Skipping malformed cron job');
      continue;
    }

    jobs.push({ name, schedule, prompt, enabled, tier, maxTurns, model, workDir, mode, maxHours, maxRetries, after, successCriteria, alwaysDeliver, preCheck });
  }

  return jobs;
}

/**
 * Parse cron jobs from agent-scoped CRON.md files.
 * Scans each agent subdirectory for CRON.md, prefixes job names with agent slug.
 */
export function parseAgentCronJobs(agentsDir: string): CronJobDefinition[] {
  if (!existsSync(agentsDir)) return [];

  const allJobs: CronJobDefinition[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(agentsDir, { withFileTypes: true } as any)
      .filter((d: any) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d: any) => d.name);
  } catch {
    return [];
  }

  for (const slug of dirs) {
    const cronFile = path.join(agentsDir, slug, 'CRON.md');
    if (!existsSync(cronFile)) continue;

    try {
      const raw = readFileSync(cronFile, 'utf-8');
      const parsed = matter(raw);
      const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;

      for (const job of jobDefs) {
        const name = String(job.name ?? '');
        const schedule = String(job.schedule ?? '');
        const prompt = String(job.prompt ?? '');
        const enabled = job.enabled !== false;
        const tier = Number(job.tier ?? 1);
        const maxTurns = job.max_turns != null ? Number(job.max_turns) : undefined;
        const model = job.model != null ? String(job.model) : undefined;
        const workDir = job.work_dir != null ? String(job.work_dir) : undefined;
        const mode = job.mode === 'unleashed' ? 'unleashed' as const : 'standard' as const;
        const maxHours = job.max_hours != null ? Number(job.max_hours) : undefined;
        const maxRetries = job.max_retries != null ? Number(job.max_retries) : undefined;
        const after = job.after != null ? String(job.after) : undefined;
        const successCriteria = Array.isArray(job.success_criteria)
          ? (job.success_criteria as unknown[]).map(c => String(c))
          : undefined;
        const preCheck = job.pre_check != null ? String(job.pre_check) : undefined;

        if (!name || !schedule || !prompt) {
          logger.warn({ job, agent: slug }, 'Skipping malformed agent cron job');
          continue;
        }

        // Prefix name with agent slug and tag with agentSlug
        allJobs.push({
          name: `${slug}:${name}`,
          schedule, prompt, enabled, tier, maxTurns, model, workDir,
          mode, maxHours, maxRetries, after, successCriteria, preCheck,
          agentSlug: slug,
        });
      }
    } catch (err) {
      logger.error({ err, agent: slug }, `Agent ${slug} CRON.md parse error — skipping`);
    }
  }

  return allJobs;
}

/**
 * Validate that a CRON.md string parses without YAML errors.
 * Call this before writing to prevent corrupted files from crashing the daemon.
 * Returns null on success, or the error message on failure.
 */
export function validateCronYaml(content: string): string | null {
  try {
    matter(content);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── Retry / backoff ──────────────────────────────────────────────────

/** Exponential backoff schedule in ms: 30s, 1m, 5m, 15m, 60m */
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/** Patterns that indicate a transient (retryable) error. */
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /5\d\d/,
  /overloaded/i,
  /temporarily unavailable/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /service.?unavailable/i,
  /capacity/i,
  /try again/i,
];

export function classifyError(err: unknown): 'transient' | 'permanent' {
  const msg = String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg)) ? 'transient' : 'permanent';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Run history logging ──────────────────────────────────────────────

/**
 * JSONL-based per-job run log.  Auto-prunes to keep files under 2 MB
 * and 2000 lines (whichever limit hits first).
 */
export class CronRunLog {
  private readonly dir: string;
  private static readonly MAX_BYTES = 2_000_000;
  private static readonly MAX_LINES = 2000;

  constructor(baseDir?: string) {
    this.dir = path.join(baseDir ?? BASE_DIR, 'cron', 'runs');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private logPath(jobName: string): string {
    // Sanitize job name for filesystem
    const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  append(entry: CronRunEntry): void {
    const filePath = this.logPath(entry.jobName);
    const line = JSON.stringify(entry) + '\n';
    try {
      appendFileSync(filePath, line);
      // Schedule pruning asynchronously so it doesn't block the caller
      setImmediate(() => this.maybePrune(filePath));
    } catch (err) {
      logger.warn({ err, job: entry.jobName }, 'Failed to write run log');
    }
  }

  readRecent(jobName: string, count = 20): CronRunEntry[] {
    const filePath = this.logPath(jobName);
    if (!existsSync(filePath)) return [];

    try {
      const lines = readFileSync(filePath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      return lines
        .slice(-count)
        .map((l) => JSON.parse(l) as CronRunEntry)
        .reverse(); // newest first
    } catch {
      return [];
    }
  }

  consecutiveErrors(jobName: string): number {
    const recent = this.readRecent(jobName, 10);
    let count = 0;
    for (const entry of recent) {
      if (entry.status === 'ok') break;
      count++;
    }
    return count;
  }

  private maybePrune(filePath: string): void {
    try {
      const { size } = statSync(filePath);
      if (size <= CronRunLog.MAX_BYTES) return;

      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      if (lines.length <= CronRunLog.MAX_LINES) return;

      // Keep the most recent MAX_LINES entries
      const trimmed = lines.slice(-CronRunLog.MAX_LINES);
      writeFileSync(filePath, trimmed.join('\n') + '\n');
    } catch {
      // non-critical
    }
  }
}

// ── CronScheduler ─────────────────────────────────────────────────────

export class CronScheduler {
  private gateway: Gateway;
  private dispatcher: NotificationDispatcher;
  private jobs: CronJobDefinition[] = [];
  private disabledJobs = new Set<string>();
  private scheduledTasks = new Map<string, cron.ScheduledTask>();
  private runningJobs = new Set<string>();
  private completedJobs = new Map<string, number>(); // jobName → completion timestamp
  private watching = false;
  readonly runLog: CronRunLog;

  // Workflow support
  private workflowDefs: WorkflowDefinition[] = [];
  private workflowTasks = new Map<string, cron.ScheduledTask>();
  private runningWorkflows = new Set<string>();
  private watchingWorkflows = false;

  // Trigger directory for MCP-initiated job runs
  private triggerDir = path.join(BASE_DIR, 'cron', 'triggers');
  private goalTriggerDir = path.join(BASE_DIR, 'cron', 'goal-triggers');
  private triggerTimer: ReturnType<typeof setInterval> | null = null;

  // Event-driven status change listeners (used by Discord status embed)
  private statusChangeListeners: Array<() => void> = [];

  constructor(gateway: Gateway, dispatcher: NotificationDispatcher) {
    this.gateway = gateway;
    this.dispatcher = dispatcher;
    this.runLog = new CronRunLog();
    // Eagerly load job definitions (without scheduling) so they're
    // available for queries before start() is called — agent bots
    // query jobs on connect which happens before start().
    this.loadJobDefinitions();
  }

  /** Load job definitions from CRON.md and agent dirs without scheduling tasks. */
  private loadJobDefinitions(): void {
    this.jobs = parseCronJobs();
    const agentJobs = parseAgentCronJobs(AGENTS_DIR);
    if (agentJobs.length > 0) {
      this.jobs.push(...agentJobs);
    }
  }

  /** Register a listener that fires when system state changes (job start/finish, self-improve, etc). */
  onStatusChange(cb: () => void): void {
    this.statusChangeListeners.push(cb);
  }

  private emitStatusChange(): void {
    for (const cb of this.statusChangeListeners) {
      try { cb(); } catch { /* ignore listener errors */ }
    }
  }

  start(): void {
    this.reloadJobs();
    this.reloadWorkflows();
    this.watchCronFile();
    this.watchAgentsDir();
    this.watchWorkflowDir();

    this.watchTriggers();

    // Wire up push notifications for unleashed task completions
    this.gateway.setUnleashedCompleteCallback((jobName, result) => {
      this.completedJobs.set(jobName, Date.now());
      if (result && result !== '__NOTHING__') {
        const slug = jobName.includes(':') ? jobName.split(':')[0] : undefined;
        this.dispatcher.send(`✅ Unleashed task **${jobName}** completed:\n\n${result.slice(0, 1500)}`, { agentSlug: slug }).catch(() => {});
      }
    });

    // Wire up phase progress notifications for unleashed tasks
    this.gateway.setPhaseCompleteCallback((jobName, phase, _total, output) => {
      const preview = output.slice(0, 500);
      const slug = jobName.includes(':') ? jobName.split(':')[0] : undefined;
      this.dispatcher.send(`⏳ **${jobName}** — phase ${phase} complete:\n${preview}`, { agentSlug: slug }).catch(() => {});
    });

    // Wire up real-time progress summaries (throttled to max 1/minute)
    const lastProgressSent = new Map<string, number>();
    this.gateway.setPhaseProgressCallback((jobName, phase, summary) => {
      const now = Date.now();
      const lastSent = lastProgressSent.get(jobName) ?? 0;
      if (now - lastSent < 60_000) return; // throttle: 1 per minute
      lastProgressSent.set(jobName, now);
      const slug = jobName.includes(':') ? jobName.split(':')[0] : undefined;
      this.dispatcher.send(`📊 **${jobName}** (phase ${phase}): ${summary.slice(0, 300)}`, { agentSlug: slug }).catch(() => {});
    });

    logger.info(`Cron scheduler started with ${this.jobs.length} jobs`);
  }

  stop(): void {
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();
    for (const [name, task] of this.workflowTasks) {
      task.stop();
      logger.debug(`Stopped workflow task: ${name}`);
    }
    this.workflowTasks.clear();
    this.unwatchCronFile();
    this.unwatchAgentsDir();
    this.unwatchWorkflowDir();
    if (this.triggerTimer) {
      clearInterval(this.triggerTimer);
      this.triggerTimer = null;
    }
    logger.info('Cron scheduler stopped');
  }

  /** Watch CRON.md for changes and auto-reload jobs. */
  private watchCronFile(): void {
    if (this.watching) return;
    if (!existsSync(CRON_FILE)) return;

    watchFile(CRON_FILE, { interval: 2000 }, () => {
      logger.info('CRON.md changed — reloading jobs');
      try {
        this.reloadJobs();
        scanner.refreshIntegrity(); // CRON.md change is legitimate
        logger.info(`Cron scheduler reloaded: ${this.jobs.length} jobs`);
      } catch (err) {
        logger.error({ err }, 'Failed to reload CRON.md — keeping previous schedule');
      }
    });
    this.watching = true;
  }

  private unwatchCronFile(): void {
    if (!this.watching) return;
    try {
      unwatchFile(CRON_FILE);
    } catch { /* ignore */ }
    this.watching = false;
  }

  /** Watch agents directory for cron/workflow changes and auto-reload. */
  private watchingAgents = false;

  private watchAgentsDir(): void {
    if (this.watchingAgents) return;
    if (!existsSync(AGENTS_DIR)) return;

    watchFile(AGENTS_DIR, { interval: 5000 }, () => {
      logger.info('Agents directory changed — reloading jobs and workflows');
      try {
        this.reloadJobs();
        this.reloadWorkflows();
        scanner.refreshIntegrity();
      } catch (err) {
        logger.error({ err }, 'Failed to reload agent configs');
      }
    });
    this.watchingAgents = true;
  }

  private unwatchAgentsDir(): void {
    if (!this.watchingAgents) return;
    try {
      unwatchFile(AGENTS_DIR);
    } catch { /* ignore */ }
    this.watchingAgents = false;
  }

  reloadJobs(): void {
    // Stop existing scheduled tasks (but NOT the file watcher)
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();

    this.jobs = parseCronJobs();

    // Evict stale entries from disabledJobs and completedJobs for removed jobs
    const currentJobNames = new Set(this.jobs.map(j => j.name));
    for (const name of this.disabledJobs) {
      if (!currentJobNames.has(name)) this.disabledJobs.delete(name);
    }
    const MAX_COMPLETED_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
    const now = Date.now();
    for (const [name, ts] of this.completedJobs) {
      if (!currentJobNames.has(name) || now - ts > MAX_COMPLETED_AGE_MS) {
        this.completedJobs.delete(name);
      }
    }

    // Merge in agent-scoped cron jobs
    const agentJobs = parseAgentCronJobs(AGENTS_DIR);
    if (agentJobs.length > 0) {
      this.jobs.push(...agentJobs);
      logger.info(`Loaded ${agentJobs.length} agent-scoped cron job(s)`);
    }

    if (this.jobs.length === 0) {
      logger.info('No CRON.md found or no jobs defined');
      return;
    }

    // ── Cycle detection for `after` chains (DFS) ──────────────────────
    const jobNames = new Set(this.jobs.map(j => j.name));
    const afterMap = new Map<string, string>(); // child → parent
    for (const def of this.jobs) {
      if (def.after) {
        if (!jobNames.has(def.after)) {
          logger.warn(`Job '${def.name}' references missing parent '${def.after}' — ignoring chain`);
          def.after = undefined;
        } else {
          afterMap.set(def.name, def.after);
        }
      }
    }

    // DFS cycle detection
    const cycledJobs = new Set<string>();
    for (const startName of afterMap.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = startName;
      while (current && afterMap.has(current)) {
        if (visited.has(current)) {
          // Cycle found — disable all jobs in the cycle
          for (const name of visited) cycledJobs.add(name);
          logger.error({ cycle: [...visited] }, `Circular dependency detected — disabling cycled jobs`);
          break;
        }
        visited.add(current);
        current = afterMap.get(current);
      }
    }

    for (const name of cycledJobs) {
      const job = this.jobs.find(j => j.name === name);
      if (job) {
        job.enabled = false;
        job.after = undefined;
        logger.error(`Disabled '${name}' due to circular chain dependency`);
      }
    }

    for (const def of this.jobs) {
      if (def.enabled && !this.disabledJobs.has(def.name)) {
        // Jobs with `after` are triggered by their parent — skip cron scheduling
        if (def.after) {
          logger.info(`Cron job '${def.name}' chained after '${def.after}' — skipping cron schedule`);
          continue;
        }

        if (!cron.validate(def.schedule)) {
          logger.error(`Invalid cron schedule for '${def.name}': ${def.schedule}`);
          continue;
        }

        const task = cron.schedule(def.schedule, () => {
          this.runJob(def).catch((err) => {
            logger.error({ err, job: def.name }, `Cron job '${def.name}' failed`);
          });
        }, { timezone: SYSTEM_TIMEZONE });
        this.scheduledTasks.set(def.name, task);
        logger.info(`Cron job '${def.name}' scheduled: ${def.schedule} (${SYSTEM_TIMEZONE})`);
      }
    }
  }

  private async runJob(job: CronJobDefinition): Promise<void> {
    // Agent status check — skip if agent is paused/terminated
    if (job.agentSlug) {
      const agentMgr = this.gateway?.getAgentManager?.();
      if (agentMgr && !agentMgr.isRunnable(job.agentSlug)) {
        const agent = agentMgr.get(job.agentSlug);
        logger.info({ job: job.name, status: agent?.status }, `Agent '${job.agentSlug}' is ${agent?.status ?? 'unknown'} — skipping cron job`);
        return;
      }
      // Budget check — skip if over monthly budget
      if (agentMgr) {
        const agent = agentMgr.get(job.agentSlug);
        if (agent?.budgetMonthlyCents && agent.budgetMonthlyCents > 0) {
          try {
            const { MemoryStore } = await import('../memory/store.js');
            const { MEMORY_DB_PATH, VAULT_DIR } = await import('../config.js');
            const { existsSync } = await import('node:fs');
            if (existsSync(MEMORY_DB_PATH)) {
              const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
              store.initialize();
              if (store.isOverBudget(job.agentSlug, agent.budgetMonthlyCents)) {
                logger.warn({ job: job.name, agentSlug: job.agentSlug, budget: agent.budgetMonthlyCents },
                  `Agent '${job.agentSlug}' is over monthly budget — skipping cron job`);
                store.close();
                return;
              }
              store.close();
            }
          } catch { /* budget check failed — allow job to run */ }
        }
      }
    }

    // Prevent concurrent runs of the same job
    if (this.runningJobs.has(job.name)) {
      logger.info(`Cron job '${job.name}' is already running — skipping this trigger`);
      return;
    }

    // Cooldown for unleashed jobs that completed recently
    const completedAt = this.completedJobs.get(job.name);
    if (completedAt) {
      const cooldownMs = (job.maxHours ?? 6) * 60 * 60 * 1000;
      if (Date.now() - completedAt < cooldownMs) {
        logger.info(`Cron job '${job.name}' completed recently — cooling down, skipping`);
        return;
      }
      this.completedJobs.delete(job.name);
    }

    // ── Pre-check gate: run shell command, skip job if exit non-zero ──
    if (job.preCheck) {
      try {
        const preCheckStart = Date.now();
        const stdout = execSync(job.preCheck, {
          timeout: 30_000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: job.workDir || undefined,
        }).trim();
        const preCheckMs = Date.now() - preCheckStart;
        logger.info({ job: job.name, preCheckMs, hasOutput: stdout.length > 0 }, 'Pre-check passed');

        // Inject pre-check output as context so the agent doesn't re-query
        if (stdout.length > 0) {
          job = { ...job, prompt: `Pre-check data (already fetched — use this, do not re-query):\n\`\`\`\n${stdout.slice(0, 4000)}\n\`\`\`\n\n${job.prompt}` };
        }
      } catch (preCheckErr: unknown) {
        // Non-zero exit or timeout → skip the job
        const exitCode = (preCheckErr as { status?: number }).status ?? 1;
        logger.info({ job: job.name, exitCode }, 'Pre-check failed — skipping job (no work to do)');
        this.runLog.append({
          jobName: job.name,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'skipped',
          durationMs: 0,
          attempt: 0,
          outputPreview: `Pre-check exit ${exitCode} — no work`,
        });
        return;
      }
    }

    // ── Adaptive execution: consult advisor before running ──
    const originalJob = job; // snapshot before mutation
    const { getExecutionAdvice } = await import('../agent/execution-advisor.js');
    const advice = getExecutionAdvice(job.name, job);

    if (advice.shouldSkip) {
      logger.info({ job: job.name, reason: advice.skipReason }, 'Execution advisor: circuit breaker — skipping job');
      this.runLog.append({
        jobName: job.name,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'skipped',
        durationMs: 0,
        attempt: 0,
        outputPreview: `Circuit breaker: ${advice.skipReason}`,
      });
      return;
    }

    // Apply advisor overrides to a mutable copy
    let advisorApplied: CronRunEntry['advisorApplied'] | undefined;
    if (advice.adjustedMaxTurns || advice.adjustedModel || advice.adjustedTimeoutMs || advice.promptEnrichment || advice.shouldEscalate) {
      job = { ...job };
      if (advice.adjustedMaxTurns) job.maxTurns = advice.adjustedMaxTurns;
      if (advice.adjustedModel) job.model = advice.adjustedModel;
      if (advice.shouldEscalate && job.mode !== 'unleashed') {
        job.mode = 'unleashed';
        logger.info({ job: job.name, reason: advice.escalationReason }, 'Execution advisor: escalating to unleashed mode');
      }
      if (advice.promptEnrichment) {
        job.prompt = `## Lessons from Previous Runs\n${advice.promptEnrichment}\n\n${job.prompt}`;
      }
      advisorApplied = {
        adjustedMaxTurns: advice.adjustedMaxTurns ?? undefined,
        adjustedModel: advice.adjustedModel ?? undefined,
        adjustedTimeoutMs: advice.adjustedTimeoutMs ?? undefined,
        enriched: !!advice.promptEnrichment,
        escalated: advice.shouldEscalate,
      };
      logger.info({
        job: job.name,
        ...advisorApplied,
      }, 'Execution advisor applied overrides');
    }

    // Compute effective timeout: advisor override > standard default
    const effectiveTimeoutMs = job.mode !== 'unleashed'
      ? (advice.adjustedTimeoutMs ?? CRON_STANDARD_TIMEOUT_MS)
      : undefined;

    // Persist advisor decision for analytics
    if (advisorApplied) {
      try {
        mkdirSync(path.dirname(ADVISOR_LOG_PATH), { recursive: true });
        appendFileSync(ADVISOR_LOG_PATH, JSON.stringify({
          jobName: job.name,
          timestamp: new Date().toISOString(),
          advice,
          originalModel: originalJob.model,
          originalMaxTurns: originalJob.maxTurns,
        }) + '\n');
      } catch { /* non-fatal */ }
    }

    this.runningJobs.add(job.name);
    this.emitStatusChange();

    try {
      logger.info(`Running cron job: ${job.name}${job.agentSlug ? ` (agent: ${job.agentSlug})` : ''}`);

      // Set agent profile for scoped cron jobs
      const cronSessionKey = `cron:${job.name}`;
      if (job.agentSlug) {
        this.gateway.setSessionProfile(cronSessionKey, job.agentSlug);
      }

      // Unleashed tasks handle their own retries/phases internally — never retry the whole task
      const priorErrors = this.runLog.consecutiveErrors(job.name);
      const maxAttempts = job.mode === 'unleashed'
        ? 1
        : 1 + (job.maxRetries ?? Math.min(priorErrors, BACKOFF_MS.length));

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = new Date();
        try {
          // Standard cron jobs get a timeout via SDK AbortController (advisor may override)
          let response = await this.gateway.handleCronJob(
            job.name,
            job.prompt,
            job.tier,
            job.maxTurns,
            job.model,
            job.workDir,
            job.mode,
            job.maxHours,
            effectiveTimeoutMs,
            job.successCriteria,
          );

          // alwaysDeliver: retry once if the response is empty/noise
          if (job.alwaysDeliver && (!response || CronScheduler.isCronNoise(response))) {
            logger.info({ job: job.name }, 'alwaysDeliver: empty/noise response — retrying once');
            try {
              const retryResponse = await this.gateway.handleCronJob(
                job.name,
                job.prompt + '\n\nYou MUST produce a brief status update. Do NOT return __NOTHING__.',
                job.tier,
                job.maxTurns,
                job.model,
                job.workDir,
                job.mode,
                job.maxHours,
                effectiveTimeoutMs,
                job.successCriteria,
              );
              if (retryResponse && !CronScheduler.isCronNoise(retryResponse)) {
                response = retryResponse;
              } else {
                // Fallback: minimal check-in message
                response = `${job.name}: Checked in, nothing notable today.`;
              }
            } catch (retryErr) {
              logger.warn({ err: retryErr, job: job.name }, 'alwaysDeliver retry failed — using fallback');
              response = `${job.name}: Checked in, nothing notable today.`;
            }
          }

          // Success — log and dispatch
          const finishedAt = new Date();
          const entry: CronRunEntry = {
            jobName: job.name,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            status: 'ok',
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempt,
            outputPreview: response ? response.slice(0, 200) : undefined,
            advisorApplied,
          };

          if (response && !CronScheduler.isCronNoise(response) && job.mode !== 'unleashed') {
            // Strip internal thinking/process narration from Discord output
            const cleanedResponse = CronScheduler.stripThinkingPrefixes(response);
            const result = await this.dispatcher.send(cleanedResponse, { agentSlug: job.agentSlug });
            if (!result.delivered) {
              entry.deliveryFailed = true;
              entry.deliveryError = Object.values(result.channelErrors).join('; ').slice(0, 300);
              // Preserve more output when delivery fails so it's recoverable
              entry.outputPreview = response.slice(0, 2000);
              logger.warn({ job: job.name, errors: result.channelErrors }, 'Cron output not delivered to any channel');
            } else if (Object.keys(result.channelErrors).length > 0) {
              // Partial success — some channels failed. Log so broken channels are visible.
              entry.deliveryError = `partial: ${Object.entries(result.channelErrors).map(([ch, e]) => `${ch}: ${e}`).join('; ').slice(0, 300)}`;
              logger.warn({ job: job.name, errors: result.channelErrors }, 'Cron output delivered but some channels failed');
            }
            // Inject into owner's DM session so follow-up conversation has context
            if (DISCORD_OWNER_ID && DISCORD_OWNER_ID !== '0') {
              this.gateway.injectContext(
                `discord:user:${DISCORD_OWNER_ID}`,
                `[Scheduled cron: ${job.name}]`,
                response,
              );
            }
          }

          this.runLog.append(entry);

          // Fire-and-forget: extract procedural skill from successful long-running cron jobs
          if (entry.status === 'ok' && entry.durationMs > 30_000 && response && response.length > 500) {
            this.gateway.extractCronSkill(job.name, job.prompt, response, entry.durationMs, job.agentSlug)
              .catch(() => {});
          }

          // Log to daily note so end-of-day summary has data to work with
          const durationSec = Math.round(entry.durationMs / 1000);
          const preview = response ? response.slice(0, 100).replace(/\n/g, ' ') : 'no output';
          logToDailyNote(`**${job.name}** (${durationSec}s): ${preview}`);

          // Fire dependent chained jobs (async, non-blocking)
          const dependents = this.jobs.filter(j => j.after === job.name && j.enabled && !this.disabledJobs.has(j.name));
          for (const dep of dependents) {
            logger.info(`Chain: '${job.name}' succeeded — triggering '${dep.name}'`);
            this.runJob(dep).catch((err) => {
              logger.error({ err, job: dep.name }, `Chained job '${dep.name}' failed`);
            });
          }

          return; // done
        } catch (err) {
          const finishedAt = new Date();
          const errorType = classifyError(err);

          this.runLog.append({
            jobName: job.name,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            status: attempt < maxAttempts && errorType === 'transient' ? 'retried' : 'error',
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            error: String(err).slice(0, 1500),
            errorType,
            attempt,
            advisorApplied,
          });

          // Permanent error — stop immediately
          if (errorType === 'permanent') {
            logger.error({ err, job: job.name }, `Cron job '${job.name}' permanent error — not retrying`);
            await this.dispatcher.send(`${job.name} failed: ${err}`, { agentSlug: job.agentSlug });
            return;
          }

          // Transient — retry with backoff if attempts remain
          if (attempt < maxAttempts) {
            const backoffMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
            logger.warn(
              { job: job.name, attempt, backoffMs },
              `Cron job '${job.name}' transient error — retrying in ${backoffMs / 1000}s`,
            );
            await sleep(backoffMs);
          } else {
            logger.error({ err, job: job.name }, `Cron job '${job.name}' failed after ${attempt} attempt(s)`);
            await this.dispatcher.send(CronScheduler.formatCronError(job.name, err), { agentSlug: job.agentSlug });
          }
        }
      }
    } finally {
      this.runningJobs.delete(job.name);
      this.emitStatusChange();

      // Fire-and-forget: check if this agent's profile needs self-learning update
      if (job.agentSlug) {
        this.checkAgentLearning(job.agentSlug, job.name).catch(() => {});
      }

      // Close the feedback loop: append outcome to advisor decision log
      if (advisorApplied) {
        try {
          const lastRun = this.runLog.readRecent(job.name, 1)[0];
          if (lastRun) {
            appendFileSync(ADVISOR_LOG_PATH, JSON.stringify({
              jobName: job.name,
              timestamp: new Date().toISOString(),
              type: 'outcome',
              interventions: advisorApplied,
              outcome: lastRun.status,
              durationMs: lastRun.durationMs,
            }) + '\n');
          }
        } catch { /* non-fatal */ }
      }

      // Notify on circuit breaker and escalation events
      const consErrors = this.runLog.consecutiveErrors(job.name);
      if (consErrors === 5) {
        // Circuit breaker just engaged — notify
        this.logAdvisorEvent('circuit-breaker', job.name, `Circuit breaker engaged after ${consErrors} consecutive errors`);
        this.dispatcher.send(`⚡ **Circuit breaker engaged** for \`${job.name}\` — ${consErrors} consecutive errors. Will retry in 1 hour.`, { agentSlug: job.agentSlug }).catch(() => {});
      } else if (consErrors >= 5) {
        // Check if recovery probe just succeeded
        const lastRun = this.runLog.readRecent(job.name, 1)[0];
        if (lastRun?.status === 'ok') {
          this.logAdvisorEvent('circuit-recovery', job.name, `Circuit breaker recovered after ${consErrors} errors`);
          this.dispatcher.send(`✅ **Circuit breaker recovered** — \`${job.name}\` succeeded after ${consErrors} prior errors.`, { agentSlug: job.agentSlug }).catch(() => {});
        }
      }

      if (advice.shouldEscalate) {
        this.logAdvisorEvent('escalation', job.name, advice.escalationReason ?? 'Escalated to unleashed');
      }

      // Write targeted self-improvement trigger when consecutive errors are high
      if (consErrors >= 3) {
        try {
          const triggerDir = path.join(BASE_DIR, 'self-improve', 'triggers');
          mkdirSync(triggerDir, { recursive: true });
          const triggerPath = path.join(triggerDir, `${job.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
          writeFileSync(triggerPath, JSON.stringify({
            jobName: job.name,
            consecutiveErrors: consErrors,
            recentErrors: this.runLog.readRecent(job.name, 3).map(e => e.error?.slice(0, 200)),
            triggeredAt: new Date().toISOString(),
          }, null, 2));
          logger.info({ job: job.name, consErrors }, 'Wrote self-improvement trigger for failing job');
        } catch { /* non-fatal */ }
      }
    }
  }

  /**
   * Log an advisor event to the events JSONL file for dashboard surfacing.
   */
  private logAdvisorEvent(type: string, jobName: string, detail: string): void {
    try {
      const eventsPath = path.join(BASE_DIR, 'cron', 'advisor-events.jsonl');
      mkdirSync(path.dirname(eventsPath), { recursive: true });
      appendFileSync(eventsPath, JSON.stringify({
        type,
        jobName,
        detail,
        timestamp: new Date().toISOString(),
      }) + '\n');
    } catch { /* non-fatal */ }
  }

  /**
   * Check if an agent's recent cron reflections show consistently low quality.
   * If the last N runs average below the threshold, auto-append a "lessons learned"
   * section to the agent's profile. This is additive (not destructive) — it
   * only appends insights, never overwrites the core agent prompt.
   */
  private async checkAgentLearning(agentSlug: string, jobName: string): Promise<void> {
    const MIN_RUNS = 5;
    const QUALITY_THRESHOLD = 3.0;

    try {
      // Read the agent's reflection log
      const safeJobName = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const logFile = path.join(CRON_REFLECTIONS_DIR, `${safeJobName}.jsonl`);
      if (!existsSync(logFile)) return;

      const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
      if (lines.length < MIN_RUNS) return;

      // Parse the last N reflections
      const recent = lines.slice(-MIN_RUNS).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      if (recent.length < MIN_RUNS) return;

      const avgQuality = recent.reduce((sum: number, r: any) => sum + (r.quality ?? 0), 0) / recent.length;
      if (avgQuality >= QUALITY_THRESHOLD) return;

      // Quality is consistently low — extract lessons from gaps
      const gaps = recent
        .map((r: any) => r.gap)
        .filter((g: string) => g && g !== 'none' && g.length > 5);

      if (gaps.length === 0) return;

      // Check if we've already added lessons recently (prevent spam)
      const profilePath = path.join(AGENTS_DIR, agentSlug, 'agent.md');
      if (!existsSync(profilePath)) return;

      const profile = readFileSync(profilePath, 'utf-8');
      const lessonsMarker = '## Lessons Learned (auto-generated)';

      // Only update at most once per week
      const lastLessonMatch = profile.match(/<!-- lessons-updated: (\d{4}-\d{2}-\d{2}) -->/);
      if (lastLessonMatch) {
        const lastUpdate = new Date(lastLessonMatch[1]);
        const daysSince = (Date.now() - lastUpdate.getTime()) / 86_400_000;
        if (daysSince < 7) return;
      }

      // Deduplicate and summarize gaps
      const uniqueGaps = [...new Set(gaps)].slice(0, 5);
      const lessonsBlock =
        `\n\n${lessonsMarker}\n` +
        `<!-- lessons-updated: ${todayISO()} -->\n` +
        `_Based on ${MIN_RUNS} recent runs (avg quality: ${avgQuality.toFixed(1)}/5):_\n\n` +
        uniqueGaps.map((g) => `- ${g}`).join('\n') + '\n';

      // Append or replace the lessons section
      let updatedProfile: string;
      const existingIdx = profile.indexOf(lessonsMarker);
      if (existingIdx >= 0) {
        // Replace existing lessons section (everything from marker to end or next ##)
        const afterMarker = profile.slice(existingIdx);
        const nextSection = afterMarker.indexOf('\n## ', lessonsMarker.length);
        if (nextSection >= 0) {
          updatedProfile = profile.slice(0, existingIdx) + lessonsBlock + afterMarker.slice(nextSection);
        } else {
          updatedProfile = profile.slice(0, existingIdx) + lessonsBlock;
        }
      } else {
        updatedProfile = profile + lessonsBlock;
      }

      writeFileSync(profilePath, updatedProfile);
      logger.info(
        { agent: agentSlug, avgQuality: avgQuality.toFixed(1), gaps: uniqueGaps.length },
        `Auto-appended ${uniqueGaps.length} lessons to ${agentSlug}/agent.md (avg quality: ${avgQuality.toFixed(1)})`,
      );
    } catch (err) {
      logger.debug({ err, agent: agentSlug }, 'Agent learning check failed (non-fatal)');
    }
  }

  async runManual(jobName: string): Promise<string> {
    const job = this.jobs.find((j) => j.name === jobName);
    if (!job) {
      return `Cron job '${jobName}' not found. Use \`!cron list\` to see available jobs.`;
    }

    if (this.runningJobs.has(jobName)) {
      return `Cron job '${jobName}' is already running.`;
    }

    try {
      await this.runJob(job);
      return `*(cron job '${jobName}' completed)*`;
    } catch (err) {
      return CronScheduler.formatCronError(jobName, err);
    }
  }

  /** Filter out cron responses that are truly empty or nothing-to-report. */
  /** Strip internal reasoning/thinking prefixes from cron output before sending to Discord. */
  private static stripThinkingPrefixes(response: string): string {
    // Split into lines and skip leading process narration
    const lines = response.split('\n');
    const thinkingPatterns = [
      /^I('ll| will| need to| found| can see| should|'m going to) /i,
      /^Let me /i,
      /^Now (let me|I'll|I need) /i,
      /^(First|Next),? (let me|I'll|I need) /i,
      /^(Checking|Looking|Searching|Reading|Fetching|Pulling|Querying) /i,
    ];

    let startIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim();
      if (!line) { startIdx = i + 1; continue; }
      if (thinkingPatterns.some(p => p.test(line))) {
        startIdx = i + 1;
      } else {
        break;
      }
    }

    if (startIdx > 0 && startIdx < lines.length) {
      return lines.slice(startIdx).join('\n').trim();
    }
    return response;
  }

  private static isCronNoise(response: string): boolean {
    const trimmed = response.trim();
    if (trimmed === '__NOTHING__') return true;

    // Only treat as noise if the response is short — avoids filtering out
    // substantive responses that happen to start with "No updates, but..."
    if (trimmed.length > 80) return false;

    const lower = trimmed.toLowerCase();
    const noisePatterns = [
      'nothing to report',
      'nothing new to report',
      'all clear',
      'no updates',
      'completing silently',
    ];
    if (noisePatterns.some((p) => lower.startsWith(p) || lower === p)) return true;

    return false;
  }

  /** Format cron error messages for clean notifications. */
  private static formatCronError(jobName: string, err: unknown): string {
    let msg = String(err);
    // Strip "Error: " prefix
    msg = msg.replace(/^Error:\s*/i, '');
    // Strip stack traces
    const stackIdx = msg.indexOf('\n    at ');
    if (stackIdx > 0) msg = msg.slice(0, stackIdx);
    // Replace exit code messages
    msg = msg.replace(/Claude Code process exited with code \d+/i, 'Task could not complete');
    // Truncate
    if (msg.length > 300) msg = msg.slice(0, 297) + '...';
    return `${jobName} failed: ${msg.trim()}`;
  }

  listJobs(): string {
    if (this.jobs.length === 0) {
      this.reloadJobs();
    }

    if (this.jobs.length === 0) {
      return 'No cron jobs configured. Edit `vault/00-System/CRON.md` to add jobs.';
    }

    const lines = ['**Scheduled Cron Jobs:**\n'];
    for (const job of this.jobs) {
      const enabled = job.enabled && !this.disabledJobs.has(job.name);
      const status = enabled ? 'enabled' : 'disabled';
      const modeTag = job.mode === 'unleashed' ? ' [unleashed]' : '';
      const chainTag = job.after ? ` → after "${job.after}"` : '';
      const retryTag = job.maxRetries != null ? ` [max ${job.maxRetries} retries]` : '';
      lines.push(`- **${job.name}** (\`${job.schedule}\`) — ${status}${modeTag}${chainTag}${retryTag}`);
      lines.push(`  _${job.prompt.slice(0, 80)}_`);
    }
    return lines.join('\n');
  }

  getJobNames(): string[] {
    return this.jobs.map((j) => j.name);
  }

  getJob(jobName: string): CronJobDefinition | undefined {
    return this.jobs.find((j) => j.name === jobName);
  }

  isJobRunning(jobName: string): boolean {
    return this.runningJobs.has(jobName);
  }

  getRunningJobs(): string[] {
    return [...this.runningJobs];
  }

  getRunningWorkflowNames(): string[] {
    return [...this.runningWorkflows];
  }

  /** Return all job definitions with enabled/disabled state for the status embed. */
  getJobDefinitions(): Array<CronJobDefinition & { active: boolean }> {
    return this.jobs.map(j => ({
      ...j,
      active: j.enabled && !this.disabledJobs.has(j.name),
    }));
  }

  /** Get today's run stats: total runs, successes, failures (since local midnight). */
  getTodayStats(): { total: number; ok: number; errors: number; skipped: number } {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightISO = midnight.toISOString();
    let total = 0, ok = 0, errors = 0, skipped = 0;
    for (const job of this.jobs) {
      const entries = this.runLog.readRecent(job.name, 50);
      for (const e of entries) {
        if (e.startedAt < midnightISO) break;
        total++;
        if (e.status === 'ok') ok++;
        else if (e.status === 'error') errors++;
        else if (e.status === 'skipped') skipped++;
      }
    }
    return { total, ok, errors, skipped };
  }

  disableJob(jobName: string): string {
    const job = this.jobs.find((j) => j.name === jobName);
    if (!job) return `Job not found: ${jobName}`;

    this.disabledJobs.add(jobName);
    const task = this.scheduledTasks.get(jobName);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(jobName);
    }
    return `Disabled cron job: ${jobName}`;
  }

  enableJob(jobName: string): string {
    this.disabledJobs.delete(jobName);
    this.completedJobs.delete(jobName);
    this.reloadJobs();
    return `Enabled cron job: ${jobName}`;
  }

  // ── Workflow support ──────────────────────────────────────────────

  reloadWorkflows(): void {
    // Stop existing workflow scheduled tasks
    for (const [name, task] of this.workflowTasks) {
      task.stop();
      logger.debug(`Stopped workflow task: ${name}`);
    }
    this.workflowTasks.clear();

    try {
      this.workflowDefs = parseAllWorkflowsSync(WORKFLOWS_DIR);
    } catch {
      this.workflowDefs = [];
    }

    // Merge in agent-scoped workflows
    if (existsSync(AGENTS_DIR)) {
      try {
        const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true } as any)
          .filter((d: any) => d.isDirectory() && !d.name.startsWith('_'))
          .map((d: any) => d.name);

        for (const slug of dirs) {
          const wfDir = path.join(AGENTS_DIR, slug, 'workflows');
          if (!existsSync(wfDir)) continue;
          try {
            const agentWfs = parseAllWorkflowsSync(wfDir);
            for (const wf of agentWfs) {
              wf.name = `${slug}:${wf.name}`;
              wf.agentSlug = slug;
              this.workflowDefs.push(wf);
            }
          } catch {
            logger.warn(`Failed to parse workflows for agent ${slug}`);
          }
        }
      } catch { /* agents dir not readable */ }
    }

    if (this.workflowDefs.length === 0) {
      logger.debug('No workflows found');
      return;
    }

    // Schedule workflows with cron triggers
    for (const wf of this.workflowDefs) {
      if (!wf.enabled || !wf.trigger.schedule) continue;

      if (!cron.validate(wf.trigger.schedule)) {
        logger.error(`Invalid cron schedule for workflow '${wf.name}': ${wf.trigger.schedule}`);
        continue;
      }

      const task = cron.schedule(wf.trigger.schedule, () => {
        this.runWorkflow(wf.name).catch(err => {
          logger.error({ err, workflow: wf.name }, `Scheduled workflow '${wf.name}' failed`);
        });
      }, { timezone: SYSTEM_TIMEZONE });
      this.workflowTasks.set(wf.name, task);
      logger.info(`Workflow '${wf.name}' scheduled: ${wf.trigger.schedule} (${SYSTEM_TIMEZONE})`);
    }

    logger.info(`Loaded ${this.workflowDefs.length} workflow(s), ${this.workflowTasks.size} scheduled`);
  }

  private watchWorkflowDir(): void {
    if (this.watchingWorkflows) return;
    if (!existsSync(WORKFLOWS_DIR)) return;

    watchFile(WORKFLOWS_DIR, { interval: 2000 }, () => {
      logger.info('Workflows directory changed — reloading');
      try {
        this.reloadWorkflows();
        scanner.refreshIntegrity();
      } catch (err) {
        logger.error({ err }, 'Failed to reload workflows');
      }
    });
    this.watchingWorkflows = true;
  }

  private unwatchWorkflowDir(): void {
    if (!this.watchingWorkflows) return;
    try {
      unwatchFile(WORKFLOWS_DIR);
    } catch { /* ignore */ }
    this.watchingWorkflows = false;
  }

  /** Watch the triggers directory for MCP-initiated job runs and goal work sessions. */
  private watchTriggers(): void {
    mkdirSync(this.triggerDir, { recursive: true });
    mkdirSync(this.goalTriggerDir, { recursive: true });
    this.triggerTimer = setInterval(() => {
      this.processTriggers();
      this.processGoalTriggers();
    }, 3000);
  }

  /** Process any pending trigger files and run the corresponding jobs. */
  private processTriggers(): void {
    if (!existsSync(this.triggerDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.triggerDir).filter(f => f.endsWith('.trigger'));
    } catch { return; }
    for (const file of files) {
      const filePath = path.join(this.triggerDir, file);
      try {
        const jobName = readFileSync(filePath, 'utf-8').trim();
        unlinkSync(filePath);
        if (!jobName) continue;
        logger.info({ jobName }, 'Processing MCP trigger for cron job');
        this.runManual(jobName).then((result) => {
          if (result && !result.includes('not found')) {
            this.dispatcher.send(`🔧 **${jobName}** (triggered):\n\n${result.slice(0, 1500)}`).catch(() => {});
          }
        }).catch((err) => {
          logger.error({ err, jobName }, 'Trigger-initiated job failed');
        });
      } catch (err) {
        logger.warn({ err, file }, 'Failed to process trigger file');
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }

  /** Process any pending goal work trigger files. */
  private processGoalTriggers(): void {
    if (!existsSync(this.goalTriggerDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.goalTriggerDir).filter(f => f.endsWith('.trigger.json'));
    } catch { return; }
    for (const file of files) {
      const filePath = path.join(this.goalTriggerDir, file);
      try {
        const trigger = JSON.parse(readFileSync(filePath, 'utf-8'));
        unlinkSync(filePath);
        if (!trigger.goalId) continue;

        const goalPath = path.join(GOALS_DIR, `${trigger.goalId}.json`);
        if (!existsSync(goalPath)) {
          logger.warn({ goalId: trigger.goalId }, 'Goal trigger references missing goal — skipping');
          continue;
        }
        const goal = JSON.parse(readFileSync(goalPath, 'utf-8'));
        if (goal.status !== 'active') continue;

        logger.info({ goalId: trigger.goalId, title: goal.title, focus: trigger.focus }, 'Processing goal work trigger');

        // Build a cron-like prompt that focuses on the goal
        const prompt =
          `You are working on a focused goal session.\n\n` +
          `## Goal: ${goal.title}\n${goal.description}\n\n` +
          `## Focus for this session\n${trigger.focus}\n\n` +
          (goal.progressNotes?.length > 0
            ? `## Prior progress\n${goal.progressNotes.slice(-5).map((n: string) => `- ${n}`).join('\n')}\n\n`
            : '') +
          (goal.nextActions?.length > 0
            ? `## Planned next actions\n${goal.nextActions.map((a: string) => `- ${a}`).join('\n')}\n\n`
            : '') +
          (goal.blockers?.length > 0
            ? `## Current blockers\n${goal.blockers.map((b: string) => `- ${b}`).join('\n')}\n\n`
            : '') +
          `## Instructions\n` +
          `1. Work on the focus area above. Use tools as needed.\n` +
          `2. When done, use \`goal_update\` to record progress notes, update next actions, and clear resolved blockers.\n` +
          `3. If blocked, add blockers and change status to "blocked".\n` +
          `4. Keep your output concise — summarize what you accomplished.`;

        const jobName = `goal:${goal.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
        this.gateway.handleCronJob(
          jobName,
          prompt,
          2, // tier 2 — logged
          trigger.maxTurns ?? 15,
        ).then((result) => {
          if (result && !CronScheduler.isCronNoise(result)) {
            this.dispatcher.send(`🎯 **Goal work: ${goal.title}**\n\n${result.slice(0, 1500)}`).catch(() => {});
          }
          logToDailyNote(`**Goal work: ${goal.title}** — ${(result || 'completed').slice(0, 100).replace(/\n/g, ' ')}`);
        }).catch((err) => {
          logger.error({ err, goalId: trigger.goalId }, 'Goal work session failed');
        });
      } catch (err) {
        logger.warn({ err, file }, 'Failed to process goal trigger file');
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }

  async runWorkflow(name: string, inputs?: Record<string, string>): Promise<string> {
    const wf = this.workflowDefs.find(w => w.name === name);
    if (!wf) {
      return `Workflow '${name}' not found. Use \`!workflow list\` to see available workflows.`;
    }

    if (this.runningWorkflows.has(name)) {
      return `Workflow '${name}' is already running.`;
    }

    this.runningWorkflows.add(name);
    this.emitStatusChange();
    const startedAt = new Date();
    try {
      logger.info({ workflow: name, inputs }, `Running workflow: ${name}`);
      const response = await this.gateway.handleWorkflow(wf, inputs ?? {});

      if (response && response !== '*(workflow completed — no output)*') {
        await this.dispatcher.send(`**[Workflow: ${name}]**\n\n${response.slice(0, 1500)}`);
        // Inject into owner's DM session
        if (DISCORD_OWNER_ID && DISCORD_OWNER_ID !== '0') {
          this.gateway.injectContext(
            `discord:user:${DISCORD_OWNER_ID}`,
            `[Workflow: ${name}]`,
            response,
          );
        }
      }

      const durationSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
      logToDailyNote(`**Workflow: ${name}** (${durationSec}s): ${(response || 'no output').slice(0, 100).replace(/\n/g, ' ')}`);

      return response;
    } catch (err) {
      logger.error({ err, workflow: name }, `Workflow '${name}' failed`);
      const errMsg = `Workflow '${name}' failed: ${String(err).slice(0, 300)}`;
      await this.dispatcher.send(errMsg);
      return errMsg;
    } finally {
      this.runningWorkflows.delete(name);
      this.emitStatusChange();
    }
  }

  getWorkflowNames(): string[] {
    return this.workflowDefs.map(w => w.name);
  }

  getWorkflow(name: string): WorkflowDefinition | undefined {
    return this.workflowDefs.find(w => w.name === name);
  }

  isWorkflowRunning(name: string): boolean {
    return this.runningWorkflows.has(name);
  }

  listWorkflows(): string {
    if (this.workflowDefs.length === 0) {
      this.reloadWorkflows();
    }

    if (this.workflowDefs.length === 0) {
      return 'No workflows configured. Add workflow files to `vault/00-System/workflows/`.';
    }

    const lines = ['**Workflows:**\n'];
    for (const wf of this.workflowDefs) {
      const status = wf.enabled ? 'enabled' : 'disabled';
      const schedule = wf.trigger.schedule ? ` (\`${wf.trigger.schedule}\`)` : ' (manual)';
      const running = this.runningWorkflows.has(wf.name) ? ' [running]' : '';
      lines.push(`- **${wf.name}**${schedule} — ${status}${running}`);
      if (wf.description) lines.push(`  _${wf.description.slice(0, 80)}_`);
      lines.push(`  Steps: ${wf.steps.map(s => s.id).join(' → ')}`);
    }
    return lines.join('\n');
  }

  // ── Self-Improvement ─────────────────────────────────────────────

  async runSelfImproveLoop(
    config?: Partial<SelfImproveConfig>,
    onProposal?: (experiment: SelfImproveExperiment) => Promise<void>,
  ): Promise<SelfImproveState> {
    const loop = new SelfImproveLoop(this.gateway.assistant, config);
    this.emitStatusChange();
    try {
      return await loop.run(onProposal);
    } finally {
      this.emitStatusChange();
    }
  }

  async applySelfImproveChange(experimentId: string): Promise<string> {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    const result = loop.applyApprovedChange(experimentId);
    this.emitStatusChange();
    return result;
  }

  denySelfImproveChange(experimentId: string): string {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    const result = loop.denyChange(experimentId);
    this.emitStatusChange();
    return result;
  }

  getSelfImproveStatus(): SelfImproveState {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    return loop.loadState();
  }

  getSelfImproveHistory(limit = 10): SelfImproveExperiment[] {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    const log = loop.loadExperimentLog();
    return log.slice(-limit).reverse();
  }

  getSelfImprovePending(): Array<SelfImproveExperiment & { before: string }> {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    return loop.getPendingChanges();
  }
}
