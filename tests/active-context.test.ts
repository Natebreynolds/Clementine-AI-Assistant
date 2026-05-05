import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackgroundTask, markFailed, markRunning } from '../src/agent/background-tasks.js';
import { buildActiveContextSnapshot } from '../src/gateway/active-context.js';
import { recordProactiveNotificationEvent } from '../src/gateway/notification-context.js';
import { appendTurnLedger } from '../src/gateway/turn-ledger.js';

describe('active working set context', () => {
  let baseDir: string;
  const sessionKey = 'discord:user:1467785052082405386';
  const now = Date.parse('2026-05-05T12:00:00.000Z');

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-active-context-'));
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('builds a bounded active working set from operational sources', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: 'audit-inbox-check failing',
      summary: 'Task "audit-inbox-check" aborted after 3 consecutive phase errors.',
      text: 'Cron failure.',
      jobNames: ['audit-inbox-check'],
      sentAt: '2026-05-05T11:55:00.000Z',
    }, { baseDir, now });

    const task = createBackgroundTask({
      fromAgent: 'clementine',
      prompt: 'Diagnose the recent scheduler issue',
      maxMinutes: 60,
      sessionKey,
    }, { dir: path.join(baseDir, 'background-tasks') });
    markRunning(task.id, { dir: path.join(baseDir, 'background-tasks') });
    markFailed(task.id, "You've hit your org's monthly usage limit.", 'failed', { dir: path.join(baseDir, 'background-tasks') });

    const statusFile = path.join(baseDir, 'unleashed', 'audit-inbox-check', 'status.json');
    mkdirSync(path.dirname(statusFile), { recursive: true });
    writeFileSync(statusFile, JSON.stringify({
      jobName: 'audit-inbox-check',
      status: 'error',
      phase: 3,
      updatedAt: '2026-05-05T11:59:00.000Z',
    }));

    appendTurnLedger({
      id: 'turn-1',
      createdAt: '2026-05-05T11:58:00.000Z',
      sessionKey,
      channel: 'Discord DM',
      userMessagePreview: 'How do we fix that issue?',
      userMessageChars: 25,
      userMessageTokensEstimate: 7,
      toolCallsMade: 0,
      toolNames: [],
      actionExpected: true,
      deliveryStatus: 'returned',
      responsePreview: 'On it — this looks like real work.',
      durationMs: 100,
    }, baseDir);

    const snapshot = buildActiveContextSnapshot(sessionKey, { baseDir, now, maxItems: 5 });

    expect(snapshot.items.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.promptBlock).toContain('[Active working set]');
    expect(snapshot.promptBlock).toContain('background-task');
    expect(snapshot.promptBlock).toContain('notification');
    expect(snapshot.promptBlock).toContain('unleashed');
    expect(snapshot.greetingLine).toContain('Main thing right now');
    expect(snapshot.greetingLine).toContain(task.id);
  });

  it('does not leak another session into the snapshot', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey: 'discord:user:someone-else',
      title: 'other failure',
      summary: 'Other session failure.',
      text: 'Cron failure.',
      jobNames: ['other-job'],
      sentAt: '2026-05-05T11:55:00.000Z',
    }, { baseDir, now });

    const snapshot = buildActiveContextSnapshot(sessionKey, { baseDir, now });

    expect(snapshot.promptBlock).toBeNull();
    expect(snapshot.greetingLine).toBeNull();
  });
});
