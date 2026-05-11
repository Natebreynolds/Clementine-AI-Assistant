import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT_DIR = path.join(tmpdir(), `clem-cron-tz-${process.pid}`);
const SYSTEM_DIR = path.join(ROOT_DIR, 'vault', '00-System');
const CRON_FILE = path.join(SYSTEM_DIR, 'CRON.md');
const AGENTS_DIR = path.join(SYSTEM_DIR, 'agents');
const WORKFLOWS_DIR = path.join(SYSTEM_DIR, 'workflows');
(globalThis as any).__CLEM_TZ_ROOT = ROOT_DIR;
(globalThis as any).__CLEM_TZ_SYSTEM = SYSTEM_DIR;
(globalThis as any).__CLEM_TZ_CRON = CRON_FILE;
(globalThis as any).__CLEM_TZ_AGENTS = AGENTS_DIR;
(globalThis as any).__CLEM_TZ_WORKFLOWS = WORKFLOWS_DIR;

const PREV_HOME = process.env.CLEMENTINE_HOME;
const PREV_TZ = process.env.TIMEZONE;
process.env.CLEMENTINE_HOME = ROOT_DIR;

const scheduleMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const validateMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('node-cron', () => ({
  default: {
    validate: validateMock,
    schedule: scheduleMock,
  },
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    get BASE_DIR() { return (globalThis as any).__CLEM_TZ_ROOT as string; },
    get SYSTEM_DIR() { return (globalThis as any).__CLEM_TZ_SYSTEM as string; },
    get CRON_FILE() { return (globalThis as any).__CLEM_TZ_CRON as string; },
    get AGENTS_DIR() { return (globalThis as any).__CLEM_TZ_AGENTS as string; },
    get WORKFLOWS_DIR() { return (globalThis as any).__CLEM_TZ_WORKFLOWS as string; },
  };
});

const { CronScheduler } = await import('../src/gateway/cron-scheduler.js');

function writeCron(): void {
  mkdirSync(SYSTEM_DIR, { recursive: true });
  writeFileSync(CRON_FILE, [
    '---',
    'jobs:',
    '  - name: local-time-job',
    '    schedule: "0 9 * * *"',
    '    prompt: "Run the local-time smoke job."',
    '    enabled: true',
    '---',
    '',
  ].join('\n'));
}

function writeRuntimeTimezone(timezone: string): void {
  mkdirSync(ROOT_DIR, { recursive: true });
  writeFileSync(path.join(ROOT_DIR, '.env'), `TIMEZONE=${timezone}\n`);
}

describe('cron scheduler timezone hot reload', () => {
  beforeEach(() => {
    rmSync(ROOT_DIR, { recursive: true, force: true });
    mkdirSync(AGENTS_DIR, { recursive: true });
    mkdirSync(WORKFLOWS_DIR, { recursive: true });
    writeCron();
    delete process.env.TIMEZONE;
    scheduleMock.mockClear();
    validateMock.mockClear();
  });

  afterAll(() => {
    rmSync(ROOT_DIR, { recursive: true, force: true });
    if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = PREV_HOME;
    if (PREV_TZ === undefined) delete process.env.TIMEZONE;
    else process.env.TIMEZONE = PREV_TZ;
  });

  it('uses the live runtime timezone each time schedules are reloaded', () => {
    writeRuntimeTimezone('America/Los_Angeles');
    const scheduler = new CronScheduler({} as never, { send: vi.fn() } as never);

    scheduler.reloadJobs();
    expect(scheduleMock).toHaveBeenLastCalledWith(
      '0 9 * * *',
      expect.any(Function),
      { timezone: 'America/Los_Angeles' },
    );

    writeRuntimeTimezone('America/New_York');
    scheduler.reloadJobs();
    expect(scheduleMock).toHaveBeenLastCalledWith(
      '0 9 * * *',
      expect.any(Function),
      { timezone: 'America/New_York' },
    );

    scheduler.stop();
  });
});
