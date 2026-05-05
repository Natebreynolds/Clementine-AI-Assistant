/**
 * Recent operational context resolver.
 *
 * This sits above long-term memory: fresh notifications, background tasks, and
 * cron state are deterministic context that should resolve vague follow-ups
 * before Clementine decides to use tools or deep mode.
 */

import type { BackgroundTask } from '../types.js';
import path from 'node:path';
import { listBackgroundTasks } from '../agent/background-tasks.js';
import {
  buildNotificationContextPrompt,
  findRecentNotificationContext,
  looksLikeNotificationFollowup,
  type ProactiveNotificationEvent,
} from './notification-context.js';
import {
  buildCronDiagnosticResponseForRequest,
  detectCronDiagnosticRequest,
  isInternalSyntheticPrompt,
} from './cron-diagnostic-turn.js';

export { isInternalSyntheticPrompt } from './cron-diagnostic-turn.js';

export interface RecentOperationalContext {
  source: 'notification' | 'background-task';
  reason: string;
  promptText?: string;
  responseText?: string;
  suppressDeepMode: boolean;
  eventId?: string;
  jobNames?: string[];
  taskId?: string;
}

export interface RecentOperationalContextOptions {
  baseDir: string;
  now?: number;
}

const RECENT_TASK_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~>#:[\](){}.,!?]/g, ' ')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function wantsFix(text: string): boolean {
  return /\b(fix|repair|solve|handle|diagnose|debug|what broke|what happened|why did|why is|issue|problem|failure|failed|failing)\b/i.test(text);
}

function jobMentionedInText(jobName: string, text: string): boolean {
  const normalizedText = normalizeForMatch(text);
  const normalizedJob = normalizeForMatch(jobName);
  return !!normalizedJob && normalizedText.includes(normalizedJob);
}

function resolveNotificationJob(event: ProactiveNotificationEvent, userText: string, baseDir: string): string | null {
  const explicit = detectCronDiagnosticRequest(userText, { baseDir });
  if (explicit?.jobName) return explicit.jobName;

  const jobs = event.jobNames ?? [];
  if (jobs.length === 1) return jobs[0] ?? null;

  const mentioned = jobs.find((job) => jobMentionedInText(job, userText));
  return mentioned ?? null;
}

function summarizeCronNotification(event: ProactiveNotificationEvent, userText: string, opts: RecentOperationalContextOptions): string | null {
  const jobs = event.jobNames ?? [];
  if (jobs.length === 0) return null;

  const targetJob = resolveNotificationJob(event, userText, opts.baseDir);
  if (targetJob) {
    return buildCronDiagnosticResponseForRequest(
      { jobName: targetJob, wantsFix: wantsFix(userText) },
      { baseDir: opts.baseDir },
    );
  }

  const lines: string[] = [
    `I am resolving this to the recent cron failure alert: ${jobs.join(', ')}.`,
    'More than one job was in that alert, so I am not going to guess or start background work.',
    '',
  ];

  for (const job of jobs.slice(0, 5)) {
    const diagnostic = buildCronDiagnosticResponseForRequest(
      { jobName: job, wantsFix: false },
      { baseDir: opts.baseDir },
    );
    const preview = diagnostic
      ? diagnostic.split('\n').slice(1, 4).join(' ')
      : 'No local diagnostic summary available.';
    lines.push(`- ${job}: ${compactWhitespace(preview).slice(0, 260)}`);
  }

  lines.push('');
  lines.push(`Reply \`fix ${jobs[0]}\` or name the job you want me to repair first.`);
  return lines.join('\n');
}

function taskMatchesSession(task: BackgroundTask, sessionKey: string): boolean {
  return task.sessionKey === sessionKey;
}

function taskAgeMs(task: BackgroundTask, now: number): number {
  const timestamp = Date.parse(task.completedAt ?? task.startedAt ?? task.createdAt);
  return Number.isFinite(timestamp) ? now - timestamp : Number.POSITIVE_INFINITY;
}

function overlapScore(userText: string, candidate: string): number {
  const userTerms = new Set(normalizeForMatch(userText).split(' ').filter((term) => term.length >= 4));
  if (userTerms.size === 0) return 0;
  const candidateTerms = new Set(normalizeForMatch(candidate).split(' ').filter((term) => term.length >= 4));
  let score = 0;
  for (const term of userTerms) {
    if (candidateTerms.has(term)) score += 4;
  }
  return score;
}

