/**
 * Skill quality scoring per Anthropic skill metrics (1.18.164).
 *
 * Anthropic's skill spec calls for tracking per-skill quality with a few
 * specific metrics: trigger accuracy, success rate, average tool calls,
 * average tokens, failure rate per workflow. Today we have the raw data
 * (CronRunEntry stamps `skillsApplied: [{name, source}]` on every run
 * since 1.18.85) but never aggregate it into a "how is this skill
 * actually performing?" view.
 *
 * This module computes the metrics on demand from the existing run log —
 * no new schema, no new persistence. The Skills page card surfaces the
 * scores so the owner can spot:
 *   - Skills that auto-trigger but don't help (low trigger accuracy)
 *   - Skills that are pinned but consistently fail (low success rate)
 *   - Skills with no recent activity ("stale")
 *   - Skills with no data at all ("no-data" — fresh; may be unused)
 *
 * The grade is a coarse 4-bucket label optimized for "what should the
 * owner do about this skill?" rather than a precise number. Detailed
 * stats accompany so the owner can drill in.
 *
 * Why no SQLite table:
 *  - The data already exists in CronRunLog jsonl files
 *  - Recompute is cheap (one-time scan over recent jsonl)
 *  - Avoids a new schema migration + the risk of double-counting if
 *    we forget to write to it from one of the run paths
 *  - Owner isn't running this 100×/sec — the dashboard hits it once
 *    when the Skills page renders
 *
 * If the volume ever grows past ~50 skills × 500 runs/day, we can
 * promote to SQLite. Until then, keep it simple.
 */

import path from 'node:path';
import pino from 'pino';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BASE_DIR } from '../config.js';
import type { CronRunEntry } from '../types.js';

const logger = pino({ name: 'clementine.skill-quality' });

// ── Tunables ─────────────────────────────────────────────────────────

/** Default rolling window for quality computation. Anthropic suggests
 *  a 30-day evaluation horizon for skill metrics; that matches our
 *  cron-run-log retention so we read what we have. */
export const DEFAULT_WINDOW_DAYS = 30;

/** Minimum runs before we hand out a grade. Below this, the skill is
 *  marked 'no-data' regardless of pass/fail to avoid grading from a
 *  sample of 1. */
const MIN_RUNS_FOR_GRADE = 3;

/** Stale threshold — if the skill hasn't been used at all within
 *  this many days, the grade becomes 'stale' regardless of past stats. */
const STALE_DAYS = 30;

/** Below this success-rate threshold a skill with enough runs is graded
 *  'underperforming'. 0.6 = "fails 4 in 10" — a reasonable trigger for
 *  the owner to investigate. */
const UNDERPERFORMING_SUCCESS_RATE = 0.6;

// ── Types ─────────────────────────────────────────────────────────────

export interface SkillQualityScore {
  /** Skill identifier (the `name` field from frontmatter). */
  name: string;
  /** Window the metrics cover. */
  windowDays: number;
  /** Total runs in the window where this skill was applied. */
  totalRuns: number;
  /** Of those, runs where the skill was explicitly pinned by the cron. */
  pinnedRuns: number;
  /** Of those, runs where the skill was auto-matched by the search layer. */
  autoRuns: number;
  /** Runs we count as successful (status='ok' AND goalCheck didn't fail). */
  successRuns: number;
  /** Runs we count as failed (status in error/timeout/lost OR goalCheck.fail). */
  failureRuns: number;
  /** successRuns / totalRuns — null when totalRuns is 0. */
  successRate: number | null;
  /** Among auto-matched runs only, what fraction succeeded. Anthropic's
   *  "trigger accuracy" — how often the auto-match was the right call.
   *  null when there are no auto-matched runs in the window. */
  triggerAccuracy: number | null;
  /** Average duration in ms across runs that completed (not 'running'). */
  avgDurationMs: number | null;
  /** Average cost in USD across runs that report it. */
  avgCostUsd: number | null;
  /** Most recent ISO timestamp this skill was applied to a run. */
  lastUsedAt: string | null;
  /**
   * Coarse 4-bucket label for owner attention:
   *  - 'good' — enough runs, success rate above threshold
   *  - 'underperforming' — enough runs, success rate below threshold
   *  - 'stale' — no runs in the last STALE_DAYS regardless of past stats
   *  - 'no-data' — fewer than MIN_RUNS_FOR_GRADE runs in the window
   */
  grade: 'good' | 'underperforming' | 'stale' | 'no-data';
  /** One-sentence reason for the grade — surfaces under the badge. */
  gradeReason: string;
}

// ── Internals ────────────────────────────────────────────────────────

/** Scan all per-job run log files and yield every entry within the window. */
function* iterRecentRuns(windowDays: number, baseDir = BASE_DIR): Generator<CronRunEntry> {
  const runsDir = path.join(baseDir, 'cron', 'runs');
  if (!existsSync(runsDir)) return;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(path.join(runsDir, file), 'utf-8').trim().split('\n').filter(Boolean);
    } catch {
      continue;
    }
    // Iterate newest-first; bail once we cross the cutoff (assumes
    // append-only writes).
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: CronRunEntry;
      try { entry = JSON.parse(lines[i]!) as CronRunEntry; }
      catch { continue; }
      const ts = Date.parse(entry.startedAt);
      if (Number.isFinite(ts) && ts < cutoff) break;
      yield entry;
    }
  }
}

