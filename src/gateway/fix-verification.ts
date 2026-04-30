/**
 * Clementine TypeScript — Cron fix verification.
 *
 * When a CRON.md (global or per-agent) is edited, we record a "pending
 * verification" for any job whose definition changed AND that is currently
 * in a failing state. After that job's next non-skipped run, we DM the
 * owner with the verdict — succeeded or still failing — so a self-reported
 * "fix" can't go untested again.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';

import { BASE_DIR } from '../config.js';
import type { CronJobDefinition, CronRunEntry } from '../types.js';
import { computeBrokenJobs } from './failure-monitor.js';

const logger = pino({ name: 'clementine.fix-verification' });

const STATE_FILE = path.join(BASE_DIR, 'cron', 'fix-verifications.json');

interface PendingVerification {
  jobName: string;
  recordedAt: string;
  preFailureCount: number;
  preLastError: string | null;
  /** Used by Phase 8.1 — when set, the verifier is also responsible for
   * deleting this artifact if the fix doesn't help. Existing CRON.md edits
   * leave this unset (they're hand-edits, not auto-applies, so we never
   * revert them automatically). */
  autoApply?: AutoApplyTracker;
  /** Run-by-run history accumulated since the fix was applied. Single-run
   * verdicts (the original CRON.md flow) only need the first entry; multi-
   * run autoApply verifications need the accumulated sample. */
  postRunOutcomes?: Array<'ok' | 'error' | 'retried'>;
}

/**
 * Tracks an autoApply that's currently being verified. When the verdict
 * window closes negatively, revertFix() uses these fields to undo.
 *
 * - `advisor-rule` and `prompt-override` revert by deleting the written file.
 * - `cron-config` reverts by re-applying the captured `prevFields` to the
 *   named job inside CRON.md (deleting CRON.md would be catastrophic).
 */
export interface AutoApplyTracker {
  kind: 'advisor-rule' | 'prompt-override' | 'cron-config';
  /** Absolute path of the file the apply wrote. */
  file: string;
  /** advisor-rule only: the rule's id, used by the loader's hot-reload. */
  ruleId?: string;
  /** prompt-override only: scope label for the verdict message. */
  scope?: 'global' | 'agent' | 'job';
  scopeKey?: string;
  /** cron-config only: bare job name as written in the CRON.md frontmatter. */
  bareName?: string;
  /** cron-config only: original values for the fields that were mutated.
   * Use null for "field was absent (delete on revert)". */
  prevFields?: Record<string, unknown>;
}

interface State {
  pending: Record<string, PendingVerification>;
}

/**
 * Number of post-fix runs we accumulate before deciding an autoApply
 * verdict. Single sample is too noisy; ten is too patient. Three is
 * a tight window: 0/3 successes after a "fix" is overwhelming evidence
 * the fix didn't help.
 */
const AUTOAPPLY_VERDICT_WINDOW = 3;

function loadState(): State {
  try {
    if (!existsSync(STATE_FILE)) return { pending: {} };
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<State>;
    return { pending: raw.pending ?? {} };
  } catch {
    return { pending: {} };
  }
}

function saveState(state: State): void {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    logger.warn({ err }, 'Failed to persist fix-verification state');
  }
}

/**
 * Hash the job fields a fix could touch. Schedule + prompt + tier + mode +
 * model + maxTurns + maxHours + workDir + preCheck + successCriteria are the
 * only fields a "fix" would realistically change. We deliberately ignore
 * `enabled` because disabling isn't a fix.
 */
function jobHash(j: CronJobDefinition): string {
  const data = JSON.stringify({
    schedule: j.schedule,
    prompt: j.prompt,
    tier: j.tier,
    maxTurns: j.maxTurns,
    model: j.model,
    workDir: j.workDir,
    mode: j.mode,
    maxHours: j.maxHours,
    preCheck: j.preCheck,
    successCriteria: j.successCriteria,
  });
  return crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
}

/**
 * Compare an old and new jobs list and record verifications for any job that:
 *   - exists in both lists (new jobs aren't "fixes" of existing problems)
 *   - has its definition hash changed
 *   - is currently in a failing state per failure-monitor
 *
 * Disabled jobs and removed jobs are tracked too: if a previously failing
 * job gets disabled or removed in the edit, we surface that as a "removed
 * pending verification" rather than waiting for a run that will never come.
 */
