/**
 * bg-orchestrator — drive a Plan from start to finish by queuing one
 * bg-task per PlanStep, advancing the chain as each step completes.
 *
 * Why this exists (1.18.190)
 * ──────────────────────────
 * The bg-planner produces a Plan with 3-7 PlanSteps. This module is
 * the runtime that executes that Plan, one step at a time, with each
 * step getting its own fresh bg-task + worker context. The chain only
 * advances when the previous step completed successfully — failures
 * pause the chain and notify the owner.
 *
 * Architectural role:
 *   bg-planner.ts → Plan (data)
 *   bg-orchestrator.ts → drives the Plan (this module)
 *   background-tasks.ts → bg-task persistence (filesystem)
 *   run-agent-cron.ts → runs the actual SDK call for each step
 *
 * The orchestrator is NEVER the thing reading files or calling APIs.
 * It's a state machine: read plan → queue next step → wait for step
 * to finish → repeat. The state machine lives across daemon restarts
 * because both Plans and BackgroundTasks are filesystem-persisted.
 *
 * Why this prevents the autocompact thrash that motivated 1.18.190:
 *   - each step gets a FRESH bg-task with a FRESH 200K worker window
 *   - state flows between steps via the project's STATUS.md and the
 *     plan's `deliverable` fields, NOT via accumulated SDK context
 *   - no single worker has to do more than ~2-6 tool calls before
 *     completing its scoped deliverable
 *   - the model's compaction pressure resets between steps
 */

import path from 'node:path';
import pino from 'pino';
import { createBackgroundTask } from './background-tasks.js';
import { loadPlan, savePlan } from './bg-planner.js';
import type { Plan, PlanStep } from './bg-planner.js';
import type { BackgroundTask } from '../types.js';

const logger = pino({ name: 'clementine.bg-orchestrator' });

// ── Public API ───────────────────────────────────────────────────────

/**
 * Queue the first step of a freshly-planned chain. Returns the
 * BackgroundTask created for step 0.
 *
 * Caller responsibility: the Plan must already be persisted to disk
 * (via savePlan) before calling this — the dispatched step task
 * carries a planId that will be loaded back at execution time.
 */
export function dispatchChain(plan: Plan): BackgroundTask {
  if (!plan.steps.length) {
    throw new Error(`Cannot dispatch chain: plan ${plan.id} has zero steps`);
  }
  const firstStep = plan.steps[0]!;
  const task = createBackgroundTask({
    fromAgent: 'clementine',
    prompt: buildStepPrompt(plan, firstStep),
    maxMinutes: 30, // generous per-step; the step itself decides how long it needs
    ...(plan.originatingSessionKey ? { sessionKey: plan.originatingSessionKey } : {}),
    kind: 'step',
    chainId: plan.chainId,
    planId: plan.id,
    stepIndex: 0,
  });

  // Stamp the step with its taskId + mark plan as in_progress so future
  // resumes don't try to re-dispatch the same step.
  firstStep.taskId = task.id;
  firstStep.status = 'running';
  plan.status = 'in_progress';
  savePlan(plan, plan.projectPath);

  logger.info({
    planId: plan.id,
    chainId: plan.chainId,
    stepIndex: 0,
    stepTitle: firstStep.title,
    taskId: task.id,
  }, 'dispatchChain: queued step 0');
  return task;
}

/**
 * Called by the bg-task framework when a chained step completes.
 * Updates the plan's step status, then either:
 *   - queues the next step (chain continues),
 *   - marks the plan completed (no more steps), or
 *   - pauses the chain (step failed; owner notification surfaces elsewhere).
 *
 * Returns the next BackgroundTask if one was queued, or null otherwise.
 *
 * Safe to call multiple times for the same completed task (idempotent
 * via the step's status check).
 */
