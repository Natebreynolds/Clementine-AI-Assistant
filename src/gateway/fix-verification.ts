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
}

interface State {
  pending: Record<string, PendingVerification>;
}

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
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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
 * After a cron run completes, check whether we were waiting on a fix
 * verification for this job. If so, send the owner a verdict and clear it.
 *
 * Skipped runs (circuit breaker, pre-check exit, etc.) don't carry signal
 * and shouldn't count as a verdict either way.
 */
export async function checkAndDeliverVerification(
  entry: CronRunEntry,
  send: (text: string) => Promise<unknown>,
): Promise<void> {
  if (entry.status === 'skipped') return;

  const state = loadState();
  const pending = state.pending[entry.jobName];
  if (!pending) return;

  delete state.pending[entry.jobName];
  saveState(state);

  const ok = entry.status === 'ok';
  const verdict = ok ? '✅ succeeded' : '⚠️ still failing';
  const ageMin = Math.max(1, Math.round((Date.now() - Date.parse(pending.recordedAt)) / 60000));
  const detail = ok
    ? ''
    : `\nError: ${(entry.error ?? 'unknown').split('\n')[0]!.slice(0, 200)}`;
  const msg = `**[Fix verification]** \`${entry.jobName}\` ${verdict} on its first run after edit (${ageMin}m later).${detail}`;
  try {
    await send(msg);
  } catch (err) {
    logger.warn({ err, job: entry.jobName }, 'Failed to send fix verification DM');
  }
}

/** Read-only accessor for dashboards or debugging. */
export function listPendingVerifications(): PendingVerification[] {
  return Object.values(loadState().pending);
}
