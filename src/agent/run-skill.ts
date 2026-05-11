/**
 * runSkill — the canonical Skill execution primitive (1.18.162).
 *
 * Closes Skills Runtime C-2 from the Skills-First redesign.
 *
 * Today (pre-1.18.162) a pinned skill is fed into a cron prompt as a
 * markdown context block and its `clementine.tools.allow` list is UNIONED
 * into the cron's allowedTools (1.18.121 widening). That is permissive,
 * not enforced — a skill that says "I only use Bash + WebFetch" can still
 * call any tool the surrounding cron allows.
 *
 * `runSkill(name, options)` is the alternative path: a sub-call where
 * `{{var}}` placeholders in the body are substituted from `options.inputs`,
 * optional `tools.allow` / `tools.deny` becomes an SDK allowlist, and
 * `clementine.success.schema` is ajv-validated post-run.
 *
 * Why a separate primitive (and not a flag on the existing widening path):
 * - Caller intent is different. Pinned-skills-as-context is "give the LLM
 *   reference material"; runSkill is "do this specific procedure now."
 * - Hard enforcement requires constructing the SDK call ourselves, not
 *   reusing a cron-job's effective allowlist.
 * - Inputs/success are skill-call concepts, not cron concepts.
 *
 * Surfaced as the MCP tool `run_skill(name, inputs?)` so chat + cron +
 * sub-agents converge on one primitive.
 */

import path from 'node:path';
import pino from 'pino';

import { getSkill } from './skill-store.js';
import { runAgent } from './run-agent.js';
import type { RunAgentOptions } from './run-agent.js';
import type { AgentProfile, Skill } from '../types.js';
import type { AgentManager } from './agent-manager.js';
import type { MemoryStore } from '../memory/store.js';

const logger = pino({ name: 'clementine.run-skill' });

// ── Types ─────────────────────────────────────────────────────────────

export interface RunSkillOptions {
  /** Mustache-style `{{var}}` substitutions for the skill body. */
  inputs?: Record<string, string | number | boolean>;
  /** Optional caller context appended after the skill body
   *  (e.g. the user's request, the cron firing context). */
  context?: string;
  /** Stable session key for transcript mirroring. Defaults to a synthesized
   *  key derived from the skill name + timestamp. */
  sessionKey?: string;
  /** Source classification for telemetry. Defaults to 'skill'. */
  source?: string;
  /** Optional model override. */
  model?: string;
  /** Hard turn cap. Falls back to `clementine.limits.maxTurns` if set. */
  maxTurns?: number;
  /** Hard budget cap (USD). Falls back to `clementine.limits.maxBudgetUsd`. */
  maxBudgetUsd?: number;
  /** Project work dir for per-project skill precedence (mirrors getSkill's
   *  `projectWorkDir` parameter — when set, project-scoped skills shadow
   *  global ones with the same name). */
  projectWorkDir?: string;
  /** Optional hired-agent profile used as the main agent for this skill run. */
  profile?: AgentProfile | null;
  /** Hired-agent registry for SDK subagent definitions. */
  agentManager?: AgentManager | null;
  /** Memory store for transcript mirroring, cost logging, and run observability. */
  memoryStore?: MemoryStore | null;
  /** Skip success.schema validation even if the skill declares one. */
  skipValidation?: boolean;
  /** Streaming callback for partial assistant text. */
  onText?: (chunk: string) => void | Promise<void>;
  /** Abort signal — cancels the SDK stream when triggered. */
  abortSignal?: AbortSignal;
}

