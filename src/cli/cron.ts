/**
 * Clementine CLI — Standalone cron runner.
 *
 * Lightweight runner that initializes just the agent + gateway (no channels,
 * no daemon), parses CRON.md, and executes a single job or heartbeat.
 * Designed to be called by OS scheduler and exit.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cron from 'node-cron';
import matter from 'gray-matter';
import type { CronJobDefinition } from '../types.js';
import {
  parseCronJobs,
  HeartbeatScheduler,
  CronRunLog,
  classifyError,
} from '../gateway/heartbeat.js';

const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
const LAST_RUN_FILE = path.join(BASE_DIR, '.cron_last_run.json');

/** Exponential backoff schedule in ms: 30s, 1m, 5m, 15m, 60m */
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Lightweight agent + gateway init ─────────────────────────────────

async function initGateway(): Promise<{ gateway: import('../gateway/router.js').Gateway }> {
  // Set CLEMENTINE_HOME so config.ts resolves correctly
  process.env.CLEMENTINE_HOME = BASE_DIR;

  // Clear nested session guard so the SDK can spawn Claude CLI subprocesses
  delete process.env['CLAUDECODE'];

  const { PersonalAssistant } = await import('../agent/assistant.js');
  const assistant = new PersonalAssistant();

  const { Gateway } = await import('../gateway/router.js');
  const gateway = new Gateway(assistant);

  // Wire approval callback (auto-deny in headless mode)
  const { setApprovalCallback } = await import('../agent/hooks.js');
  setApprovalCallback(async () => false);

  return { gateway };
}

// ── Commands ─────────────────────────────────────────────────────────

export async function cmdCronList(): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;

  const jobs = parseCronJobs();

  if (jobs.length === 0) {
    console.log('No cron jobs defined. Edit vault/00-System/CRON.md to add jobs.');
    return;
  }

  const runLog = new CronRunLog(BASE_DIR);

  console.log('Cron jobs:\n');
  for (const job of jobs) {
    const status = job.enabled ? 'enabled' : 'disabled';
    const recent = runLog.readRecent(job.name, 1);
    const lastRun = recent.length > 0
      ? `last run: ${recent[0].finishedAt.slice(0, 16).replace('T', ' ')} (${recent[0].status})`
      : 'never run';
    const errors = runLog.consecutiveErrors(job.name);
    const errorTag = errors > 0 ? ` [${errors} consecutive error(s)]` : '';

    console.log(`  ${job.name}  (${job.schedule})  [${status}]`);
    console.log(`    ${job.prompt.slice(0, 100)}`);
    console.log(`    ${lastRun}${errorTag}`);
    console.log();
  }
}

export async function cmdCronRun(jobName: string): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;
  const jobs = parseCronJobs();
  const job = jobs.find((j) => j.name === jobName);

  if (!job) {
    console.error(`Job not found: ${jobName}`);
    console.error(`Available jobs: ${jobs.map((j) => j.name).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const { gateway } = await initGateway();
  const runLog = new CronRunLog(BASE_DIR);

  console.log(`Running cron job: ${job.name}`);
  const startedAt = new Date();

  try {
    const response = await gateway.handleCronJob(job.name, job.prompt, job.tier, job.maxTurns);
    const finishedAt = new Date();

    runLog.append({
      jobName: job.name,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: 'ok',
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      attempt: 1,
      outputPreview: response ? response.slice(0, 200) : undefined,
    });

    console.log(response || '(no output)');
  } catch (err) {
    const finishedAt = new Date();
    runLog.append({
      jobName: job.name,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: 'error',
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: String(err).slice(0, 500),
      errorType: classifyError(err),
      attempt: 1,
    });
    console.error(`Error: ${err}`);
    process.exit(1);
  }
}

export async function cmdCronRunDue(): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;

  const jobs = parseCronJobs();
  const enabledJobs = jobs.filter((j) => j.enabled);

  if (enabledJobs.length === 0) {
    return; // nothing to do, silent exit for OS scheduler
  }

  const now = new Date();
  const lastRuns = loadLastRuns();
  const dueJobs = enabledJobs.filter((job) => isJobDue(job, now, lastRuns));

  if (dueJobs.length === 0) {
    return; // nothing due
  }

  const { gateway } = await initGateway();
  const runLog = new CronRunLog(BASE_DIR);

  // Also init dispatcher for sending notifications
  const { NotificationDispatcher } = await import('../gateway/notifications.js');
  const dispatcher = new NotificationDispatcher();

  for (const job of dueJobs) {
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    console.log(`[${new Date().toISOString()}] Running due job: ${job.name}`);

    // Determine retry ceiling from error history
    const priorErrors = runLog.consecutiveErrors(job.name);
    const maxAttempts = 1 + Math.min(priorErrors, BACKOFF_MS.length);

    let succeeded = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = new Date();
      try {
        const response = await gateway.handleCronJob(job.name, job.prompt, job.tier, job.maxTurns);
        const finishedAt = new Date();

        runLog.append({
          jobName: job.name,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          status: 'ok',
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          attempt,
          outputPreview: response ? response.slice(0, 200) : undefined,
        });

        if (response) {
          console.log(`[${job.name}] ${response}`);
          await dispatcher.send(`**[Cron: ${job.name} — ${timeStr}]**\n\n${response}`).catch(() => {
            // No senders registered in headless mode — expected
          });
        }
        succeeded = true;
        break;
      } catch (err) {
        const finishedAt = new Date();
        const errorType = classifyError(err);

        runLog.append({
          jobName: job.name,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          status: attempt < maxAttempts && errorType === 'transient' ? 'retried' : 'error',
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: String(err).slice(0, 500),
          errorType,
          attempt,
        });

        if (errorType === 'permanent') {
          console.error(`[${job.name}] Permanent error — not retrying: ${err}`);
          break;
        }

        if (attempt < maxAttempts) {
          const backoffMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
          console.log(`[${job.name}] Transient error — retrying in ${backoffMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
          await sleep(backoffMs);
        } else {
          console.error(`[${job.name}] Failed after ${attempt} attempt(s): ${err}`);
        }
      }
    }

    if (succeeded) {
      lastRuns[job.name] = now.toISOString();
    }
  }

  saveLastRuns(lastRuns);
}

