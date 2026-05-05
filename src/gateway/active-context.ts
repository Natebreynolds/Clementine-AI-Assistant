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
import { recordContextEvent, type ContextEventSeverity } from './context-events.js';

export interface ActiveContextItem {
  source: 'notification' | 'background-task' | 'unleashed' | 'turn-ledger' | 'commitment';
  label: string;
  detail: string;
  priority: number;
  timestamp?: string;
  eventId?: string;
  sourceId?: string;
  alreadyLogged?: boolean;
  alreadySurfaced?: boolean;
  acknowledged?: boolean;
  resolved?: boolean;
  greetingEligible?: boolean;
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
  recordEvents?: boolean;
  /**
   * Dense embedding coverage for transcripts. When < 50%, the prompt block
   * carries an inline note so the model knows recall is degraded.
   */
  transcriptCoverage?: { embedded: number; total: number };
  /**
   * Open commitments tied to this session (or owner-wide). Caller looks
   * these up via store.listCommitments and threads them through so
   * active-context.ts stays free of the store dependency.
   */
  openCommitments?: Array<{
    id: number;
    owner: 'user' | 'clementine';
    text: string;
    dueAt: string | null;
    dueHint: string | null;
    sessionKey: string | null;
  }>;
}

const RECENT_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_UNLEASHED_ERROR_TTL_MS = 12 * 60 * 60 * 1000;
const FRESH_ACTIVE_TASK_GREETING_TTL_MS = 20 * 60 * 1000;
const MAX_DETAIL_CHARS = 220;

interface SurfaceHistory {
  entries: TurnLedgerEntry[];
  loggedText: string;
  surfacedText: string;
}

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

function normalizeForSurface(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSurfaceHistory(sessionKey: string, opts: ActiveContextOptions): SurfaceHistory {
  let entries: TurnLedgerEntry[] = [];
  try {
    entries = readRecentTurnLedger(sessionKey, 12, opts.baseDir);
  } catch {
    entries = [];
  }

  const loggedText = entries
    .map((entry) => [
      entry.userMessagePreview,
      entry.responsePreview ?? '',
      entry.errorPreview ?? '',
    ].join(' '))
    .join(' ');
  const surfacedText = entries
    .map((entry) => [
      entry.responsePreview ?? '',
      entry.errorPreview ?? '',
    ].join(' '))
    .join(' ');

  return {
    entries,
    loggedText: normalizeForSurface(loggedText),
    surfacedText: normalizeForSurface(surfacedText),
  };
}

function mentionsAny(haystack: string, needles: Array<string | undefined>): boolean {
  if (!haystack) return false;
  return needles.some((needle) => {
    const normalized = normalizeForSurface(needle ?? '');
    return normalized.length >= 4 && haystack.includes(normalized);
  });
}

function taskAgeMs(task: BackgroundTask, now: number): number {
  const ms = timestampMs(task.completedAt ?? task.startedAt ?? task.createdAt);
  return ms > 0 ? now - ms : Number.POSITIVE_INFINITY;
}

function taskMatchesSession(task: BackgroundTask, sessionKey: string): boolean {
  return task.sessionKey === sessionKey;
}

function maybeRecordContextEvent(
  opts: ActiveContextOptions,
  input: Parameters<typeof recordContextEvent>[0],
): ReturnType<typeof recordContextEvent> | null {
  if (opts.recordEvents === false) return null;
  return recordContextEvent(input, { baseDir: opts.baseDir, now: opts.now });
}

function backgroundTaskItems(sessionKey: string, opts: ActiveContextOptions, surfaceHistory: SurfaceHistory): ActiveContextItem[] {
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
      const ageMs = taskAgeMs(task, now);
      const detail = failed
        ? `Failed: ${cap(task.error ?? task.prompt)}`
        : task.status === 'done'
          ? `Done: ${cap(task.result ?? task.prompt)}`
          : cap(task.prompt);
      const terminalPriority = failed ? (blocker ? 65 : 60) : 30;
      const severity: ContextEventSeverity = blocker ? 'urgent' : failed ? 'warning' : active ? 'normal' : 'low';
      const eventAt = task.completedAt ?? task.startedAt ?? task.createdAt;
      const event = maybeRecordContextEvent(opts, {
        source: 'background-task',
        sourceId: task.id,
        sessionKey,
        title: `${task.id} ${task.status}`,
        summary: detail,
        status: task.status,
        severity,
        eventAt,
        loggedAt: eventAt,
        ...(task.status === 'done' ? { resolvedAt: task.completedAt ?? eventAt } : {}),
        fingerprintParts: [sessionKey, 'background-task', task.id],
        metadata: { fromAgent: task.fromAgent },
      });
      const alreadyLogged = Boolean(event?.loggedAt) || mentionsAny(surfaceHistory.loggedText, [task.id]);
      const alreadySurfaced = Boolean(event?.surfacedAt) || mentionsAny(surfaceHistory.surfacedText, [task.id]);
      return {
        source: 'background-task',
        label: `${task.id} ${task.status}`,
        detail,
        priority: active ? (blocker ? 85 : 78) : terminalPriority,
        timestamp: eventAt,
        eventId: event?.id,
        sourceId: task.id,
        alreadyLogged,
        alreadySurfaced,
        acknowledged: Boolean(event?.acknowledgedAt),
        resolved: Boolean(event?.resolvedAt),
        greetingEligible: active
          && !alreadySurfaced
          && ageMs <= FRESH_ACTIVE_TASK_GREETING_TTL_MS,
      };
    });
}