export interface RunSkillResult {
  ok: boolean;
  /** Final text response from the SDK. */
  output: string;
  /** Cost in USD. */
  cost?: number;
  /** Number of agentic turns. */
  turns?: number;
  /** SDK session id — capture for resume. */
  sessionId?: string;
  /** SDK runId — joins to the Event store. */
  runId?: string;
  /** Schema validation result when the skill declared `clementine.success.schema`. */
  validation?: {
    /** True when validation actually ran (schema present + JSON extractable). */
    tried: boolean;
    /** True when the response validated against the schema. */
    pass: boolean;
    /** First few ajv error messages. */
    errors: string[];
  };
  /** Computed skill tools. Passed to the SDK only when the skill declares tool scope. */
  effectiveTools?: string[];
  /** Effective SDK allowedTools after defaults/MCP mapping were applied. */
  allowedToolsApplied?: string[];
  /** Effective SDK built-in tools after policy mapping. */
  builtinToolsApplied?: string[];
  /** MCP servers mounted for the run. */
  mcpServersApplied?: string[];
  /** SDK permission mode used for this skill execution. */
  permissionMode?: string;
  /** Failure reason when ok=false. */
  error?: string;
}

// ── Mustache substitution ─────────────────────────────────────────────

/** Matches `{{var_name}}` with optional whitespace. var_name is
 *  `[a-zA-Z_][a-zA-Z0-9_-]*` — the same identifier shape used in YAML
 *  frontmatter `inputs:` keys. */
const MUSTACHE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g;

/**
 * Substitute `{{var}}` placeholders in `body` from `inputs`. Missing
 * keys are left as-is (so the LLM still sees the placeholder and can
 * complain) rather than silently dropped — a missing input is more
 * recoverable as visible text than as a stripped string.
 */
export function applyMustache(
  body: string,
  inputs: Record<string, string | number | boolean> | undefined,
): string {
  if (!inputs || Object.keys(inputs).length === 0) return body;
  return body.replace(MUSTACHE, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      return String(inputs[key]);
    }
    return match;
  });
}

// ── Allowlist computation ─────────────────────────────────────────────

/** Tools every skill needs as a baseline regardless of its `tools.allow`.
 *  Without these the SDK can't navigate the project at all. Read/Glob/Grep
 *  are non-mutating; Agent is required so the SDK can dispatch its own
 *  internal subagents. */
const SKILL_BASELINE_TOOLS = ['Agent', 'Read', 'Glob', 'Grep'] as const;

/** Matches `mcp__<server>__<tool>` references in skill bodies. Used to
 *  auto-include MCP tool names the skill *clearly* intends to call but
 *  which the author forgot to list under `tools.allow`. Same pattern as
 *  run-agent-cron.ts:150. */
const MCP_TOOL_REF = /mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__[A-Za-z0-9_-]+/g;

/**
 * Compute the explicit allowlist for a scoped skill call.
 *
 * Combines, in order:
 *   1. The skill's `clementine.tools.allow` list (or [] if absent)
 *   2. Tool names auto-extracted from the skill body matching `mcp__*__*`
 *   3. SKILL_BASELINE_TOOLS so the SDK can read files / dispatch subagents
 *
 * Then subtracts anything in `clementine.tools.deny` (deny wins).
 *
 * Returns a deduped array. The runner only passes it to the SDK when the
 * skill actually declared tool scope or referenced exact MCP tool names;
 * unscoped skills inherit the surrounding runAgent defaults.
 */
export function computeSkillAllowlist(skill: Skill): string[] {
  const tools = skill.frontmatter?.clementine?.tools;
  const declared = Array.isArray(tools?.allow) ? tools!.allow! : [];
  const denied = new Set(Array.isArray(tools?.deny) ? tools!.deny! : []);

  const fromBody = new Set<string>();
  let m: RegExpExecArray | null;
  // exec() with /g shares state per-regex; reset before each pass.
  MCP_TOOL_REF.lastIndex = 0;
  while ((m = MCP_TOOL_REF.exec(skill.body)) !== null) {
    // m[0] is the full mcp__<server>__<tool> match
    fromBody.add(m[0]);
  }

  const merged = new Set<string>([
    ...declared,
    ...fromBody,
    ...SKILL_BASELINE_TOOLS,
  ]);

  for (const d of denied) merged.delete(d);

  return [...merged];
}

