import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  recentDecisions,
  outcomeStatusFromGoalDisposition,
  recordDecision,
  recordDecisionOutcome,
  wasRecentlyDecided,
} from '../src/agent/proactive-ledger.js';
import type { ProactiveDecision } from '../src/agent/proactive-engine.js';

const TEST_DIR = path.join(os.tmpdir(), 'clem-proactive-ledger-tests');

function ledgerFile(name: string): string {
  const dir = path.join(TEST_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function decision(overrides: Partial<ProactiveDecision> = {}): ProactiveDecision {
  return {
    action: 'act_now',
    source: 'goal',
    reason: 'test',
    urgency: 4,
    confidence: 0.8,
    authorityTier: 2,
    idempotencyKey: 'goal:test-key',
    ...overrides,
  };
}

describe('proactive ledger', () => {
  it('records and reads decisions newest first', () => {
    const filePath = ledgerFile('decisions.jsonl');
    recordDecision(decision({ idempotencyKey: 'a' }), { signalType: 'test', description: 'A' }, {
      filePath,
      now: new Date('2026-04-24T10:00:00.000Z'),
    });
    recordDecision(decision({ idempotencyKey: 'b' }), { signalType: 'test', description: 'B' }, {
      filePath,
      now: new Date('2026-04-24T11:00:00.000Z'),
    });

    const records = recentDecisions({}, { filePath, now: new Date('2026-04-24T12:00:00.000Z') });
    expect(records).toHaveLength(2);
    expect(records[0].decision.idempotencyKey).toBe('b');
    expect(records[1].decision.idempotencyKey).toBe('a');
  });

  it('detects recent duplicate decisions inside the window only', () => {
    const filePath = ledgerFile('decisions.jsonl');
    recordDecision(decision(), { signalType: 'test', description: 'A' }, {
      filePath,
      now: new Date('2026-04-24T10:00:00.000Z'),
    });

    expect(wasRecentlyDecided('goal:test-key', 2 * 60 * 60 * 1000, {
      filePath,
      now: new Date('2026-04-24T11:00:00.000Z'),
    })).toBe(true);
    expect(wasRecentlyDecided('goal:test-key', 30 * 60 * 1000, {
      filePath,
      now: new Date('2026-04-24T11:00:00.000Z'),
    })).toBe(false);
  });

  it('records outcome events with the same decision id', () => {
    const filePath = ledgerFile('decisions.jsonl');
    const first = recordDecision(decision(), { signalType: 'test', description: 'A' }, {
      filePath,
      now: new Date('2026-04-24T11:00:00.000Z'),
    });
    recordDecisionOutcome(
      first.id,
      decision(),
      { signalType: 'test', description: 'A' },
      { status: 'advanced', summary: 'Goal moved forward' },
      { filePath, now: new Date('2026-04-24T12:00:00.000Z') },
    );

    const records = recentDecisions({ idempotencyKey: 'goal:test-key' }, { filePath });
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe(first.id);
    expect(records[0].outcome?.status).toBe('advanced');
  });

  it('maps goal dispositions to proactive outcome statuses', () => {
    expect(outcomeStatusFromGoalDisposition('advanced')).toBe('advanced');
    expect(outcomeStatusFromGoalDisposition('blocked-on-user')).toBe('blocked-on-user');
    expect(outcomeStatusFromGoalDisposition('blocked-on-external')).toBe('blocked-on-external');
    expect(outcomeStatusFromGoalDisposition('needs-different-approach')).toBe('needs-different-approach');
    expect(outcomeStatusFromGoalDisposition('monitoring')).toBe('monitoring');
    expect(outcomeStatusFromGoalDisposition('no-change')).toBe('no-change');
    expect(outcomeStatusFromGoalDisposition('error')).toBe('failed');
  });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});
