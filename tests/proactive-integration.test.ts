import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  decideDailyPlanPriority,
  decideGoalAdvancement,
} from '../src/agent/proactive-engine.js';
import {
  recentDecisions,
  recordDecision,
  recordDecisionOutcome,
  wasRecentlyDecided,
} from '../src/agent/proactive-ledger.js';
import type { DailyPlanPriority, PersistentGoal } from '../src/types.js';

const TEST_DIR = path.join(os.tmpdir(), 'clem-proactive-integration-tests');

function ledgerFile(): string {
  const dir = path.join(TEST_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'decisions.jsonl');
}

function priority(overrides: Partial<DailyPlanPriority> = {}): DailyPlanPriority {
  return {
    type: 'goal',
    id: 'g1',
    action: 'Draft outreach batch',
    urgency: 5,
    ...overrides,
  };
}

function goal(overrides: Partial<PersistentGoal> = {}): PersistentGoal {
  return {
    id: 'g1',
    title: 'Book demos',
    description: 'Increase qualified demos.',
    status: 'active',
    owner: 'clementine',
    priority: 'high',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-24T10:00:00.000Z',
    progressNotes: [],
    nextActions: ['Draft outreach batch'],
    blockers: [],
    reviewFrequency: 'weekly',
    linkedCronJobs: [],
    ...overrides,
  };
}

describe('proactive engine + ledger integration', () => {
  it('dedupes a decision once it has been recorded', () => {
    const filePath = ledgerFile();
    const t0 = new Date('2026-04-24T10:00:00.000Z');
    const decision = decideDailyPlanPriority({ priority: priority(), date: '2026-04-24', now: t0 });

    expect(wasRecentlyDecided(decision.idempotencyKey, 60_000, { filePath, now: t0 })).toBe(false);

    recordDecision(decision, { signalType: 'daily-plan-priority', description: priority().action }, {
      filePath,
      now: t0,
    });

    const t1 = new Date('2026-04-24T10:30:00.000Z');
    expect(wasRecentlyDecided(decision.idempotencyKey, 60 * 60_000, { filePath, now: t1 })).toBe(true);

    const t2 = new Date('2026-04-24T15:00:00.000Z');
    expect(wasRecentlyDecided(decision.idempotencyKey, 60 * 60_000, { filePath, now: t2 })).toBe(false);
  });

  it('an outcome record continues to suppress re-deciding the same key', () => {
    const filePath = ledgerFile();
    const t0 = new Date('2026-04-24T10:00:00.000Z');
    const decision = decideGoalAdvancement({ goal: goal(), now: t0 })!.decision;

    const original = recordDecision(decision, { signalType: 'goal-advancement', description: 'Draft outreach batch' }, {
      filePath,
      now: t0,
    });

    const t1 = new Date('2026-04-24T11:00:00.000Z');
    recordDecisionOutcome(
      original.id,
      decision,
      { signalType: 'goal-advancement', description: 'Draft outreach batch' },
      { status: 'advanced', summary: 'queued outreach draft' },
      { filePath, now: t1 },
    );

    // After outcome, the dedup window should still consider this key "decided"
    // — that's the event-sourced contract: don't re-act on a signal we've
    // already handled.
    const t2 = new Date('2026-04-24T11:30:00.000Z');
    expect(wasRecentlyDecided(decision.idempotencyKey, 4 * 60 * 60_000, { filePath, now: t2 })).toBe(true);
  });

  it('decideGoalAdvancement returns null in cooldown so the heartbeat skips silently', () => {
    const result = decideGoalAdvancement({
      goal: goal({ priority: 'high' }),
      now: new Date('2026-04-24T12:00:00.000Z'),
      inCooldown: true,
    });
    expect(result).toBeNull();
  });

  it('outcome record for the same decision id is retrievable via recentDecisions', () => {
    const filePath = ledgerFile();
    const t0 = new Date('2026-04-24T10:00:00.000Z');
    const decision = decideDailyPlanPriority({ priority: priority(), date: '2026-04-24', now: t0 });
    const ctx = { signalType: 'daily-plan-priority', description: priority().action };

    const original = recordDecision(decision, ctx, { filePath, now: t0 });
    recordDecisionOutcome(
      original.id,
      decision,
      ctx,
      { status: 'advanced', summary: 'done' },
      { filePath, now: new Date('2026-04-24T11:00:00.000Z') },
    );

    const records = recentDecisions({ idempotencyKey: decision.idempotencyKey }, { filePath });
    expect(records).toHaveLength(2);
    expect(records[0].outcome?.status).toBe('advanced');
    expect(records[1].outcome).toBeUndefined();
  });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});
