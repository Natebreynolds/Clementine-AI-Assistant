/**
 * Clementine — Minimal Anthropic client wrapper for the brain.
 *
 * Ingestion calls Haiku for per-chunk distillation and one-shot schema
 * inference. Tests inject a deterministic override via `setLLMOverride()`
 * so the pipeline can be verified without network.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MODELS, ANTHROPIC_API_KEY } from '../config.js';

export interface LLMCallOpts {
  model?: string;
  maxTokens?: number;
  system?: string;
  /** Response format hint — if 'json', asks the model for JSON-only output. */
  format?: 'text' | 'json';
}

export type LLMCallFn = (prompt: string, opts?: LLMCallOpts) => Promise<string>;

let override: LLMCallFn | null = null;

/** Inject a deterministic override (used by tests). Pass null to restore. */
export function setLLMOverride(fn: LLMCallFn | null): void {
  override = fn;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    // Honor the same credential precedence the rest of Clementine uses:
    // OAuth token > legacy auth token > API key. The Anthropic SDK will
    // throw "Could not resolve authentication method" if we pass only
    // apiKey when the user has set an OAuth token instead.
    const authToken =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (authToken) {
      client = new Anthropic({ authToken });
    } else {
      client = new Anthropic({ apiKey });
    }
  }
  return client;
}

/** Single-shot completion. Returns the assistant's text output. */
export async function callLLM(prompt: string, opts: LLMCallOpts = {}): Promise<string> {
  if (override) return override(prompt, opts);

  const model = opts.model ?? MODELS.haiku;
  const maxTokens = opts.maxTokens ?? 1024;
  const systemParts: string[] = [];
  if (opts.system) systemParts.push(opts.system);
  if (opts.format === 'json') {
    systemParts.push(
      'Respond with a single valid JSON object. No prose, no code fences, no explanation.',
    );
  }

  const result = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system: systemParts.join('\n\n') || undefined,
    messages: [{ role: 'user', content: prompt }],
  });

  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}

/** Parse a JSON response defensively (strip code fences, trailing text). */
export function parseJsonResponse<T = unknown>(raw: string): T | null {
  let text = raw.trim();
  // Strip ```json or ``` fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Find the first { or [ and matching last } or ]
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
