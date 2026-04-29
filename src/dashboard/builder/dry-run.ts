/**
 * Builder dry-run.
 *
 * Walks a workflow's step DAG in topological order and produces a
 * human-readable description of what each step *would* do, without
 * executing anything. Crucial for long-running jobs (multi-hour
 * outreach batches, brain ingestion runs) where the user wants to
 * preview changes safely before scheduling a real run.
 */

import type { WorkflowDefinition, WorkflowStep, WorkflowStepKind } from '../../types.js';
import { validateWorkflow } from './validation.js';

export interface DryRunStep {
  stepId: string;
  kind: WorkflowStepKind;
  wave: number;          // topological wave (parallelism band)
  description: string;
  warnings: string[];
}

export interface DryRunResult {
  ok: boolean;
  validationIssues: ReturnType<typeof validateWorkflow>['issues'];
  steps: DryRunStep[];
  estimatedTokens?: { promptSteps: number; perPromptEstimate: number; total: number };
  notes: string[];
}

export function dryRunWorkflow(wf: WorkflowDefinition): DryRunResult {
  const validation = validateWorkflow(wf);
  const result: DryRunResult = {
    ok: validation.ok,
    validationIssues: validation.issues,
    steps: [],
    notes: [],
  };

  if (!validation.ok) {
    result.notes.push('Validation failed — fix errors before scheduling. Steps below are descriptive only.');
  }

  const waveOf = computeWaves(wf.steps);
  let promptSteps = 0;

  for (const step of wf.steps) {
    const kind = step.kind ?? 'prompt';
    if (kind === 'prompt') promptSteps++;

    result.steps.push({
      stepId: step.id,
      kind,
      wave: waveOf[step.id] ?? 0,
      description: describeStep(step),
      warnings: stepWarnings(step),
    });
  }

  if (promptSteps > 0) {
    const perPromptEstimate = 1500;  // very rough heuristic; real cost depends on prior step outputs
    result.estimatedTokens = {
      promptSteps,
      perPromptEstimate,
      total: promptSteps * perPromptEstimate,
    };
    result.notes.push(`Cost estimate is rough — actual usage depends on prior step outputs and tool calls.`);
  }

  if (wf.trigger.schedule) {
    result.notes.push(`Trigger: cron "${wf.trigger.schedule}". This describes one execution.`);
  } else if (wf.trigger.manual) {
    result.notes.push('Trigger: manual. Workflow runs only when invoked directly.');
  }

  return result;
}

function describeStep(step: WorkflowStep): string {
  const kind = step.kind ?? 'prompt';
  const deps = step.dependsOn.length ? ` (after: ${step.dependsOn.join(', ')})` : '';

  switch (kind) {
    case 'prompt':
      return `Prompt step "${step.id}"${deps}: would send a prompt to the agent (model: ${step.model ?? 'default'}, maxTurns: ${step.maxTurns}). Prompt preview: ${truncate(step.prompt, 160)}`;
    case 'mcp':
      if (!step.mcp) return `MCP step "${step.id}"${deps}: misconfigured (no mcp config)`;
      return `MCP step "${step.id}"${deps}: would call ${step.mcp.server}.${step.mcp.tool}${step.mcp.inputs ? ` with inputs ${JSON.stringify(step.mcp.inputs)}` : ' (no inputs)'}`;
    case 'channel':
      if (!step.channel) return `Channel step "${step.id}"${deps}: misconfigured`;
      return `Channel step "${step.id}"${deps}: would send to ${step.channel.channel} → ${step.channel.target}. Content preview: ${truncate(step.channel.content, 120)}`;
    case 'transform':
      if (!step.transform) return `Transform step "${step.id}"${deps}: misconfigured`;
      return `Transform step "${step.id}"${deps}: would evaluate ${truncate(step.transform.expression, 160)}`;
    case 'conditional':
      if (!step.conditional) return `Conditional step "${step.id}"${deps}: misconfigured`;
      return `Conditional step "${step.id}"${deps}: branches on ${truncate(step.conditional.condition, 120)}. True → ${(step.conditional.trueNext ?? []).join(',') || '(none)'}, False → ${(step.conditional.falseNext ?? []).join(',') || '(none)'}`;
    case 'loop':
      if (!step.loop) return `Loop step "${step.id}"${deps}: misconfigured`;
      return `Loop step "${step.id}"${deps}: iterates over ${truncate(step.loop.items, 80)}, body: ${step.loop.bodyStepIds.join(', ')}`;
  }
}

function stepWarnings(step: WorkflowStep): string[] {
  const warnings: string[] = [];
  const kind = step.kind ?? 'prompt';

  if (kind === 'channel' && step.channel) {
    if (step.channel.channel === 'email' && !step.channel.target.includes('@')) {
      warnings.push('Email target does not look like an email address');
    }
  }
  if (kind === 'mcp' && step.mcp) {
    if (/(create|delete|update|push|send|post|drop)/i.test(step.mcp.tool)) {
      warnings.push('Looks like a write/destructive MCP tool — confirm before running for real');
    }
  }
  if (kind === 'prompt' && step.prompt && step.prompt.length > 5000) {
    warnings.push('Prompt is very long — may exceed reasonable cost per run');
  }
  if (kind === 'prompt' && step.maxTurns > 60) {
    warnings.push('maxTurns is high; this step may run for many minutes');
  }
  return warnings;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

/** Topological wave numbers — same logic as serializer's, kept local to avoid circular import. */
function computeWaves(steps: WorkflowStep[]): Record<string, number> {
  const wave: Record<string, number> = {};
  const ids = new Set(steps.map(s => s.id));
  const remaining = new Set(steps.map(s => s.id));
  let current = 0;
  const maxIter = steps.length + 1;
  for (let iter = 0; iter < maxIter && remaining.size > 0; iter++) {
    const ready: string[] = [];
    for (const s of steps) {
      if (!remaining.has(s.id)) continue;
      const depsResolved = s.dependsOn.every(d => !ids.has(d) || (wave[d] != null && wave[d] < current + 1));
      if (depsResolved) ready.push(s.id);
    }
    if (ready.length === 0) {
      for (const id of remaining) wave[id] = current;
      break;
    }
    for (const id of ready) {
      wave[id] = current;
      remaining.delete(id);
    }
    current++;
  }
  return wave;
}
