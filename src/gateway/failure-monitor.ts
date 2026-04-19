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
const SELF_IMPROVE_STATE_FILE = path.join(BASE_DIR, 'self-improve', 'state.json');
const SELF_IMPROVE_LOG_FILE = path.join(BASE_DIR, 'self-improve', 'experiment-log.jsonl');

/** A job is broken if it crosses any of these thresholds in the lookback window. */
const ERRORS_IN_WINDOW = 3;
const WINDOW_HOURS = 48;
/**
 * Independent of the window — a job whose last N runs are all failures is
 * broken even if they're spread over days (daily cron jobs can't accumulate
 * 3 failures in 48h, but 2 consecutive BLOCKED days is still broken).
 */
const CONSECUTIVE_FAILURES = 2;
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
  /** Populated asynchronously by the diagnostic agent when available. */
  diagnosis?: {
    rootCause: string;
    confidence: 'high' | 'medium' | 'low';
    proposedFix: {
      type: string;
      details: string;
      diff?: string;
    };
    riskLevel: 'low' | 'medium' | 'high';
    generatedAt: string;
  };
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
  return entry.status === 'error' || entry.status === 'retried' || isSemanticFailure(entry);
}

/**
 * "Semantic failure" — a run the scheduler called `ok` but whose agent output
 * self-reports the task didn't actually complete. We only flag on explicit
 * block/failure markers in the preview; the duration-vs-output heuristic was
 * tested against the live corpus and produced too many false positives on
 * legitimately quiet jobs (healthchecks, inbox probes that return empty
 * when there's nothing to report).
 *
 * Markers are drawn from observed failure modes in Ross's cron jobs
 * (kernel-vs-local Bash, "BLOCKED (no local bash access)") plus generic
 * agent self-reports.
 */
function isSemanticFailure(entry: CronRunEntry): boolean {
  if (entry.status !== 'ok') return false;
  const preview = (entry.outputPreview ?? '').trim();
  if (!preview) return false;
  const previewLower = preview.toLowerCase();

  // Match on word boundaries so "BLOCKED" matches "Result: BLOCKED" but
  // "blockedBy" in a stray JSON fragment doesn't.
  const markerRegexes = [
    /\b(blocked|task_blocked|task_incomplete)\b/,
    /\b(failed|could not|unable to|no local bash|permission denied)\b/,
    /__nothing__/,
  ];
  for (const re of markerRegexes) {
    if (re.test(previewLower)) return true;
  }
  return false;
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

  const dormantCutoffMs = now - 7 * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const entries = readRunLog(path.join(RUNS_DIR, file));
    if (entries.length === 0) continue;

    const jobName = entries[0]!.jobName;

    // Skip dormant jobs — if the last run is >7 days old the job is
    // probably removed or renamed and its historical failures aren't
    // actionable. Circuit breaker still counts because an engaged breaker
    // is itself "the job stopped running".
    const lastEntry = entries[entries.length - 1]!;
    const lastRunMs = Date.parse(lastEntry.startedAt);

    // Always consult the breaker state — a stuck breaker is the primary
    // signal for "job has been silently broken for days".
    let cb = lastCircuitBreakerEvent(jobName);

    // Clear a "stuck" breaker flag if we see an ok run AFTER the last
    // breaker engagement. The scheduler only logs a circuit-recovery
    // event when consecutiveErrors >= 5 at recovery time — but a
    // successful manual/probe run resets consecutiveErrors to 0 first,
    // so the recovery branch never fires and the advisor log keeps the
    // breaker appearing engaged forever. Fix: use run-log truth instead.
    if (cb.engagedAt) {
      const engagedMs = Date.parse(cb.engagedAt);
      const hasOkSinceBreaker = entries.some(e =>
        e.status === 'ok' && Date.parse(e.startedAt) > engagedMs,
      );
      if (hasOkSinceBreaker) {
        cb = { engagedAt: null, lastOpinion: cb.lastOpinion };
      }
    }

    if (!cb.engagedAt && Number.isFinite(lastRunMs) && lastRunMs < dormantCutoffMs) {
      continue;
    }

    const inWindow = entries.filter(e => {
      const ts = Date.parse(e.startedAt);
      return Number.isFinite(ts) && ts >= sinceMs;
    });
    const failures = inWindow.filter(isFailure);

    // Consecutive-failure signal: scan from most recent entry backward.
    // Stops at the first non-failure (ignoring 'skipped' which is neither
    // signal). Catches daily jobs that fail every run without accumulating
    // 3 in a 48h window.
    let consecutiveFailures = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.status === 'skipped') continue;
      if (isFailure(e)) consecutiveFailures++;
      else break;
    }

    const meetsThreshold = failures.length >= ERRORS_IN_WINDOW
      || consecutiveFailures >= CONSECUTIVE_FAILURES
      || !!cb.engagedAt;
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

  // Also check the self-improve loop — it has its own log (not cron/runs/).
  const siBroken = detectSelfImproveBreakage(now);
  if (siBroken) broken.push(siBroken);

  // Most recently failing first
  broken.sort((a, b) => {
    const aT = a.lastErrorAt ? Date.parse(a.lastErrorAt) : 0;
    const bT = b.lastErrorAt ? Date.parse(b.lastErrorAt) : 0;
    return bT - aT;
  });

  // Attach any cached diagnosis (fresh within 24h). Reads the cache file
  // directly — avoids circular imports with failure-diagnostics.
  attachCachedDiagnoses(broken, now);

  return broken;
}

