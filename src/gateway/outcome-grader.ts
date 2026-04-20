/**
 * Clementine TypeScript — Outcome grader.
 *
 * Second-pass check for cron runs the scheduler called `ok` but that
 * might actually be semantic failures. Covers the gap between the
 * marker-based semantic detection in failure-monitor (which caught
 * BLOCKED / FAILED / etc. in output) and the empty-output-too-short
 * case (which false-positives on legitimate quiet healthchecks).
 *
 * Strategy: only invoke the LLM when the run is SUSPICIOUS (empty
 * preview with non-trivial duration, or ambiguous content). Cost:
 * bounded to ~$0.01 per suspicious run, cached forever per
 * (job_name, started_at) tuple.
 */

import pino from 'pino';

import { MEMORY_DB_PATH, VAULT_DIR } from '../config.js';
import type { CronRunEntry } from '../types.js';
import type { Gateway } from './router.js';

const logger = pino({ name: 'clementine.outcome-grader' });

export interface Grade {
  jobName: string;
  startedAt: string;
  passed: boolean;
  score: number;   // 0-5
  reasoning: string;
  gradedAt: string;
}

async function getStore() {
  const { MemoryStore } = await import('../memory/store.js');
  const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
  store.initialize();
  return store;
}

/**
 * Decide whether a run warrants LLM grading. Heuristic — designed to
 * fire on the exact pattern that slipped through today: apparent-ok
 * runs with empty output + duration suggesting real work happened.
 */
export function isSuspicious(entry: CronRunEntry): boolean {
  if (entry.status !== 'ok') return false;
  const preview = (entry.outputPreview ?? '').trim();

  // Case 1: empty or near-empty preview with meaningful duration.
  // 20s threshold catches today's empty-market-leader-followup pattern
  // (23s + $0.57 cost, returned nothing). Legitimate quiet healthchecks
  // can run 15-33s too — we'll grade them once, the LLM correctly judges
  // "nothing to report" as passed, and the cached result means no re-grade.
  if (preview.length < 20 && entry.durationMs > 20_000) return true;

  // Case 2: reasonable preview but contains soft-negative language that
  // marker-based detection might miss. Kept tight so we don't spend on
  // normal variance.
  const lower = preview.toLowerCase();
  if (/\b(partial|skipped\s+\d+|could\s+not\s+complete|insufficient|timeout(?!ed)|not\s+enough|attempting|retrying)\b/.test(lower)) {
    return true;
  }

  return false;
}

export async function getGrade(jobName: string, startedAt: string): Promise<Grade | null> {
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    const row = db.prepare(
      `SELECT job_name AS jobName, started_at AS startedAt, passed, score, reasoning, graded_at AS gradedAt
       FROM graded_runs WHERE job_name = ? AND started_at = ?`,
    ).get(jobName, startedAt) as { jobName: string; startedAt: string; passed: number; score: number; reasoning: string; gradedAt: string } | undefined;
    store.close();
    if (!row) return null;
    return { ...row, passed: row.passed === 1 };
  } catch {
    return null;
  }
}

export async function recordGrade(grade: Grade): Promise<void> {
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    db.prepare(
      `INSERT OR REPLACE INTO graded_runs (job_name, started_at, passed, score, reasoning)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(grade.jobName, grade.startedAt, grade.passed ? 1 : 0, grade.score, grade.reasoning);
    store.close();
  } catch (err) {
    logger.warn({ err, jobName: grade.jobName }, 'Failed to record grade');
  }
}

function buildPrompt(entry: CronRunEntry, jobPrompt: string | null): string {
  return [
    'You are judging whether a cron job execution actually accomplished its intent.',
    '',
    `## Job: ${entry.jobName}`,
    `## Duration: ${Math.round(entry.durationMs / 1000)}s`,
    '',
    '## Job instructions (the prompt the agent was given):',
    jobPrompt ? jobPrompt.slice(0, 2000) : '(instructions unavailable)',
    '',
    '## What the agent produced (output preview, may be truncated):',
    (entry.outputPreview ?? '(empty)').slice(0, 1500),
    '',
    '## Your job',
    'Decide: did the agent actually accomplish the task, or did it superficially succeed while failing semantically?',
    'Examples of semantic success that looks like failure: a healthcheck that returns nothing because everything is healthy; a reply-detection sweep that returns nothing because no replies came in.',
    'Examples of semantic failure that looks like success: the agent hits a blocker, logs status=ok, returns empty; the agent fails auth and returns a generic "cannot proceed"; the agent reports "attempting X" but never actually does X.',
    '',
    'Output ONLY a JSON object, no fences:',
    '{',
    '  "passed": true|false,',
    '  "score": 0-5 (5 = clearly accomplished, 0 = clearly failed),',
    '  "reasoning": "one sentence explaining your judgment"',
    '}',
  ].join('\n');
}

function parseGrade(raw: string): Omit<Grade, 'jobName' | 'startedAt' | 'gradedAt'> | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]) as { passed?: unknown; score?: unknown; reasoning?: unknown };
    if (typeof p.passed !== 'boolean') return null;
    const score = typeof p.score === 'number' ? Math.max(0, Math.min(5, Math.round(p.score))) : (p.passed ? 4 : 1);
    return {
      passed: p.passed,
      score,
      reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 300) : '(no reasoning)',
    };
  } catch {
    return null;
  }
}

/**
 * Grade a single cron run. Returns cached grade if we've already graded
 * this (job, startedAt) tuple. Returns null if grading fails — caller
 * should fall back to existing signals.
 */
export async function gradeRun(
  entry: CronRunEntry,
  gateway: Gateway,
  jobPrompt?: string,
): Promise<Grade | null> {
  // Cache lookup
  const cached = await getGrade(entry.jobName, entry.startedAt);
  if (cached) return cached;

  if (!isSuspicious(entry)) return null;

  const prompt = buildPrompt(entry, jobPrompt ?? null);

  let raw: string;
  try {
    raw = await gateway.handleCronJob(
      `grade:${entry.jobName}`,
      prompt,
      1,        // tier 1
      3,        // maxTurns — tight
      'haiku',
    );
  } catch (err) {
    logger.warn({ err, jobName: entry.jobName }, 'Outcome grader LLM call failed');
    return null;
  }

  const parsed = parseGrade(raw);
  if (!parsed) {
    logger.warn({ jobName: entry.jobName, rawHead: raw.slice(0, 200) }, 'Outcome grader returned unparseable response');
    return null;
  }

  const grade: Grade = {
    jobName: entry.jobName,
    startedAt: entry.startedAt,
    ...parsed,
    gradedAt: new Date().toISOString(),
  };
  await recordGrade(grade);
  logger.info({ jobName: grade.jobName, passed: grade.passed, score: grade.score }, 'Graded run');
  return grade;
}

/** Look up recent grades for a job — used by the dashboard. */
export async function recentGrades(jobName: string, limit = 10): Promise<Grade[]> {
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    const rows = db.prepare(
      `SELECT job_name AS jobName, started_at AS startedAt, passed, score, reasoning, graded_at AS gradedAt
       FROM graded_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`,
    ).all(jobName, limit) as Array<{ jobName: string; startedAt: string; passed: number; score: number; reasoning: string; gradedAt: string }>;
    store.close();
    return rows.map(r => ({ ...r, passed: r.passed === 1 }));
  } catch {
    return [];
  }
}
