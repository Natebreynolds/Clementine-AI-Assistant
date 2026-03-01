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
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
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
import type { CronJobDefinition, HeartbeatState } from '../types.js';
import type { NotificationDispatcher } from './notifications.js';
import type { Gateway } from './router.js';

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

    if (currentFingerprint === lastFingerprint) {
      logger.debug('Heartbeat: no changes since last check — skipping agent call');
      return;
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

// ── CronScheduler ─────────────────────────────────────────────────────

export class CronScheduler {
  private gateway: Gateway;
  private dispatcher: NotificationDispatcher;
  private jobs: CronJobDefinition[] = [];
  private disabledJobs = new Set<string>();
  private scheduledTasks = new Map<string, cron.ScheduledTask>();

  constructor(gateway: Gateway, dispatcher: NotificationDispatcher) {
    this.gateway = gateway;
    this.dispatcher = dispatcher;
  }

  start(): void {
    this.reloadJobs();
    logger.info(`Cron scheduler started with ${this.jobs.length} jobs`);
  }

  stop(): void {
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();
    logger.info('Cron scheduler stopped');
  }

  reloadJobs(): void {
    // Stop existing tasks
    this.stop();

    this.jobs = [];

    if (!existsSync(CRON_FILE)) {
      logger.info('No CRON.md found — no cron jobs loaded');
      return;
    }

    const raw = readFileSync(CRON_FILE, 'utf-8');
    const parsed = matter(raw);
    const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;

    for (const job of jobDefs) {
      const name = String(job.name ?? '');
      const schedule = String(job.schedule ?? '');
      const prompt = String(job.prompt ?? '');
      const enabled = job.enabled !== false;
      const tier = Number(job.tier ?? 1);
      const maxTurns = job.max_turns != null ? Number(job.max_turns) : undefined;

      if (!name || !schedule || !prompt) {
        logger.warn({ job }, 'Skipping malformed cron job');
        continue;
      }

      const def: CronJobDefinition = { name, schedule, prompt, enabled, tier, maxTurns };
      this.jobs.push(def);

      if (enabled && !this.disabledJobs.has(name)) {
        if (!cron.validate(schedule)) {
          logger.error(`Invalid cron schedule for '${name}': ${schedule}`);
          continue;
        }

        const task = cron.schedule(schedule, () => {
          this.runJob(def).catch((err) => {
            logger.error({ err, job: name }, `Cron job '${name}' failed`);
          });
        });
        this.scheduledTasks.set(name, task);
        logger.info(`Cron job '${name}' scheduled: ${schedule}`);
      }
    }
  }

  private async runJob(job: CronJobDefinition): Promise<void> {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    logger.info(`Running cron job: ${job.name}`);

    try {
      const response = await this.gateway.handleCronJob(
        job.name,
        job.prompt,
        job.tier,
        job.maxTurns,
      );
      if (response) {
        await this.dispatcher.send(`**[Cron: ${job.name} — ${timeStr}]**\n\n${response}`);
      }
    } catch (err) {
      logger.error({ err, job: job.name }, `Cron job '${job.name}' failed`);
      await this.dispatcher.send(`**[Cron: ${job.name} — FAILED]**\n\n${err}`);
    }
  }

  async runManual(jobName: string): Promise<string> {
    const job = this.jobs.find((j) => j.name === jobName);
    if (!job) {
      return `Cron job '${jobName}' not found. Use \`!cron list\` to see available jobs.`;
    }

    try {
      const response = await this.gateway.handleCronJob(
        jobName,
        job.prompt,
        job.tier,
        job.maxTurns,
      );
      return response || `*(cron job '${jobName}' completed — no output)*`;
    } catch (err) {
      return `Cron job '${jobName}' error: ${err}`;
    }
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
      lines.push(`- **${job.name}** (\`${job.schedule}\`) — ${status}`);
      lines.push(`  _${job.prompt.slice(0, 80)}_`);
    }
    return lines.join('\n');
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
