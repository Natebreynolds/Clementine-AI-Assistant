/**
 * goal-evaluator: schema validation path. The evaluator-agent path requires
 * a real SDK call so we don't unit-test that here — the orchestrator's
 * fallback behavior (no schema, no criterion → undefined goalCheck) is
 * covered by runGoalCheck's early-return.
 */

import { describe, it, expect } from 'vitest';
import { validateAgainstSchema, runGoalCheck } from '../src/agent/goal-evaluator.js';
import type { CronJobDefinition } from '../src/types.js';

describe('validateAgainstSchema', () => {
  it('passes when the response is a valid JSON object matching the schema', async () => {
    const schema = {
      type: 'object',
      required: ['sent'],
      properties: { sent: { type: 'boolean' } },
    };
    const result = await validateAgainstSchema('{"sent": true}', schema);
    expect(result.tried).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails with ajv error messages when validation fails', async () => {
    const schema = {
      type: 'object',
      required: ['sent'],
      properties: { sent: { type: 'boolean' } },
    };
    const result = await validateAgainstSchema('{"sent": "yes"}', schema);
    expect(result.tried).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('extracts JSON from a fenced ```json block', async () => {
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
    const responseText = 'Here is the result:\n\n```json\n{"ok": true}\n```\n\nDone.';
    const result = await validateAgainstSchema(responseText, schema);
    expect(result.tried).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('returns tried=false when no JSON can be extracted', async () => {
    const schema = { type: 'object' };
    const result = await validateAgainstSchema('No JSON in this response at all.', schema);
    expect(result.tried).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.errors[0]).toContain('No JSON');
  });

  it('falls back to first {...} substring when whole-text and fenced block both fail', async () => {
    const schema = { type: 'object', required: ['count'], properties: { count: { type: 'number' } } };
    const responseText = 'The agent reports: {"count": 42} which I think is correct.';
    const result = await validateAgainstSchema(responseText, schema);
    expect(result.tried).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe('runGoalCheck', () => {
  const baseJob: CronJobDefinition = {
    name: 'test-job',
    schedule: '0 9 * * *',
    prompt: 'do the thing',
    enabled: true,
    tier: 1,
  };

  it('returns undefined when no goal is configured', async () => {
    const result = await runGoalCheck('any output', baseJob);
    expect(result).toBeUndefined();
  });

  it('returns pass when the schema validates and no criterion is set', async () => {
    const job: CronJobDefinition = {
      ...baseJob,
      successSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    };
    const result = await runGoalCheck('{"ok": true}', job);
    expect(result).toBeDefined();
    expect(result!.status).toBe('pass');
    expect(result!.mode).toBe('schema');
    expect(result!.schemaPass).toBe(true);
  });

  it('returns fail when the schema does not validate', async () => {
    const job: CronJobDefinition = {
      ...baseJob,
      successSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    };
    const result = await runGoalCheck('{"ok": "no"}', job);
    expect(result).toBeDefined();
    expect(result!.status).toBe('fail');
    expect(result!.schemaPass).toBe(false);
    expect(result!.schemaErrors).toBeDefined();
    expect(result!.schemaErrors!.length).toBeGreaterThan(0);
  });

  it('returns fail when no JSON can be extracted from the response', async () => {
    const job: CronJobDefinition = {
      ...baseJob,
      successSchema: { type: 'object' },
    };
    const result = await runGoalCheck('Plain text, no JSON.', job);
    expect(result).toBeDefined();
    expect(result!.status).toBe('fail');
  });
});
