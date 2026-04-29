/**
 * Builder test runner — mock-safe execution of workflow step DAGs.
 *
 * Verifies:
 *  - prompt steps stub by default (no real LLM calls)
 *  - mcp write-shaped tools stub in mock mode; read-shaped invoke real
 *    when an invoke handler is registered
 *  - channel steps always stub
 *  - transform / conditional / loop steps actually evaluate
 *  - conditional false-branch steps are skipped on the false side
 *  - per-step timeout cancels long-running transforms
 *  - cancelRun aborts mid-run
 *  - events stream in expected order through the bus
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runWorkflowTest,
  cancelRun,
  registerMcpInvokeHandler,
} from '../src/dashboard/builder/runner.js';
import { onAnyBuilderEvent } from '../src/dashboard/builder/events.js';
import type { WorkflowDefinition, WorkflowStep } from '../src/types.js';

describe('Builder runner', () => {
  let unsubscribe: (() => void) | null = null;
  let captured: Array<{ type: string; payload?: any; runId?: string }> = [];

  beforeEach(() => {
    captured = [];
    unsubscribe = onAnyBuilderEvent((e) => { captured.push({ type: e.type, payload: e.payload as any, runId: e.runId }); });
  });
  afterEach(() => {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    // Reset MCP handler so we don't leak across tests
    (globalThis as any).__clementineMcpInvoke = undefined;
  });

  it('stubs prompt steps in mock mode (no LLM)', async () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'do something', dependsOn: [] })]);
    const result = await runWorkflowTest(wf, { workflowId: 'w1' });
    expect(result.status).toBe('ok');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].status).toBe('done');
    expect(result.stepResults[0].mocked).toBe(true);
    expect(String(result.stepResults[0].output)).toContain('[mock]');
  });

  it('emits run:started, step-status, step-output, run:completed events in order', async () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: 'x', dependsOn: [] })]);
    await runWorkflowTest(wf, { workflowId: 'w1' });
    const types = captured.map(c => c.type);
    expect(types[0]).toBe('run:started');
    expect(types).toContain('run:step-status');
    expect(types).toContain('run:step-output');
    expect(types[types.length - 1]).toBe('run:completed');
  });

  it('evaluates transform steps for real and threads outputs through steps map', async () => {
    const wf = wfOf([
      stepOf({ id: 's1', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: '{ value: 7 }' } }),
      stepOf({ id: 's2', prompt: '', dependsOn: ['s1'], kind: 'transform', transform: { expression: 'steps.s1.value * 2' } }),
    ]);
    const result = await runWorkflowTest(wf, { workflowId: 'w' });
    expect(result.status).toBe('ok');
    const s1 = result.stepResults.find(r => r.stepId === 's1')!;
    const s2 = result.stepResults.find(r => r.stepId === 's2')!;
    expect((s1.output as { value: number }).value).toBe(7);
    expect(s2.output).toBe(14);
    expect(s1.mocked).toBe(false);
    expect(s2.mocked).toBe(false);
  });

  it('mocks channel steps and templatizes content from prior step output', async () => {
    const wf = wfOf([
      stepOf({ id: 's1', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: '"hello world"' } }),
      stepOf({ id: 's2', prompt: '', dependsOn: ['s1'], kind: 'channel', channel: { channel: 'slack', target: '#me', content: 'msg: {{steps.s1}}' } }),
    ]);
    const result = await runWorkflowTest(wf, { workflowId: 'w' });
    const s2 = result.stepResults.find(r => r.stepId === 's2')!;
    expect(s2.mocked).toBe(true);
    expect(String(s2.output)).toContain('[mock]');
    expect(String(s2.output)).toContain('hello world');
  });

  it('mocks mcp write-shaped tools, invokes real for read-shaped tools', async () => {
    let callCount = 0;
    registerMcpInvokeHandler(async ({ tool }) => {
      callCount++;
      return { ok: true, tool };
    });
    const wf = wfOf([
      stepOf({ id: 'r', prompt: '', dependsOn: [], kind: 'mcp', mcp: { server: 'gmail', tool: 'list_unread' } }),
      stepOf({ id: 'w', prompt: '', dependsOn: ['r'], kind: 'mcp', mcp: { server: 'gmail', tool: 'send_email' } }),
    ]);
    const result = await runWorkflowTest(wf, { workflowId: 'wf' });
    const r = result.stepResults.find(s => s.stepId === 'r')!;
    const w = result.stepResults.find(s => s.stepId === 'w')!;
    expect(r.mocked).toBe(false);  // read-shaped, real invocation
    expect(w.mocked).toBe(true);   // write-shaped, stubbed in mock mode
    expect(callCount).toBe(1);     // only the read tool actually called
  });

  it('skips false-branch dependents when conditional resolves true', async () => {
    const wf = wfOf([
      stepOf({ id: 'cond', prompt: '', dependsOn: [], kind: 'conditional', conditional: { condition: 'true', trueNext: ['t1'], falseNext: ['f1'] } }),
      stepOf({ id: 't1', prompt: '', dependsOn: ['cond'], kind: 'transform', transform: { expression: '"true-path"' } }),
      stepOf({ id: 'f1', prompt: '', dependsOn: ['cond'], kind: 'transform', transform: { expression: '"false-path"' } }),
    ]);
    const result = await runWorkflowTest(wf, { workflowId: 'w' });
    const t1 = result.stepResults.find(s => s.stepId === 't1')!;
    const f1 = result.stepResults.find(s => s.stepId === 'f1')!;
    expect(t1.status).toBe('done');
    expect(f1.status).toBe('skipped');
  });

  it('cancels mid-run via cancelRun', async () => {
    // A long transform we can interrupt
    const wf = wfOf([
      stepOf({ id: 's1', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: '"first"' } }),
      // sleep loop in JS sandbox — we can't actually block; instead use a
      // very long busy-wait expression that the per-step timeout will hit
      stepOf({ id: 's2', prompt: '', dependsOn: ['s1'], kind: 'transform', transform: { expression: '(()=>{ const t=Date.now(); while(Date.now()-t<3000); return 1 })()' } }),
    ]);

    const runIdHolder: { runId?: string } = {};
    const captureRunId = onAnyBuilderEvent((e) => {
      if (e.type === 'run:started' && !runIdHolder.runId) runIdHolder.runId = e.runId;
    });

    // Kick off; cancel as soon as we have a runId
    const promise = runWorkflowTest(wf, { workflowId: 'wf', perStepTimeoutMs: 5000, totalBudgetMs: 6000 });
    // Wait briefly for the run to start
    await new Promise(r => setTimeout(r, 30));
    if (runIdHolder.runId) cancelRun(runIdHolder.runId);
    const result = await promise;
    captureRunId();
    expect(['cancelled', 'timeout', 'error']).toContain(result.status);
  });

  it('honors per-step timeout', async () => {
    const wf = wfOf([
      stepOf({ id: 's1', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: '(()=>{ const t=Date.now(); while(Date.now()-t<2000); return 1 })()' } }),
    ]);
    const result = await runWorkflowTest(wf, { workflowId: 'w', perStepTimeoutMs: 200, totalBudgetMs: 5000 });
    const s1 = result.stepResults[0];
    // Either the vm script timeout kicks in (synchronous error wrapped) or our timeout fires
    expect(['failed', 'timeout']).toContain(s1.status);
    expect(['error', 'timeout']).toContain(result.status);
  });

  it('continues to later waves after a step fails', async () => {
    const wf = wfOf([
      stepOf({ id: 'good', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: '"ok"' } }),
      stepOf({ id: 'bad', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: 'throw new Error("boom")' } }),
      stepOf({ id: 'after', prompt: '', dependsOn: ['good'], kind: 'transform', transform: { expression: '"reached"' } }),
    ]);
    const result = await runWorkflowTest(wf, { workflowId: 'w' });
    expect(result.stepResults.find(s => s.stepId === 'good')!.status).toBe('done');
    expect(result.stepResults.find(s => s.stepId === 'bad')!.status).toBe('failed');
    expect(result.stepResults.find(s => s.stepId === 'after')!.status).toBe('done');
    expect(result.status).toBe('error');
  });

  it('does not leak require/process into transform sandbox', async () => {
    const wf = wfOf([stepOf({ id: 's1', prompt: '', dependsOn: [], kind: 'transform', transform: { expression: 'typeof require + "/" + typeof process' } })]);
    const result = await runWorkflowTest(wf, { workflowId: 'w' });
    expect(result.stepResults[0].output).toBe('undefined/undefined');
  });
});

// ── helpers ────────────────────────────────────────────────────────

function wfOf(steps: WorkflowStep[]): WorkflowDefinition {
  return {
    name: 't',
    description: '',
    enabled: true,
    trigger: { manual: true },
    inputs: {},
    steps,
    sourceFile: '',
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
