import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackgroundTask, markFailed, markRunning } from '../src/agent/background-tasks.js';
import { recordProactiveNotificationEvent } from '../src/gateway/notification-context.js';
import { resolveRecentOperationalContext } from '../src/gateway/recent-context.js';

describe('recent operational context resolver', () => {
  let baseDir: string;
  const sessionKey = 'discord:user:1467785052082405386';
  const now = Date.parse('2026-05-05T00:25:00.000Z');

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-recent-context-'));
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function writeCronConfig(jobName: string): void {
    const file = path.join(baseDir, 'vault', '00-System', 'CRON.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, [
      'jobs:',
      `  - name: ${jobName}`,
      '    schedule: 0 * * * *',
      '    tier: 2',
      '    enabled: true',
      '    mode: unleashed',
      '    max_hours: 1',
      '    prompt: |',
      '      Check the thing.',
    ].join('\n'));
  }

  function writeCronRun(jobName: string, entry: Record<string, unknown>): void {
    const file = path.join(baseDir, 'cron', 'runs', `${jobName}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  }

  function writeUnleashedStatus(jobName: string, status: Record<string, unknown>): void {
    const file = path.join(baseDir, 'unleashed', jobName, 'status.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(status, null, 2));
  }

  it('resolves a vague cron-failure follow-up before chat/deep-mode routing', () => {
    const jobName = 'audit-inbox-check';
    writeCronConfig(jobName);
    writeCronRun(jobName, {
      jobName,
      startedAt: '2026-05-04T23:00:00.478Z',
      finishedAt: '2026-05-04T23:00:19.929Z',
      status: 'ok',
      durationMs: 19451,
      outputPreview: 'Task "audit-inbox-check" aborted after 3 consecutive phase errors.',
      terminalReason: 'completed',
    });
    writeUnleashedStatus(jobName, {
      jobName,
      status: 'error',
      phase: 3,
      updatedAt: '2026-05-04T23:00:19.928Z',
    });
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: '1 cron job failing',
      summary: 'audit-inbox-check is failing.',
      text: 'Task "audit-inbox-check" aborted after 3 consecutive phase errors.',
      jobNames: [jobName],
      sentAt: '2026-05-05T00:20:00.000Z',
    }, { baseDir, now });

    const resolved = resolveRecentOperationalContext(
      sessionKey,
      'How do we fix that issue',
      { baseDir, now },
    );

    expect(resolved?.source).toBe('notification');
    expect(resolved?.suppressDeepMode).toBe(true);
    expect(resolved?.responseText).toContain('I found audit-inbox-check. I am not running the job.');
    expect(resolved?.responseText).toContain('Unleashed status: error, phase 3');
    expect(resolved?.responseText).toContain('underlying phase failure');
  });

  it('summarizes multiple cron notification targets instead of guessing or starting background work', () => {
    for (const job of ['insight-check', 'audit-inbox-check']) {
      writeCronConfig(job);
      writeCronRun(job, {
        jobName: job,
        startedAt: '2026-05-04T23:00:00.000Z',
        status: 'error',
        durationMs: 1000,
        error: `${job} failed`,
      });
    }
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: '2 cron jobs failing',
      summary: 'insight-check and audit-inbox-check are failing.',
      text: 'Cron failures.',
      jobNames: ['insight-check', 'audit-inbox-check'],
      sentAt: '2026-05-05T00:20:00.000Z',
    }, { baseDir, now });

    const resolved = resolveRecentOperationalContext(sessionKey, 'How do we fix that issue', { baseDir, now });

    expect(resolved?.responseText).toContain('recent cron failure alert: insight-check, audit-inbox-check');
    expect(resolved?.responseText).toContain('not going to guess or start background work');
    expect(resolved?.responseText).toContain('Reply `fix insight-check`');
    expect(resolved?.suppressDeepMode).toBe(true);
  });

  it('surfaces recent background provider blockers as local context', () => {
    const task = createBackgroundTask({
      fromAgent: 'clementine',
      prompt: 'Diagnose the recent scheduler issue',
      maxMinutes: 60,
      sessionKey,
    }, { dir: path.join(baseDir, 'background-tasks') });
    markRunning(task.id, { dir: path.join(baseDir, 'background-tasks') });
    markFailed(task.id, "You've hit your org's monthly usage limit.", 'failed', { dir: path.join(baseDir, 'background-tasks') });

    const resolved = resolveRecentOperationalContext(sessionKey, 'what happened with that issue?', { baseDir, now });

    expect(resolved?.source).toBe('background-task');
    expect(resolved?.responseText).toContain(task.id);
    expect(resolved?.responseText).toContain('provider/billing blocker');
    expect(resolved?.suppressDeepMode).toBe(true);
  });
});
