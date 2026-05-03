import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildNotificationContextPrompt,
  findRecentNotificationContext,
  looksLikeNotificationFollowup,
  recordProactiveNotificationEvent,
} from '../src/gateway/notification-context.js';

describe('proactive notification context', () => {
  let baseDir: string;
  const now = Date.parse('2026-05-03T12:00:00.000Z');
  const sessionKey = 'discord:user:1467785052082405386';

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-notification-context-'));
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('detects vague replies that need recent notification context', () => {
    expect(looksLikeNotificationFollowup('How do we fix this')).toBe(true);
    expect(looksLikeNotificationFollowup('can we fix that please')).toBe(true);
    expect(looksLikeNotificationFollowup('what broke?')).toBe(true);
    expect(looksLikeNotificationFollowup('what is on my calendar tomorrow')).toBe(false);
  });

  it('resolves a vague follow-up to the latest event for the same session', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: 'Cron failures',
      summary: 'insight-check is failing with Prompt is too long.',
      text: 'Cron failure report. Reply `fix insight-check`.',
      jobNames: ['insight-check'],
      sentAt: '2026-05-03T11:50:00.000Z',
    }, { baseDir, now });

    const event = findRecentNotificationContext(
      sessionKey,
      'How do we fix this?',
      { baseDir, now },
    );

    expect(event?.type).toBe('cron_failure');
    expect(event?.jobNames).toEqual(['insight-check']);

    const prompt = buildNotificationContextPrompt(event!, 'How do we fix this?');
    expect(prompt).toContain('The current user message is likely a reply to it.');
    expect(prompt).toContain('Jobs: insight-check');
    expect(prompt).toContain('Prompt is too long');
  });

  it('does not leak notification context across sessions', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: 'Cron failures',
      summary: 'audit-inbox-check is failing.',
      text: 'Cron failure report.',
      jobNames: ['audit-inbox-check'],
      sentAt: '2026-05-03T11:50:00.000Z',
    }, { baseDir, now });

    const event = findRecentNotificationContext(
      'discord:user:someone-else',
      'fix this',
      { baseDir, now },
    );

    expect(event).toBeNull();
  });

  it('allows explicit job mentions even when the reply is not otherwise vague', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: 'Cron failures',
      summary: 'market-leader-followup is failing with context overflow.',
      text: 'Cron failure report.',
      jobNames: ['market-leader-followup'],
      sentAt: '2026-05-03T11:50:00.000Z',
    }, { baseDir, now });

    const event = findRecentNotificationContext(
      sessionKey,
      'market leader followup needs attention',
      { baseDir, now },
    );

    expect(event?.jobNames).toEqual(['market-leader-followup']);
  });

  it('ignores expired events', () => {
    recordProactiveNotificationEvent({
      type: 'cron_failure',
      sessionKey,
      title: 'Cron failures',
      summary: 'old failure.',
      text: 'Old cron failure report.',
      jobNames: ['old-job'],
      sentAt: '2026-05-01T11:50:00.000Z',
    }, { baseDir, now });

    expect(findRecentNotificationContext(sessionKey, 'fix this', { baseDir, now })).toBeNull();
  });
});
