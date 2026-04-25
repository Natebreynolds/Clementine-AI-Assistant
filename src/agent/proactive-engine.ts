import { createHash } from 'node:crypto';
import type { DailyPlanPriority, PersistentGoal } from '../types.js';

export type ProactiveAction = 'act_now' | 'queue' | 'ask_user' | 'snooze' | 'ignore';
export type ProactiveSource = 'daily-plan' | 'goal' | 'cron' | 'inbox' | 'insight' | 'manual';

export interface ProactiveDecision {
  action: ProactiveAction;
  source: ProactiveSource;
  reason: string;
  urgency: number;
  confidence: number;
  authorityTier: 1 | 2 | 3;
  idempotencyKey: string;
  nextCheckAt?: string;
}

export interface DailyPlanDecisionInput {
  priority: DailyPlanPriority;
  date: string;
  goalAutoSchedule?: boolean;
  now?: Date;
}

export type ProactiveWorkType =
  | 'stale-goal'
  | 'cron-failure'
  | 'overdue-tasks'
  | 'inbox'
  | `plan-${DailyPlanPriority['type']}`
  | 'unknown';

export interface ProactiveWorkItem {
  type: ProactiveWorkType;
  id?: string;
  description: string;
  urgency: number;
  source?: ProactiveSource;
}

export interface GoalAdvancementDecision {
  goal: PersistentGoal;
  decision: ProactiveDecision;
  score: number;
  focus: string;
  reason: string;
}

export interface GoalAdvancementInput {
  goal: PersistentGoal;
  now?: Date;
  inCooldown?: boolean;
}

const HUMAN_INPUT_PATTERN = /\?|decide|choose|approve|confirm|review with|ask\s/i;

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}

export function requiresHumanInput(text: string): boolean {
  return HUMAN_INPUT_PATTERN.test(text);
}

function clampUrgency(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(5, Math.round(value)));
}

