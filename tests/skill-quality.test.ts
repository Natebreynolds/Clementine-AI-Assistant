import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeSkillQuality, computeAllSkillQuality, DEFAULT_WINDOW_DAYS } from '../src/memory/skill-quality.js';
import type { CronRunEntry } from '../src/types.js';

let TMP: string;

function writeRunLog(jobName: string, entries: CronRunEntry[]): void {
  const dir = path.join(TMP, 'cron', 'runs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobName.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function entry(over: Partial<CronRunEntry>): CronRunEntry {
  return {
    jobName: 'test-job',
    startedAt: new Date().toISOString(),
    status: 'ok',
    durationMs: 1000,
    attempt: 1,
    ...over,
  };
}

beforeEach(() => {
  TMP = mkdtempSync(path.join(tmpdir(), 'clem-skill-quality-'));
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('computeSkillQuality', () => {
  it('returns no-data grade with 0 runs when the log directory is empty', () => {
    const score = computeSkillQuality('absent-skill', { baseDir: TMP });
    expect(score.totalRuns).toBe(0);
    expect(score.grade).toBe('no-data');
    expect(score.successRate).toBeNull();
    expect(score.triggerAccuracy).toBeNull();
  });

  it('counts only runs where skillsApplied includes the target skill', () => {
    writeRunLog('job-a', [
      entry({ skillsApplied: [{ name: 'foo', source: 'pinned' }] }),
      entry({ skillsApplied: [{ name: 'bar', source: 'pinned' }] }),
      entry({ skillsApplied: [{ name: 'foo', source: 'auto', score: 0.8 }] }),
    ]);
    const fooScore = computeSkillQuality('foo', { baseDir: TMP });
    expect(fooScore.totalRuns).toBe(2);
    expect(fooScore.pinnedRuns).toBe(1);
    expect(fooScore.autoRuns).toBe(1);
  });

  it('grades 100% success as "good" once over MIN_RUNS_FOR_GRADE', () => {
    writeRunLog('j', [
      entry({ status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.successRate).toBe(1);
    expect(s.grade).toBe('good');
  });

  it('grades < UNDERPERFORMING_SUCCESS_RATE as underperforming', () => {
    writeRunLog('j', [
      entry({ status: 'error', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'error', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'error', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok',    skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.successRate).toBeCloseTo(0.25);
    expect(s.grade).toBe('underperforming');
    expect(s.gradeReason).toContain('25%');
  });

  it('treats goalCheck.status="fail" as a failure even when status="ok"', () => {
    writeRunLog('j', [
      entry({ status: 'ok', goalCheck: { status: 'fail', mode: 'evaluator' }, skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok', goalCheck: { status: 'fail', mode: 'evaluator' }, skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok', goalCheck: { status: 'fail', mode: 'evaluator' }, skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.successRuns).toBe(0);
    expect(s.failureRuns).toBe(3);
    expect(s.grade).toBe('underperforming');
  });

  it('computes triggerAccuracy from auto-matched runs only', () => {
    writeRunLog('j', [
      // 3 pinned, 1 success
      entry({ status: 'error', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'error', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok',    skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      // 4 auto-matched, 3 success
      entry({ status: 'ok',    skillsApplied: [{ name: 'sk', source: 'auto' }] }),
      entry({ status: 'ok',    skillsApplied: [{ name: 'sk', source: 'auto' }] }),
      entry({ status: 'ok',    skillsApplied: [{ name: 'sk', source: 'auto' }] }),
      entry({ status: 'error', skillsApplied: [{ name: 'sk', source: 'auto' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.autoRuns).toBe(4);
    expect(s.triggerAccuracy).toBeCloseTo(0.75);
  });

  it('returns null triggerAccuracy when no auto-matched runs exist', () => {
    writeRunLog('j', [
      entry({ status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.triggerAccuracy).toBeNull();
  });

  it('grades stale when the most recent run is > STALE_DAYS old', () => {
    const oldTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeRunLog('j', [
      entry({ startedAt: oldTs, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ startedAt: oldTs, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ startedAt: oldTs, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    // Use a wide window so the runs are still in scope but past STALE_DAYS.
    const s = computeSkillQuality('sk', { baseDir: TMP, windowDays: 365 });
    expect(s.totalRuns).toBe(3);
    expect(s.grade).toBe('stale');
  });

  it('aggregates avgDurationMs and avgCostUsd', () => {
    writeRunLog('j', [
      entry({ durationMs: 1000, totalCostUsd: 0.10, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ durationMs: 3000, totalCostUsd: 0.30, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ durationMs: 2000, totalCostUsd: 0.20, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.avgDurationMs).toBe(2000);
    expect(s.avgCostUsd).toBeCloseTo(0.20);
  });

  it('respects the windowDays cutoff', () => {
    const oldTs = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date().toISOString();
    writeRunLog('j', [
      // newest first in the file (we iterate reverse, but Date ordering matters for the cutoff)
      entry({ startedAt: oldTs, skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ startedAt: oldTs, skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ startedAt: newTs, skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP, windowDays: 30 });
    expect(s.totalRuns).toBe(1);
  });

  it('uses DEFAULT_WINDOW_DAYS when no windowDays passed', () => {
    writeRunLog('j', [
      entry({ skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('does not count "running" rows toward avgDurationMs', () => {
    writeRunLog('j', [
      entry({ durationMs: 0, status: 'running', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ durationMs: 2000, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
      entry({ durationMs: 4000, status: 'ok', skillsApplied: [{ name: 'sk', source: 'pinned' }] }),
    ]);
    const s = computeSkillQuality('sk', { baseDir: TMP });
    expect(s.avgDurationMs).toBe(3000);
  });
});

describe('computeAllSkillQuality', () => {
  it('returns one entry per skill that appeared in any run', () => {
    writeRunLog('j1', [
      entry({ skillsApplied: [{ name: 'foo', source: 'pinned' }] }),
      entry({ skillsApplied: [{ name: 'bar', source: 'pinned' }] }),
    ]);
    writeRunLog('j2', [
      entry({ skillsApplied: [{ name: 'foo', source: 'auto' }, { name: 'baz', source: 'pinned' }] }),
    ]);
    const scores = computeAllSkillQuality({ baseDir: TMP });
    const names = scores.map(s => s.name).sort();
    expect(names).toEqual(['bar', 'baz', 'foo']);
  });

  it('sorts by totalRuns descending', () => {
    writeRunLog('j', [
      entry({ skillsApplied: [{ name: 'often', source: 'pinned' }] }),
      entry({ skillsApplied: [{ name: 'often', source: 'pinned' }] }),
      entry({ skillsApplied: [{ name: 'often', source: 'pinned' }] }),
      entry({ skillsApplied: [{ name: 'rare',  source: 'pinned' }] }),
    ]);
    const scores = computeAllSkillQuality({ baseDir: TMP });
    expect(scores[0]!.name).toBe('often');
    expect(scores[1]!.name).toBe('rare');
  });

  it('returns [] when no run logs exist', () => {
    expect(computeAllSkillQuality({ baseDir: TMP })).toEqual([]);
  });
});
