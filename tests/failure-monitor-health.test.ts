import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CronRunEntry } from '../src/types.js';

const originalHome = process.env.CLEMENTINE_HOME;
let activeHome: string | null = null;

afterEach(() => {
  if (activeHome) rmSync(activeHome, { recursive: true, force: true });
  activeHome = null;
  if (originalHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = originalHome;
  vi.resetModules();
});

function writeRun(baseDir: string, entry: CronRunEntry): void {
  const runsDir = path.join(baseDir, 'cron', 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, 'market-leader-followup.jsonl'), JSON.stringify(entry) + '\n');
}

function writeBreakerEvent(baseDir: string, timestamp: string): void {
  const eventsPath = path.join(baseDir, 'cron', 'advisor-events.jsonl');
  mkdirSync(path.dirname(eventsPath), { recursive: true });
  writeFileSync(eventsPath, JSON.stringify({
    type: 'circuit-breaker',
    jobName: 'market-leader-followup',
    detail: 'Circuit breaker engaged after 5 consecutive errors',
    timestamp,
  }) + '\n');
}

function run(overrides: Partial<CronRunEntry>): CronRunEntry {
  return {
    jobName: 'market-leader-followup',
    startedAt: '2026-05-04T08:10:00.000Z',
    finishedAt: '2026-05-04T08:11:00.000Z',
    status: 'ok',
    durationMs: 60_000,
    attempt: 1,
    ...overrides,
  };
}

describe('failure monitor health classification', () => {
  it('does not clear an engaged circuit breaker for raw-ok context-overflow runs', async () => {
    activeHome = mkdtempSync(path.join(tmpdir(), 'clementine-failure-monitor-'));
    process.env.CLEMENTINE_HOME = activeHome;
    vi.resetModules();

    writeBreakerEvent(activeHome, '2026-05-04T08:00:00.000Z');
    writeRun(activeHome, run({
      terminalReason: 'rapid_refill_breaker',
      outputPreview: 'Autocompact is thrashing.',
    }));

    const { computeBrokenJobs } = await import('../src/gateway/failure-monitor.js');
    const broken = computeBrokenJobs(Date.parse('2026-05-04T09:00:00.000Z'));

    expect(broken).toHaveLength(1);
    expect(broken[0]!.jobName).toBe('market-leader-followup');
    expect(broken[0]!.circuitBreakerEngagedAt).toBe('2026-05-04T08:00:00.000Z');
  });

  it('clears an engaged circuit breaker after a health-classified successful run', async () => {
    activeHome = mkdtempSync(path.join(tmpdir(), 'clementine-failure-monitor-'));
    process.env.CLEMENTINE_HOME = activeHome;
    vi.resetModules();

    writeBreakerEvent(activeHome, '2026-05-04T08:00:00.000Z');
    writeRun(activeHome, run({ outputPreview: 'No new replies found.' }));

    const { computeBrokenJobs } = await import('../src/gateway/failure-monitor.js');
    const broken = computeBrokenJobs(Date.parse('2026-05-04T09:00:00.000Z'));

    expect(broken).toEqual([]);
  });
});