export function recordEditsForFailingJobs(
  oldJobs: CronJobDefinition[],
  newJobs: CronJobDefinition[],
): void {
  const oldByName = new Map(oldJobs.map(j => [j.name, j]));
  const newByName = new Map(newJobs.map(j => [j.name, j]));

  const broken = computeBrokenJobs();
  const brokenByName = new Map(broken.map(b => [b.jobName, b]));

  const state = loadState();
  const stamp = new Date().toISOString();
  let mutated = false;

  for (const [name, oj] of oldByName) {
    const b = brokenByName.get(name);
    if (!b) continue; // not currently broken — nothing to verify

    const nj = newByName.get(name);
    if (!nj) {
      // Job removed entirely. Treat as resolved by removal.
      delete state.pending[name];
      mutated = true;
      logger.info({ job: name }, 'Failing job removed from CRON.md — verification cleared');
      continue;
    }
    if (!nj.enabled) {
      // Job disabled. Don't wait for a run; clear and note.
      delete state.pending[name];
      mutated = true;
      logger.info({ job: name }, 'Failing job disabled in CRON.md — verification cleared');
      continue;
    }
    if (jobHash(oj) === jobHash(nj)) continue; // no relevant changes

    state.pending[name] = {
      jobName: name,
      recordedAt: stamp,
      preFailureCount: b.errorCount48h,
      preLastError: b.lastErrors[0] ?? null,
    };
    mutated = true;
    logger.info({ job: name, preFailureCount: b.errorCount48h }, 'Recorded pending fix verification');
  }

  if (mutated) saveState(state);
}

/**
 * Phase 8.1 — record a pending verification for an autoApply (advisor-rule
 * or prompt-override) so the verifier can roll the fix back if the next
 * AUTOAPPLY_VERDICT_WINDOW runs don't show improvement.
 *
 * Called from fix-applier.applyFix on success. Idempotent: if a previous
 * verification for the same job is still pending, the new tracker overwrites
 * it (the most-recent fix is the one we're verifying).
 */
export function recordAutoApplyForVerification(
  jobName: string,
  tracker: AutoApplyTracker,
): void {
  const state = loadState();
  const broken = computeBrokenJobs();
  const b = broken.find(x => x.jobName === jobName);
  state.pending[jobName] = {
    jobName,
    recordedAt: new Date().toISOString(),
    preFailureCount: b?.errorCount48h ?? 0,
    preLastError: b?.lastErrors[0] ?? null,
    autoApply: tracker,
    postRunOutcomes: [],
  };
  saveState(state);
  logger.info(
    { job: jobName, kind: tracker.kind, file: tracker.file },
    'Recorded autoApply for verification — will track next runs',
  );
}

/**
 * Undo an autoApply. Dispatches on `tracker.kind`:
 *
 *   - advisor-rule / prompt-override: delete the file the apply wrote.
 *   - cron-config: re-apply the captured `prevFields` to the named job
 *     in CRON.md (never delete CRON.md).
 *
 * Best-effort throughout: a missing file or vanished job is not an error.
 * Returns true if a meaningful change was made.
 */
function revertAutoApply(tracker: AutoApplyTracker): boolean {
  if (tracker.kind === 'cron-config') {
    return revertCronConfig(tracker);
  }
  try {
    if (existsSync(tracker.file)) {
      // Use unlinkSync from fs — kept dynamic to avoid a top-of-file import
      // we don't otherwise need.
      const { unlinkSync } = require('node:fs') as typeof import('node:fs');
      unlinkSync(tracker.file);
      logger.warn({ file: tracker.file, kind: tracker.kind }, 'Reverted autoApply — fix did not help');
      return true;
    }
  } catch (err) {
    logger.warn({ err, file: tracker.file }, 'Failed to delete autoApply file during revert');
  }
  return false;
}

/**
 * Restore the previous values of the fields the cron-config autoApply mutated.
 * A `null` in `prevFields` means the field was absent before the fix and
 * should be deleted on revert.
 */
function revertCronConfig(tracker: AutoApplyTracker): boolean {
  if (!tracker.bareName || !tracker.prevFields) {
    logger.warn({ tracker }, 'cron-config revert missing bareName/prevFields — skipping');
    return false;
  }
  try {
    if (!existsSync(tracker.file)) {
      logger.warn({ file: tracker.file }, 'cron-config revert: file missing — skipping');
      return false;
    }
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const matter = require('gray-matter') as typeof import('gray-matter');
    const raw = readFileSync(tracker.file, 'utf-8');
    const parsed = matter(raw);
    const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
    const job = jobs.find((j) => String(j.name ?? '') === tracker.bareName);
    if (!job) {
      logger.warn({ file: tracker.file, bareName: tracker.bareName }, 'cron-config revert: job not found — already removed/renamed');
      return false;
    }
    let mutated = false;
    for (const [key, prev] of Object.entries(tracker.prevFields)) {
      if (prev === null || prev === undefined) {
        if (key in job) {
          delete (job as Record<string, unknown>)[key];
          mutated = true;
        }
      } else if (job[key] !== prev) {
        job[key] = prev;
        mutated = true;
      }
    }
    if (!mutated) return false;
    writeFileSync(tracker.file, matter.stringify(parsed.content, parsed.data));
    logger.warn({ file: tracker.file, bareName: tracker.bareName }, 'Reverted cron-config autoApply — fix did not help');
    return true;
  } catch (err) {
    logger.warn({ err, file: tracker.file }, 'Failed to revert cron-config autoApply');
    return false;
  }
}