function skillHasExplicitToolScope(skill: Skill): boolean {
  const tools = skill.frontmatter?.clementine?.tools;
  const hasAllow = Array.isArray(tools?.allow) && tools.allow.length > 0;
  const hasDeny = Array.isArray(tools?.deny) && tools.deny.length > 0;
  MCP_TOOL_REF.lastIndex = 0;
  const hasMcpRef = MCP_TOOL_REF.test(skill.body);
  MCP_TOOL_REF.lastIndex = 0;
  return hasAllow || hasDeny || hasMcpRef;
}

// ── Prompt builder ────────────────────────────────────────────────────

/**
 * Build the prompt the SDK actually executes for a skill call.
 *
 * Format:
 *   <skill body, with mustache substitutions applied>
 *
 *   ## Caller context
 *   <options.context>      ← when provided
 *
 * The skill body itself becomes the procedure; the optional context is
 * the immediate "what triggered this call" frame. Bundled files (other
 * .md siblings under the skill folder) are NOT inlined — the SDK can
 * read them via `Read` if listed under tools.allow.
 */
export function buildSkillPrompt(
  skill: Skill,
  inputs: Record<string, string | number | boolean> | undefined,
  context: string | undefined,
): string {
  const substitutedBody = applyMustache(skill.body, inputs);
  if (!context || !context.trim()) return substitutedBody;
  return `${substitutedBody}\n\n## Caller context\n\n${context.trim()}\n`;
}

// ── Schema validation ─────────────────────────────────────────────────

/** Best-effort JSON extraction: try whole text, then fenced ```json
 *  block, then the largest {…} substring. Mirrors goal-evaluator.ts so
 *  skill authors get the same forgiving behavior as goalCheck. */
function extractJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

