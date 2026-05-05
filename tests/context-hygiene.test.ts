import { describe, expect, it } from 'vitest';
import { assessGatewayContextHygiene, formatGatewayHygieneAnnotation } from '../src/gateway/context-hygiene.js';

describe('gateway context hygiene', () => {
  it('requests compaction before the hard session limit', () => {
    const decision = assessGatewayContextHygiene({
      sessionKey: 'discord:user:1',
      textChars: 100,
      exchangeCount: 100,
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

  it('leaves moderately long sessions alone (raised thresholds)', () => {
    // 30 exchanges + 90K used to trip compaction. With the new ceilings
    // (100 exchanges / 180K tokens), normal long chats stay untouched and
    // the SDK's autocompact owns the actual context-window dance.
    const decision = assessGatewayContextHygiene({
      sessionKey: 'discord:user:1',
      textChars: 100,
      exchangeCount: 30,
    });
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe('within_budget');
  });
});
