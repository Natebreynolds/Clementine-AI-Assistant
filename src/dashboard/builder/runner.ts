/**
 * Builder workflow test runner.
 *
 * Executes a workflow's step DAG in topological waves, streaming per-step
 * status + output events through the events bus so the dashboard canvas
 * can light up in real time.
 *
 * Safety posture for **test mode** (the default for canvas runs):
 *   - Prompt steps: stubbed by default (no LLM tokens, no agent turns).
 *     Real-mode runs through the production scheduler, not here.
 *   - MCP steps: read-only-shaped tools invoke for real (list_/get_/
 *     read_/search_); write-shaped tools are stubbed unless mode='real'.
 *   - Channel steps: always stubbed in the test runner. Real channel
 *     sends should happen on a scheduled run, not from a canvas test.
 *   - Transform / conditional / loop: real evaluation (sandboxed JS,
 *     short timeout). They have no external side effects.
 *
 * Long-running awareness:
 *   - Per-step timeout (default 30s)
 *   - Total budget cap (default 60s wall-clock)
 *   - AbortSignal cancellation; canceller killed between steps and
 *     during transform/conditional/loop evaluation.
 */

import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
} from '../../types.js';
import { emitBuilderEvent } from './events.js';

export type RunMode = 'mock' | 'real';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'timeout';

export interface RunOptions {
  workflowId: string;
  runId?: string;
  mode?: RunMode;
  perStepTimeoutMs?: number;
  totalBudgetMs?: number;
  signal?: AbortSignal;
}

export interface StepResult {
  stepId: string;
  status: StepStatus;
  durationMs: number;
  output?: unknown;
  error?: string;
  mocked?: boolean;
}

export interface RunResult {
  runId: string;
  workflowId: string;
  mode: RunMode;
  status: 'ok' | 'error' | 'cancelled' | 'timeout';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stepResults: StepResult[];
}

/** Map of running runId → AbortController so a separate cancel call can kill in-flight runs. */
const activeRuns = new Map<string, AbortController>();

