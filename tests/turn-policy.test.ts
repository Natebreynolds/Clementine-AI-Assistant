import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../src/agent/intent-classifier.js';
import { decideTurn, decideTurnPolicy } from '../src/agent/turn-policy.js';

function policy(text: string, hasRecentContext = false) {
  return decideTurnPolicy({
    text,
    intent: classifyIntent(text, hasRecentContext ? [{ user: 'old', assistant: 'old answer' }] : undefined),
    hasRecentContext,
  });
}

function decision(text: string, hasRecentContext = false) {
  return decideTurn({
    text,
    intent: classifyIntent(text, hasRecentContext ? [{ user: 'old', assistant: 'old answer' }] : undefined),
    hasRecentContext,
  });
}

describe('turn policy', () => {
  it('keeps casual turns on the no-memory/no-tool fast path', () => {
    const p = policy('thanks');

    expect(p.retrievalTier).toBe('none');
    expect(p.disableAllTools).toBe(true);
    expect(p.enableTeams).toBe(false);
    expect(p.maxTurns).toBeLessThanOrEqual(3);
  });

  it('isolates standalone greetings from stale action context', () => {
    const p = policy('hey', true);

    expect(p.reason).toBe('standalone-greeting');
    expect(p.retrievalTier).toBe('none');
    expect(p.disableAllTools).toBe(true);
    expect(p.suppressSessionResume).toBe(true);
    expect(p.suppressContextInjection).toBe(true);
  });

  it('isolates common standalone greeting variants', () => {
    expect(policy('hey there', true).reason).toBe('standalone-greeting');
    expect(policy('hi Clementine!', true).reason).toBe('standalone-greeting');
  });

  it('does not isolate greetings that include an explicit task', () => {
    const p = policy('hey can you check the logs', true);

    expect(p.suppressSessionResume).toBeUndefined();
    expect(p.disableAllTools).toBe(false);
  });

  it('does not fast-path explicit memory continuity requests', () => {
    const p = policy('what did I say last time about the release?');

    expect(p.retrievalTier).toBe('search');
    expect(p.disableAllTools).toBe(false);
  });

  it('keeps local repo work tool-enabled without enabling teams by default', () => {
    const p = policy('run the tests and fix the failing file');

    expect(p.retrievalTier).toBe('search');
    expect(p.disableAllTools).toBe(false);
    expect(p.enableTeams).toBe(false);
  });

  it('promotes broad analysis to the full context path with teams enabled', () => {
    const p = policy('analyze the entire agentic flow across all conversations and recommend improvements');

    expect(p.retrievalTier).toBe('full');
    expect(p.disableAllTools).toBe(false);
    expect(p.enableTeams).toBe(true);
  });

  it('routes explicit full-surface requests to the full policy', () => {
    const p = policy('debug this with all integrations and full tool surface');

    expect(p.retrievalTier).toBe('full');
    expect(p.disableAllTools).toBe(false);
    expect(p.enableTeams).toBe(true);
  });

  it('classifies casual fast paths as lightweight LLM turns', () => {
    const d = decision('thanks');

    expect(d.mode).toBe('lightweight_llm');
    expect(d.userVisibleStatus).toBe('answering');
    expect(d.policy.disableAllTools).toBe(true);
  });

  it('surfaces routed tool turns explicitly', () => {
    const d = decision('check the Outlook inbox for Ross follow-up replies');

    expect(d.mode).toBe('tool_llm');
    expect(d.userVisibleStatus).toBe('checking tools');
    expect(d.toolRoute.bundles).toEqual(['email_outlook']);
  });

  it('routes explicit sustained-work requests to background mode', () => {
    const d = decision('keep working on the repo audit in the background until it is done');

    expect(d.mode).toBe('background');
    expect(d.userVisibleStatus).toBe('working in background');
  });
});
