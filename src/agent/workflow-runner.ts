/**
 * Clementine TypeScript — Workflow Runner.
 *
 * Parses workflow definition files (markdown + YAML frontmatter),
 * validates the step DAG, and executes steps using the wave scheduler
 * (topological sort + concurrency-capped settled execution).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import pino from 'pino';
import type { PersonalAssistant } from './assistant.js';
import { computeWaves, settledWithLimit } from './wave-scheduler.js';
import { resolveStaticVariables, resolveStepOutputs } from './workflow-variables.js';
import type {
  PlanStep,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowInput,
  WorkflowRunEntry,
} from '../types.js';
import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.workflow' });

const MAX_CONCURRENT_STEPS = 3;
const RESULT_TRUNCATE_CHARS = 4000;

// ── Workflow progress types ─────────────────────────────────────────

export interface WorkflowProgressUpdate {
  stepId: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  description: string;
  durationMs?: number;
}

export interface WorkflowRunResult {
  status: 'ok' | 'error' | 'partial';
  output: string;
  entry: WorkflowRunEntry;
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a single workflow markdown file into a WorkflowDefinition.
 */
export function parseWorkflow(filePath: string): WorkflowDefinition {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const data = parsed.data;

  if (data.type !== 'workflow') {
    throw new Error(`File is not a workflow (type="${data.type}"): ${filePath}`);
  }

  const name = String(data.name ?? path.basename(filePath, '.md'));
  const description = String(data.description ?? '');
  const enabled = data.enabled !== false;

  // Trigger
  const triggerRaw = data.trigger ?? {};
  const trigger = {
    schedule: triggerRaw.schedule ? String(triggerRaw.schedule) : undefined,
    manual: triggerRaw.manual !== false,
  };

  // Inputs
  const inputs: Record<string, WorkflowInput> = {};
  if (data.inputs && typeof data.inputs === 'object') {
    for (const [key, val] of Object.entries(data.inputs)) {
      const v = val as Record<string, unknown>;
      inputs[key] = {
        type: (v.type === 'number' ? 'number' : 'string') as 'string' | 'number',
        default: v.default != null ? String(v.default) : undefined,
        description: v.description ? String(v.description) : undefined,
      };
    }
  }

  // Steps
  const stepsRaw = data.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error(`Workflow "${name}" has no steps: ${filePath}`);
  }

  const steps: WorkflowStep[] = stepsRaw.map((s: Record<string, unknown>, i: number) => ({
    id: String(s.id ?? `step-${i + 1}`),
    prompt: String(s.prompt ?? ''),
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
    model: s.model ? String(s.model) : undefined,
    tier: Number(s.tier ?? 1),
    maxTurns: Number(s.maxTurns ?? 15),
    workDir: s.workDir ? String(s.workDir) : undefined,
  }));

  // Synthesis
  const synthesis = data.synthesis?.prompt
    ? { prompt: String(data.synthesis.prompt) }
    : undefined;

  return {
    name,
    description,
    enabled,
    trigger,
    inputs,
    steps,
    synthesis,
    sourceFile: filePath,
  };
}

/**
 * Parse all workflow files in a directory.
 */
export function parseAllWorkflows(dir: string): WorkflowDefinition[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const workflows: WorkflowDefinition[] = [];

  for (const file of files) {
    try {
      workflows.push(parseWorkflow(path.join(dir, file)));
    } catch (err) {
      logger.warn({ err, file }, `Failed to parse workflow: ${file}`);
    }
  }

  return workflows;
}

// ── Validation ──────────────────────────────────────────────────────