export function cancelRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export async function runWorkflowTest(
  wf: WorkflowDefinition,
  opts: RunOptions,
): Promise<RunResult> {
  const runId = opts.runId ?? randomUUID();
  const mode: RunMode = opts.mode ?? 'mock';
  const perStepTimeoutMs = opts.perStepTimeoutMs ?? 30_000;
  const totalBudgetMs = opts.totalBudgetMs ?? 60_000;

  const controller = new AbortController();
  activeRuns.set(runId, controller);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const outputs = new Map<string, unknown>();
  const stepResults: StepResult[] = [];

  emitBuilderEvent({
    type: 'run:started',
    workflowId: opts.workflowId,
    runId,
    payload: { mode, stepCount: wf.steps.length, perStepTimeoutMs, totalBudgetMs },
  });

  let overallStatus: RunResult['status'] = 'ok';
  const waves = computeWaves(wf.steps);

  try {
    for (const wave of waves) {
      if (controller.signal.aborted) { overallStatus = 'cancelled'; break; }
      if (performance.now() - startMs > totalBudgetMs) { overallStatus = 'timeout'; break; }

      for (const step of wave) {
        if (controller.signal.aborted) { overallStatus = 'cancelled'; break; }
        if (performance.now() - startMs > totalBudgetMs) { overallStatus = 'timeout'; break; }

        const skipReason = shouldSkipFromConditional(step, wf, outputs);
        if (skipReason) {
          stepResults.push({ stepId: step.id, status: 'skipped', durationMs: 0, output: skipReason, mocked: true });
          emitBuilderEvent({ type: 'run:step-status', workflowId: opts.workflowId, runId, payload: { stepId: step.id, status: 'skipped', reason: skipReason } });
          continue;
        }

        emitBuilderEvent({ type: 'run:step-status', workflowId: opts.workflowId, runId, payload: { stepId: step.id, status: 'running' } });

        const stepStart = performance.now();
        let result: StepResult;
        try {
          const out = await runWithTimeout(
            () => executeStep(step, wf, outputs, mode, controller.signal),
            perStepTimeoutMs,
            controller.signal,
          );
          outputs.set(step.id, out.output);
          result = {
            stepId: step.id,
            status: 'done',
            durationMs: Math.round(performance.now() - stepStart),
            output: out.output,
            mocked: out.mocked,
          };
        } catch (err) {
          const e = err as { name?: string; message?: string };
          const status: StepStatus = e?.name === 'AbortError' ? 'cancelled' : (e?.name === 'TimeoutError' ? 'timeout' : 'failed');
          result = {
            stepId: step.id,
            status,
            durationMs: Math.round(performance.now() - stepStart),
            error: e?.message ?? String(err),
          };
          if (status === 'failed') overallStatus = 'error';
          if (status === 'cancelled') overallStatus = 'cancelled';
          if (status === 'timeout') overallStatus = 'timeout';
        }
        stepResults.push(result);
        emitBuilderEvent({
          type: 'run:step-status',
          workflowId: opts.workflowId,
          runId,
          payload: { stepId: step.id, status: result.status, durationMs: result.durationMs, error: result.error, mocked: result.mocked },
        });
        emitBuilderEvent({
          type: 'run:step-output',
          workflowId: opts.workflowId,
          runId,
          payload: { stepId: step.id, output: previewOf(result.output), error: result.error, status: result.status },
        });
      }

      if (overallStatus !== 'ok' && overallStatus !== 'cancelled' && overallStatus !== 'timeout') {
        // Continue executing later waves even after a step failed — caller can decide what to do.
      }
    }
  } finally {
    activeRuns.delete(runId);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Math.round(performance.now() - startMs);
  const finalStatus: RunResult['status'] = overallStatus;

  emitBuilderEvent({
    type: finalStatus === 'cancelled' ? 'run:cancelled' : 'run:completed',
    workflowId: opts.workflowId,
    runId,
    payload: { status: finalStatus, durationMs, stepCount: stepResults.length },
  });

  return {
    runId,
    workflowId: opts.workflowId,
    mode,
    status: finalStatus,
    startedAt,
    finishedAt,
    durationMs,
    stepResults,
  };
}

// ── step execution ──────────────────────────────────────────────────

interface StepOutput {
  output: unknown;
  mocked: boolean;
}

async function executeStep(
  step: WorkflowStep,
  wf: WorkflowDefinition,
  priorOutputs: Map<string, unknown>,
  mode: RunMode,
  signal: AbortSignal,
): Promise<StepOutput> {
  const kind: WorkflowStepKind = step.kind ?? 'prompt';
  const ctx = buildExecContext(wf, priorOutputs);

  switch (kind) {
    case 'prompt':
      return executePromptStep(step, mode);
    case 'mcp':
      return executeMcpStep(step, mode, ctx, signal);
    case 'channel':
      return executeChannelStep(step, ctx);
    case 'transform':
      return executeTransformStep(step, ctx);
    case 'conditional':
      return executeConditionalStep(step, ctx);
    case 'loop':
      return executeLoopStep(step, ctx);
  }
}

function executePromptStep(step: WorkflowStep, mode: RunMode): StepOutput {
  if (mode === 'real') {
    // Real prompt execution would route through the live agent. Today the
    // canvas test runner intentionally stays mock-only for prompt steps —
    // schedule a real run via cron for full LLM execution.
    return {
      mocked: true,
      output: `[real-mode requested but prompt steps are stubbed in canvas test runner — schedule a cron for full execution] prompt: ${truncate(step.prompt, 200)}`,
    };
  }
  return {
    mocked: true,
    output: `[mock] would call agent (model: ${step.model ?? 'default'}, maxTurns: ${step.maxTurns}). prompt: ${truncate(step.prompt, 200)}`,
  };
}

async function executeMcpStep(
  step: WorkflowStep,
  mode: RunMode,
  ctx: ExecContext,
  signal: AbortSignal,
): Promise<StepOutput> {
  if (!step.mcp || !step.mcp.server || !step.mcp.tool) {
    throw new Error('MCP step missing server or tool');
  }
  const looksDestructive = /(create|delete|update|push|send|post|drop|write|patch|set_)/i.test(step.mcp.tool);
  const shouldMock = mode === 'mock' && looksDestructive;
  if (shouldMock) {
    return {
      mocked: true,
      output: `[mock-write] would call ${step.mcp.server}.${step.mcp.tool} with inputs ${JSON.stringify(resolveInputs(step.mcp.inputs ?? {}, ctx))}`,
    };
  }
  // Read-only or real-mode: invoke for real via the daemon's MCP bridge.
  // We delegate through a runtime callback registered by the daemon to
  // avoid pulling agent-bridge code into the runner module's dependency
  // tree directly. Falls back to a clear stub if no handler is wired.
  const handler = (globalThis as unknown as { __clementineMcpInvoke?: McpInvokeFn }).__clementineMcpInvoke;
  if (!handler) {
    return {
      mocked: true,
      output: `[mock — daemon MCP bridge not registered] would call ${step.mcp.server}.${step.mcp.tool}`,
    };
  }
  const inputs = resolveInputs(step.mcp.inputs ?? {}, ctx);
  const result = await handler({ server: step.mcp.server, tool: step.mcp.tool, inputs, signal });
  return { mocked: false, output: result };
}

function executeChannelStep(step: WorkflowStep, ctx: ExecContext): StepOutput {
  if (!step.channel) throw new Error('Channel step missing config');
  const content = templatize(step.channel.content, ctx);
  return {
    mocked: true,
    output: `[mock] would send to ${step.channel.channel} → ${step.channel.target}: ${truncate(content, 200)}`,
  };
}

function executeTransformStep(step: WorkflowStep, ctx: ExecContext): StepOutput {
  if (!step.transform || !step.transform.expression) throw new Error('Transform step missing expression');
  const value = evalSandbox(step.transform.expression, ctx);
  return { mocked: false, output: value };
}

function executeConditionalStep(step: WorkflowStep, ctx: ExecContext): StepOutput {
  if (!step.conditional || !step.conditional.condition) throw new Error('Conditional step missing condition');
  const value = !!evalSandbox(step.conditional.condition, ctx);
  return {
    mocked: false,
    output: { result: value, branch: value ? 'true' : 'false' },
  };
}

function executeLoopStep(step: WorkflowStep, ctx: ExecContext): StepOutput {
  if (!step.loop || !step.loop.items) throw new Error('Loop step missing items');
  const items = evalSandbox(step.loop.items, ctx);
  const iterable = Array.isArray(items) ? items : Object.values(items ?? {});
  return {
    mocked: false,
    output: { itemCount: iterable.length, sample: iterable.slice(0, 3) },
  };
}

// ── exec context, sandboxing, templates ─────────────────────────────

interface ExecContext {
  steps: Record<string, unknown>;
  input: unknown;
}

function buildExecContext(_wf: WorkflowDefinition, priorOutputs: Map<string, unknown>): ExecContext {
  const steps: Record<string, unknown> = {};
  for (const [k, v] of priorOutputs) steps[k] = v;
  // For loop body steps, downstream may reference the upstream loop step by id.
  return { steps, input: undefined };
}

function evalSandbox(expression: string, ctx: ExecContext): unknown {
  // Sandbox JS expressions. Don't expose require, process, etc.
  const sandbox = { steps: ctx.steps, input: ctx.input };
  const script = new vm.Script('(' + expression + ')');
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  return script.runInContext(context, { timeout: 1500 });
}

function templatize(template: string, ctx: ExecContext): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_m, expr) => {
    try {
      const v = evalSandbox(String(expr), ctx);
      return v == null ? '' : String(v);
    } catch {
      return '';
    }
  });
}

