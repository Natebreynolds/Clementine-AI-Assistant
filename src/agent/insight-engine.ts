/**
 * Clementine TypeScript — Insight Engine.
 *
 * Proactive conversation initiation: runs during heartbeat ticks to
 * identify events or patterns the user should know about. Generates
 * urgency-rated insights and dispatches via NotificationDispatcher.
 *
 * Throttling: max 3 proactive messages per day, minimum 2-hour cooldown.
 * Adapts based on user acknowledgment (doubles cooldown after 3 ignored).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { GOALS_DIR, BASE_DIR, MEMORY_DB_PATH, VAULT_DIR } from '../config.js';
import { listAllGoals } from '../tools/shared.js';
import { computeBrokenJobs } from '../gateway/failure-monitor.js';
import { MemoryStore } from '../memory/store.js';

const logger = pino({ name: 'clementine.insight-engine' });

export interface InsightResult {
  message: string;
  urgency: number;     // 1-5: 1=trivial, 3=informational, 4=important, 5=critical
  source: string;      // what generated the insight
}

export interface InsightState {
  /** ISO timestamps of proactive messages sent today */
  sentToday: string[];
  /** ISO timestamp of last proactive message */
  lastSentAt?: string;
  /** Count of consecutive unacknowledged proactive messages */
  unackedCount: number;
  /** Adaptive cooldown multiplier (starts at 1, doubles on ignores) */
  cooldownMultiplier: number;
  /** Date string (YYYY-MM-DD) for resetting daily count */
  currentDate?: string;
}

const BASE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_DAILY_INSIGHTS = 3;
const UNACKED_THRESHOLD = 3; // double cooldown after this many ignored

/**
 * Check if it's too soon to send another proactive message.
 */
export function canSendInsight(state: InsightState): boolean {
  const today = new Date().toISOString().slice(0, 10);

  // Reset daily count on new day
  if (state.currentDate !== today) {
    state.sentToday = [];
    state.currentDate = today;
    // Don't reset cooldownMultiplier — that persists across days
  }

  // Daily limit
  if (state.sentToday.length >= MAX_DAILY_INSIGHTS) {
    return false;
  }

  // Cooldown check
  if (state.lastSentAt) {
    const elapsed = Date.now() - new Date(state.lastSentAt).getTime();
    const cooldown = BASE_COOLDOWN_MS * state.cooldownMultiplier;
    if (elapsed < cooldown) {
      return false;
    }
  }

  return true;
}

/**
 * Record that a proactive message was sent.
 */
export function recordInsightSent(state: InsightState): void {
  const now = new Date().toISOString();
  state.sentToday.push(now);
  state.lastSentAt = now;
  state.unackedCount++;
}

/**
 * Record that the user acknowledged a proactive message (replied to it).
 * Resets the unacked counter and lowers cooldown.
 */
export function recordInsightAcked(state: InsightState): void {
  state.unackedCount = 0;
  state.cooldownMultiplier = 1;
}

/**
 * Check if cooldown should be increased due to ignored messages.
 */
export function maybeIncreaseCooldown(state: InsightState): void {
  if (state.unackedCount >= UNACKED_THRESHOLD) {
    state.cooldownMultiplier = Math.min(state.cooldownMultiplier * 2, 8); // cap at 16 hours
    state.unackedCount = 0; // reset counter after adjustment
    logger.info({ multiplier: state.cooldownMultiplier }, 'Proactive message cooldown increased — messages going unacknowledged');
  }
}

/**
 * Gather raw signals for insight generation (no LLM call — pure data).
 * Returns structured event summaries that can be passed to an LLM for urgency rating.
 */
