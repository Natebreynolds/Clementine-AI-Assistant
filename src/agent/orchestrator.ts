/**
 * Clementine TypeScript — Plan Orchestrator.
 *
 * Decomposes a task into steps, runs independent steps in parallel
 * via concurrent query() calls, then synthesizes a final response.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import pino from 'pino';
import type { PersonalAssistant } from './assistant.js';
import type { PlanStep, ExecutionPlan, PlanProgressUpdate } from '../types.js';
import { PLAN_STATE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.orchestrator' });

const MAX_STEPS = 10;
const MAX_CONCURRENT_STEPS = 3;
const RESULT_TRUNCATE_CHARS = 4000;
const LONG_PLAN_WARNING_MS = 30 * 60 * 1000; // 30 minutes
const ALLOWED_MODELS = ['haiku', 'sonnet'];

const PLANNER_PROMPT = `You are a task planner for an AI assistant. Decompose the following request into executable steps.

**Planning Principles:**
- Each step runs in a FRESH CONTEXT (separate sub-agent) — no context rot, peak quality
- Steps should be ATOMIC — completable in one focused session, not vague or open-ended
- MAXIMIZE PARALLELISM — independent steps run concurrently in separate contexts
- Follow Research → Execute → Verify — research steps feed into execution steps, verification confirms delivery
- Size for quality: each step should complete within 15-50 tool calls, not sprawl indefinitely

Output ONLY valid JSON matching this schema (no markdown fences, no prose):

{
  "steps": [
    {
      "id": "step-1",
      "description": "Short human-readable label",
      "prompt": "Detailed, self-contained instructions for the sub-agent. Be specific — the agent has no prior conversation context. Include tool names to use, what to look for, and what output to produce. End with a clear deliverable: 'Deliver: ...'",
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
- Each step must end with a clear deliverable statement ("Deliver: the list of...", "Deliver: a draft email...")
- Set maxTurns based on complexity: simple lookup = 5, moderate task = 15, complex work = 30-50
- Set model based on step complexity: "haiku" for simple lookups/formatting, "sonnet" for reasoning/writing/analysis
- Keep step count between 2-8. Simple tasks = fewer steps. Complex tasks = more.
- If the task has a verification component, include it as a final dependent step
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
export function computeWaves(steps: PlanStep[]): PlanStep[][] {
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
export async function settledWithLimit<T>(
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

/** Persistent state for a plan execution — survives interruptions. */
interface PlanState {
  id: string;
  goal: string;
  status: 'planning' | 'executing' | 'synthesizing' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  plan?: ExecutionPlan;
  totalWaves: number;
  wavesCompleted: number;
  results: Record<string, string>;
  errors: Array<{ stepId: string; error: string }>;
}

export class PlanOrchestrator {
  private assistant: PersonalAssistant;
  private stepStatuses = new Map<string, PlanProgressUpdate>();
  private stepStartTimes = new Map<string, number>();
  private startTime = 0;
  private stateId: string;

