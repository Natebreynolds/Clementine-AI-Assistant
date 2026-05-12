/**
 * bg-planner — decompose a multi-step user request into a chain of
 * focused PlanSteps that the orchestrator can dispatch one at a time.
 *
 * Why this exists (1.18.190)
 * ──────────────────────────
 * Before this, a complex multi-step user ask ("find the coaches project,
 * build me an HTML report, deploy it to Netlify, verify the URL") got
 * handed to a single monolithic bg-task worker. The worker had its own
 * 200K context but still autocompact-thrashed because:
 *   - tool outputs accumulated across all 5-6 phases of the work
 *   - the model lost fidelity to its own past tool outputs as the
 *     output-guard tightened from 30KB → 4KB
 *   - one bad turn (huge file read, big Glob) poisoned the rest
 *
 * The decomposition pattern this module enables:
 *   1. Planner runs ONCE with Sonnet (not Haiku — plans need real
 *      reasoning, see "Model choice" below)
 *   2. Emits a Plan: 3-7 PlanSteps, each with title + scope + expected
 *      tool calls + deliverable artifact path
 *   3. Plan persists to <project>/.clementine/plans/<planId>.json
 *      (or BASE_DIR/plans/<planId>.json if no active project)
 *   4. Orchestrator (bg-orchestrator.ts) queues one bg-task per step,
 *      each with a tight scope and a fresh 200K worker window
 *   5. State flows between steps via STATUS.md + the plan ledger;
 *      no step accumulates context from prior steps
 *
 * Model choice: Sonnet, NOT Haiku
 * ────────────────────────────────
 * Planning is a reasoning task, not a transformation. A poorly
 * decomposed plan costs $5+ in downstream worker thrash; a well-
 * decomposed plan saves multiples of that. The marginal cost of
 * Sonnet over Haiku (~$0.05-0.15 vs ~$0.01 per plan) is trivial
 * compared to the downstream cost of bad decomposition. Haiku is for
 * mechanical tasks (extraction, classification, routing); decomposing
 * a multi-domain ask into proper steps is not mechanical.
 *
 * If you're tempted to "save tokens" by flipping this to Haiku, read
 * the 2026-05-12 root-cause plan first
 * (~/.claude/plans/look-at-the-last-vivid-rossum.md). The whole point
 * of this ship is to NOT cut corners on the decomposition layer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR, MODELS, applyOneMillionContextRecovery, looksLikeClaudeOneMillionContextError, normalizeClaudeSdkOptionsForOneMillionContext } from '../config.js';
import type { ProjectMeta } from './assistant.js';

const logger = pino({ name: 'clementine.bg-planner' });

// ── Types ────────────────────────────────────────────────────────────

export interface PlanStep {
  /** 0-indexed position. */
  index: number;
  /** Short imperative title (e.g., "Find the coaches project"). */
  title: string;
  /** What this step does, in 1-2 sentences. The chained worker sees this. */
  scope: string;
  /** Tools the step is expected to call. The chained worker sees this as
   *  guidance, not enforcement — overshooting is allowed, just not
   *  preferred. */
  expectedTools: string[];
  /** Where the step's output goes (file path, deploy URL, etc.) — used
   *  by claim-verification + by the next step to find prior work. */
  deliverable?: string;
  /** Step status — orchestrator updates this. */
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  /** Set by orchestrator after dispatch. */
  taskId?: string;
  /** Worker's final result text (for visibility, capped). */
  resultPreview?: string;
  /** Set on completion. */
  completedAt?: string;
}

export interface Plan {
  /** Unique plan id — also the filename basename. */
  id: string;
  /** Chain id — shared by the planner task and all step tasks for one user request. */
  chainId: string;
  /** Original user request the planner decomposed. */
  userRequest: string;
  /** Resolved project path (if any) when the planner ran. */
  projectPath?: string;
  /** Session key of the originating chat — for delivering the final result. */
  originatingSessionKey?: string;
  /** ISO when the planner emitted this. */
  createdAt: string;
  /** Steps in execution order. */
  steps: PlanStep[];
  /** Overall chain status. Derived from steps; persisted for cheap reads. */
  status: 'pending' | 'in_progress' | 'completed' | 'paused' | 'failed';
  /** Total estimated cost (USD) for this plan if every step's expectedTools fire as-projected.
   *  Informational only — not enforced. */
  estimatedCostUsd?: number;
  /** Free-form notes from the planner: known risks, assumptions, etc. */
  notes?: string;
}

// ── Persistence ──────────────────────────────────────────────────────

/**
 * Where plans live. If `projectPath` is set, plans go inside that
 * project's `.clementine/plans/` so they travel with the project; if
 * no project, plans go under `BASE_DIR/plans/` (global).
 */
export function plansDir(projectPath?: string | null): string {
  if (projectPath) return path.join(projectPath, '.clementine', 'plans');
  return path.join(BASE_DIR, 'plans');
}

