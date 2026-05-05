/**
 * Structured context-event ledger.
 *
 * This is the durable surface ledger for operational context. Notifications,
 * background work, heartbeat state, and local diagnostics can all describe the
 * same issue; this file gives the gateway one place to collapse duplicates and
 * remember whether an event was already shown, acknowledged, or resolved.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';

import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.context-events' });

const MAX_LINES_TO_SCAN = 1200;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ContextEventSource =
  | 'notification'
  | 'background-task'
  | 'unleashed'
  | 'turn-ledger'
  | 'pending-context'
  | 'memory-correction';

export type ContextEventStatus =
  | 'active'
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'resolved'
  | 'stale'
  | 'unknown';

export type ContextEventSeverity = 'low' | 'normal' | 'warning' | 'urgent';

export interface ContextEvent {
  id: string;
  fingerprint: string;
  source: ContextEventSource;
  sourceId?: string;
  sessionKey?: string;
  title: string;
  summary: string;
  status: ContextEventStatus;
  severity: ContextEventSeverity;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  count: number;
  loggedAt?: string;
  surfacedAt?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  staleAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextEventInput {
  source: ContextEventSource;
  sourceId?: string;
  sessionKey?: string;
  title: string;
  summary: string;
  status?: ContextEventStatus;
  severity?: ContextEventSeverity;
  eventAt?: string;
  loggedAt?: string;
  surfacedAt?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  staleAt?: string;
  fingerprintParts?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextEventOptions {
  baseDir?: string;
  now?: number;
}

export interface ContextEventPatch {
  summary?: string;
  status?: ContextEventStatus;
  severity?: ContextEventSeverity;
  loggedAt?: string;
  surfacedAt?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  staleAt?: string;
  metadata?: Record<string, unknown>;
}

export function contextEventsPath(baseDir = BASE_DIR): string {
  return path.join(baseDir, 'context', 'events.jsonl');
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeForFingerprint(text: string): string {
  return compactWhitespace(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:._/-]+/gu, ' ')
    .trim();
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function eventTimestamp(options: ContextEventOptions, fallback?: string): string {
  if (fallback) return fallback;
  return new Date(options.now ?? Date.now()).toISOString();
}

function buildFingerprint(input: ContextEventInput): string {
  const parts = input.fingerprintParts?.length
    ? input.fingerprintParts
    : [
        input.sessionKey ?? 'broadcast',
        input.source,
        input.sourceId ?? '',
        input.title,
      ];
  return shortHash(parts.map((part) => normalizeForFingerprint(part)).join('|'));
}

function sessionMatches(eventSessionKey: string | undefined, sessionKey: string): boolean {
  if (!eventSessionKey) return false;
  return eventSessionKey === sessionKey
    || sessionKey.startsWith(eventSessionKey + ':')
    || eventSessionKey.startsWith(sessionKey + ':');
}

function readContextEvents(options: ContextEventOptions = {}): ContextEvent[] {
  const file = contextEventsPath(options.baseDir);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_LINES_TO_SCAN);
    const latest = new Map<string, ContextEvent>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ContextEvent;
        if (parsed.id && parsed.fingerprint && parsed.source) latest.set(parsed.id, parsed);
      } catch { /* skip malformed rows */ }
    }
    return [...latest.values()];
  } catch {
    return [];
  }
}

function appendContextEvent(event: ContextEvent, options: ContextEventOptions = {}): void {
  try {
    const file = contextEventsPath(options.baseDir);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(event) + '\n');
  } catch (err) {
    logger.warn({ err, eventId: event.id }, 'Failed to persist context event');
  }
}