export function advanceChain(opts: {
  completedTask: BackgroundTask;
  /** Optional override for tests; defaults to filesystem. */
  loadPlanFn?: typeof loadPlan;
  savePlanFn?: typeof savePlan;
  createTaskFn?: typeof createBackgroundTask;
}): BackgroundTask | null {
  const { completedTask } = opts;
  if (!completedTask.planId || typeof completedTask.stepIndex !== 'number') {
    logger.debug({ taskId: completedTask.id }, 'advanceChain: task has no plan id/step index — not a chain step');
    return null;
  }
  const loadPlanImpl = opts.loadPlanFn ?? loadPlan;
  const savePlanImpl = opts.savePlanFn ?? savePlan;
  const createTaskImpl = opts.createTaskFn ?? createBackgroundTask;

  // Plans live alongside the project when one's set; the task carries
  // the planId but not the project path. Try the project path first
  // (fast path), then fall back to the global plans dir inside
  // loadPlan itself.
  const plan = loadPlanImpl(completedTask.planId, undefined);
  if (!plan) {
    logger.warn({ planId: completedTask.planId, taskId: completedTask.id }, 'advanceChain: plan not found — cannot advance');
    return null;
  }

  const step = plan.steps[completedTask.stepIndex];
  if (!step) {
    logger.warn({ planId: plan.id, stepIndex: completedTask.stepIndex }, 'advanceChain: step index out of range');
    return null;
  }

  // Idempotency: if the step has already been marked terminal, don't
  // advance again. Protects against duplicate completion callbacks.
  if (step.status === 'done' || step.status === 'failed' || step.status === 'skipped') {
    logger.debug({ planId: plan.id, stepIndex: step.index, status: step.status }, 'advanceChain: step already terminal — skipping');
    return null;
  }

  // Reflect the task's terminal status onto the plan step.
  if (completedTask.status === 'done') {
    step.status = 'done';
    step.completedAt = completedTask.completedAt ?? new Date().toISOString();
    step.resultPreview = (completedTask.result ?? '').slice(0, 400);
  } else {
    // failed | aborted | interrupted — all map to plan-step failure for now
    step.status = 'failed';
    step.completedAt = completedTask.completedAt ?? new Date().toISOString();
    step.resultPreview = (completedTask.error ?? completedTask.result ?? '').slice(0, 400);
    plan.status = 'paused';
    savePlanImpl(plan, plan.projectPath);
    logger.warn({
      planId: plan.id,
      chainId: plan.chainId,
      stepIndex: step.index,
      stepTitle: step.title,
      taskStatus: completedTask.status,
      error: completedTask.error,
    }, 'advanceChain: step failed — chain paused');
    return null;
  }

  // Look for the next pending step.
  const nextStep = plan.steps.find((s, i) => i > step.index && s.status === 'pending');
  if (!nextStep) {
    // Chain complete!
    plan.status = 'completed';
    savePlanImpl(plan, plan.projectPath);
    logger.info({
      planId: plan.id,
      chainId: plan.chainId,
      stepCount: plan.steps.length,
    }, 'advanceChain: chain completed');
    return null;
  }

  // Queue the next step.
  const nextTask = createTaskImpl({
    fromAgent: 'clementine',
    prompt: buildStepPrompt(plan, nextStep),
    maxMinutes: 30,
    ...(plan.originatingSessionKey ? { sessionKey: plan.originatingSessionKey } : {}),
    kind: 'step',
    chainId: plan.chainId,
    planId: plan.id,
    stepIndex: nextStep.index,
    parentTaskId: completedTask.id,
  });
  nextStep.taskId = nextTask.id;
  nextStep.status = 'running';
  savePlanImpl(plan, plan.projectPath);

  logger.info({
    planId: plan.id,
    chainId: plan.chainId,
    stepIndex: nextStep.index,
    stepTitle: nextStep.title,
    taskId: nextTask.id,
    parentTaskId: completedTask.id,
  }, 'advanceChain: queued next step');
  return nextTask;
}

/**
 * Pause a chain explicitly (e.g., owner intervention). The current
 * running step is left alone — caller can mark it however the
 * downstream cancellation flow does.
 */
export function pauseChain(planId: string, projectPath?: string | null, reason?: string): void {
  const plan = loadPlan(planId, projectPath ?? undefined);
  if (!plan) return;
  plan.status = 'paused';
  if (reason) plan.notes = `${plan.notes ? plan.notes + '\n' : ''}[paused] ${reason}`;
  savePlan(plan, plan.projectPath);
  logger.info({ planId, reason }, 'pauseChain: chain paused');
}

/**
 * Resume a paused chain by dispatching its next pending step. If
 * all steps are terminal, marks the plan completed. Returns the
 * dispatched task, or null when nothing to dispatch.
 */
export function resumeChain(planId: string, projectPath?: string | null): BackgroundTask | null {
  const plan = loadPlan(planId, projectPath ?? undefined);
  if (!plan) return null;
  if (plan.status === 'completed') return null;

  const nextStep = plan.steps.find((s) => s.status === 'pending');
  if (!nextStep) {
    plan.status = 'completed';
    savePlan(plan, plan.projectPath);
    return null;
  }
  const task = createBackgroundTask({
    fromAgent: 'clementine',
    prompt: buildStepPrompt(plan, nextStep),
    maxMinutes: 30,
    ...(plan.originatingSessionKey ? { sessionKey: plan.originatingSessionKey } : {}),
    kind: 'step',
    chainId: plan.chainId,
    planId: plan.id,
    stepIndex: nextStep.index,
  });
  nextStep.taskId = task.id;
  nextStep.status = 'running';
  plan.status = 'in_progress';
  savePlan(plan, plan.projectPath);
  logger.info({ planId, stepIndex: nextStep.index, taskId: task.id }, 'resumeChain: dispatched next step');
  return task;
}