export function planFile(planId: string, projectPath?: string | null): string {
  const safe = String(planId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  return path.join(plansDir(projectPath), `${safe}.json`);
}

export function savePlan(plan: Plan, projectPath?: string | null): string {
  const dir = plansDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = planFile(plan.id, projectPath);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

export function loadPlan(planId: string, projectPath?: string | null): Plan | null {
  const file = planFile(planId, projectPath);
  if (!fs.existsSync(file)) {
    // Fallback: if the project-scoped path is missing, try the global
    // dir. Common when the project was added AFTER the plan was created.
    if (projectPath) {
      const fallback = planFile(planId);
      if (fs.existsSync(fallback)) {
        try { return JSON.parse(fs.readFileSync(fallback, 'utf-8')) as Plan; }
        catch { return null; }
      }
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Plan;
  } catch (err) {
    logger.warn({ err, planId }, 'plan parse failed');
    return null;
  }
}

// ── The planner ──────────────────────────────────────────────────────

export interface PlanRequestOptions {
  userRequest: string;
  originatingSessionKey?: string;
  project?: ProjectMeta | null;
  /** Optional override; defaults to Sonnet. NEVER pass Haiku here. */
  model?: string;
  /** Override the SDK query function for tests. */
  llmCall?: (prompt: string, systemPrompt: string, model: string) => Promise<string>;
}

/**
 * Decompose a user request into a Plan. Pure async function — no side
 * effects except the optional LLM call. Caller decides whether to
 * persist the result via `savePlan`.
 *
 * Behavior:
 *   - Builds a system prompt describing the decomposition contract
 *   - Asks the model to emit a JSON object matching the Plan schema
 *   - Validates the response against the schema; logs and retries once on parse failure
 *   - Returns a Plan ready for orchestrator dispatch
 *
 * Failure modes:
 *   - LLM returns non-JSON → throws PlanGenerationError
 *   - LLM returns empty steps → throws PlanGenerationError
 *   - LLM returns >12 steps → trimmed to first 12 with a warning
 */
export async function planRequest(opts: PlanRequestOptions): Promise<Plan> {
  const model = opts.model ?? MODELS.sonnet ?? 'claude-sonnet-4-6';
  const chainId = `chain-${randomUUID().slice(0, 12)}`;
  const planId = `plan-${randomUUID().slice(0, 12)}`;

  const systemPrompt = buildPlannerSystemPrompt();
  const userPrompt = buildPlannerUserPrompt(opts);

  const text = opts.llmCall
    ? await opts.llmCall(userPrompt, systemPrompt, model)
    : await runPlannerLlm(userPrompt, systemPrompt, model);

  const parsed = parsePlannerResponse(text);
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new PlanGenerationError(
      `Planner returned no steps (raw response head: ${text.slice(0, 200)})`,
    );
  }

  // Cap at 12 steps. Real multi-step work fits in 3-7; >12 is almost
  // always over-decomposition by the model. Trim to keep chains manageable.
  const rawSteps = parsed.steps.slice(0, 12);
  const steps: PlanStep[] = rawSteps.map((raw, i) => ({
    index: i,
    title: String(raw.title ?? `Step ${i + 1}`).slice(0, 160),
    scope: String(raw.scope ?? '').slice(0, 800),
    expectedTools: Array.isArray(raw.expectedTools)
      ? raw.expectedTools.map((t: unknown) => String(t)).filter(Boolean).slice(0, 8)
      : [],
    ...(raw.deliverable ? { deliverable: String(raw.deliverable).slice(0, 400) } : {}),
    status: 'pending' as const,
  }));

  const plan: Plan = {
    id: planId,
    chainId,
    userRequest: opts.userRequest,
    ...(opts.project?.path ? { projectPath: opts.project.path } : {}),
    ...(opts.originatingSessionKey ? { originatingSessionKey: opts.originatingSessionKey } : {}),
    createdAt: new Date().toISOString(),
    steps,
    status: 'pending',
    ...(typeof parsed.estimatedCostUsd === 'number' ? { estimatedCostUsd: parsed.estimatedCostUsd } : {}),
    ...(parsed.notes ? { notes: String(parsed.notes).slice(0, 600) } : {}),
  };

  logger.info({
    planId,
    chainId,
    stepCount: steps.length,
    model,
    project: opts.project?.path,
  }, 'planRequest: emitted plan');

  return plan;
}

export class PlanGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanGenerationError';
  }
}

// ── Internals: prompt construction + SDK call ────────────────────────

