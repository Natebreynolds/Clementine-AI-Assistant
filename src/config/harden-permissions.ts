/**
 * Tighten file modes on the Clementine data home.
 *
 * Walks ~/.clementine/ (or any baseDir) and:
 *   - Sets every regular file to mode 0600 (owner read/write only)
 *   - Sets every directory to mode 0700 (owner traverse only)
 *
 * Why: state files live alongside `credentials.json` and `.env`. Even
 * after Phase 9b's outbound redaction, contents on disk include
 * conversation transcripts, advisor LLM outputs, cron run logs, full
 * Discord/Slack message snippets, etc. Default umask 022 leaves all of
 * those world-readable; on a single-user laptop the practical risk is
 * Time Machine backup exposure and any process running as the user.
 *
 * Pure: returns a result describing what was tightened, what was already
 * correct, and what failed (e.g. permission denied if user wasn't owner).
 * Caller decides whether to print, JSON-stringify, or act on the result.
 *
 * Idempotent: re-running on an already-hardened tree is a no-op (every
 * entry returns "already correct"). chmod is the cheapest syscall —
 * even a 1000-file tree completes in milliseconds.
 *
 * Skip list: a few entries are intentionally NOT touched:
 *   - Symlinks (chmod follows symlinks; could escalate elsewhere). We
 *     check via lstat and skip non-files/non-dirs.
 *   - Files we don't own (chmod will fail; we capture the failure in
 *     the report rather than crashing).
 */

import { readdirSync, lstatSync, chmodSync } from 'node:fs';
import path from 'node:path';

export type HardenStatus = 'tightened' | 'already-correct' | 'skipped' | 'failed';

export interface HardenEntry {
  path: string;
  kind: 'file' | 'directory' | 'other';
  beforeMode: string;     // octal string like '644'
  afterMode: string;
  status: HardenStatus;
  error?: string;
}

export interface HardenReport {
  baseDir: string;
  scanned: number;
  tightened: number;
  alreadyCorrect: number;
  skipped: number;
  failed: number;
  /** Per-entry detail. Cap at 50 in printable form to keep output sane;
   *  full list available in the JSON output. */
  entries: HardenEntry[];
}

const FILE_TARGET = 0o600;
const DIR_TARGET = 0o700;

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/**
 * Walk a directory tree iteratively (not recursively — no stack-blow risk
 * on deep vault trees). Returns absolute paths.
 */
function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable dir — caller will see it as skipped
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue; // never follow
        if (st.isDirectory()) {
          out.push(full);
          stack.push(full);
        } else if (st.isFile()) {
          out.push(full);
        }
      } catch {
        // stat failed — skip
      }
    }
  }
  return out;
}

export function hardenPermissions(
  baseDir: string,
  opts: { dryRun?: boolean } = {},
): HardenReport {
  const report: HardenReport = {
    baseDir,
    scanned: 0,
    tightened: 0,
    alreadyCorrect: 0,
    skipped: 0,
    failed: 0,
    entries: [],
  };

  // Always include baseDir itself in the walk
  let baseSt;
  try {
    baseSt = lstatSync(baseDir);
  } catch (err) {
    report.entries.push({
      path: baseDir,
      kind: 'other',
      beforeMode: '???',
      afterMode: '???',
      status: 'failed',
      error: `baseDir not accessible: ${String(err).slice(0, 100)}`,
    });
    report.failed++;
    return report;
  }
  if (!baseSt.isDirectory()) {
    report.entries.push({
      path: baseDir,
      kind: 'other',
      beforeMode: octal(baseSt.mode),
      afterMode: octal(baseSt.mode),
      status: 'skipped',
      error: 'baseDir is not a directory',
    });
    report.skipped++;
    return report;
  }

  const all = [baseDir, ...walk(baseDir)];

  for (const p of all) {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      report.entries.push({
        path: p,
        kind: 'other',
        beforeMode: '???',
        afterMode: '???',
        status: 'failed',
        error: String(err).slice(0, 100),
      });
      report.failed++;
      continue;
    }

    report.scanned++;
    const beforeMode = octal(st.mode);
    let kind: 'file' | 'directory' | 'other' = 'other';
    let target: number | null = null;
    if (st.isDirectory()) { kind = 'directory'; target = DIR_TARGET; }
    else if (st.isFile()) { kind = 'file'; target = FILE_TARGET; }

    if (target === null) {
      // Sockets, FIFOs, devices, etc. — leave alone.
      report.entries.push({
        path: p, kind, beforeMode, afterMode: beforeMode, status: 'skipped',
      });
      report.skipped++;
      continue;
    }

    if ((st.mode & 0o777) === target) {
      report.entries.push({
        path: p, kind, beforeMode, afterMode: beforeMode, status: 'already-correct',
      });
      report.alreadyCorrect++;
      continue;
    }

    if (opts.dryRun) {
      report.entries.push({
        path: p, kind, beforeMode, afterMode: octal(target), status: 'tightened',
      });
      report.tightened++;
      continue;
    }

    try {
      chmodSync(p, target);
      report.entries.push({
        path: p, kind, beforeMode, afterMode: octal(target), status: 'tightened',
      });
      report.tightened++;
    } catch (err) {
      report.entries.push({
        path: p, kind, beforeMode, afterMode: beforeMode, status: 'failed',
        error: String(err).slice(0, 100),
      });
      report.failed++;
    }
  }

  return report;
}
