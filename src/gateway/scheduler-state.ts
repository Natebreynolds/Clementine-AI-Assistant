/**
 * Scheduler state-file helpers (1.18.143)
 *
 * Three schedulers each persist a JSON state file (heartbeat,
 * cron-running-jobs, per-agent heartbeat). Before this module they
 * each reimplemented "try parse, fall back on error" + "write JSON,
 * log on error". The patterns are tiny but they were drifting (some
 * had `mkdirSync`, some had atomic write-then-rename, some had
 * neither — and a future addition would have copied yet another
 * variant).
 *
 * This module is the single source of truth for both shapes:
 *
 *   loadStateFile(path, default, validator?)
 *     — read JSON, fall back to default on missing/invalid file,
 *       optionally run a validator that can clean/coerce the parsed
 *       payload before returning it.
 *
 *   saveStateFile(path, state, opts)
 *     — ensure parent dir exists, then either plain
 *       writeFileSync (default) or atomic write-then-rename for
 *       crash-safe persistence (set `atomic: true`).
 *
 * Both swallow filesystem errors and log a warning — the schedulers
 * treat persistence as best-effort (a missing/corrupt state file
 * means "start fresh", not "crash"). Callers that need failure
 * surfaced should check the boolean return on saveStateFile.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const logger = pino({ name: 'clementine.scheduler-state' });

/**
 * Read a JSON state file. Returns `defaultValue` if the file is
 * missing, unreadable, or fails JSON parse. Optional validator runs
 * after parse and can return a cleaned-up version (e.g. coerce
 * missing fields, drop invalid values).
 */
export function loadStateFile<T>(
  filePath: string,
  defaultValue: T,
  validator?: (raw: unknown) => T,
): T {
  try {
    if (!existsSync(filePath)) return defaultValue;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return validator ? validator(raw) : (raw as T);
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to load state file — starting fresh');
    return defaultValue;
  }
}

export interface SaveStateOptions {
  /**
   * If true, write to `<file>.tmp` then rename — guarantees the on-disk
   * file is either the previous state or the new state, never a half-
   * written file. Use for state that must survive crashes mid-write
   * (cron-running.json relies on this for idempotency).
   */
  atomic?: boolean;
}

/**
 * Write a JSON state file. Creates the parent directory if missing.
 * Returns true on success, false on failure (always logs a warning
 * on failure — caller doesn't need to log again).
 */
export function saveStateFile<T>(
  filePath: string,
  state: T,
  opts: SaveStateOptions = {},
): boolean {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const json = JSON.stringify(state, null, 2);
    if (opts.atomic) {
      const tmp = filePath + '.tmp';
      writeFileSync(tmp, json);
      renameSync(tmp, filePath);
    } else {
      writeFileSync(filePath, json);
    }
    return true;
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to save state file');
    return false;
  }
}