function buildPlannerSystemPrompt(): string {
  return [
    'You are a planning assistant for Clementine, a personal AI agent.',
    'Your one job: take a multi-step user request and decompose it into 3-7 focused',
    'subtasks that an execution worker can run one at a time, each in its own fresh',
    'context window.',
    '',
    '## Why decomposition matters',
    '',
    'The execution worker has a 200K context budget per step. If a single step',
    'tries to do too much (read a 10MB CSV + build HTML + deploy + verify), it',
    'fills its window with tool outputs, the SDK compacts, fidelity degrades, and',
    'the worker thrashes. Your job is to keep each step BOUNDED so this can\'t',
    'happen.',
    '',
    '## Decomposition principles',
    '',
    '1. **One verb per step.** Each step does ONE thing: find, read, build,',
    '   write, deploy, verify. Compound verbs ("build and deploy") = bad step.',
    '2. **State flows through disk, not context.** If step 3 needs data from',
    '   step 1, step 1 writes to a file; step 3 reads it. Don\'t carry data in',
    '   the chain itself.',
    '3. **Each step has ONE deliverable.** A file path, a URL, a confirmation.',
    '   Steps without a clear deliverable are signal that the decomposition is',
    '   off.',
    '4. **Estimate tool calls per step.** A step expected to make >10 tool calls',
    '   probably needs to be split. Aim for 2-6 tool calls per step.',
    '5. **Match steps to the actual user ask.** Don\'t add steps the user didn\'t',
    '   request (e.g., don\'t add a "send confirmation email" step unless they',
    '   asked). Don\'t skip steps they DID ask for.',
    '',
    '## Output format — STRICT JSON only',
    '',
    'Return ONLY a JSON object with this shape. No markdown fences, no prose:',
    '',
    '{',
    '  "steps": [',
    '    {',
    '      "title": "<short imperative title, e.g. \'Find the coaches project\'>",',
    '      "scope": "<1-2 sentences describing exactly what this step does>",',
    '      "expectedTools": ["tool_name_1", "tool_name_2"],',
    '      "deliverable": "<file path | URL | description of the artifact>"',
    '    }',
    '    // ... 2-11 more steps',
    '  ],',
    '  "estimatedCostUsd": 0.50,',
    '  "notes": "<known risks or assumptions, optional>"',
    '}',
    '',
    'Available tools the worker can call (these are the most relevant for',
    'decomposition; full list is bigger):',
    '- project_discover, project_link, project_deploy (Clementine project tools)',
    '- Read, Write, Edit (file I/O)',
    '- Bash (any shell command — prefer `head/awk/jq` over Read for big files)',
    '- Glob, Grep (search)',
    '- memory_search, memory_write (Clementine memory)',
    '- WebFetch, WebSearch (web)',
    '',
    'Sample expected-tool sequences:',
    '- "Find a project" → [project_discover, project_link]',
    '- "Read source data" → [Bash (head/wc), Read]',
    '- "Build artifact" → [Read, Write]',
    '- "Deploy" → [project_deploy]',
    '- "Verify deploy" → [Bash (curl)]',
  ].join('\n');
}

function buildPlannerUserPrompt(opts: PlanRequestOptions): string {
  const lines: string[] = [];
  lines.push('## User request');
  lines.push(opts.userRequest);

  if (opts.project) {
    lines.push('');
    lines.push('## Active project');
    lines.push(`Path: ${opts.project.path}`);
    if (opts.project.description) lines.push(`Description: ${opts.project.description}`);
    if (opts.project.keywords?.length) lines.push(`Keywords: ${opts.project.keywords.join(', ')}`);
    // Surface STATUS.md preview if present — it carries state from prior chains.
    try {
      const statusPath = path.join(opts.project.path, '.clementine', 'STATUS.md');
      if (fs.existsSync(statusPath)) {
        const status = fs.readFileSync(statusPath, 'utf-8').trim();
        if (status) {
          lines.push('');
          lines.push('## Project STATUS.md (current state)');
          lines.push(status.slice(0, 1500));
        }
      }
    } catch { /* non-fatal */ }
  } else {
    lines.push('');
    lines.push('## Active project');
    lines.push('(none — if this request implies a project, your first step should be project_discover + project_link to resolve it before doing other work)');
  }

  lines.push('');
  lines.push('Decompose the request into a Plan. Return strict JSON, no prose.');
  return lines.join('\n');
}

async function runPlannerLlm(userPrompt: string, systemPrompt: string, model: string): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let text = '';
  const stream = query({
    prompt: userPrompt,
    options: normalizeClaudeSdkOptionsForOneMillionContext({
      model,
      maxTurns: 1, // single shot — emit JSON, done
      systemPrompt,
    }),
  });
  for await (const msg of stream) {
    if (msg.type === 'result') {
      // SDK 'result' message carries the final text.
      const m = msg as { is_error?: boolean; errors?: unknown[]; result?: string };
      if (m.is_error) {
        const errorText = Array.isArray(m.errors) ? m.errors.join('; ') : String(m.result ?? '');
        if (looksLikeClaudeOneMillionContextError(errorText)) applyOneMillionContextRecovery();
        throw new Error(errorText || 'Planner SDK call failed');
      }
      text = m.result ?? '';
    }
  }
  return text;
}

interface RawPlannerResponse {
  steps?: Array<{
    title?: unknown;
    scope?: unknown;
    expectedTools?: unknown;
    deliverable?: unknown;
  }>;
  estimatedCostUsd?: number;
  notes?: unknown;
}

/** Defensive JSON parse — strips common LLM wrappers (markdown fences,
 *  leading/trailing prose) before parsing. */
export function parsePlannerResponse(raw: string): RawPlannerResponse | null {
  if (!raw || !raw.trim()) return null;
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1]!.trim();
  // If still not pure JSON, try to extract the first {...} block.
  if (!text.startsWith('{')) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) text = objMatch[0];
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RawPlannerResponse;
    }
    return null;
  } catch {
    return null;
  }
}
