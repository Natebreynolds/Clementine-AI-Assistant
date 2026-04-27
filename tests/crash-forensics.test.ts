import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ackCrashReport,
  buildCrashReport,
  formatCrashSummary,
  readUnreadCrashReports,
  surfaceUnreadCrashReports,
  writeCrashReport,
} from '../src/agent/crash-forensics.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clem-crash-forensics-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildCrashReport', () => {
  it('captures error message and stack from Error instances', () => {
    const err = new Error('something blew up');
    const report = buildCrashReport({ type: 'uncaughtException', error: err, uptime: 123, pid: 9999, baseDir: tmpDir });
    expect(report.type).toBe('uncaughtException');
    expect(report.error).toBe('something blew up');
    expect(report.stack).toBeDefined();
    expect(report.uptime).toBe(123);
    expect(report.pid).toBe(9999);
  });

  it('handles non-Error throwables', () => {
    const report = buildCrashReport({ type: 'unhandledRejection', error: 'just a string', uptime: 1, pid: 1, baseDir: tmpDir });
    expect(report.error).toBe('just a string');
    expect(report.stack).toBeUndefined();
  });

  it('clamps very long error messages so the dump stays small', () => {
    const huge = new Error('x'.repeat(5000));
    const report = buildCrashReport({ type: 'uncaughtException', error: huge, uptime: 0, pid: 0, baseDir: tmpDir });
    expect(report.error.length).toBeLessThanOrEqual(1000);
  });
});

describe('writeCrashReport / readUnreadCrashReports', () => {
  it('writes a dump and surfaces it as unread', () => {
    const file = writeCrashReport({ type: 'uncaughtException', error: new Error('boom'), baseDir: tmpDir });
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);
    const unread = readUnreadCrashReports(tmpDir);
    expect(unread.length).toBe(1);
    expect(unread[0].report.error).toBe('boom');
    expect(unread[0].report.type).toBe('uncaughtException');
  });

  it('does not surface acked reports on subsequent reads', () => {
    const file = writeCrashReport({ type: 'unhandledRejection', error: 'nope', baseDir: tmpDir });
    expect(file).not.toBeNull();
    ackCrashReport(file!);
    expect(readUnreadCrashReports(tmpDir)).toEqual([]);
  });

  it('returns reports oldest-first', async () => {
    writeCrashReport({ type: 'uncaughtException', error: 'first', baseDir: tmpDir });
    // tiny delay so timestamp differs
    await new Promise(r => setTimeout(r, 10));
    writeCrashReport({ type: 'uncaughtException', error: 'second', baseDir: tmpDir });
    const unread = readUnreadCrashReports(tmpDir);
    expect(unread.length).toBe(2);
    expect(unread[0].report.error).toBe('first');
    expect(unread[1].report.error).toBe('second');
  });

  it('drops corrupt dumps by acking them so they do not retrigger', () => {
    const dir = path.join(tmpDir, 'crash-reports');
    require('node:fs').mkdirSync(dir, { recursive: true });
    const corruptPath = path.join(dir, '2026-01-01T00-00-00Z-uncaughtException.json');
    require('node:fs').writeFileSync(corruptPath, '{not valid json');
    expect(readUnreadCrashReports(tmpDir)).toEqual([]);
    expect(existsSync(`${corruptPath}.ack`)).toBe(true);
  });
});

describe('formatCrashSummary', () => {
  it('produces a short single-line summary', () => {
    const report = buildCrashReport({
      type: 'uncaughtException',
      error: new Error('database connection lost'),
      uptime: 7325,
      pid: 12345,
      baseDir: tmpDir,
    });
    const summary = formatCrashSummary(report);
    expect(summary).toContain('uncaughtException');
    expect(summary).toContain('database connection lost');
    expect(summary).toContain('after');
    expect(summary.split('\n').length).toBe(1);
  });
});

describe('surfaceUnreadCrashReports', () => {
  it('sends one digest message and acks each report', async () => {
    writeCrashReport({ type: 'uncaughtException', error: 'a', baseDir: tmpDir });
    writeCrashReport({ type: 'unhandledRejection', error: 'b', baseDir: tmpDir });
    const send = vi.fn(async () => {});
    const count = await surfaceUnreadCrashReports(tmpDir, send);
    expect(count).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg).toContain('Recovered from 2 crash event');
    expect(msg).toContain('a');
    expect(msg).toContain('b');
    // All reports acked
    const dir = path.join(tmpDir, 'crash-reports');
    const remaining = readdirSync(dir).filter(f => f.endsWith('.json') && !readdirSync(dir).includes(`${f}.ack`));
    expect(remaining.every(f => existsSync(path.join(dir, `${f}.ack`)))).toBe(true);
  });

  it('returns 0 and sends nothing when no unread reports exist', async () => {
    const send = vi.fn(async () => {});
    const count = await surfaceUnreadCrashReports(tmpDir, send);
    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('captures recent log lines if a log file exists', () => {
    const logsDir = path.join(tmpDir, 'logs');
    require('node:fs').mkdirSync(logsDir, { recursive: true });
    const sample = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    require('node:fs').writeFileSync(path.join(logsDir, 'clementine.log'), sample);
    const file = writeCrashReport({ type: 'uncaughtException', error: 'x', baseDir: tmpDir });
    const parsed = JSON.parse(readFileSync(file!, 'utf-8'));
    expect(parsed.recentLogs.length).toBe(30);
    expect(parsed.recentLogs[parsed.recentLogs.length - 1]).toBe('line 49');
  });
});
