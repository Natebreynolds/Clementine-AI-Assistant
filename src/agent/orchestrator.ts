/**
 * Clementine TypeScript — Plan Orchestrator.
 *
 * Decomposes a task into steps, runs independent steps in parallel
 * via concurrent query() calls, then synthesizes a final response.
 */

import pino from 'pino';
import type { PersonalAssistant } from './assistant.js';
import type { PlanStep, ExecutionPlan, PlanProgressUpdate } from '../types.js';

const logger = pino({ name: 'clementine.orchestrator' });

const MAX_STEPS = 10;
const MAX_CONCURRENT_STEPS = 3;
const RESULT_TRUNCATE_CHARS = 4000;
const LONG_PLAN_WARNING_MS = 30 * 60 * 1000; // 30 minutes
const ALLOWED_MODELS = ['haiku', 'sonnet'];

const PLANNER_PROMPT = `You are a task planner for an AI assistant. Decompose the following request into executable steps that can be run by independent sub-agents.

Output ONLY valid JSON matching this schema (no markdown fences, no prose):

{
  "steps": [
    {
      "id": "step-1",
      "description": "Short human-readable label",
      "prompt": "Detailed instructions for the sub-agent. Be specific — the agent has no context beyond this prompt. Include tool names to use.",
      "dependsOn": [],
      "maxTurns": 15,
      "model": "sonnet"
    }
  ],
  "synthesisPrompt": "Instructions for combining all step results into a final response"
}

Rules:
- MAXIMIZE PARALLELISM: if steps don't need each other's output, give them no dependencies
- Each step prompt must be SELF-CONTAINED — the sub-agent has memory/vault access but no prior conversation context
- Set maxTurns based on complexity: simple lookup = 5, moderate task = 15, complex work = 30-50
- Set model based on step complexity: "haiku" for simple lookups/formatting, "sonnet" for reasoning/writing/analysis
- Keep step count between 2-8. Simple tasks = fewer steps. Complex tasks = more.
- The synthesis step combines everything — it should produce a coherent final message for the user

Available tools for sub-agents: Outlook (inbox, search, draft, send, calendar), memory (read/write/search), vault (notes, tasks), Bash, WebSearch, WebFetch, discord_channel_send, github_prs, rss_fetch, browser_screenshot, and file tools.

<user_request>
`;

const PLANNER_PROMPT_SUFFIX = `
</user_request>`;

/**
 * Compute execution waves from a dependency graph via topological sort.
 * Steps with empty dependsOn = wave 0. Steps whose deps are all in wave N = wave N+1.
 */
function computeWaves(steps: PlanStep[]): PlanStep[][] {
  const stepMap = new Map(steps.map(s => [s.id, s]));
  const waveOf = new Map<string, number>();
  const visiting = new Set<string>(); // shared across all roots for cycle detection

  function getWave(id: string): number {
    if (waveOf.has(id)) return waveOf.get(id)!;
    if (visiting.has(id)) throw new Error(`Circular dependency detected involving step ${id}`);
    visiting.add(id);

    const step = stepMap.get(id);
    if (!step || step.dependsOn.length === 0) {
      visiting.delete(id);
      waveOf.set(id, 0);
      return 0;
    }

    let maxDepWave = 0;
    for (const depId of step.dependsOn) {
      if (!stepMap.has(depId)) continue; // unknown deps stripped during validation
      maxDepWave = Math.max(maxDepWave, getWave(depId) + 1);
    }
    visiting.delete(id);
    waveOf.set(id, maxDepWave);
    return maxDepWave;
  }

  for (const step of steps) {
    getWave(step.id);
  }

  // Group into waves
  const maxWave = Math.max(0, ...waveOf.values());
  const waves: PlanStep[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const step of steps) {
    waves[waveOf.get(step.id) ?? 0].push(step);
  }
  return waves.filter(w => w.length > 0);
}

/**
 * Run promises with a concurrency limit.
 */