export async function cmdCronRuns(jobName?: string): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;

  const runLog = new CronRunLog(BASE_DIR);

  if (jobName) {
    const entries = runLog.readRecent(jobName, 20);
    if (entries.length === 0) {
      console.log(`No run history for job: ${jobName}`);
      return;
    }

    console.log(`Run history for ${jobName} (most recent first):\n`);
    for (const entry of entries) {
      const ts = entry.startedAt.slice(0, 19).replace('T', ' ');
      const dur = `${(entry.durationMs / 1000).toFixed(1)}s`;
      const status = entry.status === 'ok' ? '\x1b[32mok\x1b[0m' :
        entry.status === 'retried' ? '\x1b[33mretried\x1b[0m' :
          '\x1b[31merror\x1b[0m';
      const attempt = entry.attempt > 1 ? ` (attempt ${entry.attempt})` : '';
      console.log(`  ${ts}  ${status}  ${dur}${attempt}`);
      if (entry.error) {
        console.log(`    ${entry.error.slice(0, 120)}`);
      }
      if (entry.outputPreview) {
        console.log(`    ${entry.outputPreview.slice(0, 120)}`);
      }
    }
  } else {
    // Show summary for all jobs
    const jobs = parseCronJobs();
    if (jobs.length === 0) {
      console.log('No cron jobs defined.');
      return;
    }

    console.log('Run history summary:\n');
    for (const job of jobs) {
      const entries = runLog.readRecent(job.name, 5);
      const consecutiveErrs = runLog.consecutiveErrors(job.name);
      const lastEntry = entries[0];

      const lastStr = lastEntry
        ? `${lastEntry.startedAt.slice(0, 16).replace('T', ' ')} (${lastEntry.status})`
        : 'never';
      const errTag = consecutiveErrs > 0 ? ` [${consecutiveErrs} consecutive errors]` : '';

      console.log(`  ${job.name}: last=${lastStr}${errTag}`);
    }
  }
}

export async function cmdHeartbeat(): Promise<void> {
  const { gateway } = await initGateway();

  // Read HEARTBEAT.md standing instructions
  process.env.CLEMENTINE_HOME = BASE_DIR;
  const { HEARTBEAT_FILE } = await import('../config.js');

  let standingInstructions = 'Check for overdue tasks. Ensure today\'s daily note exists.';
  if (existsSync(HEARTBEAT_FILE)) {
    const raw = readFileSync(HEARTBEAT_FILE, 'utf-8');
    const parsed = matter(raw);
    standingInstructions = parsed.content;
  }

  const hour = new Date().getHours();
  const timeContext = HeartbeatScheduler.getTimeContext(hour);

  console.log('Running one-shot heartbeat...');
  const response = await gateway.handleHeartbeat(standingInstructions, '', timeContext);
  console.log(response || '(no output)');
}

// ── Cron schedule matching ──────────────────────────────────────────

function isJobDue(
  job: CronJobDefinition,
  now: Date,
  lastRuns: Record<string, string>,
): boolean {
  if (!cron.validate(job.schedule)) return false;

  // Check if this job already ran recently (within 10 minutes)
  const lastRun = lastRuns[job.name];
  if (lastRun) {
    const lastRunDate = new Date(lastRun);
    const elapsedMs = now.getTime() - lastRunDate.getTime();
    if (elapsedMs < 10 * 60 * 1000) return false; // ran <10min ago
  }

  // Check if the cron schedule matches any minute in the last 5 minutes
  // (the OS scheduler runs every 5 minutes)
  for (let offsetMin = 0; offsetMin < 5; offsetMin++) {
    const checkTime = new Date(now.getTime() - offsetMin * 60 * 1000);
    if (cronMatchesTime(job.schedule, checkTime)) return true;
  }

  return false;
}

/**
 * Check if a cron expression matches a specific time.
 */
function cronMatchesTime(schedule: string, time: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minField, hourField, domField, monField, dowField] = parts;

  return (
    fieldMatches(minField, time.getMinutes(), 0, 59) &&
    fieldMatches(hourField, time.getHours(), 0, 23) &&
    fieldMatches(domField, time.getDate(), 1, 31) &&
    fieldMatches(monField, time.getMonth() + 1, 1, 12) &&
    fieldMatches(dowField, time.getDay(), 0, 7)
  );
}

function fieldMatches(field: string, value: number, _min: number, _max: number): boolean {
  if (field === '*') return true;

  // Handle */N step values
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // Handle comma-separated values
  const values = field.split(',');
  for (const v of values) {
    // Handle ranges like 1-5
    if (v.includes('-')) {
      const [start, end] = v.split('-').map(Number);
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true;
    } else {
      const num = parseInt(v, 10);
      if (!isNaN(num) && num === value) return true;
    }
  }

  return false;
}

// ── Last-run state persistence ──────────────────────────────────────

function loadLastRuns(): Record<string, string> {
  if (!existsSync(LAST_RUN_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LAST_RUN_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLastRuns(data: Record<string, string>): void {
  const dir = path.dirname(LAST_RUN_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LAST_RUN_FILE, JSON.stringify(data, null, 2));
}
