/**
 * Clementine CLI — Standalone cron runner.
 *
 * Lightweight runner that initializes just the agent + gateway (no channels,
 * no daemon), parses CRON.md, and executes a single job or heartbeat.
 * Designed to be called by OS scheduler and exit.
 */

import { execSync } from 'node:child_process';
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
  let job = jobs.find((j) => j.name === jobName);

  if (!job) {
    console.error(`Job not found: ${jobName}`);
    console.error(`Available jobs: ${jobs.map((j) => j.name).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const { gateway } = await initGateway();
  const runLog = new CronRunLog(BASE_DIR);

  // ── Pre-check gate ──
  if (job.preCheck) {
    console.log(`Running pre-check for ${job.name}...`);
    try {
      const stdout = execSync(job.preCheck, {
        timeout: 30_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: job.workDir || undefined,
      }).trim();
      console.log(`Pre-check passed${stdout ? ` (${stdout.split('\n').length} lines of context)` : ''}`);
      if (stdout.length > 0) {
        job = { ...job, prompt: `Pre-check data (already fetched — use this, do not re-query):\n\`\`\`\n${stdout.slice(0, 4000)}\n\`\`\`\n\n${job.prompt}` };
      }
    } catch (preCheckErr: unknown) {
      const exitCode = (preCheckErr as { status?: number }).status ?? 1;
      console.log(`Pre-check exit ${exitCode} — no work to do, skipping job`);
      runLog.append({
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

  console.log(`Running cron job: ${job.name}`);
  const startedAt = new Date();

  try {
    const response = await gateway.handleCronJob(job.name, job.prompt, job.tier, job.maxTurns, job.model, job.workDir, job.mode, job.maxHours);
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
    if (response && response !== '__NOTHING__') {
      console.log('\n(Note: Standalone runner — output not delivered to channels. Use the daemon for channel delivery.)');
    }
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

/** Check if the main daemon process is alive via its PID file. */
function isDaemonRunning(): boolean {
  // PID file is named after the assistant (e.g. .clementine.pid)
  const envPath = path.join(BASE_DIR, '.env');
  let name = 'clementine';
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^ASSISTANT_NAME=(.+)$/m);
    if (match) name = match[1].trim().toLowerCase();
  }
  const pidFile = path.join(BASE_DIR, `.${name}.pid`);
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    return false;
  }
}

export async function cmdCronRunDue(): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;

  // Skip if the daemon is running — it has its own CronScheduler
  if (isDaemonRunning()) {
    console.log('Daemon is running — skipping standalone cron (daemon handles scheduling)');
    return;
  }

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

  // Note: the standalone runner doesn't deliver notifications to channels.
  // The daemon's CronScheduler handles delivery via NotificationDispatcher.
  // This runner is a fallback for when the daemon is down.

  for (let job of dueJobs) {
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    console.log(`[${new Date().toISOString()}] Running due job: ${job.name}`);

    // ── Pre-check gate ──
    if (job.preCheck) {
      try {
        const stdout = execSync(job.preCheck, {
          timeout: 30_000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: job.workDir || undefined,
        }).trim();
        if (stdout.length > 0) {
          job = { ...job, prompt: `Pre-check data (already fetched — use this, do not re-query):\n\`\`\`\n${stdout.slice(0, 4000)}\n\`\`\`\n\n${job.prompt}` };
        }
      } catch (preCheckErr: unknown) {
        const exitCode = (preCheckErr as { status?: number }).status ?? 1;
        console.log(`  Pre-check exit ${exitCode} — skipping ${job.name}`);
        runLog.append({
          jobName: job.name,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'skipped',
          durationMs: 0,
          attempt: 0,
          outputPreview: `Pre-check exit ${exitCode} — no work`,
        });
        lastRuns[job.name] = now.toISOString();
        continue;
      }
    }

    // Determine retry ceiling from error history
    const priorErrors = runLog.consecutiveErrors(job.name);
    const maxAttempts = 1 + Math.min(priorErrors, BACKOFF_MS.length);

    let succeeded = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = new Date();
      try {
        const response = await gateway.handleCronJob(job.name, job.prompt, job.tier, job.maxTurns, job.model, job.workDir, job.mode, job.maxHours);
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
          // Output logged to run history; daemon handles channel delivery
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

export async function cmdCronAdd(
  name: string,
  schedule: string,
  prompt: string,
  options: { tier?: string },
): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;

  // Validate cron expression
  if (!cron.validate(schedule)) {
    console.error(`Invalid cron expression: ${schedule}`);
    console.error('Examples: "0 9 * * 1" (Mon 9 AM), "*/30 * * * *" (every 30 min)');
    process.exit(1);
  }

  // Resolve CRON.md path
  const cronFile = path.join(BASE_DIR, 'vault', '00-System', 'CRON.md');

  // Read existing CRON.md or create empty structure
  let parsed: matter.GrayMatterFile<string>;
  if (existsSync(cronFile)) {
    const raw = readFileSync(cronFile, 'utf-8');
    parsed = matter(raw);
  } else {
    // Create directory if needed
    const dir = path.dirname(cronFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    parsed = matter('');
    parsed.data = {};
  }

  const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;

  // Check for duplicate name
  const duplicate = jobs.find(
    (j) => String(j.name ?? '').toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    console.error(`A job named "${name}" already exists.`);
    process.exit(1);
  }

  // Create new job entry
  const tier = parseInt(options.tier ?? '1', 10);
  const newJob = {
    name,
    schedule,
    prompt,
    enabled: true,
    tier: isNaN(tier) ? 1 : tier,
  };

  jobs.push(newJob);
  parsed.data.jobs = jobs;

  // Write back preserving body content — validate first to prevent daemon crash
  const output = matter.stringify(parsed.content, parsed.data);
  try {
    matter(output);
  } catch (err) {
    console.error(`Generated CRON.md has invalid YAML: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  writeFileSync(cronFile, output);

  console.log(`Added cron job: ${name}`);
  console.log(`  Schedule: ${schedule}`);
  console.log(`  Prompt:   ${prompt.slice(0, 100)}`);
  console.log(`  Tier:     ${newJob.tier}`);
  console.log(`  Enabled:  true`);
  console.log();
  console.log('The daemon will auto-reload CRON.md on file change.');
}

export async function cmdCronTest(jobNameOrIndex: string): Promise<void> {
  process.env.CLEMENTINE_HOME = BASE_DIR;

  const jobs = parseCronJobs();
  if (jobs.length === 0) {
    console.error('No cron jobs defined. Edit vault/00-System/CRON.md to add jobs.');
    process.exit(1);
  }

  // Find job by name (case-insensitive) or by numeric index
  let job: CronJobDefinition | undefined;
  const index = parseInt(jobNameOrIndex, 10);

  if (!isNaN(index) && index >= 0 && index < jobs.length) {
    job = jobs[index];
  } else {
    job = jobs.find(
      (j) => j.name.toLowerCase() === jobNameOrIndex.toLowerCase(),
    );
  }

  if (!job) {
    console.error(`Job not found: ${jobNameOrIndex}`);
    console.error(`Available jobs: ${jobs.map((j) => j.name).join(', ') || '(none)'}`);
    process.exit(1);
  }

  console.log(`Dry-running cron job: ${job.name}`);
  console.log(`  Schedule: ${job.schedule}`);
  console.log(`  Prompt:   ${job.prompt.slice(0, 100)}`);
  console.log(`  Tier:     ${job.tier}`);
  console.log();

  const { gateway } = await initGateway();

  try {
    const response = await gateway.handleCronJob(job.name, job.prompt, job.tier, job.maxTurns, job.model, job.workDir, job.mode, job.maxHours);
    console.log('--- Output ---');
    console.log(response || '(no output)');
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
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

  // Determine how far back to look: since last run, or up to 24 hours
  const lastRun = lastRuns[job.name];
  let lookbackMinutes: number;

  if (lastRun) {
    const lastRunDate = new Date(lastRun);
    const elapsedMs = now.getTime() - lastRunDate.getTime();
    if (elapsedMs < 2 * 60 * 1000) return false; // ran <2min ago, skip
    lookbackMinutes = Math.min(Math.ceil(elapsedMs / 60_000), 1440); // cap at 24h
  } else {
    // Never run — look back up to 24 hours for any scheduled time
    lookbackMinutes = 1440;
  }

  // Check if the cron schedule matches any minute in the lookback window
  for (let offsetMin = 0; offsetMin < lookbackMinutes; offsetMin++) {
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