  constructor(assistant: PersonalAssistant) {
    this.assistant = assistant;
    this.stateId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── State persistence ────────────────────────────────────────────────

  private saveState(state: PlanState): void {
    try {
      if (!existsSync(PLAN_STATE_DIR)) mkdirSync(PLAN_STATE_DIR, { recursive: true });
      state.updatedAt = new Date().toISOString();
      writeFileSync(
        `${PLAN_STATE_DIR}/${state.id}.json`,
        JSON.stringify(state, null, 2),
      );
    } catch (err) {
      logger.debug({ err }, 'Failed to save plan state (non-fatal)');
    }
  }

  private cleanupState(): void {
    try {
      const filePath = `${PLAN_STATE_DIR}/${this.stateId}.json`;
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* non-fatal */ }
  }

  /** Load a previously interrupted plan state (for future resumability). */
  static loadState(stateId: string): PlanState | null {
    try {
      const filePath = `${PLAN_STATE_DIR}/${stateId}.json`;
      if (!existsSync(filePath)) return null;
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Main entry: plan → approve → execute → synthesize → return final response.
   */
  async run(
    taskDescription: string,
    onProgress?: (updates: PlanProgressUpdate[]) => Promise<void>,
    onApproval?: (planSummary: string, steps: PlanStep[]) => Promise<boolean | string>,
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

    // 1. Generate plan (with revision loop)
    const MAX_REVISIONS = 3;
    let revisionCount = 0;
    let effectiveTask = taskDescription;
    let plan: ExecutionPlan;
    let waves: PlanStep[][];

    // Plan → approval → (optional revision) loop
    planLoop: while (true) {
      try {
        plan = await this.generatePlan(effectiveTask);
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
        { goal: effectiveTask, stepCount: plan.steps.length, steps: plan.steps.map(s => s.id), revision: revisionCount },
        'Plan generated',
      );

      // 2. Initialize statuses
      this.stepStatuses.clear();
      for (const step of plan.steps) {
        this.stepStatuses.set(step.id, {
          stepId: step.id,
          status: 'waiting',
          description: step.description,
        });
      }
      await safeProgress(this.getAllUpdates());

      // 3. Compute waves
      try {
        waves = computeWaves(plan.steps);
      } catch (err) {
        logger.error({ err }, 'Dependency graph error');
        return this.runSingleStep(taskDescription);
      }

      // 3b. Approval gate — show plan before executing
      if (onApproval) {
        const planSummary = waves
          .map((wave, wi) => wave.map(s => `  [Wave ${wi + 1}] ${s.id}: ${s.description}`).join('\n'))
          .join('\n');
        const result = await onApproval(planSummary, plan.steps);
        if (result === false) {
          logger.info({ goal: taskDescription }, 'Plan cancelled by user');
          return 'Plan cancelled.';
        }
        if (typeof result === 'string') {
          // Revision feedback — regenerate the plan
          revisionCount++;
          if (revisionCount > MAX_REVISIONS) {
            logger.warn({ goal: taskDescription, revisions: revisionCount }, 'Max plan revisions reached');
            return 'Plan cancelled — too many revisions.';
          }
          logger.info({ goal: taskDescription, revision: revisionCount, feedback: result }, 'Plan revision requested');
          effectiveTask = `${taskDescription}\n\n[Revision ${revisionCount}] The user reviewed the previous plan and asked for changes:\n${result}`;
          continue planLoop;
        }
      }

      break; // Approved — proceed to execution
    }

    // 4. Execute waves — with state persistence for resumability
    const results = new Map<string, string>();
    let longPlanWarned = false;

    const state: PlanState = {
      id: this.stateId,
      goal: taskDescription,
      status: 'executing',
      startedAt: new Date(this.startTime).toISOString(),
      updatedAt: new Date().toISOString(),
      plan: plan!,
      totalWaves: waves!.length,
      wavesCompleted: 0,
      results: {},
      errors: [],
    };
    this.saveState(state);

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

      // Inter-wave spot-check: verify claimed artifacts exist before proceeding
      // This prevents downstream waves from building on phantom results
      const spotCheckIssues = this.spotCheckWaveResults(wave, results);
      if (spotCheckIssues.length > 0) {
        logger.warn({ issues: spotCheckIssues }, 'Spot-check found issues in wave results');
        // Annotate results so the synthesis step knows about verification failures
        for (const issue of spotCheckIssues) {
          const existing = results.get(issue.stepId) ?? '';
          results.set(issue.stepId, existing + `\n\n[SPOT-CHECK WARNING: ${issue.issue}]`);
        }
      }

      // Persist state after each wave for resumability
      state.wavesCompleted++;
      state.results = Object.fromEntries(results);
      for (const step of wave) {
        const s = this.stepStatuses.get(step.id);
        if (s?.status === 'failed') {
          state.errors.push({ stepId: step.id, error: s.resultPreview ?? 'unknown' });
        }
      }
      this.saveState(state);

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

    // Mark state as complete and clean up
    state.status = 'complete';
    this.saveState(state);
    // Clean up state file on successful completion (it served its purpose)
    this.cleanupState();

    // 6. Post-synthesis reflection (async, non-blocking)
    this.runReflection(taskDescription, finalResult).catch(err => {
      logger.debug({ err }, 'Post-plan reflection failed (non-fatal)');
    });

    return finalResult;
  }

  /**
   * Goal-backward verification pass using Haiku after plan synthesis.
   * Verifies outcomes rather than just rating quality:
   * - Did each step produce a real result?
   * - Is the synthesized output substantive (not restating the question)?
   * - Are there gaps between request and output?
   */
  private async runReflection(taskDescription: string, output: string): Promise<void> {
    if (!output || output.length < 50) return;

    // Build a step results summary for the verifier
    const stepSummary = [...this.stepStatuses.entries()]
      .filter(([id]) => id !== '__synthesis__')
      .map(([id, s]) => `- ${s.description}: ${s.status}${s.status === 'failed' ? ' FAILED' : ''}`)
      .join('\n');

    const reflectionPrompt =
      `Verify the outcome of this orchestrated plan using goal-backward verification.\n\n` +
      `**Original request:** ${taskDescription.slice(0, 400)}\n\n` +
      `**Step results:**\n${stepSummary}\n\n` +
      `**Final output (first 1000 chars):** ${output.slice(0, 1000)}\n\n` +
      `Verify:\n` +
      `1. COMPLETENESS: Does the output address ALL parts of the original request? (not just the easy parts)\n` +
      `2. SUBSTANCE: Is each claim backed by data/evidence? (not vague summaries or restating the question)\n` +
      `3. WIRED: Are the step results actually connected in the synthesis? (not just concatenated)\n` +
      `4. GAPS: What specific parts of the request were missed or under-addressed?\n\n` +
      `Respond with ONLY a JSON object (no markdown):\n` +
      `{"completeness": true/false, "substance": true/false, "wired": true/false, ` +
      `"quality": 1-10, "gaps": "specific gaps or 'none'", "improvement": "one concrete thing to do differently"}`;

    try {
      const result = await this.assistant.runPlanStep('plan-reflection', reflectionPrompt, {
        tier: 1,
        maxTurns: 1,
        model: 'haiku',
        disableTools: true,
      });

      const jsonMatch = result.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const reflection = JSON.parse(jsonMatch[0]);
        logger.info({
          quality: reflection.quality,
          completeness: reflection.completeness,
          substance: reflection.substance,
          wired: reflection.wired,
          gaps: reflection.gaps?.slice(0, 100),
          improvement: reflection.improvement?.slice(0, 100),
        }, 'Plan reflection completed');
      }
    } catch {
      // Non-fatal — reflection is best-effort
    }
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

  /**
   * Inter-wave spot-check: verify that step results contain substance.
   * Catches empty outputs, error-only results, and placeholder/stub responses
   * before downstream waves try to build on them.
   */
  private spotCheckWaveResults(
    wave: PlanStep[],
    results: Map<string, string>,
  ): Array<{ stepId: string; issue: string }> {
    const issues: Array<{ stepId: string; issue: string }> = [];

    for (const step of wave) {
      const result = results.get(step.id) ?? '';
      const status = this.stepStatuses.get(step.id);

      // Skip already-failed steps
      if (status?.status === 'failed') continue;

      // Check 1: Empty or near-empty output
      if (result.length < 20) {
        issues.push({ stepId: step.id, issue: `Output is empty or trivial (${result.length} chars)` });
        continue;
      }

      // Check 2: Output is just an error message
      if (result.startsWith('[FAILED:') || result.startsWith('Error:') || result.startsWith('Something went wrong')) {
        issues.push({ stepId: step.id, issue: 'Output appears to be an error, not a result' });
        continue;
      }

      // Check 3: Stub detection — output that restates the task without answering
      const stubPatterns = [
        /^I('ll| will) (start|begin|look into|investigate|check)/i,
        /^Let me (start|begin|look into|investigate|check)/i,
        /^(Sure|OK|Alright),? (I'll|let me)/i,
      ];
      const firstLine = result.split('\n')[0];
      if (stubPatterns.some(p => p.test(firstLine)) && result.length < 200) {
        issues.push({ stepId: step.id, issue: 'Output appears to be a stub/placeholder (restates intent without delivering results)' });
      }
    }

    return issues;
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
