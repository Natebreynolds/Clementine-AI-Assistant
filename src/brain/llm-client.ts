/**
 * Clementine — Brain LLM client.
 *
 * Single-shot completions via the Claude Agent SDK so OAuth tokens from
 * `clementine login` work (the raw Messages API rejects OAuth). We use
 * the low-level `query()` with a minimal option set — no tools, no
 * plan-mode effort budgets, no setting sources — because ingestion just
 * wants "prompt in → text out". `PersonalAssistant.runPlanStep()` is
 * overkill here and its `effort: 'high'` default triggers task budgets
 * that Haiku doesn't support.
 *
 * Tests inject a deterministic override via `setLLMOverride()` so the
 * pipeline can be verified without spawning the SDK subprocess.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  MODELS,
  applyOneMillionContextRecovery,
  looksLikeClaudeOneMillionContextError,
  normalizeClaudeSdkOptionsForOneMillionContext,
} from '../config.js';

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

/** Single-shot completion. Returns the assistant's text output. */
export async function callLLM(prompt: string, opts: LLMCallOpts = {}): Promise<string> {
  if (override) return override(prompt, opts);

  const systemParts: string[] = [];
  if (opts.system) systemParts.push(opts.system);
  if (opts.format === 'json') {
    systemParts.push(
      'Respond with a single valid JSON object. No prose, no code fences, no explanation.',
    );
  }

  const model = opts.model ?? MODELS.haiku;
  const stream = query({
    prompt,
    options: normalizeClaudeSdkOptionsForOneMillionContext({
      model,
      maxTurns: 1,
      systemPrompt: systemParts.join('\n\n') || undefined,
      // No built-in tools: brain calls are pure completions
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      // Don't inherit user ~/.claude settings — those pull in hooks,
      // allowed-tool lists, and statusline config that can slow or
      // fail our minimal call.
      settingSources: [],
    }),
  });

  let assistantText = '';
  for await (const message of stream) {
    if (message.type === 'assistant') {
      const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } })
        .message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          assistantText += block.text;
        }
      }
    } else if (message.type === 'result') {
      const result = message as { is_error?: boolean; errors?: string[]; result?: string };
      if (result.is_error) {
        const errorText = Array.isArray(result.errors) ? result.errors.join('; ') : String(result.result ?? '');
        if (looksLikeClaudeOneMillionContextError(errorText)) applyOneMillionContextRecovery();
        throw new Error(errorText || 'Claude SDK query failed');
      }
      break; // Single-turn done
    }
  }
  return assistantText.trim();
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
