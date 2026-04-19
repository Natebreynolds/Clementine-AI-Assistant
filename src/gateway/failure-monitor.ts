/**
 * Clementine TypeScript — Cron failure monitor.
 *
 * Surfaces cron jobs that have been failing repeatedly so they don't sit
 * silently broken (which is what happened to ross-the-sdr:reply-detection —
 * the existing circuit breaker fired ONCE at consErrors=5 and then went
 * quiet for days).
 *
 * Threshold: a job is "broken" if either
 *   - it has >= 3 error/retried entries in the last 48h, OR
 *   - the circuit breaker engaged for it within the last 48h.
 *
 * Per-job 24h cooldown prevents re-spamming the owner with the same news.
 *
 * Read-only with respect to the cron run logs and advisor events; mutates
 * only its own state file (cron/failure-monitor.json).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';
import type { CronRunEntry } from '../types.js';

const logger = pino({ name: 'clementine.failure-monitor' });

const RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');
const ADVISOR_EVENTS_FILE = path.join(BASE_DIR, 'cron', 'advisor-events.jsonl');
const STATE_FILE = path.join(BASE_DIR, 'cron', 'failure-monitor.json');

/** A job is broken if it crosses any of these thresholds in the lookback window. */
const ERRORS_IN_WINDOW = 3;
const WINDOW_HOURS = 48;
/** Don't re-DM the owner about the same broken job within this window. */
const NOTIFY_COOLDOWN_HOURS = 24;

export interface BrokenJob {
  jobName: string;
  agentSlug?: string;
  errorCount48h: number;
  totalRuns48h: number;
  lastErrorAt: string | null;
  lastErrors: string[];                  // up to 3 distinct error messages
  circuitBreakerEngagedAt: string | null;
  lastAdvisorOpinion: string | null;
}

interface MonitorState {
  notified: Record<string, { lastNotifiedAt: string; lastErrorCount: number }>;
}

function loadState(): MonitorState {
  try {
    if (!existsSync(STATE_FILE)) return { notified: {} };
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return { notified: raw.notified ?? {} };
  } catch {
    return { notified: {} };
  }
}

function saveState(state: MonitorState): void {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to persist failure-monitor state');
  }
}

function readRunLog(filePath: string): CronRunEntry[] {
  try {
    return readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as CronRunEntry; }
        catch { return null; }
      })
      .filter((e): e is CronRunEntry => e !== null);
  } catch {
    return [];
  }
}

function isFailure(entry: CronRunEntry): boolean {
  return entry.status === 'error' || entry.status === 'retried';
}

/**
 * Pull the most recent circuit-breaker engagement for a job, looking at the
 * entire advisor log (not just the 48h window). A stuck breaker counts as a
 * broken job even if it last fired weeks ago, because while engaged the job
 * stops running entirely and produces no new failure entries.
 *
 * Returns the engagement timestamp (if currently engaged with no subsequent
 * recovery) and the most recent advisor opinion string, if any.
 */
function lastCircuitBreakerEvent(jobName: string): {
  engagedAt: string | null;
  lastOpinion: string | null;
} {
  if (!existsSync(ADVISOR_EVENTS_FILE)) return { engagedAt: null, lastOpinion: null };
  let engagedAt: string | null = null;
  let lastOpinion: string | null = null;
  try {
    const lines = readFileSync(ADVISOR_EVENTS_FILE, 'utf-8').trim().split('\n');
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as { type: string; jobName: string; detail: string; timestamp: string };
        if (evt.jobName !== jobName) continue;
        // Capture the most recent opinion regardless of type
        lastOpinion = `${evt.type}: ${evt.detail}`;
        if (evt.type === 'circuit-breaker') engagedAt = evt.timestamp;
        if (evt.type === 'circuit-recovery' || evt.type === 'auto-disabled') engagedAt = null;
      } catch { /* skip malformed */ }
    }
  } catch { /* non-fatal */ }
  return { engagedAt, lastOpinion };
}

/**
 * Compute the current set of broken jobs by scanning all run logs.
 * Pure function (state-free) — used both by the monitor sweep and the dashboard endpoint.
 */