async function settledWithLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason: any) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export class PlanOrchestrator {
  private assistant: PersonalAssistant;
  private stepStatuses = new Map<string, PlanProgressUpdate>();
  private stepStartTimes = new Map<string, number>();
  private startTime = 0;

  constructor(assistant: PersonalAssistant) {
    this.assistant = assistant;
  }

  /**
   * Main entry: plan → execute → synthesize → return final response.
   */
  async run(
    taskDescription: string,
    onProgress?: (updates: PlanProgressUpdate[]) => Promise<void>,
  ): Promise<string> {
    // Reset instance state for reuse safety
    this.stepStatuses.clear();
    this.stepStartTimes.clear();
    this.startTime = Date.now();

    const safeProgress = async (updates: PlanProgressUpdate[]): Promise<void> => {
      try { await onProgress?.(updates); } catch (err) {
        logger.warn({ err }, 'Progress callback error (non-fatal)');
      }
    };

    // 1. Generate plan
    let plan: ExecutionPlan;
    try {
      plan = await this.generatePlan(taskDescription);
    } catch (err) {
      logger.warn({ err }, 'Plan generation failed — running as single step');
      return this.runSingleStep(taskDescription);
    }

    // Enforce max steps
    if (plan.steps.length > MAX_STEPS) {
      plan.steps = plan.steps.slice(0, MAX_STEPS);
    }
    if (plan.steps.length === 0) {
      logger.warn('Plan has no valid steps — running as single step');
      return this.runSingleStep(taskDescription);
    }

    logger.info(
      { goal: taskDescription, stepCount: plan.steps.length, steps: plan.steps.map(s => s.id) },
      'Plan generated',
    );

    // 2. Initialize statuses
    for (const step of plan.steps) {
      this.stepStatuses.set(step.id, {
        stepId: step.id,
        status: 'waiting',
        description: step.description,
      });
    }
    await safeProgress(this.getAllUpdates());

    // 3. Compute waves
    let waves: PlanStep[][];
    try {
      waves = computeWaves(plan.steps);
    } catch (err) {
      logger.error({ err }, 'Dependency graph error');
      return this.runSingleStep(taskDescription);
    }

    // 4. Execute waves
    const results = new Map<string, string>();
    let longPlanWarned = false;

    for (const wave of waves) {
      // Mark running
      for (const step of wave) {
        this.stepStatuses.set(step.id, {
          stepId: step.id,
          status: 'running',
          description: step.description,
        });
        this.stepStartTimes.set(step.id, Date.now());
      }
      await safeProgress(this.getAllUpdates());

      // Run wave steps with concurrency limit
      const settled = await settledWithLimit(
        wave.map((step) => async () => {
          const prompt = this.buildStepPrompt(step, results);
          const result = await this.assistant.runPlanStep(step.id, prompt, {
            tier: step.tier ?? 2,
            maxTurns: step.maxTurns ?? 15,
            model: step.model,
          });
          return { stepId: step.id, result };
        }),
        MAX_CONCURRENT_STEPS,
      );

      // Collect results
      for (let i = 0; i < wave.length; i++) {
        const step = wave[i];
        const outcome = settled[i];
        const elapsed = Date.now() - (this.stepStartTimes.get(step.id) ?? this.startTime);

        if (outcome.status === 'fulfilled') {
          const resultText = outcome.value.result || '[No output produced]';
          if (!outcome.value.result) {
            logger.warn({ stepId: step.id }, 'Plan step produced empty output');
          }
          results.set(step.id, resultText);
          this.stepStatuses.set(step.id, {
            stepId: step.id,
            status: 'done',
            description: step.description,
            durationMs: elapsed,
            resultPreview: resultText.slice(0, 100),
          });
        } else {
          const errMsg = `[FAILED: ${outcome.reason}]`;
          results.set(step.id, errMsg);
          this.stepStatuses.set(step.id, {
            stepId: step.id,
            status: 'failed',
            description: step.description,
            durationMs: elapsed,
            resultPreview: errMsg.slice(0, 100),
          });
          logger.error({ stepId: step.id, err: outcome.reason }, 'Plan step failed');
        }
      }
      await safeProgress(this.getAllUpdates());

      // Long-running warning
      if (!longPlanWarned && Date.now() - this.startTime > LONG_PLAN_WARNING_MS) {
        logger.warn({ elapsed: Date.now() - this.startTime }, 'Plan has been running for 30+ minutes');
        longPlanWarned = true;
      }
    }

    // 5. Synthesis
    const synthesisStepId = '__synthesis__';
    this.stepStatuses.set(synthesisStepId, {
      stepId: synthesisStepId,
      status: 'running',
      description: 'Synthesize final response',
    });
    this.stepStartTimes.set(synthesisStepId, Date.now());
    await safeProgress(this.getAllUpdates());

    const synthesisPrompt = this.buildSynthesisPrompt(plan, results);
    let finalResult: string;
    try {
      finalResult = await this.assistant.runPlanStep(synthesisStepId, synthesisPrompt, {
        tier: 2,
        maxTurns: 5,
        disableTools: true,
      });
    } catch (err) {
      logger.error({ err }, 'Synthesis step failed');
      // Fallback: concatenate results
      finalResult = Array.from(results.entries())
        .map(([id, r]) => `**${this.stepStatuses.get(id)?.description ?? id}:**\n${r}`)
        .join('\n\n');
    }

    const synthElapsed = Date.now() - (this.stepStartTimes.get(synthesisStepId) ?? this.startTime);
    this.stepStatuses.set(synthesisStepId, {
      stepId: synthesisStepId,
      status: 'done',
      description: 'Synthesize final response',
      durationMs: synthElapsed,
    });
    await safeProgress(this.getAllUpdates());

    const totalMs = Date.now() - this.startTime;
    logger.info({ totalMs, steps: plan.steps.length }, 'Plan execution complete');

    return finalResult;
  }

  /**
   * Get formatted progress lines for display.
   */
  getProgressLines(): string[] {
    const lines: string[] = [];
    const entries = [...this.stepStatuses.values()];
    const total = entries.length;

    for (let i = 0; i < entries.length; i++) {
      const u = entries[i];
      const num = `[${i + 1}/${total}]`;
      const elapsed = this.stepStartTimes.has(u.stepId)
        ? Math.round((Date.now() - this.stepStartTimes.get(u.stepId)!) / 1000)
        : 0;

      switch (u.status) {
        case 'done':
          lines.push(`${num} ${u.description} \u2713 (${Math.round((u.durationMs ?? 0) / 1000)}s)`);
          break;
        case 'running':
          lines.push(`${num} ${u.description} \u23f3 running... (${elapsed}s)`);
          break;
        case 'failed':
          lines.push(`${num} ${u.description} \u2717 failed (${Math.round((u.durationMs ?? 0) / 1000)}s)`);
          break;
        case 'waiting':
          lines.push(`${num} ${u.description} \u25cb waiting`);
          break;
      }
    }
    return lines;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async generatePlan(task: string): Promise<ExecutionPlan> {
    const plannerResult = await this.assistant.runPlanStep(
      'planner',
      PLANNER_PROMPT + task + PLANNER_PROMPT_SUFFIX,
      { tier: 2, maxTurns: 1, model: 'sonnet', disableTools: true },
    );

    // Parse JSON from the planner response
    const parsed = this.parseJsonFromResponse(plannerResult);
    if (!parsed?.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error('Planner returned invalid plan structure');
    }

    // Validate and normalize steps
    const seenIds = new Set<string>();
    const validStepIds = new Set(parsed.steps.map((s: any, i: number) => s.id || `step-${i + 1}`));

    const steps: PlanStep[] = [];
    for (let i = 0; i < parsed.steps.length; i++) {
      const s = parsed.steps[i];
      const id = s.id || `step-${i + 1}`;

      // Skip duplicate IDs
      if (seenIds.has(id)) {
        logger.warn({ id }, 'Duplicate step ID — skipping');
        continue;
      }
      seenIds.add(id);

      // Skip empty prompts
      const prompt = (s.prompt || '').trim();
      if (!prompt) {
        logger.warn({ id }, 'Step has empty prompt — skipping');
        continue;
      }

      // Clean dependencies: remove self-refs and unknown refs
      const deps = Array.isArray(s.dependsOn)
        ? s.dependsOn.filter((d: string) => d !== id && validStepIds.has(d))
        : [];

      // Validate model
      const model = ALLOWED_MODELS.includes(s.model) ? s.model : undefined;

      steps.push({
        id,
        description: (s.description || `Step ${i + 1}`).slice(0, 80),
        prompt,
        dependsOn: deps,
        maxTurns: Math.min(Math.max(s.maxTurns ?? 15, 1), 50),
        tier: Math.min(s.tier ?? 2, 2), // Never exceed tier 2 from planner
        model,
      });
    }

    if (steps.length === 0) {
      throw new Error('No valid steps after validation');
    }

    return {
      goal: task,
      steps,
      synthesisPrompt: parsed.synthesisPrompt || 'Combine all step results into a coherent response for the user.',
    };
  }

  private parseJsonFromResponse(text: string): any {
    // Try direct parse first
    try {
      return JSON.parse(text);
    } catch { /* fall through */ }

    // Try extracting from markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1]);
      } catch { /* fall through */ }
    }

    // Try finding the last balanced { ... } block containing "steps"
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace !== -1) {
      // Walk backward to find the matching opening brace
      let depth = 0;
      for (let i = lastBrace; i >= 0; i--) {
        if (text[i] === '}') depth++;
        if (text[i] === '{') depth--;
        if (depth === 0) {
          const candidate = text.slice(i, lastBrace + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed?.steps) return parsed;
          } catch { /* continue searching */ }
          break;
        }
      }
    }

    return null;
  }

  private buildStepPrompt(step: PlanStep, priorResults: Map<string, string>): string {
    const parts: string[] = [];

    // Inject prior step results for dependencies
    if (step.dependsOn.length > 0) {
      const depResults: string[] = [];
      for (const depId of step.dependsOn) {
        const result = priorResults.get(depId);
        if (result) {
          const desc = this.stepStatuses.get(depId)?.description ?? depId;
          const isFailed = result.startsWith('[FAILED:');
          const truncated = result.length > RESULT_TRUNCATE_CHARS
            ? result.slice(0, RESULT_TRUNCATE_CHARS) + '\n...[truncated]'
            : result;
          if (isFailed) {
            depResults.push(`### ${depId}: ${desc} (FAILED)\n${truncated}\n\n*This dependency failed — work around the missing data or note the gap.*`);
          } else {
            depResults.push(`### ${depId}: ${desc}\n${truncated}`);
          }
        }
      }
      if (depResults.length > 0) {
        parts.push('## Results from prior steps:\n' + depResults.join('\n\n'));
      }
    }

    parts.push('## Your task:\n' + step.prompt);

    return parts.join('\n\n');
  }

  private buildSynthesisPrompt(plan: ExecutionPlan, results: Map<string, string>): string {
    const parts: string[] = [
      `## Original request:\n${plan.goal}`,
      '',
      '## Step results:',
    ];

    for (const step of plan.steps) {
      const result = results.get(step.id) ?? '[no result]';
      const truncated = result.length > RESULT_TRUNCATE_CHARS
        ? result.slice(0, RESULT_TRUNCATE_CHARS) + '\n...[truncated]'
        : result;
      parts.push(`### ${step.id}: ${step.description}\n${truncated}`);
    }

    parts.push('', `## Instructions:\n${plan.synthesisPrompt}`);
    parts.push('\nWrite a coherent final response for the user. Be concise and conversational — this is going to a Discord DM.');

    return parts.join('\n');
  }

  private async runSingleStep(task: string): Promise<string> {
    return this.assistant.runPlanStep('fallback', task, {
      tier: 2,
      maxTurns: 25,
    });
  }

  private getAllUpdates(): PlanProgressUpdate[] {
    return [...this.stepStatuses.values()];
  }
}
