import { describe, expect, it } from 'vitest';
import { StallGuard } from '../src/agent/stall-guard.js';

describe('StallGuard duplicate guard', () => {
  it('blocks the fourth identical idempotent tool call in a turn', () => {
    const guard = new StallGuard();
    const input = { query: 'SELECT * FROM leads LIMIT 20' };

    for (let i = 0; i < 3; i++) {
      expect(guard.shouldBlockTool('mcp__dataforseo__ranked_keywords', input).block).toBe(false);
      guard.recordToolCall('mcp__dataforseo__ranked_keywords', input);
    }

    const decision = guard.shouldBlockTool('mcp__dataforseo__ranked_keywords', input);
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('Duplicate tool call blocked');
  });

  it('does not duplicate-block changed inputs', () => {
    const guard = new StallGuard();

    for (let i = 0; i < 4; i++) {
      const input = { query: `SELECT * FROM leads WHERE id = ${i} LIMIT 20` };
      expect(guard.shouldBlockTool('mcp__salesforce__query', input).block).toBe(false);
      guard.recordToolCall('mcp__salesforce__query', input);
    }
  });
});
