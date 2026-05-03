/**
 * Clementine TypeScript — proactive notification context.
 *
 * Scheduled jobs and proactive alerts can send useful messages outside the
 * active SDK chat session. This ledger lets the next vague reply ("fix this",
 * "what happened?", "do it") resolve to the notification the user is
 * responding to, even if a daemon restart or unrelated turn consumed the
 * pending chat context.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pino from 'pino';

import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.notification-context' });

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_TEXT_CHARS = 5000;
const MAX_CONTEXT_CHARS = 3200;
const MAX_LINES_TO_SCAN = 250;

export type ProactiveNotificationType =
  | 'cron_failure'
  | 'cron_sla'
  | 'heartbeat'
  | 'insight'
  | 'system';

export interface ProactiveNotificationEvent {
  id: string;
  type: ProactiveNotificationType;
  sessionKey?: string;
  title: string;
  summary: string;
  textPreview: string;
  jobNames?: string[];
  sentAt: string;
  expiresAt: string;
}

export interface ProactiveNotificationInput {
  type: ProactiveNotificationType;
  sessionKey?: string;
  title: string;
  summary?: string;
  text: string;
  jobNames?: string[];
  sentAt?: string;
  ttlMs?: number;
}

export interface NotificationContextOptions {
  baseDir?: string;
  now?: number;
}

function eventsFile(baseDir = BASE_DIR): string {
  return path.join(baseDir, 'notifications', 'events.jsonl');
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~>#:[\](){}.,!?]/g, ' ')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 10);
}

export function recordProactiveNotificationEvent(
  input: ProactiveNotificationInput,
  options: NotificationContextOptions = {},
): ProactiveNotificationEvent {
  const sentAt = input.sentAt ?? new Date(options.now ?? Date.now()).toISOString();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const summary = compactWhitespace(input.summary || input.text).slice(0, 1200);
  const event: ProactiveNotificationEvent = {
    id: `${input.type}-${shortHash(`${sentAt}:${input.sessionKey ?? 'broadcast'}:${input.title}:${randomUUID()}`)}`,
    type: input.type,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    title: input.title.slice(0, 160),
    summary,
    textPreview: input.text.slice(0, MAX_STORED_TEXT_CHARS),
    ...(input.jobNames?.length ? { jobNames: input.jobNames.slice(0, 20) } : {}),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + ttlMs).toISOString(),
  };

  try {
    const file = eventsFile(options.baseDir);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(event) + '\n');
  } catch (err) {
    logger.warn({ err, type: input.type }, 'Failed to persist proactive notification event');
  }

  return event;
}

function readRecentEvents(options: NotificationContextOptions = {}): ProactiveNotificationEvent[] {
  const file = eventsFile(options.baseDir);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_LINES_TO_SCAN);
    const events: ProactiveNotificationEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ProactiveNotificationEvent;
        if (parsed.id && parsed.type && parsed.sentAt) events.push(parsed);
      } catch { /* skip malformed */ }
    }
    return events;
  } catch {
    return [];
  }
}

function sessionMatches(eventSessionKey: string | undefined, sessionKey: string): boolean {
  if (!eventSessionKey) return false;
  return eventSessionKey === sessionKey
    || sessionKey.startsWith(eventSessionKey + ':')
    || eventSessionKey.startsWith(sessionKey + ':');
}

export function looksLikeNotificationFollowup(text: string): boolean {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;

  if (/^(fix|diagnose|repair|solve|handle|do|run with|go ahead|yes|yep|please do|lets do|let s do)\s+(this|that|it|the issue|the problem|the failure|the alert|the cron|that please|it please)$/.test(normalized)) {
    return true;
  }
  if (/^(how|what)\s+(do|would|should|can)\s+(we|you|i)?\s*(fix|repair|solve|handle|do)\s+(this|that|it|the issue|the problem|the failure|the alert|the cron)/.test(normalized)) {
    return true;
  }
  if (/^(what happened|what broke|why did this fail|why did that fail|what failed|show me the failure|look into this|look into that)/.test(normalized)) {
    return true;
  }
  return /\b(fix|diagnose|repair|solve|look into|what broke|what happened)\b.*\b(this|that|it|failure|alert|cron)\b/.test(normalized);
}

function mentionsEvent(text: string, event: ProactiveNotificationEvent): boolean {
  const normalizedText = normalizeForMatch(text);
  for (const jobName of event.jobNames ?? []) {
    const normalizedJob = normalizeForMatch(jobName);
    if (normalizedJob && normalizedText.includes(normalizedJob)) return true;
  }
  return false;
}

export function findRecentNotificationContext(
  sessionKey: string,
  text: string,
  options: NotificationContextOptions = {},
): ProactiveNotificationEvent | null {
  const now = options.now ?? Date.now();
  const vagueFollowup = looksLikeNotificationFollowup(text);
  const events = readRecentEvents(options)
    .filter((event) => sessionMatches(event.sessionKey, sessionKey))
    .filter((event) => {
      const expiresAt = Date.parse(event.expiresAt);
      if (Number.isFinite(expiresAt)) return expiresAt >= now;
      const sentAt = Date.parse(event.sentAt);
      return Number.isFinite(sentAt) && now - sentAt <= DEFAULT_TTL_MS;
    })
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));

  for (const event of events) {
    if (vagueFollowup || mentionsEvent(text, event)) return event;
  }
  return null;
}

export function buildNotificationContextPrompt(
  event: ProactiveNotificationEvent,
  userText: string,
): string {
  const jobs = event.jobNames?.length ? event.jobNames.join(', ') : 'none listed';
  const body = (event.summary || event.textPreview).slice(0, MAX_CONTEXT_CHARS);
  const guidance = event.jobNames && event.jobNames.length > 1
    ? 'If the user did not specify which job, either prioritize the most urgent failure from the notification or ask one concise clarifying question before taking irreversible action.'
    : 'Treat vague references like "this", "that", "it", and "do it" as referring to this notification.';

  return [
    '[Recent proactive notification context]',
    `Clementine sent this notification at ${event.sentAt}. The current user message is likely a reply to it.`,
    `Type: ${event.type}`,
    `Title: ${event.title}`,
    `Jobs: ${jobs}`,
    guidance,
    'For cron failures, prefer bounded diagnosis and config/prompt repair before executing the job.',
    '',
    'Notification summary:',
    body,
    '[/Recent proactive notification context]',
    '',
    userText,
  ].join('\n');
}
