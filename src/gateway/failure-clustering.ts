/**
 * Cross-job failure clustering (1.18.163).
 *
 * Today the failure pipeline is per-job:
 *   broken-job(jobName) → classifyFailure(lastErrors) → 1 fix proposal
 *
 * That means when 5 different cron jobs all hit the same root cause
 * (e.g. all 5 fail with "Prompt is too long"), the system generates
 * 5 isolated patches instead of 1 root-cause fix. The owner sees
 * 5 separate proposals in the Self-Improve tab and either approves all
 * 5 (busywork) or denies them (and the underlying issue persists).
 *
 * This module groups recent broken jobs by *normalized error pattern*.
 * When ≥3 distinct jobs hit the same cluster, the owner gets ONE
 * "5 jobs all hit X — propose Y for all of them" suggestion instead of
 * N separate ones.
 *
 * This is purely a *suggestion / presentation* layer — clusters are
 * surfaced as a hint to the hypothesizer + dashboard. The existing
 * per-job `failure-fix-consumer` continues to handle individual patches
 * unchanged. Clustering is additive observability, not a replacement
 * for per-job fixes.
 *
 * Reads from the existing `computeBrokenJobs()` source — no new schema,
 * no new persistence, computed on demand.
 */

import pino from 'pino';
import { computeBrokenJobs } from './failure-monitor.js';
import type { BrokenJob } from './failure-monitor.js';

const logger = pino({ name: 'clementine.failure-clustering' });

// ── Tunables ─────────────────────────────────────────────────────────

/**
 * Minimum distinct jobs required to form a cluster. Below this we don't
 * bother — a single repeated error is just a per-job problem.
 *
 * 3 is conservative: 2 looks coincidental, 3 is "this is a systemic
 * thing." Tunable if we get noise.
 */
export const MIN_CLUSTER_SIZE = 3;

/** Max chars of an error message we consider when normalizing. The
 *  important signal is in the first ~200 chars; longer suffixes are
 *  usually stack traces or per-call IDs that destroy clustering. */
const ERROR_NORMALIZE_LEN = 200;

// ── Normalization ────────────────────────────────────────────────────

/**
 * Normalize an error message into a clustering key.
 *
 * Goals:
 *  - "Prompt is too long (12345 tokens)" and "Prompt is too long (45678
 *    tokens)" should collapse to the same key.
 *  - Job-specific tokens (UUIDs, timestamps, paths with the job name)
 *    should be stripped.
 *  - The result should still be human-readable (we surface it in the UI).
 *
 * Strategy:
 *  1. Lowercase + collapse whitespace
 *  2. Strip ISO timestamps + UNIX epochs
 *  3. Strip UUIDs and long hex tokens
 *  4. Strip parenthesized numbers ("(12345 tokens)" → "(N tokens)")
 *  5. Strip absolute paths
 *  6. Truncate to ERROR_NORMALIZE_LEN
 */
export function normalizeErrorMessage(raw: string): string {
  if (!raw) return '';
  let s = raw.toLowerCase().trim();

  // ISO timestamps: 2026-05-10T14:23:00.000Z (with optional millis/tz)
  s = s.replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?(z|[+-]\d{2}:?\d{2})?/g, '<ts>');
  // Unix epoch ms (13-digit) + sec (10-digit) — must come BEFORE plain numbers
  s = s.replace(/\b\d{13}\b/g, '<ts>');
  s = s.replace(/\b\d{10}\b/g, '<ts>');
  // UUIDs
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  // Long hex (16+ chars, like commit SHAs / session ids)
  s = s.replace(/\b[0-9a-f]{16,}\b/g, '<hex>');
  // Parenthesized numbers: (12345) → (N) ; (12345 tokens) → (N tokens)
  s = s.replace(/\(\s*\d[\d,_.]*\s*([a-z]*)\s*\)/g, (_m, suffix) => suffix ? `(N ${suffix})` : '(N)');
  // Absolute paths — keep just the basename
  s = s.replace(/\/[\w./-]+\/([\w.-]+)/g, '<path>/$1');
  // Generic standalone large numbers
  s = s.replace(/\b\d{4,}\b/g, '<N>');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s.slice(0, ERROR_NORMALIZE_LEN);
}

// ── Cluster shape ────────────────────────────────────────────────────

export interface FailureCluster {
  /** The normalized pattern key. Stable across jobs/runs. */
  pattern: string;
  /** A representative human-readable error message (one of the original
   *  uncleaned strings, picked by frequency). */
  representative: string;
  /** Distinct jobs hitting this cluster, sorted by error count desc. */
  jobs: Array<{
    jobName: string;
    agentSlug?: string;
    errorCount48h: number;
    lastErrorAt: string | null;
  }>;
  /** Total errors across all jobs in the cluster (last 48h). */
  totalErrors: number;
}

