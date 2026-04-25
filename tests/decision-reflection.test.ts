import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeAgentDecisions,
  formatReflectionReport,
  formatReflectionSummary,
} from '../src/agent/decision-reflection.js';
import {
  recordDecision,
  recordDecisionOutcome,
  type ProactiveDecisionContext,
} from '../src/agent/proactive-ledger.js';
import type { ProactiveDecision } from '../src/agent/proactive-engine.js';

function decision(overrides: Partial<ProactiveDecision> = {}): ProactiveDecision {
  return {
    action: 'act_now',
    source: 'goal',
    reason: 'test',
    urgency: 4,
    confidence: 0.85,
    authorityTier: 2,
    idempotencyKey: 'test-' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

function context(overrides: Partial<ProactiveDecisionContext> = {}): ProactiveDecisionContext {
  return {
    signalType: 'test-signal',
    description: 'test description',
    ...overrides,
  };
}

describe('analyzeAgentDecisions', () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-refl-'));
    mkdirSync(path.join(dir, 'proactive'), { recursive: true });
    ledgerPath = path.join(dir, 'proactive', 'decisions.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns dormant pattern when no decisions exist', () => {
    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(r.totalDecisions).toBe(0);
    expect(r.patterns[0]).toMatch(/No decisions/);
    expect(r.suggestions[0]).toMatch(/dormant/i);
  });

  it('counts decisions only for the requested agent (filter by context.owner)', () => {
    recordDecision(decision(), context({ owner: 'ross-the-sdr' }), { filePath: ledgerPath });
    recordDecision(decision(), context({ owner: 'sasha-the-cmo' }), { filePath: ledgerPath });
    recordDecision(decision(), context({ owner: 'ross-the-sdr' }), { filePath: ledgerPath });

    const ross = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(ross.totalDecisions).toBe(2);

    const sasha = analyzeAgentDecisions('sasha-the-cmo', 7, { ledgerPath });
    expect(sasha.totalDecisions).toBe(1);
  });

  it('treats unowned records as Clementine\'s decisions', () => {
    recordDecision(decision(), context({}), { filePath: ledgerPath }); // no owner
    recordDecision(decision(), context({ owner: 'ross-the-sdr' }), { filePath: ledgerPath });

    const clem = analyzeAgentDecisions('clementine', 7, { ledgerPath });
    expect(clem.totalDecisions).toBe(1);
    const ross = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(ross.totalDecisions).toBe(1);
  });

  it('flags low success rate on act_now (< 50%)', () => {
    // 3 act_now decisions, only 1 advanced — 33% success
    for (let i = 0; i < 3; i++) {
      const dec = decision({ idempotencyKey: `k${i}` });
      const rec = recordDecision(dec, context({ owner: 'ross-the-sdr' }), { filePath: ledgerPath });
      const status = i === 0 ? 'advanced' : 'failed';
      recordDecisionOutcome(rec.id, dec, context({ owner: 'ross-the-sdr' }), {
        status,
        summary: 'test',
      }, { filePath: ledgerPath });
    }

    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(r.byAction.act_now.decided).toBe(3);
    expect(r.byAction.act_now.withOutcomes).toBe(3);
    expect(r.byAction.act_now.advanced).toBe(1);
    expect(r.byAction.act_now.failed).toBe(2);
    expect(r.byAction.act_now.successRatePct).toBe(33);
    expect(r.patterns.some((p) => /act_now success rate/i.test(p))).toBe(true);
    expect(r.suggestions.some((s) => /urgency threshold/i.test(s))).toBe(true);
  });

  it('flags high decision volume (>= 20 in window)', () => {
    for (let i = 0; i < 25; i++) {
      recordDecision(
        decision({ idempotencyKey: `vol-${i}` }),
        context({ owner: 'ross-the-sdr' }),
        { filePath: ledgerPath },
      );
    }
    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(r.totalDecisions).toBe(25);
    expect(r.patterns.some((p) => /High decision volume/i.test(p))).toBe(true);
  });

  it('flags blocked outcomes when there are several', () => {
    for (let i = 0; i < 4; i++) {
      const dec = decision({ idempotencyKey: `b${i}` });
      const rec = recordDecision(dec, context({ owner: 'ross-the-sdr' }), { filePath: ledgerPath });
      recordDecisionOutcome(rec.id, dec, context({ owner: 'ross-the-sdr' }), {
        status: 'blocked-on-user',
        summary: 'waiting',
      }, { filePath: ledgerPath });
    }
    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(r.byAction.act_now.blocked).toBe(4);
    expect(r.patterns.some((p) => /ended blocked/i.test(p))).toBe(true);
  });

  it('reports zero ask_user when active autonomous work happened', () => {
    for (let i = 0; i < 6; i++) {
      recordDecision(
        decision({ action: 'act_now', idempotencyKey: `ak${i}` }),
        context({ owner: 'ross-the-sdr' }),
        { filePath: ledgerPath },
      );
    }
    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(r.byAction.ask_user.decided).toBe(0);
    expect(r.patterns.some((p) => /Zero ask_user/i.test(p))).toBe(true);
  });

  it('returns top sources sorted by count', () => {
    for (let i = 0; i < 5; i++) {
      recordDecision(
        decision({ source: 'goal', idempotencyKey: `g${i}` }),
        context({ owner: 'ross-the-sdr' }),
        { filePath: ledgerPath },
      );
    }
    for (let i = 0; i < 2; i++) {
      recordDecision(
        decision({ source: 'inbox', idempotencyKey: `i${i}` }),
        context({ owner: 'ross-the-sdr' }),
        { filePath: ledgerPath },
      );
    }
    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    expect(r.topSources[0]).toEqual({ source: 'goal', count: 5 });
    expect(r.topSources[1]).toEqual({ source: 'inbox', count: 2 });
  });
});

describe('formatReflectionReport', () => {
  it('renders empty-window case as a short note', () => {
    const r = analyzeAgentDecisions('ross-the-sdr', 7, {
      ledgerPath: path.join(tmpdir(), 'nonexistent-' + Math.random()),
    });
    const md = formatReflectionReport(r);
    expect(md).toMatch(/# Decision reflection — ross-the-sdr/);
    expect(md).toMatch(/## No decisions in window/);
  });

  it('renders the by-action table when decisions exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clementine-refl-fmt-'));
    const ledgerPath = path.join(dir, 'l.jsonl');
    recordDecision(
      decision({ action: 'queue', idempotencyKey: 'q1' }),
      context({ owner: 'ross-the-sdr' }),
      { filePath: ledgerPath },
    );
    const r = analyzeAgentDecisions('ross-the-sdr', 7, { ledgerPath });
    const md = formatReflectionReport(r);
    expect(md).toMatch(/## By action/);
    expect(md).toMatch(/Queued \(queue\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatReflectionSummary', () => {
  it('produces a compact summary suitable for working-memory', () => {
    const r = analyzeAgentDecisions('ross-the-sdr', 7, {
      ledgerPath: path.join(tmpdir(), 'nonexistent-' + Math.random()),
    });
    const summary = formatReflectionSummary(r);
    expect(summary).toMatch(/### Self-reflection/);
    expect(summary).toMatch(/last 7d/);
    expect(summary.length).toBeLessThan(2000); // bounded for prompt budget
  });
});
