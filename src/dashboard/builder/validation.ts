/**
 * Builder workflow validation.
 *
 * Static, side-effect-free checks. Used both by `workflow_validate` (agent
 * runs it explicitly) and by save handlers (refuse to persist invalid
 * graphs). Errors block save; warnings are surfaced for the agent and UI
 * but don't prevent persistence (e.g., disabled cron with no schedule —
 * legal but probably wrong).
 */

import type { WorkflowDefinition, WorkflowStep, WorkflowStepKind } from '../../types.js';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  stepId?: string;
  field?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;        // false if any error
  issues: ValidationIssue[];
}

export function validateWorkflow(wf: WorkflowDefinition): ValidationResult {
  const issues: ValidationIssue[] = [];

  // ── Workflow-level ──
  if (!wf.name || !wf.name.trim()) {
    issues.push({ severity: 'error', code: 'name-empty', message: 'Workflow has no name' });
  }
  if (wf.steps.length === 0) {
    issues.push({ severity: 'error', code: 'no-steps', message: 'Workflow has no steps' });
  }
  if (wf.trigger.schedule && !isCronExpression(wf.trigger.schedule)) {
    issues.push({
      severity: 'error', code: 'bad-schedule',
      field: 'trigger.schedule',
      message: `Invalid cron expression: "${wf.trigger.schedule}"`,
    });
  }
  if (wf.enabled && !wf.trigger.schedule && !wf.trigger.manual) {
    issues.push({
      severity: 'warning', code: 'enabled-no-trigger',
      message: 'Workflow is enabled but has neither a cron schedule nor a manual trigger',
    });
  }

  // ── Step-level ──
  const seenIds = new Set<string>();
  for (const step of wf.steps) {
    if (seenIds.has(step.id)) {
      issues.push({
        severity: 'error', code: 'duplicate-step-id',
        stepId: step.id,
        message: `Duplicate step id: "${step.id}"`,
      });
    }
    seenIds.add(step.id);

    issues.push(...validateStepConfig(step));

    for (const dep of step.dependsOn) {
      if (dep === step.id) {
        issues.push({
          severity: 'error', code: 'self-dep',
          stepId: step.id,
          message: `Step "${step.id}" depends on itself`,
        });
      }
    }
  }

  // Missing dep references
  for (const step of wf.steps) {
    for (const dep of step.dependsOn) {
      if (dep !== step.id && !seenIds.has(dep)) {
        issues.push({
          severity: 'error', code: 'missing-dep',
          stepId: step.id,
          message: `Step "${step.id}" depends on unknown step "${dep}"`,
        });
      }
    }
  }

  // Cycle detection (only worthwhile if there are no missing-dep errors)
  if (!issues.some(i => i.code === 'missing-dep' || i.code === 'self-dep')) {
    const cycle = findCycle(wf.steps);
    if (cycle) {
      issues.push({
        severity: 'error', code: 'cycle',
        message: `Cycle detected through steps: ${cycle.join(' → ')}`,
      });
    }
  }

  return { ok: !issues.some(i => i.severity === 'error'), issues };
}

function validateStepConfig(step: WorkflowStep): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind: WorkflowStepKind = step.kind ?? 'prompt';

  switch (kind) {
    case 'prompt':
      if (!step.prompt || !step.prompt.trim()) {
        issues.push({ severity: 'error', code: 'prompt-empty', stepId: step.id, message: `Prompt step "${step.id}" has empty prompt` });
      }
      break;
    case 'mcp':
      if (!step.mcp) {
        issues.push({ severity: 'error', code: 'mcp-missing', stepId: step.id, message: `MCP step "${step.id}" has no config` });
      } else {
        if (!step.mcp.server) issues.push({ severity: 'error', code: 'mcp-no-server', stepId: step.id, message: `MCP step "${step.id}" missing server` });
        if (!step.mcp.tool) issues.push({ severity: 'error', code: 'mcp-no-tool', stepId: step.id, message: `MCP step "${step.id}" missing tool` });
      }
      break;
    case 'channel':
      if (!step.channel) {
        issues.push({ severity: 'error', code: 'channel-missing', stepId: step.id, message: `Channel step "${step.id}" has no config` });
      } else {
        if (!step.channel.channel) issues.push({ severity: 'error', code: 'channel-no-channel', stepId: step.id, message: `Channel step "${step.id}" missing channel` });
        if (!step.channel.target) issues.push({ severity: 'error', code: 'channel-no-target', stepId: step.id, message: `Channel step "${step.id}" missing target` });
        if (!step.channel.content) issues.push({ severity: 'warning', code: 'channel-no-content', stepId: step.id, message: `Channel step "${step.id}" has empty content` });
      }
      break;
    case 'transform':
      if (!step.transform || !step.transform.expression) {
        issues.push({ severity: 'error', code: 'transform-no-expr', stepId: step.id, message: `Transform step "${step.id}" missing expression` });
      }
      break;
    case 'conditional':
      if (!step.conditional || !step.conditional.condition) {
        issues.push({ severity: 'error', code: 'conditional-no-cond', stepId: step.id, message: `Conditional step "${step.id}" missing condition` });
      }
      break;
    case 'loop':
      if (!step.loop || !step.loop.items) {
        issues.push({ severity: 'error', code: 'loop-no-items', stepId: step.id, message: `Loop step "${step.id}" missing items expression` });
      }
      break;
  }

  if (typeof step.tier !== 'number' || step.tier < 1 || step.tier > 5) {
    issues.push({ severity: 'warning', code: 'tier-range', stepId: step.id, field: 'tier', message: `Step "${step.id}" tier out of usual range (1-5): ${step.tier}` });
  }
  if (typeof step.maxTurns !== 'number' || step.maxTurns < 1) {
    issues.push({ severity: 'warning', code: 'max-turns-range', stepId: step.id, field: 'maxTurns', message: `Step "${step.id}" maxTurns invalid: ${step.maxTurns}` });
  }

  return issues;
}

/** Return the cycle as a list of step ids (first→last→first), or null if acyclic. */
function findCycle(steps: WorkflowStep[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const s of steps) adj.set(s.id, s.dependsOn.slice());

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of adj.get(node) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(dep);
        return [...stack.slice(cycleStart), dep];
      }
      if (c === WHITE) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  return null;
}

const CRON_FIELD = /^(\*|(\d+|\*\/\d+)([,-/](\d+))*)$/;

/** Lightweight cron expression validation. Accepts standard 5-field cron and common ranges/lists/steps. */
export function isCronExpression(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(f => CRON_FIELD.test(f) || /^[A-Z*]+$/i.test(f));
}