const DIAGNOSTICS_CACHE_FILE = path.join(BASE_DIR, 'cron', 'failure-diagnostics.json');
const DIAGNOSIS_TTL_MS = 24 * 60 * 60 * 1000;

function attachCachedDiagnoses(jobs: BrokenJob[], now: number): void {
  if (!existsSync(DIAGNOSTICS_CACHE_FILE)) return;
  try {
    const cache = JSON.parse(readFileSync(DIAGNOSTICS_CACHE_FILE, 'utf-8')) as Record<string, BrokenJob['diagnosis'] & { generatedAt: string }>;
    for (const j of jobs) {
      const d = cache[j.jobName];
      if (!d) continue;
      const age = now - Date.parse(d.generatedAt);
      if (Number.isFinite(age) && age < DIAGNOSIS_TTL_MS) {
        j.diagnosis = d;
      }
    }
  } catch { /* cache may be malformed — ignore */ }
}

/**
 * The self-improve loop writes to its own experiment-log.jsonl, not cron/runs/.
 * Its breakage pattern is: state.lastRunAt keeps getting updated nightly but
 * no new experiments are being appended (they're all failing pre-iteration),
 * OR the most recent experiments are all errors, OR state.infraError is set.
 *
 * Returns a synthetic BrokenJob for the self-improve pseudo-job, or null if
 * healthy / no data.
 */
