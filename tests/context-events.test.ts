import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listContextEvents,
  markContextEventBySource,
  recordContextEvent,
} from '../src/gateway/context-events.js';

describe('context event ledger', () => {
  let baseDir: string;
  const sessionKey = 'discord:user:123';

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-context-events-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('collapses repeat observations into one stable event', () => {
    const first = recordContextEvent({
      source: 'background-task',
      sourceId: 'bg-test-123abc',
      sessionKey,
      title: 'bg-test failed',
      summary: 'billing blocked',
      status: 'failed',
      severity: 'urgent',
      eventAt: '2026-05-05T12:00:00.000Z',
      fingerprintParts: [sessionKey, 'background-task', 'bg-test-123abc'],
    }, { baseDir });

    const second = recordContextEvent({
      source: 'background-task',
      sourceId: 'bg-test-123abc',
      sessionKey,
      title: 'bg-test failed',
      summary: 'billing blocked again',
      status: 'failed',
      severity: 'urgent',
      eventAt: '2026-05-05T12:01:00.000Z',
      fingerprintParts: [sessionKey, 'background-task', 'bg-test-123abc'],
    }, { baseDir });

    expect(second.id).toBe(first.id);
    expect(second.count).toBe(2);
    expect(listContextEvents(sessionKey, { baseDir })).toHaveLength(1);
  });

  it('tracks surfaced and acknowledged state independent of turn text', () => {
    recordContextEvent({
      source: 'notification',
      sourceId: 'cron_failure-abc',
      sessionKey,
      title: 'cron failed',
      summary: 'audit-inbox-check failed',
      status: 'failed',
      severity: 'warning',
      eventAt: '2026-05-05T12:00:00.000Z',
      fingerprintParts: [sessionKey, 'notification', 'audit-inbox-check'],
    }, { baseDir });

    markContextEventBySource(
      { sessionKey, source: 'notification', sourceId: 'cron_failure-abc' },
      {
        surfacedAt: '2026-05-05T12:02:00.000Z',
        acknowledgedAt: '2026-05-05T12:03:00.000Z',
      },
      { baseDir },
    );

    const [event] = listContextEvents(sessionKey, { baseDir });
    expect(event?.surfacedAt).toBe('2026-05-05T12:02:00.000Z');
    expect(event?.acknowledgedAt).toBe('2026-05-05T12:03:00.000Z');
  });
});