function resolveInputs(inputs: Record<string, unknown>, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' && v.includes('{{')) out[k] = templatize(v, ctx);
    else out[k] = v;
  }
  return out;
}

// ── conditional branch handling ─────────────────────────────────────

function shouldSkipFromConditional(
  step: WorkflowStep,
  wf: WorkflowDefinition,
  outputs: Map<string, unknown>,
): string | null {
  // If a parent conditional ran and chose the other branch, skip this step.
  for (const dep of step.dependsOn) {
    const parent = wf.steps.find(s => s.id === dep);
    if (!parent || parent.kind !== 'conditional') continue;
    const parentOut = outputs.get(parent.id) as { branch?: 'true' | 'false' } | undefined;
    if (!parentOut) continue;
    const trueNext = parent.conditional?.trueNext ?? [];
    const falseNext = parent.conditional?.falseNext ?? [];
    if (parentOut.branch === 'true' && falseNext.includes(step.id) && !trueNext.includes(step.id)) {
      return `parent ${parent.id} took true branch`;
    }
    if (parentOut.branch === 'false' && trueNext.includes(step.id) && !falseNext.includes(step.id)) {
      return `parent ${parent.id} took false branch`;
    }
  }
  return null;
}

// ── topological waves ──────────────────────────────────────────────

function computeWaves(steps: WorkflowStep[]): WorkflowStep[][] {
  const byId = new Map(steps.map(s => [s.id, s]));
  const remaining = new Set(steps.map(s => s.id));
  const waves: WorkflowStep[][] = [];
  const seen = new Set<string>();
  let safety = steps.length + 1;

  while (remaining.size > 0 && safety-- > 0) {
    const wave: WorkflowStep[] = [];
    for (const id of remaining) {
      const s = byId.get(id);
      if (!s) continue;
      if (s.dependsOn.every(d => !byId.has(d) || seen.has(d))) {
        wave.push(s);
      }
    }
    if (wave.length === 0) {
      // Cycle or malformed graph — drop remaining into one final wave so we don't lock up
      for (const id of remaining) {
        const s = byId.get(id);
        if (s) wave.push(s);
      }
    }
    for (const s of wave) {
      seen.add(s.id);
      remaining.delete(s.id);
    }
    waves.push(wave);
  }
  return waves;
}

// ── helpers ────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(message = 'Timed out') { super(message); this.name = 'TimeoutError'; }
}

function runWithTimeout<T>(fn: () => Promise<T> | T, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError());
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      const err = new Error('Aborted');
      (err as Error & { name: string }).name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(fn)
      .then(v => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function previewOf(out: unknown, n = 1500): string {
  try {
    const s = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    return s.length <= n ? s : s.slice(0, n) + '…';
  } catch {
    return String(out);
  }
}

// ── External MCP invoke handler registration ────────────────────────

export type McpInvokeFn = (args: { server: string; tool: string; inputs: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>;

/**
 * Daemon registers a callback the runner uses to invoke MCP tools for
 * real. Kept as a runtime injection so the runner doesn't pull the
 * agent-bridge into its module graph (which would create a cycle).
 */
export function registerMcpInvokeHandler(handler: McpInvokeFn): void {
  (globalThis as unknown as { __clementineMcpInvoke?: McpInvokeFn }).__clementineMcpInvoke = handler;
}
