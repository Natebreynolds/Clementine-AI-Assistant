/**
 * Clementine — Brain LLM client.
 *
 * Routes single-shot distillation/schema-inference calls through the
 * PersonalAssistant's `runPlanStep()`, which uses the Claude Agent SDK
 * under the hood. That path honors OAuth tokens from `clementine login`
 * (the raw Messages API does not), so brain ingestion works with
 * whatever credentials the rest of Clementine already uses.
 *
 * Tests inject a deterministic override via `setLLMOverride()` so the
 * pipeline can be verified without spawning the SDK subprocess.
 */

import { MODELS } from '../config.js';

export interface LLMCallOpts {
  model?: string;
  maxTokens?: number;
  system?: string;
  /** Response format hint — if 'json', asks the model for JSON-only output. */
  format?: 'text' | 'json';
  /** Distinct id for telemetry / logging (e.g. 'brain-distill', 'brain-schema'). */
  stepId?: string;
}

export type LLMCallFn = (prompt: string, opts?: LLMCallOpts) => Promise<string>;

let override: LLMCallFn | null = null;

/** Inject a deterministic override (used by tests). Pass null to restore. */
export function setLLMOverride(fn: LLMCallFn | null): void {
  override = fn;
}

// Lazy singleton — we avoid spinning up the assistant (which loads SOUL,
// agent profiles, etc.) unless the pipeline actually needs an LLM call.
let _assistant: unknown | null = null;
async function getAssistant(): Promise<{ runPlanStep: (id: string, prompt: string, opts?: Record<string, unknown>) => Promise<string> }> {
  if (_assistant) return _assistant as any;
  const { PersonalAssistant } = await import('../agent/assistant.js');
  _assistant = new PersonalAssistant();
  return _assistant as any;
}

/** Single-shot completion. Returns the assistant's text output. */
export async function callLLM(prompt: string, opts: LLMCallOpts = {}): Promise<string> {
  if (override) return override(prompt, opts);

  // Inline the system prompt and format hint into the user prompt since
  // runPlanStep takes a single string. The SDK's own security prompt is
  // still applied; ours sits on top for task-specific guidance.
  const systemParts: string[] = [];
  if (opts.system) systemParts.push(opts.system);
  if (opts.format === 'json') {
    systemParts.push(
      'Respond with a single valid JSON object. No prose, no code fences, no explanation.',
    );
  }
  const finalPrompt = systemParts.length
    ? `${systemParts.join('\n\n')}\n\n---\n\n${prompt}`
    : prompt;

  const assistant = await getAssistant();
  const stepId = opts.stepId ?? 'brain-call';
  const model = opts.model ?? MODELS.haiku;

  const result = await assistant.runPlanStep(stepId, finalPrompt, {
    tier: 1,            // low-security (read-only, no tools)
    maxTurns: 1,        // single assistant turn
    disableTools: true, // no tool use — pure completion
    model,
  });
  return (result ?? '').trim();
}

/** Parse a JSON response defensively (strip code fences, trailing text). */
export function parseJsonResponse<T = unknown>(raw: string): T | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const firstBrace = Math.min(
    ...['{', '['].map((c) => {
      const i = text.indexOf(c);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }),
  );
  if (firstBrace !== Number.MAX_SAFE_INTEGER) text = text.slice(firstBrace);
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Rough token counter — 4 chars ≈ 1 token. Good enough for input-truncation. */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to a token budget (approx). Returns { text, truncated }. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + '\n…[truncated]', truncated: true };
}
