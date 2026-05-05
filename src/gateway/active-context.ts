/**
 * Active working set context.
 *
 * This is the short-lived "what matters right now" layer above semantic
 * memory. It is deliberately bounded and deterministic so every channel can
 * stay aware of active operational state without dragging full transcripts or
 * run logs into the model.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { listBackgroundTasks } from '../agent/background-tasks.js';
import type { BackgroundTask } from '../types.js';
import { listRecentNotificationEvents } from './notification-context.js';
import { readRecentTurnLedger, type TurnLedgerEntry } from './turn-ledger.js';
import { isLiveUnleashedStatus } from './unleashed-status.js';

export interface ActiveContextItem {
  source: 'notification' | 'background-task' | 'unleashed' | 'turn-ledger';
  label: string;
  detail: string;
  priority: number;
  timestamp?: string;
}

export interface ActiveContextSnapshot {
  sessionKey: string;
  items: ActiveContextItem[];
  promptBlock: string | null;
  greetingLine: string | null;
}

export interface ActiveContextOptions {
  baseDir: string;
  now?: number;
  maxItems?: number;
}

const RECENT_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_UNLEASHED_ERROR_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_DETAIL_CHARS = 220;

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cap(text: string, max = MAX_DETAIL_CHARS): string {
  const normalized = compactWhitespace(text);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function timestampMs(value: string | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function taskAgeMs(task: BackgroundTask, now: number): number {
  const ms = timestampMs(task.completedAt ?? task.startedAt ?? task.createdAt);
  return ms > 0 ? now - ms : Number.POSITIVE_INFINITY;
}

function taskMatchesSession(task: BackgroundTask, sessionKey: string): boolean {
  return task.sessionKey === sessionKey;
}

function backgroundTaskItems(sessionKey: string, opts: ActiveContextOptions): ActiveContextItem[] {
  const now = opts.now ?? Date.now();
  const dir = path.join(opts.baseDir, 'background-tasks');
  return listBackgroundTasks({}, { dir })
    .filter((task) => taskMatchesSession(task, sessionKey))
    .filter((task) => task.status === 'pending' || task.status === 'running' || taskAgeMs(task, now) <= RECENT_TASK_TTL_MS)
    .slice(0, 5)
    .map((task) => {
      const active = task.status === 'pending' || task.status === 'running';
      const failed = task.status === 'failed' || task.status === 'aborted';
      const blocker = /usage limit|billing|credit balance|monthly usage|auth/i.test(task.error ?? '');
      const detail = failed
        ? `Failed: ${cap(task.error ?? task.prompt)}`
        : task.status === 'done'
          ? `Done: ${cap(task.result ?? task.prompt)}`
          : cap(task.prompt);
      return {
        source: 'background-task',
        label: `${task.id} ${task.status}`,
        detail,
        priority: blocker ? 100 : failed ? 90 : active ? 80 : 35,
        timestamp: task.completedAt ?? task.startedAt ?? task.createdAt,
      };
    });
}

function notificationItems(sessionKey: string, opts: ActiveContextOptions): ActiveContextItem[] {
  return listRecentNotificationEvents(sessionKey, { baseDir: opts.baseDir, now: opts.now }, 5)
    .map((event) => {
      const jobs = event.jobNames?.length ? ` (${event.jobNames.join(', ')})` : '';
      const priority = event.type === 'cron_failure' ? 85 : event.type === 'cron_sla' ? 75 : 45;
      return {
        source: 'notification',
        label: `${event.type}: ${event.title}${jobs}`,
        detail: cap(event.summary || event.textPreview),
        priority,
        timestamp: event.sentAt,
      };
    });
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unleashedItems(opts: ActiveContextOptions): ActiveContextItem[] {
  const now = opts.now ?? Date.now();
  const dir = path.join(opts.baseDir, 'unleashed');
  if (!existsSync(dir)) return [];

  const out: ActiveContextItem[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((name) => {
        try { return statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }

  for (const name of names) {
    const status = readJsonFile(path.join(dir, name, 'status.json'));
    if (!status) continue;

    const rawStatus = String(status.status ?? 'running');
    const updatedAt = String(status.updatedAt ?? status.finishedAt ?? status.startedAt ?? '');
    const updatedMs = timestampMs(updatedAt);
    const live = isLiveUnleashedStatus(status, now);
    const recentError = rawStatus === 'error' && updatedMs > 0 && now - updatedMs <= RECENT_UNLEASHED_ERROR_TTL_MS;
    if (!live && !recentError) continue;

    const phase = status.phase == null ? '' : ` phase ${String(status.phase)}`;
    out.push({
      source: 'unleashed',
      label: `${name} ${rawStatus}${phase}`,
      detail: live ? 'Active long-running work.' : 'Recent long-running job error.',
      priority: rawStatus === 'error' ? 88 : 70,
      timestamp: updatedAt,
    });
  }

  return out;
}

function turnLedgerItems(sessionKey: string, opts: ActiveContextOptions): ActiveContextItem[] {
  let entries: TurnLedgerEntry[] = [];
  try {
    entries = readRecentTurnLedger(sessionKey, 4, opts.baseDir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.deliveryStatus === 'failed' || entry.actionExpected || entry.toolCallsMade > 0)
    .slice(0, 2)
    .map((entry) => ({
      source: 'turn-ledger',
      label: `recent turn ${entry.deliveryStatus}`,
      detail: cap(entry.responsePreview || entry.errorPreview || entry.userMessagePreview),
      priority: entry.deliveryStatus === 'failed' ? 60 : entry.actionExpected ? 45 : 25,
      timestamp: entry.createdAt,
    }));
}

function formatPromptBlock(items: ActiveContextItem[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => `- ${item.source}: ${item.label} — ${item.detail}`);
  return [
    '[Active working set]',
    'Fresh operational context for this chat. Use this before deciding whether a vague/casual turn is new work, a follow-up, or a status request. Do not dump it unless it directly helps the user.',
    ...lines,
    '[/Active working set]',
  ].join('\n');
}

function formatGreetingLine(items: ActiveContextItem[]): string | null {
  const top = items.find((item) => item.priority >= 70);
  if (!top) return null;
  return `Hey. Main thing right now: ${top.label} — ${top.detail}`;
}

export function buildActiveContextSnapshot(
  sessionKey: string,
  opts: ActiveContextOptions,
): ActiveContextSnapshot {
  const maxItems = Math.max(1, opts.maxItems ?? 6);
  const items = [
    ...backgroundTaskItems(sessionKey, opts),
    ...notificationItems(sessionKey, opts),
    ...unleashedItems(opts),
    ...turnLedgerItems(sessionKey, opts),
  ]
    .sort((a, b) => {
      const priority = b.priority - a.priority;
      if (priority !== 0) return priority;
      return timestampMs(b.timestamp) - timestampMs(a.timestamp);
    })
    .slice(0, maxItems);

  return {
    sessionKey,
    items,
    promptBlock: formatPromptBlock(items),
    greetingLine: formatGreetingLine(items),
  };
}
