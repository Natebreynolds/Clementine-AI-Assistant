import { describe, expect, it } from 'vitest';
import { decideContextPolicy } from '../src/gateway/context-policy.js';

describe('context policy', () => {
  it('keeps greetings visible and operational context silent', () => {
    const decision = decideContextPolicy({
      text: 'hey',
      activeContext: {
        sessionKey: 'discord:user:123',
        items: [],
        promptBlock: '[Context governance: active working set]\nold failure\n[/Context governance: active working set]',
        greetingLine: 'Hey. I am here. Still working on bg-test.',
      },
    });

    expect(decision.turnIntent).toBe('greeting');
    expect(decision.visibleOpening).toBe('Hey. I am here.');
    expect(decision.silentContextBlocks).toHaveLength(0);
  });

  it('requires transcript retrieval for vague repair follow-ups', () => {
    const decision = decideContextPolicy({
      text: 'How do we fix that issue?',
      activeContext: {
        sessionKey: 'discord:user:123',
        items: [{
          source: 'notification',
          label: 'cron_failure: audit-inbox-check',
          detail: 'Task aborted after 3 phase errors.',
          priority: 70,
          sourceId: 'audit-inbox-check',
        }],
        promptBlock: '[Context governance: active working set]\naudit-inbox-check\n[/Context governance: active working set]',
        greetingLine: null,
      },
    });

    expect(decision.turnIntent).toBe('repair_request');
    expect(decision.requiredRetrieval).toBe('transcript');
    expect(decision.retrievalQueries.join(' ')).toContain('audit-inbox-check');
    expect(decision.silentContextBlocks).toHaveLength(1);
  });
});

