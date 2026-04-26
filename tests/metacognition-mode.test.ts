/**
 * Phase 9c — verify MetacognitiveMonitor's mode parameter correctly suppresses
 * the high_effort_low_output heuristic for cron + unleashed contexts, while
 * keeping circular_reasoning + research_without_action active in all modes.
 */

import { describe, expect, it } from 'vitest';
import { MetacognitiveMonitor } from '../src/agent/metacognition.js';

function fireBashCalls(m: MetacognitiveMonitor, count: number, distinct = true): void {
  for (let i = 0; i < count; i++) {
    // Distinct inputs each call so circular_reasoning doesn't fire prematurely
    m.recordToolCall('Bash', distinct ? { cmd: `echo ${i}` } : { cmd: 'echo same' });
  }
}

describe('MetacognitiveMonitor — chat mode', () => {
  it('warns at >20 tool calls with <200 chars output', () => {
    const m = new MetacognitiveMonitor('chat');
    fireBashCalls(m, 20);
    const sig = m.recordToolCall('Bash', { cmd: 'echo 21' });
    expect(sig.type).toBe('warn');
    expect(sig.reason).toBe('high_effort_low_output');
  });

  it('intervenes at >=60 tool calls with <200 chars output', () => {
    const m = new MetacognitiveMonitor('chat');
    fireBashCalls(m, 60);
    const sig = m.recordToolCall('Bash', { cmd: 'echo last' });
    expect(sig.type).toBe('intervene');
    expect(sig.reason).toBe('high_effort_low_output');
  });
});

describe('MetacognitiveMonitor — cron mode', () => {
  it('does NOT fire high_effort_low_output even at 100+ tool calls', () => {
    const m = new MetacognitiveMonitor('cron');
    fireBashCalls(m, 100);
    const sig = m.recordToolCall('Bash', { cmd: 'echo end' });
    expect(sig.reason).not.toBe('high_effort_low_output');
    expect(sig.type === 'intervene' && sig.reason === 'high_effort_low_output').toBe(false);
  });

  it('still catches circular_reasoning (same tool, same input, 3+ times)', () => {
    const m = new MetacognitiveMonitor('cron');
    m.recordToolCall('Bash', { cmd: 'echo same' });
    m.recordToolCall('Bash', { cmd: 'echo same' });
    const sig = m.recordToolCall('Bash', { cmd: 'echo same' });
    expect(sig.type).toBe('intervene');
    expect(sig.reason).toBe('circular_reasoning');
  });
});

describe('MetacognitiveMonitor — unleashed mode', () => {
  it('does NOT fire high_effort_low_output (same as cron)', () => {
    const m = new MetacognitiveMonitor('unleashed');
    fireBashCalls(m, 100);
    const sig = m.recordToolCall('Bash', { cmd: 'echo end' });
    expect(sig.reason).not.toBe('high_effort_low_output');
  });

  it('still catches research_without_action on consecutive reads', () => {
    const m = new MetacognitiveMonitor('unleashed');
    for (let i = 0; i < 11; i++) m.recordToolCall('Read', { file_path: `/tmp/f${i}` });
    const sig = m.recordToolCall('Read', { file_path: '/tmp/last' });
    expect(sig.type).toBe('intervene');
    expect(sig.reason).toBe('research_without_action');
  });
});

describe('MetacognitiveMonitor — default mode is chat', () => {
  it('zero-arg constructor still applies chat-mode thresholds', () => {
    const m = new MetacognitiveMonitor();
    fireBashCalls(m, 60);
    const sig = m.recordToolCall('Bash', { cmd: 'echo last' });
    expect(sig.reason).toBe('high_effort_low_output');
  });
});