/** Did this run succeed for the purposes of skill scoring? Status='ok'
 *  combined with a non-failing goalCheck (when present). */
function isRunSuccess(entry: CronRunEntry): boolean {
  if (entry.status !== 'ok') return false;
  if (entry.goalCheck?.status === 'fail') return false;
  return true;
}

/** Did this run terminally fail? Excludes 'running'/'skipped' so they
 *  don't pull either ratio. */
function isRunFailure(entry: CronRunEntry): boolean {
  if (entry.status === 'error' || entry.status === 'timeout' || entry.status === 'lost') return true;
  if (entry.status === 'ok' && entry.goalCheck?.status === 'fail') return true;
  return false;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Compute quality scores for a single skill. Returns the aggregate even
 * when there's no data — graded 'no-data' so the dashboard can render
 * a clean empty state.
 */
export function computeSkillQuality(
  skillName: string,
  options: { windowDays?: number; baseDir?: string } = {},
): SkillQualityScore {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  let total = 0, pinned = 0, auto = 0, success = 0, failure = 0;
  let durationSumMs = 0, durationN = 0;
  let costSum = 0, costN = 0;
  let autoSuccess = 0, autoTotal = 0;
  let lastUsedAt: string | null = null;

  for (const entry of iterRecentRuns(windowDays, options.baseDir)) {
    const applied = (entry.skillsApplied ?? []).find(s => s.name === skillName);
    if (!applied) continue;

    total++;
    if (applied.source === 'pinned') pinned++;
    else if (applied.source === 'auto') auto++;

    if (isRunSuccess(entry)) success++;
    if (isRunFailure(entry)) failure++;

    if (applied.source === 'auto') {
      autoTotal++;
      if (isRunSuccess(entry)) autoSuccess++;
    }

    if (typeof entry.durationMs === 'number' && entry.durationMs > 0 && entry.status !== 'running') {
      durationSumMs += entry.durationMs;
      durationN++;
    }
    if (typeof entry.totalCostUsd === 'number') {
      costSum += entry.totalCostUsd;
      costN++;
    }

    if (!lastUsedAt || entry.startedAt > lastUsedAt) {
      lastUsedAt = entry.startedAt;
    }
  }

  const successRate = total > 0 ? success / total : null;
  const triggerAccuracy = autoTotal > 0 ? autoSuccess / autoTotal : null;
  const avgDurationMs = durationN > 0 ? Math.round(durationSumMs / durationN) : null;
  const avgCostUsd = costN > 0 ? costSum / costN : null;

  // Grade decision — order matters: 'no-data' beats everything for
  // small samples; 'stale' beats 'underperforming' for skills that
  // historically did fine but stopped firing.
  let grade: SkillQualityScore['grade'] = 'no-data';
  let gradeReason = `Only ${total} run${total === 1 ? '' : 's'} in the last ${windowDays}d — not enough to grade.`;
  if (total >= MIN_RUNS_FOR_GRADE) {
    if (lastUsedAt) {
      const lastMs = Date.parse(lastUsedAt);
      if (Number.isFinite(lastMs) && Date.now() - lastMs > STALE_DAYS * 24 * 60 * 60 * 1000) {
        grade = 'stale';
        gradeReason = `No runs in the last ${STALE_DAYS} days. Consider archiving or revisiting triggers.`;
      } else if (successRate !== null && successRate < UNDERPERFORMING_SUCCESS_RATE) {
        grade = 'underperforming';
        gradeReason = `${(successRate * 100).toFixed(0)}% success over ${total} runs — investigate failures + tighten triggers or body.`;
      } else {
        grade = 'good';
        gradeReason = `${successRate !== null ? (successRate * 100).toFixed(0) : '?'}% success over ${total} runs.`;
      }
    } else {
      // Defensive — shouldn't happen if total > 0, but keep fall-through.
      grade = 'no-data';
    }
  }

  return {
    name: skillName,
    windowDays,
    totalRuns: total,
    pinnedRuns: pinned,
    autoRuns: auto,
    successRuns: success,
    failureRuns: failure,
    successRate,
    triggerAccuracy,
    avgDurationMs,
    avgCostUsd,
    lastUsedAt,
    grade,
    gradeReason,
  };
}

/**
 * Compute scores for every skill that appeared in *any* run within the
 * window. Returns one score per skill name, sorted by totalRuns desc
 * (most-used first). Skills that exist in the vault but never ran will
 * not appear — callers that need "every skill" should merge with the
 * skill-store listing themselves.
 */
export function computeAllSkillQuality(
  options: { windowDays?: number; baseDir?: string } = {},
): SkillQualityScore[] {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  // First pass: collect every skill name that appears at least once.
  const seen = new Set<string>();
  for (const entry of iterRecentRuns(windowDays, options.baseDir)) {
    for (const s of entry.skillsApplied ?? []) {
      if (s?.name) seen.add(s.name);
    }
  }
  // Second pass: full scoring per skill. Two passes is wasteful but
  // simple; with ~50 skills × 2000-line files this is ms-cheap.
  const scores: SkillQualityScore[] = [];
  for (const name of seen) {
    scores.push(computeSkillQuality(name, options));
  }
  scores.sort((a, b) => b.totalRuns - a.totalRuns || a.name.localeCompare(b.name));
  if (scores.length > 0) {
    logger.debug(
      { count: scores.length, top: scores[0]?.name, topRuns: scores[0]?.totalRuns },
      'Skill quality scored',
    );
  }
  return scores;
}