async function validateSkillOutput(
  output: string,
  schema: object,
): Promise<{ tried: boolean; pass: boolean; errors: string[] }> {
  const json = extractJson(output);
  if (json === null) return { tried: false, pass: false, errors: [] };
  try {
    // Lazy import: ajv pulls in ~150KB and most callers won't have a schema.
    // Default-export interop matches goal-evaluator.ts:75 — ajv@8 is CJS
    // and the ESM bridge sometimes lands the constructor on .default.
    const ajvMod = await import('ajv');
    const AjvCtor: unknown = (ajvMod as { default?: unknown }).default ?? ajvMod;
    type AjvErr = { instancePath?: string; message?: string };
    type ValidateFn = ((d: unknown) => boolean) & { errors?: AjvErr[] | null };
    type AjvInstance = { compile: (s: unknown) => ValidateFn; errors?: AjvErr[] | null };
    const ajv = new (AjvCtor as new (opts?: unknown) => AjvInstance)({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const valid = validate(json);
    const rawErrors: AjvErr[] = validate.errors ?? ajv.errors ?? [];
    return {
      tried: true,
      pass: !!valid,
      errors: rawErrors.slice(0, 5).map(e => {
        const p = e.instancePath || '';
        const m = e.message || 'invalid';
        return p ? `${p} ${m}` : m;
      }),
    };
  } catch (err) {
    return { tried: true, pass: false, errors: [`schema compile error: ${err}`] };
  }
}

// ── The primitive ─────────────────────────────────────────────────────

/**
 * Run a skill as a hard-allowlisted sub-call. Returns a structured result.
 *
 * The skill is loaded via `getSkill()` (project-precedence honored when
 * `projectDir` + `agentSlug` are passed). Its body is mustache-rendered
 * with `inputs`, then sent to the SDK with an allowlist computed from
 * `clementine.tools.allow` + auto-extracted MCP refs + a small baseline.
 * After the SDK returns, `clementine.success.schema` (when set) is
 * ajv-validated against the response.
 *
 * This function never throws — failures (skill not found, SDK error,
 * timeout) are returned as `{ ok: false, error }`. The caller (chat,
 * cron, sub-agent, MCP tool) decides how to surface that.
 */
export async function runSkill(
  name: string,
  options: RunSkillOptions = {},
): Promise<RunSkillResult> {
  const skill = getSkill(name, {
    ...(options.projectWorkDir ? { projectWorkDir: options.projectWorkDir } : {}),
  });

  if (!skill) {
    return {
      ok: false,
      output: '',
      error: `Skill not found: ${name}`,
    };
  }

  const effectiveTools = computeSkillAllowlist(skill);
  const hasExplicitToolScope = skillHasExplicitToolScope(skill);
  const prompt = buildSkillPrompt(skill, options.inputs, options.context);

  const limits = skill.frontmatter?.clementine?.limits;
  const maxTurns = options.maxTurns ?? limits?.maxTurns;
  const maxBudgetUsd = options.maxBudgetUsd ?? limits?.maxBudgetUsd;

  const sessionKey = options.sessionKey
    ?? `skill:${name}:${Date.now().toString(36)}`;

  // Surface the skill folder to the SDK via additionalDirectories so
  // bundled scripts (skill/scripts/*.py) are reachable for `Bash` calls.
  // Folder-form skills only — flat skills have no siblings worth surfacing.
  const additionalDirectories = [
    ...(skill.layout === 'folder' ? [path.dirname(skill.filePath)] : []),
  ];

  const mutatingSkill = effectiveTools.some((t) =>
    t === 'Write' || t === 'Edit' || t === 'Bash' || /__(write|edit|update|create|delete|send|post|patch|set)/i.test(t),
  );

  logger.info({
    skill: name,
    tools: effectiveTools,
    maxTurns,
    maxBudgetUsd,
    inputKeys: Object.keys(options.inputs ?? {}),
    hasContext: !!options.context,
  }, 'runSkill: invoking');

  let runResult;
  try {
    const { buildExtraMcpForRunAgent } = await import('./run-agent-mcp.js');
    const mcp = await buildExtraMcpForRunAgent({
      scopeText: [
        skill.frontmatter.name,
        skill.frontmatter.description,
        skill.body,
        effectiveTools.join('\n'),
      ].filter(Boolean).join('\n\n'),
      profile: options.profile,
    });
    const allowedToolsForRun = hasExplicitToolScope ? effectiveTools : undefined;
    const sdkOpts: RunAgentOptions = {
      sessionKey,
      source: options.source ?? 'skill',
      ...(allowedToolsForRun ? { allowedTools: allowedToolsForRun } : {}),
      profile: options.profile,
      agentManager: options.agentManager,
      memoryStore: options.memoryStore,
      cwd: options.projectWorkDir,
      extraMcpServers: mcp.servers as unknown as RunAgentOptions['extraMcpServers'],
      enableFileCheckpointing: mutatingSkill || Boolean(options.projectWorkDir),
      ...(options.model ? { model: options.model } : {}),
      ...(typeof maxTurns === 'number' ? { maxTurns } : {}),
      ...(typeof maxBudgetUsd === 'number' ? { maxBudgetUsd } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(options.onText ? { onText: options.onText } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    };
    runResult = await runAgent(prompt, sdkOpts);
  } catch (err) {
    logger.error({ err, skill: name }, 'runSkill: SDK call failed');
    return {
      ok: false,
      output: '',
      effectiveTools,
      error: `SDK error: ${err}`,
    };
  }

  // Schema validation — only when the skill declared one and the caller
  // didn't opt out. We do not flip ok=false on schema fail; we surface
  // the result so the caller can decide. (A cron may want to retry; a
  // chat user just sees a "schema mismatch" badge.)
  let validation: RunSkillResult['validation'];
  const successSchema = skill.frontmatter?.clementine?.success?.schema;
  if (!options.skipValidation && successSchema) {
    validation = await validateSkillOutput(runResult.text, successSchema as object);
  }

  return {
    ok: true,
    output: runResult.text,
    cost: runResult.totalCostUsd,
    turns: runResult.numTurns,
    sessionId: runResult.sessionId,
    runId: runResult.runId,
    effectiveTools,
    allowedToolsApplied: runResult.allowedToolsApplied,
    builtinToolsApplied: runResult.builtinToolsApplied,
    mcpServersApplied: runResult.mcpServersApplied,
    permissionMode: runResult.permissionMode,
    ...(validation ? { validation } : {}),
  };
}