function scoreBackgroundTask(task: BackgroundTask, text: string, now: number): number {
  let score = 0;
  const normalizedText = normalizeForMatch(text);
  if (normalizedText.includes(normalizeForMatch(task.id))) score += 100;
  if (task.status === 'failed' || task.status === 'aborted') score += 25;
  if (task.status === 'pending' || task.status === 'running') score += 18;
  if (/usage limit|billing|credit balance|monthly usage/i.test(task.error ?? '')) score += 12;
  score += overlapScore(text, `${task.prompt} ${task.result ?? ''} ${task.error ?? ''}`);
  const age = taskAgeMs(task, now);
  if (Number.isFinite(age)) score += Math.max(0, 12 - Math.floor(age / (60 * 60 * 1000)));
  return score;
}

function formatBackgroundTaskResponse(task: BackgroundTask): string {
  const label = `${task.id} (${task.status})`;
  const summary = compactWhitespace(task.prompt).slice(0, 180);
  const lines = [`I am resolving this to background task ${label}.`, `Task: ${summary}`];

  if (task.status === 'pending' || task.status === 'running') {
    lines.push('It is still active. Reply `status` for the live task view or `cancel` to stop it.');
  } else if (task.status === 'done') {
    lines.push(`Result: ${compactWhitespace(task.result ?? 'completed with no saved result').slice(0, 600)}`);
  } else {
    lines.push(`Failure: ${compactWhitespace(task.error ?? 'no failure details were saved').slice(0, 600)}`);
    if (/usage limit|billing|credit balance|monthly usage/i.test(task.error ?? '')) {
      lines.push('This is a provider/billing blocker. Retrying diagnostics that require Claude will fail until the account limit is cleared.');
    }
  }

  return lines.join('\n');
}

function resolveRecentBackgroundTask(
  sessionKey: string,
  text: string,
  opts: RecentOperationalContextOptions,
): RecentOperationalContext | null {
  if (!looksLikeNotificationFollowup(text)) return null;

  const now = opts.now ?? Date.now();
  const tasks = listBackgroundTasks({}, { dir: path.join(opts.baseDir, 'background-tasks') })
    .filter((task) => taskMatchesSession(task, sessionKey))
    .filter((task) => taskAgeMs(task, now) <= RECENT_TASK_TTL_MS)
    .sort((a, b) => {
      const score = scoreBackgroundTask(b, text, now) - scoreBackgroundTask(a, text, now);
      if (score !== 0) return score;
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    });

  const task = tasks[0];
  if (!task) return null;

  return {
    source: 'background-task',
    reason: 'vague-followup-to-recent-background-task',
    responseText: formatBackgroundTaskResponse(task),
    suppressDeepMode: true,
    taskId: task.id,
  };
}

export function resolveRecentOperationalContext(
  sessionKey: string,
  text: string,
  opts: RecentOperationalContextOptions,
): RecentOperationalContext | null {
  if (isInternalSyntheticPrompt(text)) return null;

  const explicitCronRequest = detectCronDiagnosticRequest(text, { baseDir: opts.baseDir });
  const notification = findRecentNotificationContext(sessionKey, text, {
    baseDir: opts.baseDir,
    now: opts.now,
  });

  if (notification) {
    if (notification.type === 'cron_failure') {
      const responseText = summarizeCronNotification(notification, text, opts);
      if (responseText) {
        return {
          source: 'notification',
          reason: 'vague-followup-to-cron-failure-notification',
          responseText,
          suppressDeepMode: true,
          eventId: notification.id,
          jobNames: notification.jobNames,
        };
      }
    }

    return {
      source: 'notification',
      reason: 'vague-followup-to-proactive-notification',
      promptText: buildNotificationContextPrompt(notification, text),
      suppressDeepMode: true,
      eventId: notification.id,
      jobNames: notification.jobNames,
    };
  }

  if (!explicitCronRequest) {
    const background = resolveRecentBackgroundTask(sessionKey, text, opts);
    if (background) return background;
  }

  return explicitCronRequest ? null : resolveRecentBackgroundTask(sessionKey, text, opts);
}
