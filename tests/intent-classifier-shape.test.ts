/**
 * 1.18.191 — message-shape classifier + plan-approval detector tests.
 *
 * The shape classifier is on the hot chat path; it must be cheap,
 * correct, and predictable. These tests pin the heuristic contract:
 *
 *   - 'simple' is conservative — small, non-actionable messages only
 *   - 'multi-step' fires on clear chain-of-work indicators
 *   - 'unknown' is the safe default that falls through to today's
 *     chat path (no regression)
 */
import { describe, it, expect } from 'vitest';
import { classifyMessageShape, detectPlanApproval, detectPlanModeRequest } from '../src/agent/intent-classifier.js';

describe('classifyMessageShape — simple', () => {
  it('one-word casual = simple', () => {
    expect(classifyMessageShape('hi').shape).toBe('simple');
    expect(classifyMessageShape('hey').shape).toBe('simple');
  });

  it('short question = simple', () => {
    expect(classifyMessageShape('what time is it').shape).toBe('simple');
    expect(classifyMessageShape("how's the weather").shape).toBe('simple');
  });

  it('short directive without batch/sequence/multi-domain = simple or unknown', () => {
    // "remind me to call X" has one action verb but no chain signals.
    const result = classifyMessageShape('remind me to call Jordan tomorrow');
    expect(['simple', 'unknown']).toContain(result.shape);
  });

  it('empty / whitespace = simple', () => {
    expect(classifyMessageShape('').shape).toBe('simple');
    expect(classifyMessageShape('   ').shape).toBe('simple');
  });
});