function notificationItems(sessionKey: string, opts: ActiveContextOptions): ActiveContextItem[] {
  return listRecentNotificationEvents(sessionKey, { baseDir: opts.baseDir, now: opts.now }, 5)
    .map((event) => {
      const jobs = event.jobNames?.length ? ` (${event.jobNames.join(', ')})` : '';
      const body = `${event.summary} ${event.textPreview}`;
      const noisyOrRecovered = /\b0\/0 recent runs failed\b/i.test(body)
        || /\b(no active failures|has recovered|fully recovered|running healthy|no fix needed)\b/i.test(body);
      const basePriority = event.type === 'cron_failure' ? 72 : event.type === 'cron_sla' ? 65 : 40;
      const contextEvent = maybeRecordContextEvent(opts, {
        source: 'notification',
        sourceId: event.id,
        sessionKey: event.sessionKey ?? sessionKey,
        title: `${event.type}: ${event.title}${jobs}`,
        summary: event.summary || event.textPreview,
        status: event.type === 'cron_failure' ? 'failed' : 'active',
        severity: noisyOrRecovered ? 'low' : event.type === 'cron_failure' ? 'warning' : 'normal',
        eventAt: event.sentAt,
        loggedAt: event.sentAt,
        surfacedAt: event.sentAt,
        fingerprintParts: [
          event.sessionKey ?? sessionKey,
          'notification',
          event.type,
          event.jobNames?.join(',') ?? event.title,
          event.summary || event.textPreview,
        ],
        metadata: { notificationId: event.id, jobNames: event.jobNames ?? [] },
      });
      return {
        source: 'notification',
        label: `${event.type}: ${event.title}${jobs}`,
        detail: cap(event.summary || event.textPreview),
        priority: noisyOrRecovered ? Math.min(basePriority, 30) : basePriority,
        timestamp: event.sentAt,
        eventId: contextEvent?.id,
        sourceId: event.id,
        alreadyLogged: true,
        alreadySurfaced: true,
        acknowledged: Boolean(contextEvent?.acknowledgedAt),
        resolved: Boolean(contextEvent?.resolvedAt),
        greetingEligible: false,
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

function unleashedItems(opts: ActiveContextOptions, surfaceHistory: SurfaceHistory): ActiveContextItem[] {
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
    const liveWork = live && rawStatus !== 'error';
    const label = `${name} ${rawStatus}${phase}`;
    const detail = live ? 'Active long-running work.' : 'Recent long-running job error.';
    const contextEvent = maybeRecordContextEvent(opts, {
      source: 'unleashed',
      sourceId: name,
      title: label,
      summary: detail,
      status: rawStatus === 'error' ? 'failed' : liveWork ? 'running' : 'unknown',
      severity: rawStatus === 'error' ? 'warning' : 'normal',
      eventAt: updatedAt || new Date(now).toISOString(),
      loggedAt: updatedAt || new Date(now).toISOString(),
      fingerprintParts: ['unleashed', name],
      metadata: { phase: status.phase ?? null },
    });
    const alreadyLogged = Boolean(contextEvent?.loggedAt) || mentionsAny(surfaceHistory.loggedText, [name]);
    const alreadySurfaced = Boolean(contextEvent?.surfacedAt) || mentionsAny(surfaceHistory.surfacedText, [name]);
    out.push({
      source: 'unleashed',
      label,
      detail,
      priority: rawStatus === 'error' ? 62 : 70,
      timestamp: updatedAt,
      eventId: contextEvent?.id,
      sourceId: name,
      alreadyLogged,
      alreadySurfaced,
      acknowledged: Boolean(contextEvent?.acknowledgedAt),
      resolved: Boolean(contextEvent?.resolvedAt),
      greetingEligible: liveWork && !alreadySurfaced,
    });
  }

  return out;
}

function turnLedgerItems(surfaceHistory: SurfaceHistory): ActiveContextItem[] {
  return surfaceHistory.entries
    .filter((entry) => entry.deliveryStatus === 'failed' || entry.actionExpected || entry.toolCallsMade > 0)
    .slice(0, 2)
    .map((entry) => ({
      source: 'turn-ledger',
      label: `recent turn ${entry.deliveryStatus}`,
      detail: cap(entry.responsePreview || entry.errorPreview || entry.userMessagePreview),
      priority: entry.deliveryStatus === 'failed' ? 60 : entry.actionExpected ? 45 : 25,
      timestamp: entry.createdAt,
      alreadyLogged: true,
      alreadySurfaced: true,
      acknowledged: true,
      greetingEligible: false,
    }));
}

function commitmentItems(opts: ActiveContextOptions): ActiveContextItem[] {
  const list = opts.openCommitments ?? [];
  if (list.length === 0) return [];
  const nowMs = opts.now ?? Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  return list.slice(0, 10).map((c) => {
    const dueMs = c.dueAt ? Date.parse(c.dueAt) : NaN;
    const overdue = Number.isFinite(dueMs) && dueMs < nowMs;
    const dueWithin24 = Number.isFinite(dueMs) && dueMs >= nowMs && dueMs - nowMs <= dayMs;
    let priority = 60;
    if (overdue) priority = 90;
    else if (dueWithin24) priority = 80;
    else if (c.dueHint) priority = 70;
    const ownerLabel = c.owner === 'clementine' ? 'I committed' : 'You committed';
    const dueLabel = overdue ? ' (overdue)' : dueWithin24 ? ' (due within 24h)' : c.dueHint ? ` (${c.dueHint})` : '';
    return {
      source: 'commitment',
      label: `${ownerLabel}${dueLabel}`,
      detail: cap(c.text),
      priority,
      timestamp: c.dueAt ?? undefined,
      sourceId: `commitment:${c.id}`,
      greetingEligible: overdue || dueWithin24,
    };
  });
}

function formatPromptBlock(
  items: ActiveContextItem[],
  coverage?: { embedded: number; total: number },
): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => {
    const tags = [
      item.greetingEligible ? 'fresh' : 'context only',
      item.alreadySurfaced ? 'already surfaced' : null,
      item.alreadyLogged ? 'logged' : null,
      item.acknowledged ? 'acknowledged' : null,
      item.resolved ? 'resolved' : null,
    ].filter(Boolean).join(', ');
    const id = item.eventId ? ` id=${item.eventId}` : '';
    return `- ${item.source}${id}: ${item.label}${tags ? ` (${tags})` : ''} — ${item.detail}`;
  });
  const coverageNote =
    coverage && coverage.total > 0 && coverage.embedded / coverage.total < 0.5
      ? `Recall note: memory partially indexed (${coverage.embedded.toLocaleString()} of ${coverage.total.toLocaleString()} turns embedded). Paraphrased recall may miss; lexical recall still works.`
      : null;
  return [
    '[Context governance: active working set]',
    'REFERENCE ONLY — recalled operational context, not new user input.',
    'Use this before deciding whether a vague/casual turn is new work, a follow-up, or a status request.',
    'Context-only, logged, acknowledged, resolved, or already-surfaced items are memory anchors for explicit follow-ups. Do not repeat heartbeat/alert details on greetings or casual small talk unless the user asks for status, a fix, or what changed.',
    ...(coverageNote ? [coverageNote] : []),
    ...lines,
    '[/Context governance: active working set]',
  ].join('\n');
}

function formatGreetingLine(items: ActiveContextItem[]): string | null {
  const top = items.find((item) => item.greetingEligible && item.priority >= 75);
  if (!top) return null;
  return `Hey. I am here. Still working on ${top.label}: ${top.detail}`;
}

export function buildActiveContextSnapshot(
  sessionKey: string,
  opts: ActiveContextOptions,
): ActiveContextSnapshot {
  const maxItems = Math.max(1, opts.maxItems ?? 6);
  const surfaceHistory = buildSurfaceHistory(sessionKey, opts);
  const items = [
    ...backgroundTaskItems(sessionKey, opts, surfaceHistory),
    ...notificationItems(sessionKey, opts),
    ...unleashedItems(opts, surfaceHistory),
    ...turnLedgerItems(surfaceHistory),
    ...commitmentItems(opts),
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
    promptBlock: formatPromptBlock(items, opts.transcriptCoverage),
    greetingLine: formatGreetingLine(items),
  };
}
