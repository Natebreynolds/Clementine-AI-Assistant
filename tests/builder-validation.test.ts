/**
 * Builder validation + dry-run.
 *
 * Verifies the static checks and the safe describe-without-executing
 * walk for long-running jobs.
 */

import { describe, expect, it } from 'vitest';
import { validateWorkflow, isCronExpression } from '../src/dashboard/builder/validation.js';
import { dryRunWorkflow } from '../src/dashboard/builder/dry-run.js';
import type { WorkflowDefinition, WorkflowStep } from '../src/types.js';

describe('Builder — validateWorkflow', () => {
  it('passes a minimal valid workflow', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'hello', dependsOn: [] })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('catches empty name', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [] })], { name: '' });
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'name-empty')).toBe(true);
  });

  it('catches no steps', () => {
    const wf = wfOf([]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'no-steps')).toBe(true);
  });

  it('catches duplicate step ids', () => {
    const wf = wfOf([
      stepOf({ id: 's1', prompt: 'x', dependsOn: [] }),
      stepOf({ id: 's1', prompt: 'y', dependsOn: [] }),
    ]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'duplicate-step-id')).toBe(true);
  });

  it('catches missing dependency reference', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: ['nope'] })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'missing-dep')).toBe(true);
  });

  it('catches self-dependency', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: ['s1'] })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'self-dep')).toBe(true);
  });

  it('catches a cycle through multiple steps', () => {
    const wf = wfOf([
      stepOf({ id: 'a', prompt: 'a', dependsOn: ['c'] }),
      stepOf({ id: 'b', prompt: 'b', dependsOn: ['a'] }),
      stepOf({ id: 'c', prompt: 'c', dependsOn: ['b'] }),
    ]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'cycle')).toBe(true);
  });

  it('rejects mcp step with missing config', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [], kind: 'mcp' })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'mcp-missing')).toBe(true);
  });

  it('rejects mcp step missing server or tool', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [], kind: 'mcp', mcp: { server: '', tool: '' } as any })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'mcp-no-server')).toBe(true);
    expect(r.issues.some(i => i.code === 'mcp-no-tool')).toBe(true);
  });

  it('rejects channel step missing target', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [], kind: 'channel', channel: { channel: 'slack', target: '', content: 'hi' } as any })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'channel-no-target')).toBe(true);
  });

  it('warns on long prompts', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'a'.repeat(6000), dependsOn: [] })]);
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(true);  // warning, not error
  });

  it('warns when enabled with neither schedule nor manual', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [] })], { enabled: true, trigger: { manual: false } });
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(true);
    expect(r.issues.some(i => i.code === 'enabled-no-trigger' && i.severity === 'warning')).toBe(true);
  });

  it('rejects bad cron expression', () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [] })], { trigger: { schedule: 'every monday' } });
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'bad-schedule')).toBe(true);
  });
});

describe('isCronExpression', () => {
  it('accepts standard 5-field cron', () => {
    expect(isCronExpression('0 9 * * *')).toBe(true);
    expect(isCronExpression('*/5 * * * *')).toBe(true);
    expect(isCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isCronExpression('0,30 8-17 * * 1-5')).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(isCronExpression('every monday')).toBe(false);
    expect(isCronExpression('0 9 *')).toBe(false);  // 3 fields
    expect(isCronExpression('')).toBe(false);
  });
});

describe('Builder — dryRunWorkflow', () => {
  it('returns step descriptions in topological order', () => {
    const wf = wfOf([
      stepOf({ id: 's1', prompt: 'first', dependsOn: [] }),
      stepOf({ id: 's2', prompt: 'second', dependsOn: ['s1'] }),
      stepOf({ id: 's3', prompt: 'third', dependsOn: ['s2'] }),
    ]);
    const r = dryRunWorkflow(wf);
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.stepId)).toEqual(['s1', 's2', 's3']);
    expect(r.steps[0].wave).toBe(0);
    expect(r.steps[2].wave).toBe(2);
  });

  it('describes mcp steps without executing', () => {
    const wf = wfOf([stepOf({
      id: 's1', prompt: '', dependsOn: [],
      kind: 'mcp', mcp: { server: 'salesforce', tool: 'create_lead', inputs: { name: 'Acme' } },
    })]);
    const r = dryRunWorkflow(wf);
    expect(r.steps[0].description).toContain('salesforce.create_lead');
    expect(r.steps[0].description).toContain('Acme');
    // Heuristic warning for write-shaped tool
    expect(r.steps[0].warnings.some(w => /write|destructive/i.test(w))).toBe(true);
  });

  it('describes channel steps without executing', () => {
    const wf = wfOf([stepOf({
      id: 's1', prompt: '', dependsOn: [],
      kind: 'channel', channel: { channel: 'slack', target: '#me', content: 'hello' },
    })]);
    const r = dryRunWorkflow(wf);
    expect(r.steps[0].description).toContain('slack');
    expect(r.steps[0].description).toContain('#me');
  });

  it('warns on email channel without @', () => {
    const wf = wfOf([stepOf({
      id: 's1', prompt: '', dependsOn: [],
      kind: 'channel', channel: { channel: 'email', target: 'invalid', content: 'hi' },
    })]);
    const r = dryRunWorkflow(wf);
    expect(r.steps[0].warnings.some(w => /email/i.test(w))).toBe(true);
  });

  it('estimates cost for prompt steps', () => {
    const wf = wfOf([
      stepOf({ id: 'a', prompt: 'one', dependsOn: [] }),
      stepOf({ id: 'b', prompt: 'two', dependsOn: ['a'] }),
    ]);
    const r = dryRunWorkflow(wf);
    expect(r.estimatedTokens).toBeDefined();
    expect(r.estimatedTokens!.promptSteps).toBe(2);
  });

  it('marks ok=false when validation fails (cycle)', () => {
    const wf = wfOf([
      stepOf({ id: 'a', prompt: 'a', dependsOn: ['b'] }),
      stepOf({ id: 'b', prompt: 'b', dependsOn: ['a'] }),
    ]);
    const r = dryRunWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.validationIssues.some(i => i.code === 'cycle')).toBe(true);
  });
});

// ── helpers ────────────────────────────────────────────────────────────

function wfOf(steps: WorkflowStep[], overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-wf',
    description: '',
    enabled: true,
    trigger: { manual: true },
    inputs: {},
    steps,
    sourceFile: '',
    ...overrides,
  };
}

function stepOf(partial: Partial<WorkflowStep> & { id: string; prompt: string }): WorkflowStep {
  return {
    id: partial.id,
    prompt: partial.prompt,
    dependsOn: partial.dependsOn ?? [],
    tier: partial.tier ?? 1,
    maxTurns: partial.maxTurns ?? 15,
    model: partial.model,
    workDir: partial.workDir,
    kind: partial.kind,
    mcp: partial.mcp,
    channel: partial.channel,
    transform: partial.transform,
    conditional: partial.conditional,
    loop: partial.loop,
  };
}
