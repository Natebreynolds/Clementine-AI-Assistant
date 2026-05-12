import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createBackgroundTask,
  findUnmirroredDeliveries,
  markBackgroundTaskMirrored,
  markDone,
  markFailed,
  markRunning,
} from '../src/agent/background-tasks.js';

// Helper: take a fresh task all the way from pending → running → done in
// one call so each test stays readable. markDone requires 'running', and
// markFailed for 'failed' requires anything-not-already-terminal.
function makeDoneTask(
  prompt: string,
  sessionKey: string | undefined,
  result: string,
  dir: string,
): { id: string } {
  const task = createBackgroundTask(
    { fromAgent: 'clementine', prompt, maxMinutes: 60, ...(sessionKey ? { sessionKey } : {}) },
    { dir },
  );
  markRunning(task.id, { dir });
  markDone(task.id, result, undefined, { dir });
  return task;
}

// Guard for the Saturday-feel restoration boot-time backfill. The bg: task
// memory-mirror landed in 1.18.180 but only applied to *new* lifecycle
// events; tasks that completed before the upgrade sat on disk with their
// result fields populated, their URLs intact, and no chat memory of any of
// it. The startup pass picks them up; this test pins that pickup contract.

describe('bg-task delivery backfill', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-bg-backfill-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns terminal tasks with a sessionKey and no mirroredAt flag', () => {
    const done = makeDoneTask('spin up a netlify report', 'discord:user:1', 'Live at https://example.netlify.app/', dir);

    const failed = createBackgroundTask(
      { fromAgent: 'clementine', prompt: 'try and fail', maxMinutes: 30, sessionKey: 'discord:user:2' },
      { dir },
    );
    markFailed(failed.id, 'budget cap', 'failed', { dir });

    const orphans = findUnmirroredDeliveries({ dir });
    const ids = orphans.map(t => t.id).sort();
    expect(ids).toEqual([done.id, failed.id].sort());
  });

  it('skips tasks without a sessionKey (legacy / synthetic)', () => {
    makeDoneTask('orphan task', undefined, 'done', dir);

    const orphans = findUnmirroredDeliveries({ dir });
    expect(orphans).toHaveLength(0);
  });

  it('skips tasks already stamped with mirroredAt — idempotent across restarts', () => {
    const t = makeDoneTask('already mirrored', 'discord:user:1', 'output', dir);
    markBackgroundTaskMirrored(t.id, { dir });

    const orphans = findUnmirroredDeliveries({ dir });
    expect(orphans).toHaveLength(0);

    // Verify the flag is persisted to disk.
    const onDisk = JSON.parse(readFileSync(path.join(dir, `${t.id}.json`), 'utf-8'));
    expect(onDisk.mirroredAt).toBeTruthy();
  });

  it('skips tasks outside the recency window', () => {
    const t = makeDoneTask('old task', 'discord:user:1', 'old output', dir);

    // Hand-edit completedAt to 30 days ago.
    const file = path.join(dir, `${t.id}.json`);
    const task = JSON.parse(readFileSync(file, 'utf-8'));
    task.completedAt = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    writeFileSync(file, JSON.stringify(task, null, 2));

    // Default window is 7 days.
    expect(findUnmirroredDeliveries({ dir })).toHaveLength(0);
    // Wider window catches it.
    expect(findUnmirroredDeliveries({ dir, sinceMs: 60 * 24 * 60 * 60_000 })).toHaveLength(1);
  });

  it('still finds tasks even when status is interrupted or aborted', () => {
    const interrupted = createBackgroundTask(
      { fromAgent: 'clementine', prompt: 'interrupted', maxMinutes: 5, sessionKey: 'discord:user:1' },
      { dir },
    );
    markFailed(interrupted.id, 'daemon restart', 'interrupted', { dir });

    const aborted = createBackgroundTask(
      { fromAgent: 'clementine', prompt: 'aborted', maxMinutes: 5, sessionKey: 'discord:user:1' },
      { dir },
    );
    markFailed(aborted.id, 'cancelled', 'aborted', { dir });

    const orphans = findUnmirroredDeliveries({ dir });
    const ids = orphans.map(t => t.id).sort();
    expect(ids).toEqual([interrupted.id, aborted.id].sort());
  });
});
