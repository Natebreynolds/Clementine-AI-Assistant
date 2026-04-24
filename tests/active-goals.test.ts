/**
 * Tests for the always-on active-goals context block. Verifies the
 * fallback is scoped correctly per agent and sorts by priority.
 */

import { describe, it, expect } from 'vitest';
import { buildActiveGoalsBlock, type ProactiveGoalInput } from '../src/agent/assistant.js';

function g(
  title: string,
  priority: 'high' | 'medium' | 'low',
  owner: string,
  nextActions?: string[],
): ProactiveGoalInput {
  return { goal: { title, priority, owner, nextActions } };
}

describe('buildActiveGoalsBlock', () => {
  it('returns empty string when no goals', () => {
    expect(buildActiveGoalsBlock([])).toBe('');
  });

  it('renders goals in priority order (high first)', () => {
    const block = buildActiveGoalsBlock([
      g('Low thing', 'low', 'clementine'),
      g('High thing', 'high', 'clementine'),
      g('Medium thing', 'medium', 'clementine'),
    ]);
    const highIdx = block.indexOf('High thing');
    const medIdx = block.indexOf('Medium thing');
    const lowIdx = block.indexOf('Low thing');
    expect(highIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it('includes nextAction arrow when present', () => {
    const block = buildActiveGoalsBlock([
      g('Task', 'high', 'clementine', ['do the thing']),
    ]);
    expect(block).toContain('Task → do the thing');
  });

  it('omits nextAction arrow when absent', () => {
    const block = buildActiveGoalsBlock([g('Task', 'high', 'clementine')]);
    expect(block).toContain('Task');
    expect(block).not.toContain('→');
  });

  it('filters by agent ownership (agent + clementine only)', () => {
    const block = buildActiveGoalsBlock(
      [
        g('Sales goal', 'high', 'sales-agent'),
        g('Other goal', 'high', 'research-agent'),
        g('Shared goal', 'high', 'clementine'),
      ],
      'sales-agent',
    );
    expect(block).toContain('Sales goal');
    expect(block).toContain('Shared goal');
    expect(block).not.toContain('Other goal');
  });

  it('caps at the configured entry count', () => {
    const goals = Array.from({ length: 10 }, (_, i) => g(`Goal ${i}`, 'high', 'clementine'));
    const block = buildActiveGoalsBlock(goals, null, 3);
    expect(block).toContain('Goal 0');
    expect(block).toContain('Goal 2');
    expect(block).not.toContain('Goal 3');
  });

  it('returns empty when agent has no owned or shared goals', () => {
    const block = buildActiveGoalsBlock(
      [g('Other goal', 'high', 'research-agent')],
      'sales-agent',
    );
    expect(block).toBe('');
  });

  it('truncates long nextAction text to 80 chars', () => {
    const long = 'x'.repeat(150);
    const block = buildActiveGoalsBlock([g('Task', 'high', 'clementine', [long])]);
    expect(block).toContain('x'.repeat(80));
    expect(block).not.toContain('x'.repeat(81));
  });
});
