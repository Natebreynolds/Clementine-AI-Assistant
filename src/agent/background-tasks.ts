/**
 * Clementine TypeScript — Background task persistence + lifecycle helpers.
 *
 * A "background task" is an unleashed multi-turn job that an agent kicks
 * off via the `start_background_task` MCP tool. Persistence is one JSON
 * file per task at ~/.clementine/background-tasks/<id>.json. The file is
 * the source of truth — the MCP tool writes the initial pending state,
 * the daemon picks it up, runs it, and updates the same file as the
 * lifecycle progresses.
 *
 * Process boundary: the MCP tool runs in an SDK subprocess, so it can't
 * call the gateway directly. It writes a pending file; the daemon's
 * cron-scheduler tick picks up pending tasks within ~3 seconds.
 *
 * Restart safety: on daemon startup, any task left in 'running' is
 * aborted (its process is gone). P6b can add resumability; for now,
 * fail-fast is clearer than silently re-running a task that may have
 * already partially completed.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { BackgroundTask } from '../types.js';

const DEFAULT_DIR = path.join(BASE_DIR, 'background-tasks');
const RESULT_TRUNCATE_BYTES = 3000;

export const BACKGROUND_TASK_DIR = DEFAULT_DIR;

export interface BackgroundTaskOptions {
  /** Override storage directory for tests. Defaults to BASE_DIR/background-tasks/. */
  dir?: string;
}

function dirFor(opts?: BackgroundTaskOptions): string {
  return opts?.dir ?? DEFAULT_DIR;
}

function makeId(now: Date = new Date()): string {
  // Sortable-by-time prefix + 6 hex chars of randomness
  return `bg-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function pathFor(id: string, opts?: BackgroundTaskOptions): string {
  return path.join(dirFor(opts), `${id}.json`);
}

function safeWrite(file: string, task: BackgroundTask): void {
  mkdirSync(path.dirname(file), { recursive: true });
  // Truncate result so a runaway task can't blow the file size
  const slim = task.result && task.result.length > RESULT_TRUNCATE_BYTES
    ? { ...task, result: task.result.slice(0, RESULT_TRUNCATE_BYTES) + '\n...[truncated]' }
    : task;
  writeFileSync(file, JSON.stringify(slim, null, 2));
}

/**
 * Create a new pending task on disk and return it. Caller (the MCP tool)
 * doesn't await execution — the daemon picks the task up asynchronously.
 */
export function createBackgroundTask(
  input: { fromAgent: string; prompt: string; maxMinutes: number },
  opts?: BackgroundTaskOptions,
): BackgroundTask {
  const now = new Date();
  const task: BackgroundTask = {
    id: makeId(now),
    fromAgent: input.fromAgent,
    prompt: input.prompt,
    maxMinutes: Math.max(1, Math.min(240, Math.floor(input.maxMinutes))), // 1m–4h
    status: 'pending',
    createdAt: now.toISOString(),
  };
  safeWrite(pathFor(task.id, opts), task);
  return task;
}

/** Load a task by id, or null if not found / malformed. */
export function loadBackgroundTask(id: string, opts?: BackgroundTaskOptions): BackgroundTask | null {
  try {
    const file = pathFor(id, opts);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as BackgroundTask;
  } catch {
    return null;
  }
}

/** List tasks with optional status / agent filters, newest first. */
export function listBackgroundTasks(
  filter: { status?: BackgroundTask['status']; fromAgent?: string } = {},
  opts?: BackgroundTaskOptions,
): BackgroundTask[] {
  const dir = dirFor(opts);
  if (!existsSync(dir)) return [];
  const out: BackgroundTask[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const file of files) {
    try {
      const task = JSON.parse(readFileSync(path.join(dir, file), 'utf-8')) as BackgroundTask;
      if (filter.status && task.status !== filter.status) continue;
      if (filter.fromAgent && task.fromAgent !== filter.fromAgent) continue;
      out.push(task);
    } catch { /* skip malformed */ }
  }
  // Newest first by createdAt; falls back to id (which is timestamp-prefixed)
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return out;
}

/** Transition a task to 'running' — daemon picked it up. */
export function markRunning(id: string, opts?: BackgroundTaskOptions): BackgroundTask | null {
  const task = loadBackgroundTask(id, opts);
  if (!task) return null;
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  safeWrite(pathFor(id, opts), task);
  return task;
}

/** Transition to 'done' with final result. */
export function markDone(
  id: string,
  result: string,
  deliverableNote?: string,
  opts?: BackgroundTaskOptions,
): BackgroundTask | null {
  const task = loadBackgroundTask(id, opts);
  if (!task) return null;
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  task.result = result;
  if (deliverableNote) task.deliverableNote = deliverableNote;
  safeWrite(pathFor(id, opts), task);
  return task;
}

/** Transition to 'failed' or 'aborted' with error message. */
export function markFailed(
  id: string,
  error: string,
  reason: 'failed' | 'aborted' = 'failed',
  opts?: BackgroundTaskOptions,
): BackgroundTask | null {
  const task = loadBackgroundTask(id, opts);
  if (!task) return null;
  task.status = reason;
  task.completedAt = new Date().toISOString();
  task.error = error.slice(0, 1000);
  safeWrite(pathFor(id, opts), task);
  return task;
}

/**
 * Daemon-restart hygiene: any task still in 'running' must be from a
 * prior daemon process. Mark them aborted so the lifecycle is honest.
 * Returns the count of tasks aborted.
 */
export function abortStaleRunningTasks(opts?: BackgroundTaskOptions): number {
  const stuck = listBackgroundTasks({ status: 'running' }, opts);
  let aborted = 0;
  for (const t of stuck) {
    markFailed(t.id, 'daemon restarted while task was in flight', 'aborted', opts);
    aborted++;
  }
  return aborted;
}

/** Test-only: delete a task file. Production code never deletes — history matters. */
export function _deleteBackgroundTask(id: string, opts?: BackgroundTaskOptions): void {
  try {
    const file = pathFor(id, opts);
    if (existsSync(file)) unlinkSync(file);
  } catch { /* ignore */ }
}