export function computeBrokenJobs(now = Date.now()): BrokenJob[] {
  if (!existsSync(RUNS_DIR)) return [];
  const sinceMs = now - WINDOW_HOURS * 60 * 60 * 1000;
  const broken: BrokenJob[] = [];

  let files: string[] = [];
  try { files = readdirSync(RUNS_DIR).filter(f => f.endsWith('.jsonl')); }
  catch { return []; }

  for (const file of files) {
    const entries = readRunLog(path.join(RUNS_DIR, file));
    if (entries.length === 0) continue;

    const jobName = entries[0]!.jobName;
    // Always consult the breaker state — a stuck breaker is the primary
    // signal for "job has been silently broken for days".
    const cb = lastCircuitBreakerEvent(jobName);

    const inWindow = entries.filter(e => {
      const ts = Date.parse(e.startedAt);
      return Number.isFinite(ts) && ts >= sinceMs;
    });
    const failures = inWindow.filter(isFailure);

    const meetsThreshold = failures.length >= ERRORS_IN_WINDOW || !!cb.engagedAt;
    if (!meetsThreshold) continue;

    // Gather up to 3 distinct error messages, newest first. Prefer in-window
    // errors; if the breaker is engaged and there are no recent runs, fall
    // back to the most recent errors anywhere in the log.
    const errSource = failures.length > 0
      ? failures
      : entries.filter(isFailure);
    const distinctErrors: string[] = [];
    const seen = new Set<string>();
    for (let i = errSource.length - 1; i >= 0 && distinctErrors.length < 3; i--) {
      const err = (errSource[i]!.error ?? '').trim();
      if (!err) continue;
      const key = err.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      distinctErrors.push(err.slice(0, 400));
    }

    const lastFailureEntry = failures[failures.length - 1] ?? errSource[errSource.length - 1] ?? null;
    const agentSlug = jobName.includes(':') ? jobName.split(':')[0] : undefined;

    broken.push({
      jobName,
      agentSlug,
      errorCount48h: failures.length,
      totalRuns48h: inWindow.length,
      lastErrorAt: lastFailureEntry?.startedAt ?? null,
      lastErrors: distinctErrors,
      circuitBreakerEngagedAt: cb.engagedAt,
      lastAdvisorOpinion: cb.lastOpinion,
    });
  }

  // Most recently failing first
  broken.sort((a, b) => {
    const aT = a.lastErrorAt ? Date.parse(a.lastErrorAt) : 0;
    const bT = b.lastErrorAt ? Date.parse(b.lastErrorAt) : 0;
    return bT - aT;
  });

  return broken;
}

/** Format a broken-job report for the owner DM. */
function formatReport(jobs: BrokenJob[]): string {
  const lines: string[] = [];
  lines.push(`🚨 **${jobs.length} cron job${jobs.length === 1 ? '' : 's'} repeatedly failing** (last ${WINDOW_HOURS}h)`);
  lines.push('');
  for (const j of jobs) {
    const breaker = j.circuitBreakerEngagedAt ? ' · circuit breaker engaged' : '';
    lines.push(`• \`${j.jobName}\` — ${j.errorCount48h}/${j.totalRuns48h} runs failed${breaker}`);
    if (j.lastErrors.length > 0) {
      const preview = j.lastErrors[0]!.split('\n')[0]!.slice(0, 140);
      lines.push(`  Last error: ${preview}`);
    }
    if (j.lastAdvisorOpinion) {
      lines.push(`  Advisor: ${j.lastAdvisorOpinion.slice(0, 140)}`);
    }
  }
  lines.push('');
  lines.push('Open the dashboard → Broken Jobs panel for the full picture.');
  return lines.join('\n');
}

/**
 * Run a sweep: identify currently-broken jobs, pick the ones we haven't
 * notified about recently, and dispatch one consolidated DM.
 *
 * Returns the jobs that triggered a fresh notification (mostly for tests/logs).
 */
export async function runFailureSweep(
  send: (text: string) => Promise<unknown>,
  now = Date.now(),
): Promise<BrokenJob[]> {
  const broken = computeBrokenJobs(now);
  if (broken.length === 0) {
    // Clear cooldowns for jobs that recovered so future failures notify promptly.
    const state = loadState();
    let mutated = false;
    for (const name of Object.keys(state.notified)) {
      if (!broken.find(b => b.jobName === name)) {
        delete state.notified[name];
        mutated = true;
      }
    }
    if (mutated) saveState(state);
    return [];
  }

  const state = loadState();
  const cooldownMs = NOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000;
  const fresh: BrokenJob[] = [];

  for (const job of broken) {
    const prev = state.notified[job.jobName];
    if (prev && now - Date.parse(prev.lastNotifiedAt) < cooldownMs) continue;
    fresh.push(job);
  }

  if (fresh.length === 0) return [];

  try {
    await send(formatReport(fresh));
    const stamp = new Date(now).toISOString();
    for (const job of fresh) {
      state.notified[job.jobName] = { lastNotifiedAt: stamp, lastErrorCount: job.errorCount48h };
    }
    saveState(state);
    appendAuditLog('notified', fresh.map(j => j.jobName));
    logger.info({ count: fresh.length, jobs: fresh.map(j => j.jobName) }, 'Failure monitor: notified owner');
  } catch (err) {
    logger.warn({ err }, 'Failure monitor: notification dispatch failed');
  }

  return fresh;
}

function appendAuditLog(action: string, jobNames: string[]): void {
  try {
    const auditPath = path.join(BASE_DIR, 'cron', 'failure-monitor.log');
    appendFileSync(auditPath, JSON.stringify({
      action,
      jobs: jobNames,
      timestamp: new Date().toISOString(),
    }) + '\n');
  } catch { /* non-fatal */ }
}
