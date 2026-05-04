import { describe, expect, it } from 'vitest';
import { assessGatewayContextHygiene, formatGatewayHygieneAnnotation } from '../src/gateway/context-hygiene.js';

describe('gateway context hygiene', () => {
  it('requests compaction before the hard session limit', () => {
    const decision = assessGatewayContextHygiene({
      sessionKey: 'discord:user:1',
      textChars: 100,
      exchangeCount: 30,
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toContain('exchange_count');
    expect(formatGatewayHygieneAnnotation(decision)).toContain('transcript_search');
  });

  it('leaves small sessions alone', () => {
    const decision = assessGatewayContextHygiene({
      sessionKey: 'discord:user:1',
      textChars: 100,
      exchangeCount: 2,
    });
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe('within_budget');
  });
});
