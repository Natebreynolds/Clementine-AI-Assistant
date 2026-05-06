import { describe, expect, it } from 'vitest';
import {
  buildAlwaysOnParallelizationHint,
  buildFanoutDirective,
  buildFanoutDirectiveForText,
  detectFanoutSignals,
  detectPreLlmPlanIntent,
} from '../src/agent/fanout-policy.js';

describe('detectFanoutSignals', () => {
  it('flags explicit "for each" iteration', () => {
    const r = detectFanoutSignals('for each prospect, send a follow-up email');
    expect(r.needsFanout).toBe(true);
    expect(r.signals.map(s => s.pattern)).toContain('multi_item_iteration');
  });

  it('flags collective + quantifier patterns ("all prospects", "every account")', () => {
    expect(detectFanoutSignals('check all prospects').needsFanout).toBe(true);
    expect(detectFanoutSignals('review every account').needsFanout).toBe(true);
    expect(detectFanoutSignals('process each lead').needsFanout).toBe(true);
  });

  it('flags numeric collection counts (10+ items)', () => {
    const r = detectFanoutSignals('research 20 prospects');
    expect(r.needsFanout).toBe(true);
    expect(r.signals.map(s => s.pattern)).toContain('numeric_collection');
  });

  it('does NOT flag a single-digit count', () => {
    // "5 prospects" intentionally not flagged — small enough to handle
    // sequentially without thrash. Tune for false positives, but small
    // batches are exactly what a single sub-agent slice handles.
    const r = detectFanoutSignals('research 5 prospects');
    expect(r.signals.map(s => s.pattern)).not.toContain('numeric_collection');
  });

  it('flags broad-scope research wording', () => {
    expect(detectFanoutSignals('produce a comprehensive content intel brief').needsFanout).toBe(true);
    expect(detectFanoutSignals('do a deep-dive competitive analysis').needsFanout).toBe(true);
    expect(detectFanoutSignals('build a content intel brief for the week').needsFanout).toBe(true);
  });

  it('flags broad scan/crawl wording', () => {
    expect(detectFanoutSignals('crawl the entire docs site').needsFanout).toBe(true);
    expect(detectFanoutSignals('inventory all the source files').needsFanout).toBe(true);
  });

  it('flags long-history pull wording', () => {
    expect(detectFanoutSignals('summarize the last 30 days').needsFanout).toBe(true);
    expect(detectFanoutSignals('what happened in the past 2 weeks').needsFanout).toBe(true);
  });

  it('does not flag a one-shot quiet task', () => {
    expect(detectFanoutSignals('check inbox').needsFanout).toBe(false);
    expect(detectFanoutSignals('send a follow-up to Mark Finizio').needsFanout).toBe(false);
    expect(detectFanoutSignals('').needsFanout).toBe(false);
  });

  it('returns multiple signals when several patterns match', () => {
    const r = detectFanoutSignals(
      'comprehensive review: process every account with 50 deals over the last 30 days',
    );
    expect(r.needsFanout).toBe(true);
    // At least 3 distinct patterns should fire
    expect(new Set(r.signals.map(s => s.pattern)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('buildFanoutDirective', () => {
  it('emits empty string when no signals', () => {
    expect(buildFanoutDirective([])).toBe('');
  });

  it('emits a directive that names the matched reasons', () => {
    const r = detectFanoutSignals('research 20 prospects across all accounts');
    const text = buildFanoutDirective(r.signals);
    expect(text).toContain('MANDATORY');
    expect(text).toContain('Agent');
    expect(text.toLowerCase()).toContain('sub-agent');
    expect(text).toContain('rapid_refill_breaker');
  });

  it('includes batch-size guidance', () => {
    const r = detectFanoutSignals('process each prospect');
    const text = buildFanoutDirective(r.signals);
    expect(text).toMatch(/3.{0,3}5/); // "3–5" or "3-5" depending on dash form
  });
});

describe('buildAlwaysOnParallelizationHint', () => {
  it('is a short, single-block string', () => {
    const hint = buildAlwaysOnParallelizationHint();
    expect(hint.length).toBeGreaterThan(50);
    expect(hint.length).toBeLessThan(500);
    expect(hint).toContain('Agent');
  });
});

describe('buildFanoutDirectiveForText', () => {
  it('returns empty directive + report when no signals', () => {
    const r = buildFanoutDirectiveForText('check the inbox once');
    expect(r.directive).toBe('');
    expect(r.report.needsFanout).toBe(false);
  });

  it('returns directive + report when signals present', () => {
    const r = buildFanoutDirectiveForText('comprehensive content intel brief for all competitors');
    expect(r.directive).not.toBe('');
    expect(r.report.needsFanout).toBe(true);
    expect(r.report.signals.length).toBeGreaterThan(0);
  });
});

describe('detectPreLlmPlanIntent', () => {
  it('routes the canonical user example: "create a task that will scrape Salesforce, research 100 leads, send emails"', () => {
    // This is the kind of query the orchestration architecture is
    // designed to handle. If this doesn't route, the system fails its
    // primary use case.
    const r = detectPreLlmPlanIntent(
      'can you create a task that will scrape salesforce research those 100 leads and send them emails',
    );
    expect(r.shouldRouteToPlanner).toBe(true);
  });

  it('routes a multi-item action: "research my top 10 prospects across all accounts"', () => {
    const r = detectPreLlmPlanIntent('research my top 10 prospects across all accounts and draft a follow-up to each');
    expect(r.shouldRouteToPlanner).toBe(true);
    expect(r.actionVerbs.length).toBeGreaterThan(0);
  });

  it('routes a "for each X, do Y" pattern with research', () => {
    const r = detectPreLlmPlanIntent('for each account in our pipeline, run the audit and email the rep with results');
    expect(r.shouldRouteToPlanner).toBe(true);
  });

  it('routes "research my 50 contacts and email each one"', () => {
    const r = detectPreLlmPlanIntent('research my 50 contacts and email each one with a tailored follow-up');
    expect(r.shouldRouteToPlanner).toBe(true);
  });

  it('does NOT route an informational query: "tell me about my prospects"', () => {
    const r = detectPreLlmPlanIntent('tell me about all of my prospects and their status');
    expect(r.shouldRouteToPlanner).toBe(false);
    expect(r.reason).toBe('informational_query');
  });

  it('does NOT route "what time is it" — too short + informational', () => {
    const r = detectPreLlmPlanIntent('what time is it');
    expect(r.shouldRouteToPlanner).toBe(false);
  });

  it('does NOT route a single-target draft: "draft a follow-up to Mark Finizio"', () => {
    const r = detectPreLlmPlanIntent('draft a follow-up to Mark Finizio about the audit results from last week');
    expect(r.shouldRouteToPlanner).toBe(false);
  });

  it('respects intentType: chat → never routes regardless of content', () => {
    const r = detectPreLlmPlanIntent(
      'research all my prospects across every account and process each one comprehensively',
      { intentType: 'chat' },
    );
    expect(r.shouldRouteToPlanner).toBe(false);
    expect(r.reason).toBe('intent_is_chat');
  });

  it('respects intentType: followup → never routes', () => {
    const r = detectPreLlmPlanIntent(
      'and process all the rest of them too',
      { intentType: 'followup' },
    );
    expect(r.shouldRouteToPlanner).toBe(false);
    expect(r.reason).toBe('intent_is_followup');
  });

  it('does NOT route on weak evidence (single verb, no collection)', () => {
    const r = detectPreLlmPlanIntent('research the prospect Mark Finizio in detail');
    expect(r.shouldRouteToPlanner).toBe(false);
    expect(r.reason).toMatch(/weak_evidence|no_action_verb/);
  });

  it('routes a "build a brief" pattern with multiple steps', () => {
    const r = detectPreLlmPlanIntent('build a comprehensive content intelligence brief covering competitors, brand mentions, and the past 30 days of news');
    expect(r.shouldRouteToPlanner).toBe(true);
  });

  it('does NOT route short queries below the length floor', () => {
    const r = detectPreLlmPlanIntent('research leads');
    expect(r.shouldRouteToPlanner).toBe(false);
    expect(r.reason).toBe('too_short');
  });

  it('does NOT route a pure declarative statement with no verb-action: "100 leads are in the pipeline"', () => {
    // Numeric collection signal fires but no multi-target verb → no route.
    const r = detectPreLlmPlanIntent('100 leads are in the pipeline waiting for triage');
    expect(r.shouldRouteToPlanner).toBe(false);
  });
});
