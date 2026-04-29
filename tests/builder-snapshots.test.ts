/**
 * Builder snapshots — file-based undo for workflow saves.
 *
 * Verifies:
 *  - snapshotWorkflow writes a copy under ~/.clementine/snapshots/builder/
 *  - listSnapshots returns newest first
 *  - restoreSnapshot writes content back AND snapshots the current state
 *  - bounded retention (oldest snapshot pruned when over MAX_PER_WORKFLOW)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP_HOME_HOLDER: { dir?: string } = {};
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.CLEMENTINE_HOME;
  TMP_HOME_HOLDER.dir = mkdtempSync(path.join(tmpdir(), 'clem-snap-'));
  process.env.CLEMENTINE_HOME = TMP_HOME_HOLDER.dir;
});
afterEach(() => {
  if (savedHome) process.env.CLEMENTINE_HOME = savedHome;
  else delete process.env.CLEMENTINE_HOME;
  if (TMP_HOME_HOLDER.dir && existsSync(TMP_HOME_HOLDER.dir)) {
    rmSync(TMP_HOME_HOLDER.dir, { recursive: true, force: true });
  }
});

describe('Builder snapshots', () => {
  it('snapshotWorkflow writes a copy and listSnapshots finds it', async () => {
    const { snapshotWorkflow, listSnapshots } = await import('../src/dashboard/builder/snapshots.js');
    const file = path.join(TMP_HOME_HOLDER.dir!, 'wf.md');
    writeFileSync(file, '---\nname: test\n---\n# original\n', 'utf-8');

    const entry = snapshotWorkflow('workflow:test', file);
    expect(entry).not.toBeNull();
    expect(entry!.filename).toMatch(/\.md$/);

    const list = listSnapshots('workflow:test');
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe(entry!.filename);
  });

  it('returns empty list when no snapshots exist', async () => {
    const { listSnapshots } = await import('../src/dashboard/builder/snapshots.js');
    const list = listSnapshots('workflow:never-saved');
    expect(list).toEqual([]);
  });

  it('returns null when source file does not exist', async () => {
    const { snapshotWorkflow } = await import('../src/dashboard/builder/snapshots.js');
    const result = snapshotWorkflow('workflow:x', path.join(TMP_HOME_HOLDER.dir!, 'missing.md'));
    expect(result).toBeNull();
  });

  it('restoreSnapshot writes content back and snapshots the prior state first', async () => {
    const { snapshotWorkflow, restoreSnapshot, listSnapshots } = await import('../src/dashboard/builder/snapshots.js');
    const file = path.join(TMP_HOME_HOLDER.dir!, 'wf.md');
    writeFileSync(file, 'v1', 'utf-8');
    const snap1 = snapshotWorkflow('workflow:rt', file)!;

    // Mutate to v2
    writeFileSync(file, 'v2', 'utf-8');

    const r = restoreSnapshot('workflow:rt', snap1.filename, file);
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('v1');

    // After restore there should be 2 snapshots: original v1 + the v2 captured pre-restore
    const list = listSnapshots('workflow:rt');
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('prunes to MAX_PER_WORKFLOW (20) snapshots', async () => {
    const { snapshotWorkflow, listSnapshots } = await import('../src/dashboard/builder/snapshots.js');
    const file = path.join(TMP_HOME_HOLDER.dir!, 'churn.md');
    for (let i = 0; i < 25; i++) {
      writeFileSync(file, 'iter ' + i, 'utf-8');
      snapshotWorkflow('workflow:churn', file);
      // Force unique timestamp filenames
      await new Promise(r => setTimeout(r, 5));
    }
    const list = listSnapshots('workflow:churn');
    expect(list.length).toBeLessThanOrEqual(20);
  });

  it('returns error for unknown id', async () => {
    const { restoreSnapshot } = await import('../src/dashboard/builder/snapshots.js');
    const r = restoreSnapshot('garbage:x', 'whatever.md', '/dev/null');
    expect(r.ok).toBe(false);
  });

  it('returns error for missing snapshot file', async () => {
    const { restoreSnapshot } = await import('../src/dashboard/builder/snapshots.js');
    const file = path.join(TMP_HOME_HOLDER.dir!, 'wf.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'whatever', 'utf-8');
    const r = restoreSnapshot('workflow:x', 'nope.md', file);
    expect(r.ok).toBe(false);
  });
});