export function gatherInsightSignals(gateway: {
  getRecentActivity: (since: string) => Array<{ sessionKey: string; role: string; content: string; createdAt: string }>;
}): string[] {
  const signals: string[] = [];
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // 1. Check for goal progress/failures
  try {
    const progressDir = path.join(GOALS_DIR, 'progress');
    if (existsSync(progressDir)) {
      const files = readdirSync(progressDir).filter(f => f.endsWith('.progress.jsonl'));
      for (const file of files.slice(0, 5)) {
        const lines = readFileSync(path.join(progressDir, file), 'utf-8').trim().split('\n').filter(Boolean);
        const recent = lines.slice(-3);
        for (const line of recent) {
          try {
            const entry = JSON.parse(line);
            if (new Date(entry.timestamp) > new Date(twoHoursAgo)) {
              if (entry.status === 'error') {
                signals.push(`Goal work session failed: ${entry.focus} (${entry.resultSnippet?.slice(0, 100)})`);
              } else if (entry.status === 'progress') {
                signals.push(`Goal progress: ${entry.focus}`);
              }
            }
          } catch { continue; }
        }
      }
    }
  } catch { /* non-fatal */ }

  // 2. Check for cron job failures
  try {
    const runLogDir = path.join(BASE_DIR, 'cron', 'run-log');
    if (existsSync(runLogDir)) {
      const logFiles = readdirSync(runLogDir).filter(f => f.endsWith('.jsonl')).slice(0, 10);
      for (const file of logFiles) {
        const lines = readFileSync(path.join(runLogDir, file), 'utf-8').trim().split('\n').filter(Boolean);
        const lastLine = lines[lines.length - 1];
        if (!lastLine) continue;
        try {
          const entry = JSON.parse(lastLine);
          if (new Date(entry.timestamp) > new Date(twoHoursAgo) && entry.status === 'error') {
            signals.push(`Cron job "${entry.jobName || file.replace('.jsonl', '')}" failed: ${(entry.error || '').slice(0, 100)}`);
          }
        } catch { continue; }
      }
    }
  } catch { /* non-fatal */ }

  // 3. Check recent activity for patterns worth surfacing
  try {
    const activity = gateway.getRecentActivity(twoHoursAgo);
    const sessionCount = new Set(activity.map(a => a.sessionKey)).size;
    if (sessionCount === 0) {
      // No recent activity — could note quiet period if there are pending goals
      try {
        const activeHighPriority = listAllGoals().filter(({ goal }) =>
          goal.status === 'active' && goal.priority === 'high',
        );
        if (activeHighPriority.length > 0) {
          signals.push(`Quiet period: ${activeHighPriority.length} high-priority goal(s) active but no recent user interaction`);
        }
      } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }

  // 4. Check advisor events (model escalations, circuit breakers)
  try {
    const eventsPath = path.join(BASE_DIR, 'cron', 'advisor-events.jsonl');
    if (existsSync(eventsPath)) {
      const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5);
      for (const line of recent) {
        try {
          const evt = JSON.parse(line);
          if (new Date(evt.timestamp) > new Date(twoHoursAgo)) {
            if (evt.type === 'circuit-breaker') {
              signals.push(`Circuit breaker tripped for "${evt.jobName}": ${evt.detail}`);
            } else if (evt.type === 'escalation') {
              signals.push(`Job "${evt.jobName}" escalated: ${evt.detail}`);
            }
          }
        } catch { continue; }
      }
    }
  } catch { /* non-fatal */ }

  // 5. Broken jobs from the failure monitor. Any currently-flagged job
  //    with a diagnosis is a real, actionable signal the owner should
  //    see proactively rather than stumble across in the dashboard.
  try {
    const broken = computeBrokenJobs();
    for (const b of broken.slice(0, 3)) {
      const hint = b.diagnosis?.rootCause
        ? ` — ${b.diagnosis.rootCause.slice(0, 120)}`
        : '';
      signals.push(`Broken cron job "${b.jobName}": ${b.errorCount48h}/${b.totalRuns48h} failures${hint}`);
      if (b.diagnosis?.proposedFix?.autoApply) {
        signals.push(`One-click fix available for "${b.jobName}" — ${b.diagnosis.proposedFix.details.slice(0, 100)}`);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to pull broken-jobs signals');
  }

  // 6. Claim tracker — failed claims in the last N hours erode trust.
  //    Surface them so the owner sees "Clementine said she'd do X; she
  //    didn't" instead of silently swallowing the miss.
  try {
    if (existsSync(MEMORY_DB_PATH)) {
      const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
      store.initialize();
      const db = (store as unknown as { conn: import('better-sqlite3').Database }).conn;
      try {
        const rows = db.prepare(
          `SELECT subject, claim_type FROM claims
           WHERE status = 'failed' AND verified_at >= datetime('now', '-6 hours')
           ORDER BY verified_at DESC LIMIT 3`,
        ).all() as Array<{ subject: string; claim_type: string }>;
        for (const r of rows) {
          signals.push(`Failed claim: "${r.subject}" (${r.claim_type}) — I promised and didn't deliver`);
        }
      } catch { /* table may not exist */ }
      store.close();
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to pull failed-claims signals');
  }

  return signals;
}

/**
 * Build a prompt for urgency rating (to be sent to a lightweight LLM).
 * Returns null if there are no signals worth evaluating.
 */
export function buildInsightPrompt(signals: string[]): string | null {
  if (signals.length === 0) return null;

  return (
    `You are a proactive assistant analyzing recent events for your owner.\n\n` +
    `## Recent Events\n${signals.map(s => `- ${s}`).join('\n')}\n\n` +
    `## Task\n` +
    `Based on these events, determine if the user should be notified.\n\n` +
    `Rate urgency 1-5:\n` +
    `1 = trivial (don't notify)\n` +
    `2 = low (don't notify)\n` +
    `3 = informational (batch into next check-in)\n` +
    `4 = important (notify during active hours)\n` +
    `5 = critical (notify immediately)\n\n` +
    `If urgency >= 3, write a brief, conversational message (1-3 sentences) for the user.\n\n` +
    `Output ONLY JSON:\n` +
    `{ "urgency": <1-5>, "message": "<text or null>", "source": "<which event triggered this>" }`
  );
}

/**
 * Parse the LLM response into an InsightResult.
 */
export function parseInsightResponse(response: string): InsightResult | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.urgency || parsed.urgency < 3 || !parsed.message) return null;
    return {
      message: parsed.message,
      urgency: parsed.urgency,
      source: parsed.source || 'unknown',
    };
  } catch {
    return null;
  }
}
