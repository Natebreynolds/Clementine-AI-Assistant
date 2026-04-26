/**
 * Phase 2b — primary-mode advisor returns rule-engine advice.
 *
 * Sets CLEMENTINE_HOME before any src import so the rule loader, run log,
 * and reflection store all resolve to an isolated temp directory. Then
 * calls getExecutionAdviceWithMode(..., 'primary') and asserts the result
 * matches what the YAML rule engine would produce — proving the dispatcher
 * routes correctly and the legacy TS path is not consulted.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = path.join(
  os.tmpdir(),
  'clem-advisor-primary-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
);
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'cron', 'runs'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'cron', 'reflections'), { recursive: true });

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function appendRun(jobName: string, entry: object) {
  const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
  appendFileSync(
    path.join(TMP_HOME, 'cron', 'runs', `${safe}.jsonl`),
    JSON.stringify({ jobName, ...entry }) + '\n',
  );
}

describe('Phase 2b: primary-mode dispatcher', () => {
  beforeEach(async () => {
    // Clear cached rule-init flag so each test re-loads from disk.
    const advisor = await import('../src/agent/execution-advisor.js');
    advisor._resetAdvisorRulesInit();
  });

  it('routes to the rule engine when mode = primary', async () => {
    const { getExecutionAdviceWithMode } = await import('../src/agent/execution-advisor.js');

    // Seed: standard job hitting max_turns 2x — rule 025 should bump maxTurns.
    const jobName = 'rule-engine-target';
    for (let i = 0; i < 2; i++) {
      appendRun(jobName, {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error',
        durationMs: 30_000,
        terminalReason: 'max_turns',
        attempt: 1,
      });
    }

    const advice = getExecutionAdviceWithMode(
      jobName,
      { name: jobName, schedule: '* * * * *', prompt: '', enabled: true, tier: 2, maxTurns: 10, mode: 'standard' },
      'primary',
    );

    // Rule 025 (turn-limit-hits) → bumpMaxTurns multiplier 1.5 → 15, capped at tier 2's 50.
    expect(advice.adjustedMaxTurns).toBe(15);
  });

  it('rule engine respects unleashed mode — no maxTurns bump even with max_turns errors', async () => {
    const { getExecutionAdviceWithMode } = await import('../src/agent/execution-advisor.js');

    const jobName = 'unleashed-target';
    for (let i = 0; i < 3; i++) {
      appendRun(jobName, {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error',
        durationMs: 30_000,
        terminalReason: 'max_turns',
        attempt: 1,
      });
    }

    const advice = getExecutionAdviceWithMode(
      jobName,
      { name: jobName, schedule: '* * * * *', prompt: '', enabled: true, tier: 2, mode: 'unleashed' },
      'primary',
    );

    expect(advice.adjustedMaxTurns).toBeNull();
  });

  it('rule engine produces circuit-breaker skip on 5+ consecutive errors', async () => {
    const { getExecutionAdviceWithMode } = await import('../src/agent/execution-advisor.js');

    const jobName = 'circuit-breaker-target';
    // 6 consecutive errors with the most recent one within cooldown window
    const recent = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      appendRun(jobName, {
        startedAt: recent,
        finishedAt: recent,
        status: 'error',
        durationMs: 30_000,
        attempt: 1,
      });
    }

    const advice = getExecutionAdviceWithMode(
      jobName,
      { name: jobName, schedule: '* * * * *', prompt: '', enabled: true, tier: 2, mode: 'standard' },
      'primary',
    );

    expect(advice.shouldSkip).toBe(true);
    expect(advice.skipReason).toContain('circuit breaker engaged');
  });

  it('mode = off skips the rule engine entirely (legacy TS path)', async () => {
    const { getExecutionAdviceWithMode } = await import('../src/agent/execution-advisor.js');

    // Use a fresh job with no run history — both paths should produce the
    // same empty advice. This test is mostly a smoke check that 'off' is
    // honored; correctness of the TS path is covered by execution-advisor.test.ts.
    const advice = getExecutionAdviceWithMode(
      'never-run-job',
      { name: 'never-run-job', schedule: '* * * * *', prompt: '', enabled: true, tier: 2, mode: 'standard' },
      'off',
    );
    expect(advice.adjustedMaxTurns).toBeNull();
    expect(advice.shouldSkip).toBe(false);
    expect(advice.shouldEscalate).toBe(false);
  });
});
