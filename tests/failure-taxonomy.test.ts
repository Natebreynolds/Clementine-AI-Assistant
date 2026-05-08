/**
 * PRD §9 — failure taxonomy classifier. Sanity checks for the most
 * important mappings: terminalReason precedence, error-string heuristics,
 * non-failure short-circuit.
 */

import { describe, it, expect } from 'vitest';
import { classifyRunFailure } from '../src/gateway/failure-taxonomy.js';
import type { CronRunEntry } from '../src/types.js';

function entry(over: Partial<CronRunEntry>): CronRunEntry {
  return {
    jobName: 'test',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'error',
    durationMs: 100,
    attempt: 1,
    ...over,
  } as CronRunEntry;
}

describe('classifyRunFailure', () => {
  it('returns null for successful runs', () => {
    expect(classifyRunFailure(entry({ status: 'ok' }))).toBeNull();
  });

  it('returns null for skipped/running runs', () => {
    expect(classifyRunFailure(entry({ status: 'skipped' }))).toBeNull();
    expect(classifyRunFailure(entry({ status: 'running' }))).toBeNull();
  });

  it('maps lost status to infrastructure_error', () => {
    expect(classifyRunFailure(entry({ status: 'lost' }))).toBe('infrastructure_error');
  });

  it('maps timeout status to tool_timeout', () => {
    expect(classifyRunFailure(entry({ status: 'timeout' }))).toBe('tool_timeout');
  });

  it('terminalReason max_turns → agent_loop_error', () => {
    expect(classifyRunFailure(entry({ terminalReason: 'max_turns' }))).toBe('agent_loop_error');
  });

  it('terminalReason prompt_too_long → context_error', () => {
    expect(classifyRunFailure(entry({ terminalReason: 'prompt_too_long' }))).toBe('context_error');
  });

  it('terminalReason aborted_streaming → cancelled', () => {
    expect(classifyRunFailure(entry({ terminalReason: 'aborted_streaming' }))).toBe('cancelled');
  });

  it('terminalReason hook_stopped → prompt_error', () => {
    expect(classifyRunFailure(entry({ terminalReason: 'hook_stopped' }))).toBe('prompt_error');
  });

  it('error string with "rate limit" → model_error', () => {
    expect(classifyRunFailure(entry({ error: 'Got 429 rate limit response' }))).toBe('model_error');
  });

  it('error string with "401 unauthorized" → model_error', () => {
    expect(classifyRunFailure(entry({ error: 'Request failed: 401 unauthorized' }))).toBe('model_error');
  });

  it('error string with "context too long" → context_error', () => {
    expect(classifyRunFailure(entry({ error: 'context window exceeded — input is too long' }))).toBe('context_error');
  });

  it('error string with "schema validation" → schema_error', () => {
    expect(classifyRunFailure(entry({ error: 'Tool output failed schema validation' }))).toBe('schema_error');
  });

  it('error string with "ENOENT" → infrastructure_error', () => {
    expect(classifyRunFailure(entry({ error: 'spawn ENOENT' }))).toBe('infrastructure_error');
  });

  it('error string with "permission denied" → prompt_error', () => {
    expect(classifyRunFailure(entry({ error: 'permission denied by hook' }))).toBe('prompt_error');
  });

  it('error string with "subagent failed" → subagent_error', () => {
    expect(classifyRunFailure(entry({ error: 'delegated agent failed mid-step' }))).toBe('subagent_error');
  });

  it('falls back to tool_error for generic non-empty errors', () => {
    expect(classifyRunFailure(entry({ error: 'something went wrong' }))).toBe('tool_error');
  });

  it('falls back to infrastructure_error when error is empty', () => {
    expect(classifyRunFailure(entry({ error: '' }))).toBe('infrastructure_error');
  });
});
