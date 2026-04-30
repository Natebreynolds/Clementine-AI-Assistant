/**
 * Phase 8.1 — multi-run autoApply verification + auto-revert.
 *
 * Drives recordAutoApplyForVerification + checkAndDeliverVerification
 * directly with synthetic CronRunEntry objects to exercise the verdict
 * window and revert path. Uses a tmp BASE_DIR so the real state file is
 * untouched.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP_HOME = path.join(tmpdir(), 'clem-fix-verif-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'cron'), { recursive: true });

import {
  _resetVerificationState,
  checkAndDeliverVerification,
  listPendingVerifications,
  recordAutoApplyForVerification,
} from '../src/gateway/fix-verification.js';
import type { CronRunEntry } from '../src/types.js';

function makeRun(jobName: string, status: CronRunEntry['status'], errorOverride?: string): CronRunEntry {
  return {
    jobName,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    durationMs: 1000,
    attempt: 1,
    ...(errorOverride ? { error: errorOverride } : {}),
  };
}

describe('Phase 8.1 — autoApply multi-run verification', () => {
  beforeEach(() => {
    _resetVerificationState();
    // Mock computeBrokenJobs in failure-monitor — avoid scanning real disk.
    vi.mock('../src/gateway/failure-monitor.js', () => ({
      computeBrokenJobs: () => [],
    }));
  });

  afterEach(() => {
    _resetVerificationState();
    vi.resetModules();
  });

  it('records pending verification with autoApply tracker', () => {
    const ruleFile = path.join(TMP_HOME, 'advisor-rules', 'user', 'fake-rule.yaml');
    mkdirSync(path.dirname(ruleFile), { recursive: true });
    writeFileSync(ruleFile, 'schemaVersion: 1\nid: fake-rule\n');

    recordAutoApplyForVerification('test-job', {
      kind: 'advisor-rule',
      file: ruleFile,
      ruleId: 'fake-rule',
    });

    const pending = listPendingVerifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.jobName).toBe('test-job');
    expect(pending[0]!.autoApply?.kind).toBe('advisor-rule');
    expect(pending[0]!.postRunOutcomes).toEqual([]);
  });

  it('accumulates run outcomes; verdict only at the 3rd run', async () => {
    const file = path.join(TMP_HOME, 'advisor-rules', 'user', 'window-rule.yaml');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'schemaVersion: 1\nid: window-rule\n');

    recordAutoApplyForVerification('window-job', {
      kind: 'advisor-rule', file, ruleId: 'window-rule',
    });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };

    // Run 1 — error. No verdict yet.
    await checkAndDeliverVerification(makeRun('window-job', 'error', 'fail'), send);
    expect(sent).toHaveLength(0);
    expect(listPendingVerifications()[0]!.postRunOutcomes).toEqual(['error']);

    // Run 2 — error. Still no verdict.
    await checkAndDeliverVerification(makeRun('window-job', 'error', 'fail'), send);
    expect(sent).toHaveLength(0);
    expect(listPendingVerifications()[0]!.postRunOutcomes).toEqual(['error', 'error']);

    // Run 3 — error. Verdict fires, file reverted.
    await checkAndDeliverVerification(makeRun('window-job', 'error', 'fail'), send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('REVERTED');
    expect(sent[0]).toContain('window-rule');
    expect(existsSync(file)).toBe(false);
    expect(listPendingVerifications()).toHaveLength(0);
  });

  it('skipped runs do not advance the verdict window', async () => {
    const file = path.join(TMP_HOME, 'advisor-rules', 'user', 'skip-rule.yaml');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'schemaVersion: 1\nid: skip-rule\n');

    recordAutoApplyForVerification('skip-job', { kind: 'advisor-rule', file, ruleId: 'skip-rule' });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };

    await checkAndDeliverVerification(makeRun('skip-job', 'skipped'), send);
    await checkAndDeliverVerification(makeRun('skip-job', 'skipped'), send);
    await checkAndDeliverVerification(makeRun('skip-job', 'skipped'), send);
    expect(sent).toHaveLength(0);
    expect(listPendingVerifications()[0]!.postRunOutcomes).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it('mixed outcomes — at least 1 success keeps the fix', async () => {
    const file = path.join(TMP_HOME, 'prompt-overrides', 'jobs', 'mixed.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'You are a focused agent.\n');

    recordAutoApplyForVerification('mixed-job', {
      kind: 'prompt-override', file, scope: 'job', scopeKey: 'mixed',
    });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };

    await checkAndDeliverVerification(makeRun('mixed-job', 'error', 'fail'), send);
    await checkAndDeliverVerification(makeRun('mixed-job', 'ok'), send);
    await checkAndDeliverVerification(makeRun('mixed-job', 'error', 'fail'), send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('partial');
    expect(sent[0]).toContain('1/3');
    expect(sent[0]).not.toContain('REVERTED');
    expect(existsSync(file)).toBe(true);
  });

  it('all runs succeed — verified, fix kept', async () => {
    const file = path.join(TMP_HOME, 'advisor-rules', 'user', 'good-rule.yaml');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'schemaVersion: 1\nid: good-rule\n');

    recordAutoApplyForVerification('good-job', { kind: 'advisor-rule', file, ruleId: 'good-rule' });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };

    await checkAndDeliverVerification(makeRun('good-job', 'ok'), send);
    await checkAndDeliverVerification(makeRun('good-job', 'ok'), send);
    await checkAndDeliverVerification(makeRun('good-job', 'ok'), send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('verified');
    expect(sent[0]).toContain('3/3');
    expect(existsSync(file)).toBe(true);
  });

  // The pre-existing hand-edit (no autoApply) flow is preserved by the
  // `if (!pending.autoApply)` branch in checkAndDeliverVerification — it
  // delegates to the original single-run verdict path. That code path is
  // covered by the existing CRON.md edit tests in the original Phase 7
  // shipment; not duplicating here.

  // ── cron-config kind: revert restores prevFields, doesn't delete the file ──

  it('cron-config: failed verdict restores prevFields without deleting CRON.md', async () => {
    const cronFile = path.join(TMP_HOME, 'cronconfig-revert', 'CRON.md');
    mkdirSync(path.dirname(cronFile), { recursive: true });
    // Initial state simulates "after the fix": mode=unleashed, max_hours=1.
    // prevFields says: before, mode was absent (delete on revert), max_hours absent.
    writeFileSync(
      cronFile,
      `---\njobs:\n  - name: market-leader-followup\n    schedule: 30 8 * * *\n    tier: 2\n    mode: unleashed\n    max_hours: 1\n---\n`,
    );

    recordAutoApplyForVerification('market-leader-followup', {
      kind: 'cron-config',
      file: cronFile,
      bareName: 'market-leader-followup',
      prevFields: { mode: null, max_hours: null },
    });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };
    // Three failures — should revert.
    await checkAndDeliverVerification(makeRun('market-leader-followup', 'error', 'still failing'), send);
    await checkAndDeliverVerification(makeRun('market-leader-followup', 'error', 'still failing'), send);
    await checkAndDeliverVerification(makeRun('market-leader-followup', 'error', 'still failing'), send);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('REVERTED');
    expect(existsSync(cronFile)).toBe(true); // never delete CRON.md

    const after = (await import('node:fs')).readFileSync(cronFile, 'utf-8');
    expect(after).not.toMatch(/mode:\s*unleashed/);
    expect(after).not.toMatch(/max_hours:\s*1/);
    expect(after).toMatch(/name: market-leader-followup/);
  });

  it('cron-config: failed verdict restores prior numeric value (not just delete)', async () => {
    const cronFile = path.join(TMP_HOME, 'cronconfig-prior', 'CRON.md');
    mkdirSync(path.dirname(cronFile), { recursive: true });
    writeFileSync(
      cronFile,
      `---\njobs:\n  - name: foo\n    schedule: '* * * * *'\n    max_hours: 4\n---\n`,
    );
    recordAutoApplyForVerification('foo', {
      kind: 'cron-config',
      file: cronFile,
      bareName: 'foo',
      prevFields: { max_hours: 2 },
    });

    const send = async () => undefined;
    await checkAndDeliverVerification(makeRun('foo', 'error'), send);
    await checkAndDeliverVerification(makeRun('foo', 'error'), send);
    await checkAndDeliverVerification(makeRun('foo', 'error'), send);

    const after = (await import('node:fs')).readFileSync(cronFile, 'utf-8');
    expect(after).toMatch(/max_hours:\s*2/);
    expect(after).not.toMatch(/max_hours:\s*4/);
  });

  it('cron-config: success verdict keeps the fix in place', async () => {
    const cronFile = path.join(TMP_HOME, 'cronconfig-success', 'CRON.md');
    mkdirSync(path.dirname(cronFile), { recursive: true });
    writeFileSync(
      cronFile,
      `---\njobs:\n  - name: bar\n    schedule: '* * * * *'\n    mode: unleashed\n    max_hours: 1\n---\n`,
    );
    recordAutoApplyForVerification('bar', {
      kind: 'cron-config',
      file: cronFile,
      bareName: 'bar',
      prevFields: { mode: null, max_hours: null },
    });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };
    await checkAndDeliverVerification(makeRun('bar', 'ok'), send);
    await checkAndDeliverVerification(makeRun('bar', 'ok'), send);
    await checkAndDeliverVerification(makeRun('bar', 'ok'), send);

    expect(sent[0]).toContain('verified');
    const after = (await import('node:fs')).readFileSync(cronFile, 'utf-8');
    expect(after).toMatch(/mode:\s*unleashed/); // still applied
  });

  it('cron-config: gracefully no-ops when job has been removed before revert', async () => {
    const cronFile = path.join(TMP_HOME, 'cronconfig-removed', 'CRON.md');
    mkdirSync(path.dirname(cronFile), { recursive: true });
    writeFileSync(cronFile, `---\njobs: []\n---\n`); // job is gone

    recordAutoApplyForVerification('ghost', {
      kind: 'cron-config',
      file: cronFile,
      bareName: 'ghost',
      prevFields: { mode: null },
    });

    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };
    await checkAndDeliverVerification(makeRun('ghost', 'error'), send);
    await checkAndDeliverVerification(makeRun('ghost', 'error'), send);
    await checkAndDeliverVerification(makeRun('ghost', 'error'), send);

    // Verdict still fires; revert reports as "tried to revert"
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('REVERTED');
    expect(existsSync(cronFile)).toBe(true);
  });
});
