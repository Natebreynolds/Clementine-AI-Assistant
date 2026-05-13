import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  function writeBackgroundTask(id: string, fields: Record<string, unknown>): void {
    const taskDir = path.join(baseDir, 'background-tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify({
      id,
      fromAgent: 'clementine',
      prompt: 'Diagnose the recent scheduler issue',
      maxMinutes: 60,
      sessionKey,
      createdAt: '2026-05-05T11:55:00.000Z',
      ...fields,
    }));
  }

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

    const taskId = 'bg-failed-123abc';
    writeBackgroundTask(taskId, {
      status: 'failed',
      startedAt: '2026-05-05T11:56:00.000Z',
      completedAt: '2026-05-05T11:57:00.000Z',
      error: "You've hit your org's monthly usage limit.",
    });

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
    const notification = snapshot.items.find((item) => item.source === 'notification');
    const background = snapshot.items.find((item) => item.label.includes(taskId));

    expect(snapshot.items.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.promptBlock).toContain('[Context governance: active working set]');
    expect(snapshot.promptBlock).toContain('REFERENCE ONLY');
    expect(snapshot.promptBlock).toContain('background-task');
    expect(snapshot.promptBlock).toContain('notification');
    expect(snapshot.promptBlock).toContain('unleashed');
    expect(snapshot.promptBlock).toContain('context only');
    expect(background?.eventId).toMatch(/^ctx-/);
    expect(notification?.alreadySurfaced).toBe(true);
    expect(background?.greetingEligible).toBe(false);
    expect(snapshot.greetingLine).toBeNull();
  });

  it('allows only fresh unsurfaced active work to become greeting context', () => {
    writeBackgroundTask('bg-fresh-123abc', {
      prompt: 'Audit the active inbox failure',
      status: 'running',
      startedAt: '2026-05-05T11:56:00.000Z',
    });

    const snapshot = buildActiveContextSnapshot(sessionKey, { baseDir, now });

    expect(snapshot.greetingLine).toContain('Still working on bg-fresh-123abc running');
  });

  it('does not promote already surfaced task failures back into greetings', () => {
    const taskId = 'bg-failed-456def';
    writeBackgroundTask(taskId, {
      status: 'failed',
      startedAt: '2026-05-05T11:56:00.000Z',
      completedAt: '2026-05-05T11:57:00.000Z',
      error: "You've hit your org's monthly usage limit.",
    });

    appendTurnLedger({
      id: 'turn-2',
      createdAt: '2026-05-05T11:59:00.000Z',
      sessionKey,
      channel: 'Discord DM',
      userMessagePreview: 'Hey',
      userMessageChars: 3,
      userMessageTokensEstimate: 1,
      toolCallsMade: 0,
      toolNames: [],
      actionExpected: false,
      deliveryStatus: 'returned',
      responsePreview: `Hey. Main thing right now: ${taskId} failed — monthly usage limit.`,
      durationMs: 20,
    }, baseDir);

    const snapshot = buildActiveContextSnapshot(sessionKey, { baseDir, now });
    const background = snapshot.items.find((item) => item.label.includes(taskId));

    expect(background?.alreadySurfaced).toBe(true);
    expect(background?.greetingEligible).toBe(false);
    expect(snapshot.greetingLine).toBeNull();
  });

  it('deprioritizes noisy or recovered heartbeat notifications', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: '1 cron job failing',
      summary: '1 cron job repeatedly failing. - sales-agent:friday-scorecard: 0/0 recent runs failed | cause: The job reached its turn cap before finishing.',
      text: 'Heartbeat notification.',
      jobNames: ['sales-agent:friday-scorecard'],
      sentAt: '2026-05-05T11:55:00.000Z',
    }, { baseDir, now });

    const snapshot = buildActiveContextSnapshot(sessionKey, { baseDir, now });
    const notification = snapshot.items.find((item) => item.source === 'notification');

    expect(notification?.priority).toBeLessThanOrEqual(30);
    expect(notification?.greetingEligible).toBe(false);
    expect(snapshot.greetingLine).toBeNull();
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
