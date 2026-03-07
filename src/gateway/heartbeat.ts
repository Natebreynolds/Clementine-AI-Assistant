/**
 * Clementine TypeScript — Heartbeat + Cron scheduler (autonomous execution).
 *
 * HeartbeatScheduler: periodic general check-ins using setInterval
 * CronScheduler: precise scheduled tasks using node-cron
 *
 * Both schedulers are channel-agnostic — they send notifications via
 * the NotificationDispatcher, which fans out to all active channels.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import matter from 'gray-matter';
import pino from 'pino';
import {
  VAULT_DIR,
  HEARTBEAT_FILE,
  CRON_FILE,
  TASKS_FILE,
  INBOX_DIR,
  DAILY_NOTES_DIR,
  HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_ACTIVE_START,
  HEARTBEAT_ACTIVE_END,
  BASE_DIR,
} from '../config.js';
import type { CronJobDefinition, CronRunEntry, HeartbeatState } from '../types.js';
import type { NotificationDispatcher } from './notifications.js';
import type { Gateway } from './router.js';
import { scanner } from '../security/scanner.js';

const logger = pino({ name: 'clementine.heartbeat' });

// ── HeartbeatScheduler ────────────────────────────────────────────────

export class HeartbeatScheduler {
  private readonly stateFile: string;
  private gateway: Gateway;
  private dispatcher: NotificationDispatcher;
  private lastState: HeartbeatState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(gateway: Gateway, dispatcher: NotificationDispatcher) {
    this.gateway = gateway;
    this.dispatcher = dispatcher;
    this.stateFile = path.join(BASE_DIR, '.heartbeat_state.json');
    this.lastState = this.loadState();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
    this.timer = setInterval(() => {
      this.heartbeatTick().catch((err) => {
        logger.error({ err }, 'Heartbeat tick failed');
      });
    }, intervalMs);
    logger.info(
      `Heartbeat started: every ${HEARTBEAT_INTERVAL_MINUTES}min, active ${HEARTBEAT_ACTIVE_START}:00-${HEARTBEAT_ACTIVE_END}:00`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Heartbeat stopped');
    }
  }

  async runManual(): Promise<string> {
    const standingInstructions = this.readHeartbeatConfig();
    const now = new Date();
    const [, currentDetails] = this.computeStateFingerprint();
    const changesSummary = this.computeChangesSummary(
      this.lastState.details ?? {},
      currentDetails,
    );
    const timeContext = HeartbeatScheduler.getTimeContext(now.getHours());

    try {
      const response = await this.gateway.handleHeartbeat(
        standingInstructions,
        changesSummary,
        timeContext,
      );
      return response || '*(heartbeat completed — nothing to report)*';
    } catch (err) {
      logger.error({ err }, 'Manual heartbeat failed');
      return `Heartbeat error: ${err}`;
    }
  }

  // ── Private methods ─────────────────────────────────────────────────

  private async heartbeatTick(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // Check active hours
    if (hour < HEARTBEAT_ACTIVE_START || hour >= HEARTBEAT_ACTIVE_END) {
      logger.debug(`Heartbeat skipped: outside active hours (${hour}:00)`);
      return;
    }

    // Compute current state and compare to last
    const [currentFingerprint, currentDetails] = this.computeStateFingerprint();
    const lastFingerprint = this.lastState.fingerprint ?? '';

    // Even if nothing changed, fire at least once every 4 hours during active hours
    // to ensure daily notes get created, proactive checks run, etc.
    const MAX_SILENT_MS = 4 * 60 * 60 * 1000;
    const lastTimestamp = this.lastState.timestamp ? new Date(this.lastState.timestamp).getTime() : 0;
    const msSinceLast = Date.now() - lastTimestamp;
    const stale = msSinceLast >= MAX_SILENT_MS;

    if (currentFingerprint === lastFingerprint && !stale) {
      logger.debug('Heartbeat: no changes since last check — skipping agent call');
      return;
    }

    if (stale && currentFingerprint === lastFingerprint) {
      logger.info(`Heartbeat: no changes but ${(msSinceLast / 3_600_000).toFixed(1)}h since last beat — running proactive check`);
    }

    // Something changed — compute a summary of what
    const changesSummary = this.computeChangesSummary(
      this.lastState.details ?? {},
      currentDetails,
    );

    // Persist new state
    this.lastState = {
      fingerprint: currentFingerprint,
      details: currentDetails,
      timestamp: now.toISOString(),
    };
    this.saveState();

    // Build time-of-day context
    const timeContext = HeartbeatScheduler.getTimeContext(hour);

    // Read standing instructions from HEARTBEAT.md
    const standingInstructions = this.readHeartbeatConfig();

    try {
      const response = await this.gateway.handleHeartbeat(
        standingInstructions,
        changesSummary,
        timeContext,
      );

      if (response && !HeartbeatScheduler.isSilent(response)) {
        const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        await this.dispatcher.send(`**[Heartbeat — ${timeStr}]**\n\n${response}`);
      } else {
        const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        logger.info(`Heartbeat silent at ${timeStr}`);
      }
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick failed');
    }
  }

  private readHeartbeatConfig(): string {
    if (!existsSync(HEARTBEAT_FILE)) {
      return 'Check for overdue tasks. Ensure today\'s daily note exists.';
    }
    const raw = readFileSync(HEARTBEAT_FILE, 'utf-8');
    const parsed = matter(raw);
    return parsed.content;
  }

  private loadState(): HeartbeatState {
    if (existsSync(this.stateFile)) {
      try {
        return JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      } catch {
        logger.warn('Failed to load heartbeat state — starting fresh');
      }
    }
    return { fingerprint: '', details: {}, timestamp: '' };
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.lastState, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save heartbeat state');
    }
  }

  private computeStateFingerprint(): [string, Record<string, number | string>] {
    const details: Record<string, number | string> = {};
    const todayStr = new Date().toISOString().slice(0, 10);

    // Count tasks by status from TASKS.md
    if (existsSync(TASKS_FILE)) {
      const content = readFileSync(TASKS_FILE, 'utf-8');
      let overdue = 0;
      let dueToday = 0;
      let pending = 0;

      for (const line of content.split('\n')) {
        const s = line.trim();
        if (/^- \[ \]/.test(s)) {
          pending++;
          const dueMatch = s.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
          if (dueMatch) {
            const dueDate = dueMatch[1];
            if (dueDate < todayStr) overdue++;
            else if (dueDate === todayStr) dueToday++;
          }
        }
      }
      details.tasks_pending = pending;
      details.tasks_overdue = overdue;
      details.tasks_due_today = dueToday;
    }

    // Count inbox items
    if (existsSync(INBOX_DIR)) {
      try {
        const files = readdirSync(INBOX_DIR).filter((f) => f.endsWith('.md'));
        details.inbox_count = files.length;
      } catch {
        details.inbox_count = 0;
      }
    }

    // Hash of today's daily note size
    const todayNote = path.join(DAILY_NOTES_DIR, `${todayStr}.md`);
    if (existsSync(todayNote)) {
      details.daily_note_size = statSync(todayNote).size;
    }

    // Include the date so day rollover always triggers a heartbeat
    details.today = todayStr;

    // Build fingerprint from details
    const fingerprintStr = JSON.stringify(details, Object.keys(details).sort());
    const fingerprint = createHash('md5').update(fingerprintStr).digest('hex').slice(0, 12);

    return [fingerprint, details];
  }

  private computeChangesSummary(
    oldDetails: Record<string, number | string>,
    newDetails: Record<string, number | string>,
  ): string {
    const changes: string[] = [];

    const oldOverdue = Number(oldDetails.tasks_overdue ?? 0);
    const newOverdue = Number(newDetails.tasks_overdue ?? 0);
    if (newOverdue > oldOverdue) {
      changes.push(`${newOverdue - oldOverdue} NEW overdue task(s) since last check`);
    } else if (newOverdue > 0) {
      changes.push(`${newOverdue} overdue task(s)`);
    }

    const oldDue = Number(oldDetails.tasks_due_today ?? 0);
    const newDue = Number(newDetails.tasks_due_today ?? 0);
    if (newDue !== oldDue) {
      changes.push(`Tasks due today: ${oldDue} → ${newDue}`);
    }

    const oldPending = Number(oldDetails.tasks_pending ?? 0);
    const newPending = Number(newDetails.tasks_pending ?? 0);
    if (newPending !== oldPending) {
      const diff = newPending - oldPending;
      const word = diff > 0 ? 'added' : 'completed/removed';
      changes.push(
        `${Math.abs(diff)} task(s) ${word} (pending: ${oldPending} → ${newPending})`,
      );
    }

    const oldInbox = Number(oldDetails.inbox_count ?? 0);
    const newInbox = Number(newDetails.inbox_count ?? 0);
    if (newInbox > oldInbox) {
      changes.push(`${newInbox - oldInbox} new inbox item(s)`);
    }

    const oldSize = Number(oldDetails.daily_note_size ?? 0);
    const newSize = Number(newDetails.daily_note_size ?? 0);
    if (newSize > oldSize && oldSize > 0) {
      changes.push('Daily note has new entries');
    } else if (newSize > 0 && oldSize === 0) {
      changes.push('Daily note was created');
    }

    if (changes.length === 0) {
      changes.push('State fingerprint changed (minor updates)');
    }

    return changes.join('; ');
  }

  static getTimeContext(hour: number): string {
    if (hour >= 8 && hour < 10) {
      return 'Morning — Focus on task review and daily setup.';
    } else if (hour >= 10 && hour < 18) {
      return 'Working hours — Check for overdue tasks and inbox items.';
    } else if (hour >= 18 && hour < 22) {
      return 'Evening — Focus on daily summary and memory consolidation.';
    }
    return '';
  }

  private static isSilent(response: string): boolean {
    const indicators = [
      'all clear',
      'nothing to report',
      'no updates',
      'everything looks good',
      'no urgent',
      'quiet heartbeat',
    ];
    const lower = response.toLowerCase();
    return indicators.some((ind) => lower.includes(ind));
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
  const parsed = matter(raw);
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

    if (!name || !schedule || !prompt) {
      logger.warn({ job }, 'Skipping malformed cron job');
      continue;
    }

    jobs.push({ name, schedule, prompt, enabled, tier, maxTurns, model, workDir, mode, maxHours });
  }

  return jobs;
}

// ── Retry / backoff ──────────────────────────────────────────────────

/** Exponential backoff schedule in ms: 30s, 1m, 5m, 15m, 60m */
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/** Patterns that indicate a transient (retryable) error. */
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /5\d\d/,
  /overloaded/i,
  /temporarily unavailable/i,
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
      this.maybePrune(filePath);
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
  private watching = false;
  readonly runLog: CronRunLog;

  constructor(gateway: Gateway, dispatcher: NotificationDispatcher) {
    this.gateway = gateway;
    this.dispatcher = dispatcher;
    this.runLog = new CronRunLog();
  }

  start(): void {
    this.reloadJobs();
    this.watchCronFile();
    logger.info(`Cron scheduler started with ${this.jobs.length} jobs`);
  }

  stop(): void {
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();
    this.unwatchCronFile();
    logger.info('Cron scheduler stopped');
  }

  /** Watch CRON.md for changes and auto-reload jobs. */
  private watchCronFile(): void {
    if (this.watching) return;
    if (!existsSync(CRON_FILE)) return;

    watchFile(CRON_FILE, { interval: 2000 }, () => {
      logger.info('CRON.md changed — reloading jobs');
      this.reloadJobs();
      scanner.refreshIntegrity(); // CRON.md change is legitimate
      logger.info(`Cron scheduler reloaded: ${this.jobs.length} jobs`);
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

  reloadJobs(): void {
    // Stop existing scheduled tasks (but NOT the file watcher)
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();

    this.jobs = parseCronJobs();

    if (this.jobs.length === 0) {
      logger.info('No CRON.md found or no jobs defined');
      return;
    }

    for (const def of this.jobs) {
      if (def.enabled && !this.disabledJobs.has(def.name)) {
        if (!cron.validate(def.schedule)) {
          logger.error(`Invalid cron schedule for '${def.name}': ${def.schedule}`);
          continue;
        }

        const task = cron.schedule(def.schedule, () => {
          this.runJob(def).catch((err) => {
            logger.error({ err, job: def.name }, `Cron job '${def.name}' failed`);
          });
        });
        this.scheduledTasks.set(def.name, task);
        logger.info(`Cron job '${def.name}' scheduled: ${def.schedule}`);
      }
    }
  }

  private async runJob(job: CronJobDefinition): Promise<void> {
    // Prevent concurrent runs of the same job
    if (this.runningJobs.has(job.name)) {
      logger.info(`Cron job '${job.name}' is already running — skipping this trigger`);
      return;
    }
    this.runningJobs.add(job.name);

    try {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      logger.info(`Running cron job: ${job.name}`);

      // Unleashed tasks handle their own retries/phases internally — never retry the whole task
      const priorErrors = this.runLog.consecutiveErrors(job.name);
      const maxAttempts = job.mode === 'unleashed'
        ? 1
        : 1 + Math.min(priorErrors, BACKOFF_MS.length);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = new Date();
        try {
          const response = await this.gateway.handleCronJob(
            job.name,
            job.prompt,
            job.tier,
            job.maxTurns,
            job.model,
            job.workDir,
            job.mode,
            job.maxHours,
          );

          // Success — log and dispatch
          const finishedAt = new Date();
          this.runLog.append({
            jobName: job.name,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            status: 'ok',
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempt,
            outputPreview: response ? response.slice(0, 200) : undefined,
          });

          if (response && !CronScheduler.isCronNoise(response)) {
            await this.dispatcher.send(`**[Cron: ${job.name} — ${timeStr}]**\n\n${response}`);
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
            error: String(err).slice(0, 500),
            errorType,
            attempt,
          });

          // Permanent error — stop immediately
          if (errorType === 'permanent') {
            logger.error({ err, job: job.name }, `Cron job '${job.name}' permanent error — not retrying`);
            await this.dispatcher.send(`**[Cron: ${job.name} — FAILED]**\n\n${err}`);
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
            await this.dispatcher.send(`**[Cron: ${job.name} — FAILED]**\n\n${err}`);
          }
        }
      }
    } finally {
      this.runningJobs.delete(job.name);
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
    this.runningJobs.add(jobName);

    try {
      const response = await this.gateway.handleCronJob(
        jobName,
        job.prompt,
        job.tier,
        job.maxTurns,
        job.model,
        job.workDir,
        job.mode,
        job.maxHours,
      );
      return response || `*(cron job '${jobName}' completed — no output)*`;
    } catch (err) {
      return `Cron job '${jobName}' error: ${err}`;
    } finally {
      this.runningJobs.delete(jobName);
    }
  }

  /** Filter out cron responses that are just narration, not actionable output. */
  private static isCronNoise(response: string): boolean {
    const lower = response.toLowerCase().trim();
    const noisePatterns = [
      'nothing to report',
      'nothing new',
      'nothing meaningful',
      'nothing notable',
      'no new',
      'no updates',
      'no unread',
      'all clear',
      'completing the cleanup silently',
      'completing silently',
      'cleanup silently',
      'let me check',
      'let me read',
      'let me search',
      'let me start',
      'let me use',
      "i'll check",
      "i'll execute",
      "i'll scan",
      'let me retry',
      'let me fix',
    ];
    // If the response starts with narration or says nothing meaningful, filter it
    return noisePatterns.some((p) => lower.includes(p));
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
      lines.push(`- **${job.name}** (\`${job.schedule}\`) — ${status}${modeTag}`);
      lines.push(`  _${job.prompt.slice(0, 80)}_`);
    }
    return lines.join('\n');
  }

  getJob(jobName: string): CronJobDefinition | undefined {
    return this.jobs.find((j) => j.name === jobName);
  }

  isJobRunning(jobName: string): boolean {
    return this.runningJobs.has(jobName);
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
    this.reloadJobs();
    return `Enabled cron job: ${jobName}`;
  }
}
