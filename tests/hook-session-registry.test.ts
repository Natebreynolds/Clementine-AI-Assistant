/**
 * PRD §6 Phase 4d / 1.18.101 — Path B hook-session registry tests.
 *
 * Covers register/unregister/lookup, seq monotonicity (path B uses
 * 1_000_000-prefixed seqs to stay distinct from path A), stale sweep,
 * and the test-helper isolation primitive.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  registerRunSession,
  unregisterRunSession,
  getRunSession,
  nextSeqForSession,
  sweepStaleSessions,
  getRegistryStats,
  _resetRegistryForTests,
} from '../src/agent/hook-session-registry.js';
import { EventLog } from '../src/gateway/event-log.js';

let tmpHome: string;
let log: EventLog;

beforeEach(() => {
  _resetRegistryForTests();
  tmpHome = mkdtempSync(path.join(tmpdir(), 'clem-hookreg-'));
  mkdirSync(path.join(tmpHome, 'events'), { recursive: true });
  log = new EventLog(tmpHome);
});

describe('register / unregister / lookup', () => {
  it('lookup returns null for unknown sessionId', () => {
    expect(getRunSession('never-registered')).toBeNull();
  });

  it('register then lookup returns the same entry', () => {
    registerRunSession('s1', 'run-1', log, 0);
    const found = getRunSession('s1');
    expect(found).not.toBeNull();
    expect(found!.runId).toBe('run-1');
    expect(found!.eventLog).toBe(log);
  });

  it('register is a no-op when sessionId is empty', () => {
    registerRunSession('', 'run-x', log, 0);
    expect(getRunSession('')).toBeNull();
  });

  it('register is a no-op when runId is empty', () => {
    registerRunSession('s2', '', log, 0);
    expect(getRunSession('s2')).toBeNull();
  });

  it('unregister removes the entry', () => {
    registerRunSession('s3', 'run-3', log, 0);
    expect(getRunSession('s3')).not.toBeNull();
    unregisterRunSession('s3');
    expect(getRunSession('s3')).toBeNull();
  });

  it('unregister of unknown sessionId is a silent no-op', () => {
    expect(() => unregisterRunSession('never-registered')).not.toThrow();
  });

  it('supports multiple concurrent registrations', () => {
    registerRunSession('s-a', 'run-a', log, 0);
    registerRunSession('s-b', 'run-b', log, 0);
    expect(getRunSession('s-a')!.runId).toBe('run-a');
    expect(getRunSession('s-b')!.runId).toBe('run-b');
    expect(getRegistryStats().count).toBe(2);
  });
});

describe('nextSeqForSession', () => {
  it('returns null when session not registered', () => {
    expect(nextSeqForSession('missing')).toBeNull();
  });

  it('returns monotonically increasing seqs prefixed at 1_000_000', () => {
    registerRunSession('s4', 'run-4', log, 0);
    expect(nextSeqForSession('s4')).toBe(1_000_000);
    expect(nextSeqForSession('s4')).toBe(1_000_001);
    expect(nextSeqForSession('s4')).toBe(1_000_002);
  });

  it('per-session counters are independent', () => {
    registerRunSession('s-x', 'run-x', log, 0);
    registerRunSession('s-y', 'run-y', log, 0);
    expect(nextSeqForSession('s-x')).toBe(1_000_000);
    expect(nextSeqForSession('s-y')).toBe(1_000_000);
    expect(nextSeqForSession('s-x')).toBe(1_000_001);
  });

  it('seqStart parameter offsets the counter', () => {
    registerRunSession('s5', 'run-5', log, 42);
    expect(nextSeqForSession('s5')).toBe(1_000_042);
  });
});

describe('sweepStaleSessions', () => {
  it('returns 0 when no entries are stale', () => {
    registerRunSession('fresh', 'run-fresh', log, 0);
    expect(sweepStaleSessions()).toBe(0);
    expect(getRunSession('fresh')).not.toBeNull();
  });

  it('removes entries older than the cutoff', () => {
    registerRunSession('stale', 'run-stale', log, 0);
    // Hack: reach into the registry by mutating the entry's registeredAt
    // through getRunSession (returns the live reference).
    const e = getRunSession('stale');
    expect(e).not.toBeNull();
    e!.registeredAt = Date.now() - 7 * 60 * 60 * 1000; // 7 hours ago
    const removed = sweepStaleSessions();
    expect(removed).toBe(1);
    expect(getRunSession('stale')).toBeNull();
  });
});

describe('getRegistryStats', () => {
  it('reports count=0 and oldestAgeMs=null when empty', () => {
    expect(getRegistryStats()).toEqual({ count: 0, oldestAgeMs: null });
  });

  it('reports count and oldest age when populated', () => {
    registerRunSession('s', 'run', log, 0);
    const stats = getRegistryStats();
    expect(stats.count).toBe(1);
    expect(typeof stats.oldestAgeMs).toBe('number');
    expect(stats.oldestAgeMs).toBeGreaterThanOrEqual(0);
  });
});