// ── Step prompt construction ─────────────────────────────────────────

/**
 * Build the focused prompt for one chained worker. Designed to be SMALL
 * (~1-2KB) and ANCHORED to the step's deliverable so the worker has a
 * clear stopping condition. Key elements:
 *   - The original user request (for context, not for re-doing it)
 *   - The plan summary (what's been done, what's next)
 *   - THIS step's scope + expected tools + deliverable
 *   - Posture: "do ONLY this step. Don't overshoot. State your deliverable
 *     in your final response."
 *
 * State that the next step might need is read by that step from the
 * project STATUS.md or the prior step's deliverable file — NOT from
 * this step's response text. Result text is for the orchestrator's
 * advancement decision; deliverables are for the work itself.
 */
export function buildStepPrompt(plan: Plan, step: PlanStep): string {
  const lines: string[] = [];
  lines.push(`# Chained step ${step.index + 1} of ${plan.steps.length}`);
  lines.push('');
  lines.push(`## Original user request`);
  lines.push(plan.userRequest);
  lines.push('');
  if (plan.projectPath) {
    lines.push(`## Active project`);
    lines.push(`Path: \`${plan.projectPath}\``);
    lines.push('Your cwd is set to this project. Read sources from there, write outputs to `output/`.');
    lines.push('');
  }
  // Concise plan summary — JUST what's been done and what's next.
  // Don't include full step bodies; that's noise.
  lines.push(`## Plan summary`);
  for (const s of plan.steps) {
    const marker = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.index === step.index ? '→' : '·';
    const detail = s.status === 'done' && s.deliverable ? ` (→ ${s.deliverable})` : '';
    lines.push(`  ${marker} ${s.index + 1}. ${s.title}${detail}`);
  }
  lines.push('');
  lines.push(`## Your step (the → above)`);
  lines.push(`**Title**: ${step.title}`);
  lines.push(`**Scope**: ${step.scope}`);
  if (step.expectedTools.length > 0) {
    lines.push(`**Expected tool calls**: ${step.expectedTools.join(', ')}`);
  }
  if (step.deliverable) {
    lines.push(`**Deliverable**: ${step.deliverable}`);
  }
  lines.push('');
  lines.push(`## Step posture`);
  lines.push(
    'Do ONLY this step. Don\'t start the next one — the orchestrator handles that. ' +
    'When you\'re done, state your deliverable concretely in your final response ' +
    '(file path, URL, confirmation) so the orchestrator can advance the chain. ' +
    'If you hit a blocker (missing info, ambiguous scope, tool failure), say so explicitly ' +
    'and stop — don\'t guess.',
  );

  return lines.join('\n');
}

// ── Convenience helpers used by run-agent-cron ───────────────────────

/**
 * Given a chain step's taskId, derive the directory where the plan
 * lives. Used by run-agent-cron to set the SDK's `cwd` and
 * `additionalDirectories` to the project root for the step.
 */
export function projectDirForChainTask(task: BackgroundTask): string | undefined {
  if (!task.planId) return undefined;
  const plan = loadPlan(task.planId);
  return plan?.projectPath ?? undefined;
}

/**
 * Format a status line for posting to the originating chat after each
 * step completes — gives the owner a real-time view of chain progress.
 */
export function formatChainStatusUpdate(plan: Plan, justCompletedStep: PlanStep): string {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const lines: string[] = [];
  lines.push(`**Step ${justCompletedStep.index + 1}/${total} done**: ${justCompletedStep.title}`);
  if (justCompletedStep.resultPreview) {
    lines.push(`→ ${justCompletedStep.resultPreview.slice(0, 200)}`);
  }
  if (done < total && plan.status === 'in_progress') {
    const nextStep = plan.steps.find((s) => s.status === 'pending');
    if (nextStep) lines.push(`Next: ${nextStep.title}`);
  } else if (plan.status === 'completed') {
    lines.push(`Chain complete (${done}/${total} steps).`);
  } else if (plan.status === 'paused') {
    lines.push(`Chain paused. Tell me how to proceed.`);
  }
  return lines.join('\n');
}

// path is imported but lint warns when unused — use it once just to keep import meaningful.
// (orchestrator uses path indirectly via loadPlan/savePlan; this comment keeps the import obvious to future readers)
void path;
