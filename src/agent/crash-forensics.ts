/**
 * Crash forensics — capture context when something goes wrong so the next
 * launch can surface "I crashed at 2:14am because X" instead of leaving
 * the user wondering why their daemon went quiet.
 *
 * Two surfaces:
 *
 *   1. installCrashHandlers() wraps process.on('uncaughtException') and
 *      process.on('unhandledRejection') — when those fire, we write a
 *      timestamped JSON dump to ~/.clementine/crash-reports/. The existing
 *      handlers in index.ts keep the daemon alive (deliberate); the dump
 *      gives us a forensic trail without changing that behavior.
 *
 *   2. surfaceUnreadCrashReports(dispatcher) runs at startup, scans for
 *      report files that haven't been acknowledged, sends a one-line
 *      summary via the dispatcher, then renames them with a `.ack`
 *      suffix so they don't re-fire on the next launch.
 *
 * The dump shape is intentionally small (under ~10KB) so it survives even
 * when the underlying problem is "we ran out of memory."
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const logger = pino({ name: 'clementine.crash-forensics' });

/** How many lines of recent log to capture in the dump. */
const RECENT_LOG_LINES = 30;

export type CrashType = 'uncaughtException' | 'unhandledRejection';

export interface CrashReport {
  timestamp: string;
  type: CrashType;
  error: string;
  stack?: string;
  uptime: number;
  pid: number;
  recentLogs: string[];
}

function reportsDir(baseDir: string): string {
  return path.join(baseDir, 'crash-reports');
}

function logFilePath(baseDir: string): string {
  return path.join(baseDir, 'logs', 'clementine.log');
}

function readRecentLogLines(baseDir: string, n: number): string[] {
  try {
    const p = logFilePath(baseDir);
    if (!existsSync(p)) return [];
    const all = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    return all.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Build a crash report payload. Pure function — exported for testing.
 * Intentionally bounds the size of recentLogs so a runaway log file
 * doesn't make the dump unwriteable when the system is already wobbly.
 */
export function buildCrashReport(opts: {
  type: CrashType;
  error: unknown;
  uptime: number;
  pid: number;
  baseDir: string;
}): CrashReport {
  const err = opts.error;
  const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
  const stack = err instanceof Error ? err.stack : undefined;
  return {
    timestamp: new Date().toISOString(),
    type: opts.type,
    error: errorMsg.slice(0, 1000),
    stack: stack?.slice(0, 4000),
    uptime: opts.uptime,
    pid: opts.pid,
    recentLogs: readRecentLogLines(opts.baseDir, RECENT_LOG_LINES),
  };
}

/** Write a single crash report. Best-effort — never throws. */
export function writeCrashReport(opts: { type: CrashType; error: unknown; baseDir: string }): string | null {
  try {
    const dir = reportsDir(opts.baseDir);
    mkdirSync(dir, { recursive: true });
    const report = buildCrashReport({
      type: opts.type,
      error: opts.error,
      uptime: process.uptime(),
      pid: process.pid,
      baseDir: opts.baseDir,
    });
    // Keep millisecond precision so back-to-back crashes don't collide
    // on filename (was a real test failure — two writes within 10ms got
    // the same name and the second clobbered the first).
    const safeStamp = report.timestamp.replace(/[:.]/g, '-');
    const filename = path.join(dir, `${safeStamp}-${opts.type}.json`);
    writeFileSync(filename, JSON.stringify(report, null, 2), { mode: 0o600 });
    return filename;
  } catch (err) {
    // If we can't even write the dump, log to stderr — the daemon's logger
    // may itself be the thing that's failed.
    try { console.error('crash-forensics: failed to write report:', err); } catch { /* nothing to do */ }
    return null;
  }
}

/**
 * Wire the global handlers. Idempotent — calling twice is a no-op past
 * the first install. We DON'T exit the process here: the existing
 * uncaughtException handler in index.ts keeps the daemon alive on
 * purpose (segfaults / OOM still kill it; this is for soft errors
 * where execution can continue).
 */
let _installed = false;
export function installCrashHandlers(baseDir: string): void {
  if (_installed) return;
  _installed = true;

  process.on('uncaughtException', (err) => {
    const file = writeCrashReport({ type: 'uncaughtException', error: err, baseDir });
    if (file) logger.warn({ file }, 'Crash report written for uncaughtException');
  });

  process.on('unhandledRejection', (err) => {
    const file = writeCrashReport({ type: 'unhandledRejection', error: err, baseDir });
    if (file) logger.warn({ file }, 'Crash report written for unhandledRejection');
  });
}

/** Test seam — clear the install flag. */
export function _resetInstalledForTesting(): void {
  _installed = false;
}

/**
 * Read all unread crash reports (those without a `.ack` sibling),
 * sorted oldest-first. Returned shape is the parsed payload + the
 * source filename so the caller can ack it after surfacing.
 */
export function readUnreadCrashReports(baseDir: string): Array<{ report: CrashReport; file: string }> {
  const dir = reportsDir(baseDir);
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir);
  const ackedSet = new Set(all.filter(f => f.endsWith('.ack')).map(f => f.replace(/\.ack$/, '')));
  const unread = all
    .filter(f => f.endsWith('.json') && !ackedSet.has(f))
    .sort();
  const out: Array<{ report: CrashReport; file: string }> = [];
  for (const name of unread) {
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as CrashReport;
      out.push({ report: parsed, file: filePath });
    } catch {
      // Corrupt dump — ack it anyway so we don't keep tripping on it.
      ackCrashReport(filePath);
    }
  }
  return out;
}