function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const stepIds = new Set(workflow.steps.map(s => s.id));

  // Check unique IDs
  if (stepIds.size !== workflow.steps.length) {
    errors.push('Duplicate step IDs found');
  }

  // Check dependencies exist
  for (const step of workflow.steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depends on unknown step "${dep}"`);
      }
      if (dep === step.id) {
        errors.push(`Step "${step.id}" depends on itself`);
      }
    }
    if (!step.prompt.trim()) {
      errors.push(`Step "${step.id}" has an empty prompt`);
    }
  }

  // Check for cycles (computeWaves will throw on cycles)
  try {
    const planSteps: PlanStep[] = workflow.steps.map(s => ({
      id: s.id,
      description: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      maxTurns: s.maxTurns,
      tier: s.tier,
    }));
    computeWaves(planSteps);
  } catch {
    errors.push('Circular dependency detected in steps');
  }

  return errors;
}

// ── Run log ─────────────────────────────────────────────────────────

function getRunLogDir(): string {
  const dir = path.join(BASE_DIR, 'workflows', 'runs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function appendRunLog(entry: WorkflowRunEntry): void {
  const safe = entry.workflowName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(getRunLogDir(), `${safe}.jsonl`);
  try {
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.warn({ err, workflow: entry.workflowName }, 'Failed to write workflow run log');
  }
}

// ── WorkflowRunner ──────────────────────────────────────────────────

export class WorkflowRunner {
  private assistant: PersonalAssistant;

  constructor(assistant: PersonalAssistant) {
    this.assistant = assistant;
  }

  async run(
    workflow: WorkflowDefinition,
    inputs: Record<string, string>,
    onProgress?: (updates: WorkflowProgressUpdate[]) => void,
  ): Promise<WorkflowRunResult> {
    const runId = randomUUID().slice(0, 8);
    const startTime = Date.now();

    logger.info({ workflow: workflow.name, runId, inputs }, 'Starting workflow');

    // 1. Validate
    const errors = validateWorkflow(workflow);
    if (errors.length > 0) {
      const entry: WorkflowRunEntry = {
        workflowName: workflow.name,
        runId,
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error',
        durationMs: Date.now() - startTime,
        inputs,
        stepResults: [],
        error: `Validation failed: ${errors.join('; ')}`,
      };
      appendRunLog(entry);
      return { status: 'error', output: `Workflow validation failed:\n${errors.join('\n')}`, entry };
    }

    // 2. Merge inputs with defaults
    const resolvedInputs: Record<string, string> = {};
    for (const [key, def] of Object.entries(workflow.inputs)) {
      resolvedInputs[key] = inputs[key] ?? def.default ?? '';
    }
    // Also pass through any extra inputs not in the schema
    for (const [key, val] of Object.entries(inputs)) {
      if (!(key in resolvedInputs)) resolvedInputs[key] = val;
    }

    // 3. Resolve static variables in all step prompts
    const resolvedSteps = workflow.steps.map(s => ({
      ...s,
      prompt: resolveStaticVariables(s.prompt, resolvedInputs, workflow.name),
    }));

    // 4. Compute execution waves
    const planSteps: PlanStep[] = resolvedSteps.map(s => ({
      id: s.id,
      description: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      maxTurns: s.maxTurns,
      tier: s.tier,
      model: s.model,
    }));
    const waves = computeWaves(planSteps);

    // 5. Initialize progress
    const statuses = new Map<string, WorkflowProgressUpdate>();
    for (const step of resolvedSteps) {
      statuses.set(step.id, { stepId: step.id, status: 'waiting', description: step.id });
    }
    onProgress?.([...statuses.values()]);

    // 6. Execute waves
    const stepResults = new Map<string, string>();
    const stepEntries: WorkflowRunEntry['stepResults'] = [];
    let hasFailures = false;

    for (const wave of waves) {
      // Mark running
      for (const step of wave) {
        statuses.set(step.id, { stepId: step.id, status: 'running', description: step.id });
      }
      onProgress?.([...statuses.values()]);

      // Run wave
      const settled = await settledWithLimit(
        wave.map(step => async () => {
          const resolvedStep = resolvedSteps.find(s => s.id === step.id)!;

          // Resolve step output references
          const prompt = resolveStepOutputs(resolvedStep.prompt, stepResults, RESULT_TRUNCATE_CHARS);

          const stepStart = Date.now();
          const result = await this.assistant.runPlanStep(step.id, prompt, {
            tier: resolvedStep.tier,
            maxTurns: resolvedStep.maxTurns,
            model: resolvedStep.model,
            usageSource: 'workflow_step',
            usageSessionKey: `workflow:${workflow.name}:${step.id}`,
            usageLabel: `${workflow.name}:${step.id}`,
            usageAgentSlug: workflow.agentSlug,
          });
          return { stepId: step.id, result, durationMs: Date.now() - stepStart };
        }),
        MAX_CONCURRENT_STEPS,
      );

      // Collect results
      for (let i = 0; i < wave.length; i++) {
        const step = wave[i];
        const outcome = settled[i];

        if (outcome.status === 'fulfilled') {
          const { result, durationMs } = outcome.value;
          const output = result || '[No output produced]';
          stepResults.set(step.id, output);
          statuses.set(step.id, {
            stepId: step.id, status: 'done', description: step.id, durationMs,
          });
          stepEntries.push({
            stepId: step.id, status: 'done', durationMs,
            outputPreview: output.slice(0, 200),
          });
        } else {
          const errMsg = `[FAILED: ${outcome.reason}]`;
          stepResults.set(step.id, errMsg);
          hasFailures = true;
          statuses.set(step.id, {
            stepId: step.id, status: 'failed', description: step.id,
          });
          stepEntries.push({ stepId: step.id, status: 'failed', durationMs: 0 });
          logger.error({ stepId: step.id, err: outcome.reason }, 'Workflow step failed');
        }
      }
      onProgress?.([...statuses.values()]);
    }

    // 7. Synthesis
    let finalOutput: string;
    if (workflow.synthesis?.prompt) {
      const synthPrompt = this.buildSynthesisPrompt(workflow, stepResults);
      try {
        finalOutput = await this.assistant.runPlanStep('__synthesis__', synthPrompt, {
          tier: 2, maxTurns: 5, disableTools: true,
          usageSource: 'workflow_step',
          usageSessionKey: `workflow:${workflow.name}:__synthesis__`,
          usageLabel: `${workflow.name}:__synthesis__`,
          usageAgentSlug: workflow.agentSlug,
        });
      } catch (err) {
        logger.warn({ err }, 'Workflow synthesis failed — concatenating results');
        finalOutput = this.fallbackOutput(stepResults);
      }
    } else {
      finalOutput = this.fallbackOutput(stepResults);
    }

    // 8. Log
    const entry: WorkflowRunEntry = {
      workflowName: workflow.name,
      runId,
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      status: hasFailures ? 'partial' : 'ok',
      durationMs: Date.now() - startTime,
      inputs: resolvedInputs,
      stepResults: stepEntries,
      outputPreview: finalOutput.slice(0, 500),
    };
    appendRunLog(entry);

    logger.info(
      { workflow: workflow.name, runId, status: entry.status, durationMs: entry.durationMs },
      'Workflow completed',
    );

    return { status: entry.status, output: finalOutput, entry };
  }

  private buildSynthesisPrompt(
    workflow: WorkflowDefinition,
    stepResults: Map<string, string>,
  ): string {
    const parts: string[] = [`## Workflow: ${workflow.name}\n`];

    parts.push('## Step results:');
    for (const step of workflow.steps) {
      const result = stepResults.get(step.id) ?? '[no result]';
      const truncated = result.length > RESULT_TRUNCATE_CHARS
        ? result.slice(0, RESULT_TRUNCATE_CHARS) + '\n...[truncated]'
        : result;
      parts.push(`### ${step.id}\n${truncated}`);
    }

    parts.push(`\n## Instructions:\n${workflow.synthesis!.prompt}`);
    return parts.join('\n');
  }

  private fallbackOutput(stepResults: Map<string, string>): string {
    return Array.from(stepResults.entries())
      .map(([id, result]) => `**${id}:**\n${result.slice(0, 500)}`)
      .join('\n\n');
  }
}