// ── Clusterer ────────────────────────────────────────────────────────

/**
 * Group the current broken jobs by normalized error pattern. Only
 * returns clusters with ≥ MIN_CLUSTER_SIZE distinct jobs. Returns
 * largest clusters first (by distinct-job count, then total error
 * count).
 *
 * Each broken job contributes UP TO 3 patterns (its `lastErrors[]`).
 * A job that hits two distinct patterns counts toward both clusters
 * — that's by design, since a job with two root causes really does
 * need both fixes.
 */
export function clusterBrokenJobs(jobs?: BrokenJob[]): FailureCluster[] {
  const source = jobs ?? computeBrokenJobs();
  if (source.length === 0) return [];

  // pattern → { representative (most common raw), jobs map keyed by jobName }
  const buckets = new Map<string, {
    representative: string;
    rawCounts: Map<string, number>;
    jobs: Map<string, FailureCluster['jobs'][number]>;
  }>();

  for (const job of source) {
    const seenForThisJob = new Set<string>();
    for (const raw of job.lastErrors ?? []) {
      const key = normalizeErrorMessage(raw);
      if (!key) continue;
      // Don't double-count this job for the same pattern even if
      // lastErrors contains two near-identical messages.
      if (seenForThisJob.has(key)) continue;
      seenForThisJob.add(key);

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { representative: raw, rawCounts: new Map(), jobs: new Map() };
        buckets.set(key, bucket);
      }
      bucket.rawCounts.set(raw, (bucket.rawCounts.get(raw) ?? 0) + 1);
      // Pick the most-common raw form as the representative on the fly.
      const cur = bucket.rawCounts.get(raw)!;
      const best = bucket.rawCounts.get(bucket.representative) ?? 0;
      if (cur > best) bucket.representative = raw;

      const existing = bucket.jobs.get(job.jobName);
      if (existing) {
        existing.errorCount48h += job.errorCount48h;
      } else {
        bucket.jobs.set(job.jobName, {
          jobName: job.jobName,
          ...(job.agentSlug ? { agentSlug: job.agentSlug } : {}),
          errorCount48h: job.errorCount48h,
          lastErrorAt: job.lastErrorAt,
        });
      }
    }
  }

  const clusters: FailureCluster[] = [];
  for (const [pattern, bucket] of buckets) {
    if (bucket.jobs.size < MIN_CLUSTER_SIZE) continue;
    const jobsArr = [...bucket.jobs.values()].sort(
      (a, b) => b.errorCount48h - a.errorCount48h,
    );
    const totalErrors = jobsArr.reduce((acc, j) => acc + j.errorCount48h, 0);
    clusters.push({
      pattern,
      representative: bucket.representative,
      jobs: jobsArr,
      totalErrors,
    });
  }

  // Sort: distinct-job count desc, then total errors desc, then pattern asc
  clusters.sort((a, b) => {
    if (b.jobs.length !== a.jobs.length) return b.jobs.length - a.jobs.length;
    if (b.totalErrors !== a.totalErrors) return b.totalErrors - a.totalErrors;
    return a.pattern.localeCompare(b.pattern);
  });

  if (clusters.length > 0) {
    logger.info(
      { count: clusters.length, top: clusters[0]?.pattern.slice(0, 80), topJobs: clusters[0]?.jobs.length },
      'Failure clusters detected',
    );
  }
  return clusters;
}

/**
 * Render a cluster summary for the hypothesizer prompt block. Empty
 * string when no clusters meet the threshold.
 *
 * Format:
 *   ### Cross-job failure clusters (last 48h)
 *   - "Prompt is too long (N tokens)" — 5 jobs: insight-check, outcome-grader, route-classifier, ...
 *   - "Reached maximum number of turns (N)" — 3 jobs: ...
 *   Bias one root-cause proposal toward the largest cluster instead of N per-job ones.
 */
export function formatClustersForHypothesizer(clusters: FailureCluster[]): string {
  if (!clusters || clusters.length === 0) return '';
  const lines: string[] = ['### Cross-job failure clusters (last 48h)'];
  for (const c of clusters.slice(0, 5)) {
    const jobNames = c.jobs.slice(0, 5).map(j => j.jobName).join(', ');
    const more = c.jobs.length > 5 ? `, +${c.jobs.length - 5} more` : '';
    const rep = c.representative.length > 100 ? c.representative.slice(0, 100) + '…' : c.representative;
    lines.push(`- "${rep}" — ${c.jobs.length} jobs (${c.totalErrors} total errors): ${jobNames}${more}`);
  }
  lines.push(
    'When a cluster of 3+ jobs hits the same pattern, prefer ONE root-cause proposal ' +
    '(e.g. an advisor-rule, a prompt-override at agent or global scope, or a shared ' +
    'config change) over N per-job patches.',
  );
  return lines.join('\n') + '\n\n';
}