function detectSelfImproveBreakage(now: number): BrokenJob | null {
  if (!existsSync(SELF_IMPROVE_STATE_FILE)) return null;

  let state: {
    lastRunAt?: string;
    status?: string;
    totalExperiments?: number;
    infraError?: { category: string; diagnostic: string };
  } = {};
  try { state = JSON.parse(readFileSync(SELF_IMPROVE_STATE_FILE, 'utf-8')); }
  catch { return null; }

  const experiments: Array<{ startedAt?: string; approvalStatus?: string; error?: string; reason?: string }> = [];
  if (existsSync(SELF_IMPROVE_LOG_FILE)) {
    try {
      const lines = readFileSync(SELF_IMPROVE_LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines.slice(-10)) {
        try { experiments.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }
  }

  const staleLookback = now - 7 * 24 * 60 * 60 * 1000; // 7 days

  const recentExperiments = experiments.filter(e => {
    const ts = e.startedAt ? Date.parse(e.startedAt) : 0;
    return Number.isFinite(ts) && ts >= staleLookback;
  });
  const recentErrors = recentExperiments.filter(e =>
    e.approvalStatus === 'denied' && (e.reason?.startsWith('Error') ?? false),
  );

  // Break modes we care about:
  //  a. state.infraError is set — loop detected unfixable infra issue
  //  b. state.status === 'failed' — run threw, didn't complete normally
  //  c. all 3+ most recent experiments are errors — persistent iteration failures
  //
  // Deliberately NOT flagging "silent early exit" (lastRunAt recent but no new
  // experiments) when state.status === 'completed'. That's the expected
  // plateau state: the hypothesizer returns null for every iteration because
  // the diversity constraint has blocked every previously-targeted area, the
  // loop skips, plateau triggers, loop exits cleanly. Not broken — saturated.
  // Forcing alarm on a saturated-but-healthy loop would make the monitor
  // unusable long-term.
  const hasInfraError = !!state.infraError;
  const runFailed = state.status === 'failed';
  const allRecentErrored = recentExperiments.length >= 3
    && recentExperiments.every(e => e.approvalStatus === 'denied');

  if (!hasInfraError && !runFailed && !allRecentErrored) return null;

  const lastErrors: string[] = [];
  for (let i = experiments.length - 1; i >= 0 && lastErrors.length < 3; i--) {
    const err = (experiments[i]!.error ?? '').trim();
    if (!err) continue;
    lastErrors.push(err.slice(0, 400));
  }

  let opinion: string;
  if (hasInfraError) {
    opinion = `infra: ${state.infraError!.category} — ${state.infraError!.diagnostic.slice(0, 200)}`;
  } else if (runFailed) {
    opinion = 'loop exited with status=failed — check daemon log for the thrown error';
  } else {
    opinion = `${recentErrors.length}/${recentExperiments.length} recent iterations errored`;
  }

  return {
    jobName: 'self-improve',
    agentSlug: undefined,
    errorCount48h: recentErrors.length,
    totalRuns48h: recentExperiments.length,
    lastErrorAt: experiments[experiments.length - 1]?.startedAt ?? state.lastRunAt ?? null,
    lastErrors,
    circuitBreakerEngagedAt: hasInfraError ? state.lastRunAt ?? null : null,
    lastAdvisorOpinion: opinion,
  };
}

/** Format a broken-job report for the owner DM. */
function formatReport(jobs: BrokenJob[]): string {
  const lines: string[] = [];
  lines.push(`🚨 **${jobs.length} cron job${jobs.length === 1 ? '' : 's'} repeatedly failing** (last ${WINDOW_HOURS}h)`);
  lines.push('');
  for (const j of jobs) {
    const breaker = j.circuitBreakerEngagedAt ? ' · circuit breaker engaged' : '';
    lines.push(`• \`${j.jobName}\` — ${j.errorCount48h}/${j.totalRuns48h} runs failed${breaker}`);

    // Prefer the diagnostic agent's analysis when available — it's more
    // actionable than the raw error. Fall back to error + advisor lines.
    if (j.diagnosis) {
      const conf = j.diagnosis.confidence === 'high' ? '' : ` (${j.diagnosis.confidence} confidence)`;
      lines.push(`  **Cause${conf}:** ${j.diagnosis.rootCause.slice(0, 240)}`);
      lines.push(`  **Proposed fix:** ${j.diagnosis.proposedFix.details.slice(0, 240)}`);
      if (j.diagnosis.proposedFix.diff) {
        // Show a short diff preview inline; full diff in the dashboard.
        const diffShort = j.diagnosis.proposedFix.diff.split('\n').slice(0, 4).join('\n');
        lines.push('  ```diff');
        lines.push('  ' + diffShort.replace(/\n/g, '\n  '));
        lines.push('  ```');
      }
    } else {
      if (j.lastErrors.length > 0) {
        const preview = j.lastErrors[0]!.split('\n')[0]!.slice(0, 140);
        lines.push(`  Last error: ${preview}`);
      }
      if (j.lastAdvisorOpinion) {
        lines.push(`  Advisor: ${j.lastAdvisorOpinion.slice(0, 140)}`);
      }
    }
  }
  lines.push('');
  lines.push('Open the dashboard → Broken Jobs panel for the full picture.');
  return lines.join('\n');
}

/**
 * Run a sweep: identify currently-broken jobs, pick the ones we haven't
 * notified about recently, invoke the diagnostic agent for new entries,
 * and dispatch one consolidated DM.
 *
 * `gateway` is optional — omitted for tests that want to skip the LLM call.
 * When present, we diagnose fresh broken jobs before notifying, so the
 * report includes a root-cause + proposed fix for each.
 *
 * Returns the jobs that triggered a fresh notification (mostly for tests/logs).
 */
export async function runFailureSweep(
  send: (text: string) => Promise<unknown>,
  gateway?: import('./router.js').Gateway,
  now = Date.now(),
): Promise<BrokenJob[]> {
  const broken = computeBrokenJobs(now);
  if (broken.length === 0) {
    // Clear cooldowns AND diagnostic cache entries for jobs that recovered.
    const state = loadState();
    let mutated = false;
    const healedJobs: string[] = [];
    for (const name of Object.keys(state.notified)) {
      if (!broken.find(b => b.jobName === name)) {
        delete state.notified[name];
        healedJobs.push(name);
        mutated = true;
      }
    }
    if (mutated) saveState(state);
    // Opportunistically drop diagnosis cache for healed jobs
    if (healedJobs.length > 0) {
      try {
        const { clearDiagnosis } = await import('./failure-diagnostics.js');
        for (const name of healedJobs) clearDiagnosis(name);
      } catch { /* non-fatal */ }
    }
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

  // Diagnose fresh broken jobs before DMing. Each call is cached 24h, so a
  // recurring failure doesn't re-invoke the LLM. Diagnosis is best-effort —
  // if it fails or the gateway isn't wired, the report still goes out.
  if (gateway) {
    try {
      const { diagnoseBrokenJob } = await import('./failure-diagnostics.js');
      for (const job of fresh) {
        if (job.diagnosis) continue; // already attached from cache
        try {
          const d = await diagnoseBrokenJob(job, gateway);
          if (d) job.diagnosis = d;
        } catch (err) {
          logger.warn({ err, job: job.jobName }, 'Diagnosis attempt failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load diagnostics module');
    }
  }

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
