import { describe, expect, it } from 'vitest';
import {
  assessActionResponse,
  buildApprovalFollowupPrompt,
  detectActionExpectation,
} from '../src/agent/action-enforcer.js';
import { classifyIntent } from '../src/agent/intent-classifier.js';
import { decideTurnPolicy } from '../src/agent/turn-policy.js';

describe('action enforcer', () => {
  it('recognizes long-form create/scrape requests as action expected', () => {
    const expectation = detectActionExpectation(
      'I would like for you to start a scrape of 20 top PI firms and add it to a new Google Sheet',
    );

    expect(expectation).toMatchObject({
      expected: true,
      source: 'user_request',
    });
  });

  it('recognizes "can we" execution requests without requiring "can you"', () => {
    const expectation = detectActionExpectation('Can we fire them off now as a test please');
    expect(expectation.expected).toBe(true);
  });

  it('promotes approval follow-ups into tool-enabled action turns', () => {
    const prompt = buildApprovalFollowupPrompt('Perfect');
    const policy = decideTurnPolicy({
      text: prompt,
      intent: classifyIntent(prompt),
      hasRecentContext: true,
    });

    expect(policy.disableAllTools).toBe(false);
    expect(['task-or-tool-request', 'memory-plus-task']).toContain(policy.reason);
  });

  it('allows initial approval prompts before sensitive action', () => {
    const expectation = detectActionExpectation('can you send a test email to james please');

    expect(assessActionResponse({
      actionExpectation: expectation,
      userText: 'can you send a test email to james please',
      response: "Before I fire it off, here's what I'd send. Good to go?",
      toolActivityCount: 0,
    })).toEqual({
      violation: false,
      reason: 'assistant requested approval before acting',
    });
  });

  it('rejects a second approval prompt after the user already approved', () => {
    const expectation = detectActionExpectation('Perfect', { approvalFollowup: true });

    expect(assessActionResponse({
      actionExpectation: expectation,
      userText: 'Perfect',
      response: 'Good to go?',
      toolActivityCount: 0,
    })).toMatchObject({
      violation: true,
      reason: 'asked for approval again after the user already approved',
    });
  });

  it('rejects done claims and empty acknowledgments without tool activity', () => {
    const expectation = detectActionExpectation('Perfect', { approvalFollowup: true });

    expect(assessActionResponse({
      actionExpectation: expectation,
      userText: 'Perfect',
      response: 'Got it.',
      toolActivityCount: 0,
    }).violation).toBe(true);

    expect(assessActionResponse({
      actionExpectation: expectation,
      userText: 'Perfect',
      response: 'Done. Email sent — 202 Accepted from Outlook.',
      toolActivityCount: 0,
    }).violation).toBe(true);
  });

  it('rejects avoidable diagnostic deflection when local tools should be used', () => {
    const expectation = detectActionExpectation('can you figure out why insight check is crashing?');

    expect(assessActionResponse({
      actionExpectation: expectation,
      userText: 'can you figure out why insight check is crashing?',
      response: 'What are you seeing in the logs?',
      toolActivityCount: 0,
    })).toMatchObject({
      violation: true,
      reason: 'asked user for logs instead of using available local tools',
    });
  });

  it('accepts verified action when tool activity happened', () => {
    const expectation = detectActionExpectation('Perfect', { approvalFollowup: true });

    expect(assessActionResponse({
      actionExpectation: expectation,
      userText: 'Perfect',
      response: 'Done. Email sent.',
      toolActivityCount: 1,
    }).violation).toBe(false);
  });
});
