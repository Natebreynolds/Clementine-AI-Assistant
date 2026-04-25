import { describe, expect, it } from 'vitest';
import {
  decideDailyPlanPriority,
  decideDiscoveredWorkItem,
  decideGoalAdvancement,
  decisionShouldCreateGoalTrigger,
  decisionShouldQueueHeartbeatWork,
  requiresHumanInput,
} from '../src/agent/proactive-engine.js';
import type { DailyPlanPriority, PersistentGoal } from '../src/types.js';

function priority(overrides: Partial<DailyPlanPriority> = {}): DailyPlanPriority {
  return {
    type: 'goal',
    id: 'g1',
    action: 'Research the next account batch',
    urgency: 4,
    ...overrides,
  };
}

describe('proactive decision engine', () => {
  it('turns high-urgency goal priorities into immediate autonomous action', () => {
    const decision = decideDailyPlanPriority({
      priority: priority({ urgency: 5 }),
      date: '2026-04-24',
    });

    expect(decision.action).toBe('act_now');
    expect(decision.authorityTier).toBe(2);
    expect(decisionShouldCreateGoalTrigger(decision)).toBe(true);
  });

  it('queues medium-urgency goal priorities instead of ignoring them', () => {
    const decision = decideDailyPlanPriority({
      priority: priority({ urgency: 3 }),
      date: '2026-04-24',
    });

    expect(decision.action).toBe('queue');
    expect(decisionShouldQueueHeartbeatWork(decision)).toBe(true);
  });

  it('asks the user before acting on decision-shaped priorities', () => {
    const decision = decideDailyPlanPriority({
      priority: priority({ action: 'Ask Nathan to approve the outbound sequence', urgency: 5 }),
      date: '2026-04-24',
    });

    expect(requiresHumanInput('Ask Nathan to approve the outbound sequence')).toBe(true);
    expect(decision.action).toBe('ask_user');
    expect(decisionShouldCreateGoalTrigger(decision)).toBe(false);
    expect(decisionShouldQueueHeartbeatWork(decision)).toBe(false);
  });

  it('uses stable idempotency keys for the same priority', () => {
    const a = decideDailyPlanPriority({ priority: priority(), date: '2026-04-24' });
    const b = decideDailyPlanPriority({ priority: priority(), date: '2026-04-24' });
    const c = decideDailyPlanPriority({ priority: priority({ action: 'Different action' }), date: '2026-04-24' });

    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
  });

  it('routes urgent cron fixes to owner confirmation', () => {
    const decision = decideDailyPlanPriority({
      priority: priority({ type: 'cron-fix', id: 'job-a', action: 'Increase max turns for job-a', urgency: 5 }),
      date: '2026-04-24',
    });

    expect(decision.action).toBe('ask_user');
    expect(decision.authorityTier).toBe(2);
  });

  it('routes inbox work to immediate tier-1 action', () => {
    const decision = decideDiscoveredWorkItem({
      type: 'inbox',
      id: 'note-a',
      description: 'Triage inbox item: note-a',
      urgency: 2,
    });

    expect(decision.action).toBe('act_now');
    expect(decision.authorityTier).toBe(1);
  });

  it('routes repeated cron failures to owner confirmation at high urgency', () => {
    const decision = decideDiscoveredWorkItem({
      type: 'cron-failure',
      id: 'daily-report',
      description: 'Job "daily-report" has 5 consecutive failures',
      urgency: 5,
    });

    expect(decision.action).toBe('ask_user');
    expect(decision.source).toBe('cron');
  });

  it('scores active high-priority goals with next actions for advancement', () => {
    const goal = makeGoal({
      priority: 'high',
      nextActions: ['Draft the first outreach batch'],
      updatedAt: '2026-04-24T10:00:00.000Z',
    });
    const result = decideGoalAdvancement({
      goal,
      now: new Date('2026-04-24T12:00:00.000Z'),
    });

    expect(result).not.toBeNull();
    expect(result?.focus).toBe('Draft the first outreach batch');
    expect(result?.decision.action).toBe('act_now');
    expect(decisionShouldCreateGoalTrigger(result!.decision)).toBe(true);
  });

  it('returns null for goals that are cooling down', () => {
    const result = decideGoalAdvancement({
      goal: makeGoal({ priority: 'high', nextActions: ['Try again'] }),
      now: new Date('2026-04-24T12:00:00.000Z'),
      inCooldown: true,
    });

    expect(result).toBeNull();
  });
});

function makeGoal(overrides: Partial<PersistentGoal> = {}): PersistentGoal {
  return {
    id: 'g1',
    title: 'Book more demos',
    description: 'Increase qualified demos.',
    status: 'active',
    owner: 'clementine',
    priority: 'medium',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    progressNotes: [],
    nextActions: [],
    blockers: [],
    reviewFrequency: 'weekly',
    linkedCronJobs: [],
    ...overrides,
  };
}