/** Mark a crash report as acknowledged so it doesn't re-surface. */
export function ackCrashReport(file: string): void {
  try {
    renameSync(file, `${file}.ack`);
  } catch {
    // Non-fatal — worst case we surface it again next launch.
  }
}

/**
 * Format a single crash report as a one-line owner-readable summary.
 * Intentionally short — the full dump is on disk for deep debugging.
 */
export function formatCrashSummary(report: CrashReport): string {
  const stamp = report.timestamp.slice(0, 19).replace('T', ' ');
  const upHours = Math.floor(report.uptime / 3600);
  const upMin = Math.floor((report.uptime % 3600) / 60);
  const uptimeStr = upHours > 0 ? `${upHours}h${upMin}m` : `${upMin}m`;
  const errLine = report.error.split('\n')[0].slice(0, 220);
  return `${stamp} (after ${uptimeStr} uptime) — ${report.type}: ${errLine}`;
}

/**
 * Startup helper: scan for unread reports, send each as a chat
 * notification via the provided send function, then ack each one.
 * Send function is the dispatcher's `send` so we don't take a hard
 * dependency on the dispatcher type from this module.
 */
export async function surfaceUnreadCrashReports(
  baseDir: string,
  send: (msg: string) => Promise<void>,
): Promise<number> {
  const unread = readUnreadCrashReports(baseDir);
  if (unread.length === 0) return 0;

  // Group multiple reports into one digest message — one ping per launch
  // is enough; the file system has the per-event detail.
  const lines = unread.slice(0, 10).map(u => `• ${formatCrashSummary(u.report)}`);
  const overflow = unread.length > 10 ? `\n…and ${unread.length - 10} more in ${reportsDir(baseDir)}` : '';
  const dirHint = `\n\n_Full dumps: ${reportsDir(baseDir)}_`;
  const msg = `**Recovered from ${unread.length} crash event${unread.length === 1 ? '' : 's'} since last successful run.**\n\n${lines.join('\n')}${overflow}${dirHint}`;

  try {
    await send(msg);
  } catch (err) {
    logger.warn({ err }, 'Failed to dispatch crash-recovery summary');
  }

  for (const u of unread) ackCrashReport(u.file);
  return unread.length;
}
