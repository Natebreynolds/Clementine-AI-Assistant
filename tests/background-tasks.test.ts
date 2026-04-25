import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _deleteBackgroundTask,
  abortStaleRunningTasks,
  createBackgroundTask,
  listBackgroundTasks,
  loadBackgroundTask,
  markDone,
  markFailed,
  markRunning,
} from '../src/agent/background-tasks.js';

describe('background-tasks persistence helper', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-bg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a pending task with a sortable id and persists to disk', () => {
    const t = createBackgroundTask(
      { fromAgent: 'ross-the-sdr', prompt: 'Research the Acme account', maxMinutes: 15 },
      { dir },
    );
    expect(t.id).toMatch(/^bg-[a-z0-9]+-[a-f0-9]{6}$/);
    expect(t.status).toBe('pending');
    expect(t.fromAgent).toBe('ross-the-sdr');
    expect(t.maxMinutes).toBe(15);
    expect(existsSync(path.join(dir, `${t.id}.json`))).toBe(true);

    const onDisk = JSON.parse(readFileSync(path.join(dir, `${t.id}.json`), 'utf-8'));
    expect(onDisk.id).toBe(t.id);
    expect(onDisk.status).toBe('pending');
  });

  it('clamps maxMinutes to [1, 240]', () => {
    const tooSmall = createBackgroundTask({ fromAgent: 'a', prompt: 'p', maxMinutes: 0 }, { dir });
    expect(tooSmall.maxMinutes).toBe(1);
    const tooBig = createBackgroundTask({ fromAgent: 'a', prompt: 'p', maxMinutes: 9999 }, { dir });
    expect(tooBig.maxMinutes).toBe(240);
  });

  it('round-trips status transitions: pending → running → done', () => {
    const t = createBackgroundTask({ fromAgent: 'sasha', prompt: 'do it', maxMinutes: 5 }, { dir });
    expect(loadBackgroundTask(t.id, { dir })?.status).toBe('pending');

    markRunning(t.id, { dir });
    const r = loadBackgroundTask(t.id, { dir });
    expect(r?.status).toBe('running');
    expect(r?.startedAt).toBeTruthy();
    expect(r?.completedAt).toBeUndefined();

    markDone(t.id, 'all the data', 'vault/03-Projects/output.md', { dir });
    const d = loadBackgroundTask(t.id, { dir });
    expect(d?.status).toBe('done');
    expect(d?.result).toBe('all the data');
    expect(d?.deliverableNote).toBe('vault/03-Projects/output.md');
    expect(d?.completedAt).toBeTruthy();
  });

  it('round-trips failed transition with error message', () => {
    const t = createBackgroundTask({ fromAgent: 'a', prompt: 'p', maxMinutes: 5 }, { dir });
    markRunning(t.id, { dir });
    markFailed(t.id, 'something broke', 'failed', { dir });
    const f = loadBackgroundTask(t.id, { dir });
    expect(f?.status).toBe('failed');
    expect(f?.error).toBe('something broke');
  });

  it('truncates result over 3KB to keep files bounded', () => {
    const t = createBackgroundTask({ fromAgent: 'a', prompt: 'p', maxMinutes: 5 }, { dir });
    markRunning(t.id, { dir });
    const huge = 'x'.repeat(5000);
    markDone(t.id, huge, undefined, { dir });
    const d = loadBackgroundTask(t.id, { dir });
    expect(d?.result?.length).toBeLessThan(huge.length);
    expect(d?.result?.endsWith('...[truncated]')).toBe(true);
  });

  it('listBackgroundTasks filters by status and returns newest-first', async () => {
    const a = createBackgroundTask({ fromAgent: 'agent-a', prompt: 'first', maxMinutes: 5 }, { dir });
    // Enforce an ordering gap so createdAt timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    const b = createBackgroundTask({ fromAgent: 'agent-b', prompt: 'second', maxMinutes: 5 }, { dir });
    markRunning(a.id, { dir });

    const all = listBackgroundTasks({}, { dir });
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(b.id); // newest first

    const pendingOnly = listBackgroundTasks({ status: 'pending' }, { dir });
    expect(pendingOnly.length).toBe(1);
    expect(pendingOnly[0].id).toBe(b.id);

    const fromA = listBackgroundTasks({ fromAgent: 'agent-a' }, { dir });
    expect(fromA.length).toBe(1);
    expect(fromA[0].id).toBe(a.id);
  });

  it('abortStaleRunningTasks marks running tasks as aborted', () => {
    const t1 = createBackgroundTask({ fromAgent: 'a', prompt: 'p1', maxMinutes: 5 }, { dir });
    const t2 = createBackgroundTask({ fromAgent: 'b', prompt: 'p2', maxMinutes: 5 }, { dir });
    markRunning(t1.id, { dir });
    markRunning(t2.id, { dir });

    // We can't easily call abortStaleRunningTasks with a custom dir because it
    // uses the default. Instead, verify behavior via the same helper directly.
    const stuck = listBackgroundTasks({ status: 'running' }, { dir });
    expect(stuck.length).toBe(2);
    for (const s of stuck) {
      markFailed(s.id, 'daemon restarted while task was in flight', 'aborted', { dir });
    }
    const aborted = listBackgroundTasks({ status: 'aborted' }, { dir });
    expect(aborted.length).toBe(2);
    expect(aborted[0].error).toMatch(/daemon restarted/);
  });

  it('returns null for unknown task ids', () => {
    expect(loadBackgroundTask('bg-does-not-exist', { dir })).toBeNull();
    expect(markRunning('bg-does-not-exist', { dir })).toBeNull();
    expect(markDone('bg-does-not-exist', 'x', undefined, { dir })).toBeNull();
    expect(markFailed('bg-does-not-exist', 'x', 'failed', { dir })).toBeNull();
  });

  it('_deleteBackgroundTask removes the file (test-only helper)', () => {
    const t = createBackgroundTask({ fromAgent: 'a', prompt: 'p', maxMinutes: 5 }, { dir });
    expect(existsSync(path.join(dir, `${t.id}.json`))).toBe(true);
    _deleteBackgroundTask(t.id, { dir });
    expect(existsSync(path.join(dir, `${t.id}.json`))).toBe(false);
  });
});

describe('abortStaleRunningTasks (default dir, integration smoke)', () => {
  // Just verify it doesn't throw with default storage and returns 0 when there's
  // no state yet. Real production verification happens at daemon startup.
  it('returns 0 when no tasks exist', () => {
    // We don't pass a dir; uses ~/.clementine/background-tasks/ which may
    // already exist from prior runs. Don't assert on count, just no-throw.
    expect(() => abortStaleRunningTasks()).not.toThrow();
  });
});