/**
 * After a cron run completes, check whether we were waiting on a fix
 * verification for this job. Two flows:
 *
 *   1. Hand-edit (CRON.md) — verdict on the FIRST non-skipped run. Original
 *      Phase 7 behavior, preserved.
 *   2. AutoApply (advisor-rule / prompt-override) — accumulate up to
 *      AUTOAPPLY_VERDICT_WINDOW outcomes, then decide. If 0 successes,
 *      revert the file. Either way, DM the verdict.
 *
 * Skipped runs don't carry signal and don't advance the window in either flow.
 */
export async function checkAndDeliverVerification(
  entry: CronRunEntry,
  send: (text: string) => Promise<unknown>,
): Promise<void> {
  if (entry.status === 'skipped') return;

  const state = loadState();
  const pending = state.pending[entry.jobName];
  if (!pending) return;

  // Hand-edit flow — single-run verdict, unchanged.
  if (!pending.autoApply) {
    delete state.pending[entry.jobName];
    saveState(state);
    const ok = entry.status === 'ok';
    const verdict = ok ? '✅ succeeded' : '⚠️ still failing';
    const ageMin = Math.max(1, Math.round((Date.now() - Date.parse(pending.recordedAt)) / 60000));
    const detail = ok ? '' : `\nError: ${(entry.error ?? 'unknown').split('\n')[0]!.slice(0, 200)}`;
    const msg = `**[Fix verification]** \`${entry.jobName}\` ${verdict} on its first run after edit (${ageMin}m later).${detail}`;
    try { await send(msg); } catch (err) {
      logger.warn({ err, job: entry.jobName }, 'Failed to send fix verification DM');
    }
    return;
  }

  // AutoApply flow — accumulate the sample first.
  const outcomes = pending.postRunOutcomes ?? [];
  outcomes.push(entry.status as 'ok' | 'error' | 'retried');
  pending.postRunOutcomes = outcomes;

  if (outcomes.length < AUTOAPPLY_VERDICT_WINDOW) {
    // Not enough sample yet — persist accumulated state, wait for more runs.
    saveState(state);
    return;
  }

  // Decision time.
  delete state.pending[entry.jobName];
  saveState(state);

  const successes = outcomes.filter(o => o === 'ok').length;
  const ageMin = Math.max(1, Math.round((Date.now() - Date.parse(pending.recordedAt)) / 60000));
  const tracker = pending.autoApply;
  const scopeLabel = tracker.scope
    ? `${tracker.kind}:${tracker.scope}${tracker.scopeKey ? `:${tracker.scopeKey}` : ''}`
    : `${tracker.kind}${tracker.ruleId ? `:${tracker.ruleId}` : ''}`;

  if (successes === 0) {
    // Fix didn't help — revert and notify.
    const reverted = revertAutoApply(tracker);
    const msg =
      `**[Fix verification — REVERTED]** \`${entry.jobName}\`: ` +
      `auto-applied ${scopeLabel} did not help (0/${outcomes.length} runs succeeded over ${ageMin}m). ` +
      (reverted ? `Reverted ${path.basename(tracker.file)}.` : `Tried to revert but file was already gone.`);
    try { await send(msg); } catch (err) {
      logger.warn({ err, job: entry.jobName }, 'Failed to send fix-revert DM');
    }
    logger.warn({ job: entry.jobName, scopeLabel, reverted }, 'Auto-reverted ineffective autoApply');
    return;
  }

  const verdict = successes === outcomes.length
    ? `✅ verified — ${successes}/${outcomes.length} runs succeeded`
    : `⚠️ partial — ${successes}/${outcomes.length} runs succeeded`;
  const msg = `**[Fix verification]** \`${entry.jobName}\`: auto-applied ${scopeLabel} ${verdict} over ${ageMin}m.`;
  try { await send(msg); } catch (err) {
    logger.warn({ err, job: entry.jobName }, 'Failed to send fix verification DM');
  }
}

/** Read-only accessor for dashboards or debugging. */
export function listPendingVerifications(): PendingVerification[] {
  return Object.values(loadState().pending);
}

/** Test helper — clear all state. */
export function _resetVerificationState(): void {
  saveState({ pending: {} });
}