export function recordContextEvent(
  input: ContextEventInput,
  options: ContextEventOptions = {},
): ContextEvent {
  const nowIso = eventTimestamp(options, input.eventAt);
  const fingerprint = buildFingerprint(input);
  const existing = readContextEvents(options).find((event) => event.fingerprint === fingerprint);
  const status = input.status ?? existing?.status ?? 'unknown';
  const summary = compactWhitespace(input.summary).slice(0, 1200);
  const title = compactWhitespace(input.title).slice(0, 200);
  const changed = !existing
    || existing.status !== status
    || existing.summary !== summary
    || existing.severity !== (input.severity ?? existing.severity);

  const event: ContextEvent = {
    id: existing?.id ?? `ctx-${fingerprint}`,
    fingerprint,
    source: input.source,
    ...(input.sourceId ? { sourceId: input.sourceId } : existing?.sourceId ? { sourceId: existing.sourceId } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : existing?.sessionKey ? { sessionKey: existing.sessionKey } : {}),
    title,
    summary,
    status,
    severity: input.severity ?? existing?.severity ?? 'normal',
    firstSeenAt: existing?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    lastChangedAt: changed ? nowIso : existing?.lastChangedAt ?? nowIso,
    count: (existing?.count ?? 0) + 1,
    ...(input.loggedAt ?? existing?.loggedAt ? { loggedAt: input.loggedAt ?? existing?.loggedAt } : {}),
    ...(input.surfacedAt ?? existing?.surfacedAt ? { surfacedAt: input.surfacedAt ?? existing?.surfacedAt } : {}),
    ...(input.acknowledgedAt ?? existing?.acknowledgedAt ? { acknowledgedAt: input.acknowledgedAt ?? existing?.acknowledgedAt } : {}),
    ...(input.resolvedAt ?? existing?.resolvedAt ? { resolvedAt: input.resolvedAt ?? existing?.resolvedAt } : {}),
    ...(input.staleAt ?? existing?.staleAt ? { staleAt: input.staleAt ?? existing?.staleAt } : {}),
    ...(input.metadata ?? existing?.metadata ? { metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) } } : {}),
  };

  appendContextEvent(event, options);
  return event;
}

export function listContextEvents(
  sessionKey: string,
  options: ContextEventOptions & { includeResolved?: boolean; limit?: number; windowMs?: number } = {},
): ContextEvent[] {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  return readContextEvents(options)
    .filter((event) => !event.sessionKey || sessionMatches(event.sessionKey, sessionKey))
    .filter((event) => options.includeResolved || (!event.resolvedAt && event.status !== 'resolved'))
    .filter((event) => {
      const lastSeen = Date.parse(event.lastSeenAt);
      return Number.isFinite(lastSeen) ? now - lastSeen <= windowMs : true;
    })
    .sort((a, b) => {
      const severityOrder: Record<ContextEventSeverity, number> = { urgent: 4, warning: 3, normal: 2, low: 1 };
      const severity = severityOrder[b.severity] - severityOrder[a.severity];
      if (severity !== 0) return severity;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    })
    .slice(0, Math.max(1, options.limit ?? 10));
}

export function updateContextEvent(
  id: string,
  patch: ContextEventPatch,
  options: ContextEventOptions = {},
): ContextEvent | null {
  const existing = readContextEvents(options).find((event) => event.id === id);
  if (!existing) return null;
  const nowIso = eventTimestamp(options);
  const next: ContextEvent = {
    ...existing,
    ...patch,
    metadata: patch.metadata ? { ...(existing.metadata ?? {}), ...patch.metadata } : existing.metadata,
    lastSeenAt: nowIso,
    lastChangedAt: nowIso,
  };
  appendContextEvent(next, options);
  return next;
}

export function markContextEventBySource(
  selector: { sessionKey?: string; source: ContextEventSource; sourceId?: string },
  patch: ContextEventPatch,
  options: ContextEventOptions = {},
): ContextEvent | null {
  const matches = readContextEvents(options)
    .filter((event) => event.source === selector.source)
    .filter((event) => !selector.sourceId || event.sourceId === selector.sourceId)
    .filter((event) => !selector.sessionKey || !event.sessionKey || sessionMatches(event.sessionKey, selector.sessionKey))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const event = matches[0];
  return event ? updateContextEvent(event.id, patch, options) : null;
}

