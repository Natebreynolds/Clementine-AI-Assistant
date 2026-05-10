/**
 * Shared formatting helpers (1.18.149).
 *
 * Consolidates implementations that were previously inlined across the
 * codebase:
 *   - formatBytes: 4 inline copies (cli/index.ts, cli/ingest.ts,
 *     memory/store.ts, cli/dashboard.ts) with minor variation
 *   - estimateTokens: 3 inline copies with INCONSISTENT divisors
 *     (brain/llm-client.ts and gateway/turn-ledger.ts used /4 — Anthropic's
 *     published rule of thumb — while agent/assistant.ts used /3.3 for
 *     no documented reason). Going with /4 as the canonical.
 *
 * Kept tiny + dependency-free so any module can import without pulling
 * in extra weight.
 */

/**
 * Format a byte count as a human-readable string (1.5 KB, 23 MB, 4.2 GB).
 * Defensive: returns '0 B' for null, undefined, NaN, negative.
 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Approximate token count for a string. Uses the Anthropic-published
 * heuristic of ~4 characters per token. Good enough for budget planning,
 * input truncation, and pre-flight cost estimates. Callers needing exact
 * counts should read `usage.input_tokens` from the SDK result.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
