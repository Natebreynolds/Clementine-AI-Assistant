/**
 * PRD §11 Phase 5b / 1.18.105 — Draft store for cron tasks.
 *
 * Drafts live alongside CRON.md (the published source of truth) but in a
 * separate per-task JSON sidecar at ~/.clementine/cron-drafts/<safe>.json.
 * Schedule firing always reads CRON.md, so a draft never accidentally
 * goes live until the user clicks Publish.
 *
 * Why a sidecar instead of editing CRON.md and gating with frontmatter:
 * - One CRON.md edit = many tasks affected. Drafts are per-task by design.
 * - Sidecars survive even if CRON.md gets rewritten (e.g. by an agent).
 * - The published-vs-draft diff is a clean two-document compare.
 *
 * Tradeoff: a draft can become "orphaned" if its base task gets renamed.
 * We detect this via basedOnName and surface a banner in the editor when
 * we can't find the published peer. Manual cleanup via DELETE /api/cron/
 * :name/draft.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { CronJobDefinition } from '../types.js';

/** Read BASE_DIR fresh on every call so tests can swap CLEMENTINE_HOME
 *  per-test without the module cache sticking the value at import time. */
function draftDir(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
  return path.join(base, 'cron-drafts');
}

function safeName(name: string): string {
  // Mirror the convention used by CronRunLog.runs/<safe>.jsonl so users
  // can grep for related files easily.
  return String(name).replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 128);
}

function draftPath(name: string): string {
  return path.join(draftDir(), safeName(name) + '.json');
}

/** Stable hash of a job def — used to detect drift between when the draft
 *  was created and the current published version. If the published task
 *  changed under the draft (someone else edited it), we surface a warning
 *  and ask the user if they want to rebase. */
export function hashJobDef(def: CronJobDefinition): string {
  const canonical = JSON.stringify(def, Object.keys(def).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export interface DraftRecord {
  /** Task name this draft belongs to. Matches the published task's name
   *  (renames detach the draft — the user must republish to a new name). */
  name: string;
  /** Full job def the user is staging. Same shape as CronJobDefinition. */
  draft: CronJobDefinition;
  /** ISO timestamp of last save. */
  savedAt: string;
  /** Author marker. 'dashboard' for UI saves; future channels may add their
   *  own values. */
  changedBy: string;
  /** Hash of the published def at the time the draft was first created.
   *  If the live published def hashes to something different now, the
   *  draft is "rebased" — the editor surfaces a banner. */
  basedOnPublishedHash: string | null;
}

export function getDraft(name: string): DraftRecord | null {
  const file = draftPath(name);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw) as DraftRecord;
  } catch {
    return null;
  }
}

export function saveDraft(record: DraftRecord): void {
  if (!record.name) throw new Error('draft.name is required');
  if (!record.draft || typeof record.draft !== 'object') throw new Error('draft.draft (job def) is required');
  mkdirSync(draftDir(), { recursive: true });
  const file = draftPath(record.name);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}

export function deleteDraft(name: string): boolean {
  const file = draftPath(name);
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function listDraftNames(): string[] {
  const dir = draftDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Compute draft state vs current published def. The badge in the editor
 *  reads this directly — four states matching the n8n flow:
 *    none           = no draft sidecar, task is on its published version
 *    draft          = draft exists, no published peer (new task being created)
 *    ready          = draft + published peer; draft != published
 *    up_to_date     = draft + published peer; draft hashes match published
 *    rebase_needed  = draft + published peer; published has drifted since draft was created
 */
export type DraftBadgeState = 'none' | 'draft' | 'ready' | 'up_to_date' | 'rebase_needed';

export function computeBadgeState(name: string, publishedDef: CronJobDefinition | null): DraftBadgeState {
  const d = getDraft(name);
  if (!d) return 'none';
  if (!publishedDef) return 'draft';
  const publishedHash = hashJobDef(publishedDef);
  const draftHash = hashJobDef(d.draft);
  if (publishedHash === draftHash) return 'up_to_date';
  // Drift detection: if the draft was based on a published version we no
  // longer recognise, surface "rebase needed". This covers two scenarios:
  // (a) someone else edited the published def, (b) the user published
  // through a different surface and forgot to discard the draft.
  if (d.basedOnPublishedHash && d.basedOnPublishedHash !== publishedHash) return 'rebase_needed';
  return 'ready';
}

/** Test-only: where we read/write drafts. Tests use a clean tmpdir. */
export function _draftDirForTests(): string {
  return draftDir();
}