function snoozeUntil(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

/**
 * Deterministic first-pass decision for daily-plan priorities.
 * The LLM decides what matters; this layer decides what the daemon may do.
 */
export function decideDailyPlanPriority(input: DailyPlanDecisionInput): ProactiveDecision {
  const { priority, date, goalAutoSchedule = false, now = new Date() } = input;
  const urgency = clampUrgency(priority.urgency);
  const keyBase = `${date}:${priority.type}:${priority.id}:${priority.action}`;
  const idempotencyKey = `daily-plan:${shortHash(keyBase)}`;

  if (!priority.action.trim()) {
    return {
      action: 'ignore',
      source: 'daily-plan',
      reason: 'Daily plan priority had no actionable description.',
      urgency,
      confidence: 0.2,
      authorityTier: 1,
      idempotencyKey,
    };
  }

  if (requiresHumanInput(priority.action)) {
    return {
      action: urgency >= 4 ? 'ask_user' : 'snooze',
      source: 'daily-plan',
      reason: 'Priority appears to require owner input before action.',
      urgency,
      confidence: 0.75,
      authorityTier: 1,
      idempotencyKey,
      nextCheckAt: snoozeUntil(now, urgency >= 4 ? 4 : 24),
    };
  }

  if (priority.type === 'goal') {
    if (urgency >= 4) {
      return {
        action: 'act_now',
        source: 'daily-plan',
        reason: 'High-urgency goal priority is autonomously actionable.',
        urgency,
        confidence: goalAutoSchedule ? 0.9 : 0.8,
        authorityTier: 2,
        idempotencyKey,
      };
    }

    if (urgency >= 3) {
      return {
        action: 'queue',
        source: 'daily-plan',
        reason: 'Medium-urgency goal priority should be queued for heartbeat work.',
        urgency,
        confidence: 0.7,
        authorityTier: 1,
        idempotencyKey,
        nextCheckAt: snoozeUntil(now, 2),
      };
    }
  }

  if (priority.type === 'cron-fix' && urgency >= 4) {
    return {
      action: 'ask_user',
      source: 'daily-plan',
      reason: 'Cron fixes can change autonomous behavior and should be confirmed.',
      urgency,
      confidence: 0.75,
      authorityTier: 2,
      idempotencyKey,
    };
  }

  return {
    action: urgency >= 3 ? 'snooze' : 'ignore',
    source: 'daily-plan',
    reason: 'Priority is not urgent enough for autonomous action.',
    urgency,
    confidence: 0.65,
    authorityTier: 1,
    idempotencyKey,
    nextCheckAt: snoozeUntil(now, 24),
  };
}

export function decisionShouldCreateGoalTrigger(decision: ProactiveDecision): boolean {
  return decision.action === 'act_now' && decision.authorityTier <= 2 && decision.confidence >= 0.7;
}

export function decisionShouldQueueHeartbeatWork(decision: ProactiveDecision): boolean {
  return decision.action === 'queue' && decision.authorityTier === 1 && decision.confidence >= 0.65;
}

export function decideDiscoveredWorkItem(item: ProactiveWorkItem, now = new Date()): ProactiveDecision {
  const urgency = clampUrgency(item.urgency);
  const source = item.source ?? (
    item.type === 'cron-failure' ? 'cron'
    : item.type === 'inbox' ? 'inbox'
    : item.type === 'stale-goal' ? 'goal'
    : item.type.startsWith('plan-') ? 'daily-plan'
    : 'manual'
  );
  const idempotencyKey = `${source}:${shortHash(`${item.type}:${item.id ?? ''}:${item.description}`)}`;

  if (!item.description.trim()) {
    return {
      action: 'ignore',
      source,
      reason: 'Work item had no actionable description.',
      urgency,
      confidence: 0.2,
      authorityTier: 1,
      idempotencyKey,
    };
  }

  if (requiresHumanInput(item.description)) {
    return {
      action: urgency >= 4 ? 'ask_user' : 'snooze',
      source,
      reason: 'Work item appears to require owner input.',
      urgency,
      confidence: 0.7,
      authorityTier: 1,
      idempotencyKey,
      nextCheckAt: snoozeUntil(now, urgency >= 4 ? 4 : 24),
    };
  }

  switch (item.type) {
    case 'cron-failure':
      return {
        action: urgency >= 4 ? 'ask_user' : 'queue',
        source,
        reason: urgency >= 4
          ? 'Repeated cron failure may require owner approval before changing automation.'
          : 'Cron failure should be queued for diagnosis.',
        urgency,
        confidence: 0.75,
        authorityTier: 2,
        idempotencyKey,
      };
    case 'overdue-tasks':
      return {
        action: urgency >= 4 ? 'ask_user' : 'snooze',
        source,
        reason: 'Overdue tasks need owner attention unless a concrete next action is known.',
        urgency,
        confidence: 0.7,
        authorityTier: 1,
        idempotencyKey,
        nextCheckAt: snoozeUntil(now, urgency >= 4 ? 4 : 24),
      };
    case 'inbox':
      return {
        action: urgency >= 2 ? 'act_now' : 'queue',
        source,
        reason: 'Inbox triage is a reversible tier-1 organization task.',
        urgency,
        confidence: 0.8,
        authorityTier: 1,
        idempotencyKey,
      };
    case 'stale-goal':
    case 'plan-goal':
      return {
        action: urgency >= 4 ? 'act_now' : urgency >= 3 ? 'queue' : 'snooze',
        source,
        reason: 'Goal-related work can move autonomously when it has a concrete action.',
        urgency,
        confidence: 0.75,
        authorityTier: urgency >= 4 ? 2 : 1,
        idempotencyKey,
        nextCheckAt: urgency < 4 ? snoozeUntil(now, 2) : undefined,
      };
    default:
      return {
        action: urgency >= 4 ? 'ask_user' : urgency >= 3 ? 'queue' : 'ignore',
        source,
        reason: 'Generic work item evaluated conservatively.',
        urgency,
        confidence: 0.6,
        authorityTier: 1,
        idempotencyKey,
        nextCheckAt: urgency >= 3 && urgency < 4 ? snoozeUntil(now, 24) : undefined,
      };
  }
}

export function decideGoalAdvancement(input: GoalAdvancementInput): GoalAdvancementDecision | null {
  const { goal, now = new Date(), inCooldown = false } = input;
  if (goal.status !== 'active') return null;
  // Cooldown is a hard skip — the caller already decided we shouldn't act on
  // this goal. Returning a snooze record here just got discarded downstream.
  if (inCooldown) return null;

  const nowMs = now.getTime();
  const dayMs = 86_400_000;
  const lastUpdate = goal.updatedAt ? new Date(goal.updatedAt).getTime() : 0;
  const daysSinceUpdate = Math.floor((nowMs - lastUpdate) / dayMs);
  const staleThreshold = goal.reviewFrequency === 'daily' ? 1 : goal.reviewFrequency === 'weekly' ? 7 : 30;
  const isStale = daysSinceUpdate > staleThreshold;
  const hasWork = (goal.nextActions?.length ?? 0) > 0;

  if (!isStale && !hasWork) return null;

  const priorityScore = goal.priority === 'high' ? 15 : goal.priority === 'medium' ? 8 : 2;
  const stalenessScore = isStale ? Math.min(daysSinceUpdate - staleThreshold, 20) : 0;
  const workScore = hasWork ? 5 : 0;
  let deadlineScore = 0;
  if (goal.targetDate) {
    const daysUntilTarget = Math.floor((new Date(goal.targetDate).getTime() - nowMs) / dayMs);
    if (daysUntilTarget <= 0) deadlineScore = 20;
    else if (daysUntilTarget <= 3) deadlineScore = 10;
    else if (daysUntilTarget <= 7) deadlineScore = 5;
  }

  const score = priorityScore + stalenessScore + workScore + deadlineScore;
  const reason = [
    isStale ? `stale(${daysSinceUpdate}d)` : 'current',
    `pri=${goal.priority}`,
    hasWork ? 'has-work' : 'no-work',
    deadlineScore > 0 ? `deadline-boost(${deadlineScore})` : '',
  ].filter(Boolean).join(', ');
  const focus = goal.nextActions?.length > 0
    ? goal.nextActions[0]
    : `Review and update progress on "${goal.title}"`;
  const idempotencyKey = `goal:${shortHash(`${goal.id}:${focus}`)}`;

  const urgency = Math.min(5, Math.max(1, Math.ceil(score / 8)));
  const action: ProactiveAction = score >= 13 ? 'act_now' : score >= 8 ? 'queue' : 'snooze';

  return {
    goal,
    score,
    focus,
    reason,
    decision: {
      action,
      source: 'goal',
      reason: action === 'act_now'
        ? 'Goal score is high enough for autonomous advancement.'
        : action === 'queue'
          ? 'Goal should be queued, but not executed immediately.'
          : 'Goal is low urgency; check later.',
      urgency,
      confidence: action === 'act_now' ? 0.8 : 0.7,
      authorityTier: action === 'act_now' ? 2 : 1,
      idempotencyKey,
      nextCheckAt: action === 'act_now' ? undefined : snoozeUntil(now, 2),
    },
  };
}
