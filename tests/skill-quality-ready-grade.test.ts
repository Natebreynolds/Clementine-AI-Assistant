/**
 * 1.18.185 — pin the 'ready' grade for vault-known skills that have
 * never run. Before this change, fresh skills got 'no-data' which
 * users read as "this thing is broken" rather than "this is loaded
 * and waiting for its first run."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeAllSkillQuality } from '../src/memory/skill-quality.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clem-quality-test-'));
  // Empty cron/runs/ directory so iterRecentRuns yields nothing —
  // exercises the no-history path without depending on the dev box's data.
  mkdirSync(path.join(tmpDir, 'cron', 'runs'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeAllSkillQuality — 1.18.185 ready grade', () => {
  it('assigns "ready" grade to vault skills that have never run', () => {
    const scores = computeAllSkillQuality({
      baseDir: tmpDir,
      vaultSkillNames: ['my-new-skill'],
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]?.name).toBe('my-new-skill');
    expect(scores[0]?.grade).toBe('ready');
    expect(scores[0]?.totalRuns).toBe(0);
    expect(scores[0]?.gradeReason).toMatch(/no runs yet|loaded and ready/i);
  });

  it('does NOT include vault skills under any other grade when they never ran', () => {
    const scores = computeAllSkillQuality({
      baseDir: tmpDir,
      vaultSkillNames: ['skill-a', 'skill-b', 'skill-c'],
    });
    expect(scores).toHaveLength(3);
    for (const s of scores) {
      expect(s.grade).toBe('ready');
      expect(s.totalRuns).toBe(0);
    }
  });

  it('returns empty list when no vault names provided and no runs exist (back-compat)', () => {
    const scores = computeAllSkillQuality({ baseDir: tmpDir });
    expect(scores).toHaveLength(0);
  });

  it('returns empty list when vaultSkillNames is empty array (no synthetic entries)', () => {
    const scores = computeAllSkillQuality({
      baseDir: tmpDir,
      vaultSkillNames: [],
    });
    expect(scores).toHaveLength(0);
  });
});