describe('classifyMessageShape — multi-step', () => {
  it('"find X, build Y, deploy Z" = multi-step', () => {
    const result = classifyMessageShape(
      "the product site project I want to build an HTML report for is in my Downloads folder. Find it, link it as a Clementine project, then build me a single index.html in its output/ folder with search/filter/sort. After that, set up a netlify deploy.json for it and deploy. Only tell me 'done' once you've curled the live URL and gotten HTTP 200.",
    );
    expect(result.shape).toBe('multi-step');
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it('"send 25 emails after scraping" = multi-step', () => {
    const result = classifyMessageShape(
      'send 25 salesforce emails after you scrape them with data for seo find their info in salesforce',
    );
    expect(result.shape).toBe('multi-step');
  });

  it('explicit numbered list = multi-step', () => {
    const result = classifyMessageShape(
      `Do these:\n1. Find the project\n2. Build the report\n3. Deploy it`,
    );
    expect(result.shape).toBe('multi-step');
    expect(result.reasons.some((r) => r.includes('numbered list'))).toBe(true);
  });

  it('"for each" + batch count = multi-step', () => {
    const result = classifyMessageShape(
      'For each of the 30 prospects in the queue, draft a cold email and send it',
    );
    expect(result.shape).toBe('multi-step');
  });

  it('cross-domain (3+ integrations) = multi-step', () => {
    const result = classifyMessageShape(
      'pull contacts from salesforce, send via gmail, and notify in slack when each one is sent',
    );
    expect(result.shape).toBe('multi-step');
  });
});

describe('classifyMessageShape — unknown (safe fallback)', () => {
  it('single-action-verb medium message = unknown (falls through to chat)', () => {
    // 1 action verb, no batch, no sequence, no list — ambiguous.
    // Today's chat path handles these fine; no need to force plan mode.
    const result = classifyMessageShape('write a markdown summary of the meeting notes');
    expect(['unknown', 'simple']).toContain(result.shape);
  });

  it('correction-style without action chain = unknown', () => {
    const result = classifyMessageShape("actually, change that to use Sonnet instead");
    expect(result.shape).not.toBe('multi-step');
  });
});

describe('classifyMessageShape — score + reasons', () => {
  it('returns reasons for debugging', () => {
    const result = classifyMessageShape(
      'send 25 emails after scraping salesforce',
    );
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0);
  });

  it('respects custom threshold', () => {
    // Lower threshold makes more messages trigger multi-step
    const lowThreshold = classifyMessageShape(
      'write a summary and email it to the team',
      { threshold: 1 },
    );
    expect(lowThreshold.shape).toBe('multi-step');
    // Default threshold (3) lets this same message fall through.
    const defaultThreshold = classifyMessageShape(
      'write a summary and email it to the team',
    );
    expect(defaultThreshold.shape).not.toBe('multi-step');
  });
});

describe('detectPlanApproval', () => {
  it.each([
    ['yes', 'approve'],
    ['y', 'approve'],
    ['yep', 'approve'],
    ['go', 'approve'],
    ['go ahead', 'approve'],
    ['approve', 'approve'],
    ['sounds good', 'approve'],
    ['lgtm', 'approve'],
    ['ship it', 'approve'],
    ['👍', 'approve'],
    ['ok!', 'approve'],
    ['  yes  ', 'approve'],
  ])('approves on %s', (input, expected) => {
    expect(detectPlanApproval(input)).toBe(expected);
  });

  it.each([
    ['cancel', 'cancel'],
    ['stop', 'cancel'],
    ['nvm', 'cancel'],
    ['nevermind', 'cancel'],
    ["don't", 'cancel'],
    ['abort', 'cancel'],
  ])('cancels on %s', (input, expected) => {
    expect(detectPlanApproval(input)).toBe(expected);
  });

  it('treats "yes but also do X" as revision, not approval', () => {
    expect(detectPlanApproval('yes but also include the contractor data')).toBe('revise');
  });

  it('treats long messages as revision even if affirmative-ish', () => {
    expect(detectPlanApproval('Yes — but also can you add a verification step at the end where you curl the URL and check for HTTP 200?'))
      .toBe('revise');
  });

  it('detects revision keywords', () => {
    expect(detectPlanApproval('actually change step 2')).toBe('revise');
    expect(detectPlanApproval('add a step for cleanup')).toBe('revise');
    expect(detectPlanApproval('skip step 3')).toBe('revise');
    expect(detectPlanApproval('instead of netlify use vercel')).toBe('revise');
  });

  it('returns "other" for unclassifiable messages', () => {
    expect(detectPlanApproval('')).toBe('other');
    expect(detectPlanApproval('   ')).toBe('other');
    // Short unrelated questions don't match approve/cancel/revise patterns.
    // They fall through to 'other' so the caller can decide (in
    // practice: probably means "different topic, abandon the plan").
    expect(detectPlanApproval('what time is it?')).toBe('other');
    expect(detectPlanApproval('huh')).toBe('other');
    expect(detectPlanApproval('uhhh')).toBe('other');
  });
});

describe('detectPlanModeRequest (1.18.193 — opt-in plan mode)', () => {
  it('triggers on /plan prefix', () => {
    const result = detectPlanModeRequest('/plan build me a catalog HTML report');
    expect(result.requested).toBe(true);
    if (result.requested) {
      expect(result.cleaned).toBe('build me a catalog HTML report');
    }
  });

  it('triggers on /plan with leading whitespace', () => {
    const result = detectPlanModeRequest('  /plan find the project and deploy');
    expect(result.requested).toBe(true);
    if (result.requested) {
      expect(result.cleaned).toBe('find the project and deploy');
    }
  });

  it('triggers case-insensitively', () => {
    const result = detectPlanModeRequest('/PLAN do the thing');
    expect(result.requested).toBe(true);
  });

  it('triggers on [plan-mode] token anywhere', () => {
    const result = detectPlanModeRequest('Build me a report [plan-mode] for the catalog');
    expect(result.requested).toBe(true);
    if (result.requested) {
      // Token stripped, surrounding text preserved
      expect(result.cleaned).toContain('Build me a report');
      expect(result.cleaned).toContain('for the catalog');
      expect(result.cleaned).not.toContain('[plan-mode]');
    }
  });

  it('does NOT trigger on multi-step language without explicit opt-in', () => {
    // Multi-step, but no explicit /plan.
    // Should fall through to normal chat (Sonnet just runs it).
    expect(detectPlanModeRequest('lets knock out touch 4 for legalweek').requested).toBe(false);
    expect(detectPlanModeRequest('pull contacts from salesforce, send via gmail').requested).toBe(false);
    expect(detectPlanModeRequest('send 25 salesforce emails after you scrape them').requested).toBe(false);
  });

  it('does NOT trigger on incidental "plan" mentions', () => {
    expect(detectPlanModeRequest('what is the plan for today').requested).toBe(false);
    expect(detectPlanModeRequest('I have a plan').requested).toBe(false);
    expect(detectPlanModeRequest('we should plan this').requested).toBe(false);
  });

  it('handles empty / whitespace gracefully', () => {
    expect(detectPlanModeRequest('').requested).toBe(false);
    expect(detectPlanModeRequest('   ').requested).toBe(false);
  });

  it('strips trigger but preserves the rest of the message exactly', () => {
    const result = detectPlanModeRequest('/plan   build a thing\nand deploy it');
    expect(result.requested).toBe(true);
    if (result.requested) {
      // Internal whitespace/newlines preserved
      expect(result.cleaned).toBe('build a thing\nand deploy it');
    }
  });
});
