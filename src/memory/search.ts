/**
 * Clementine TypeScript — Search result helpers.
 *
 * Utility functions for temporal decay, deduplication, and formatting
 * of search results for system prompt injection.
 */

import type { SearchResult } from '../types.js';

export { mmrRerank } from './mmr.js';

/**
 * Exponential decay multiplier based on age.
 *
 * score = exp(-0.693 * days / halfLife)
 * At halfLife days, score = 0.5. At 0 days, score = 1.0.
 */
export function temporalDecay(daysOld: number, halfLife: number = 30): number {
  if (daysOld <= 0) return 1.0;
  return Math.exp(-0.693 * daysOld / halfLife);
}

/**
 * Deduplicate results by (sourceFile, section), keeping the highest-scored.
 */
export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  for (const r of results) {
    const key = `${r.sourceFile}\0${r.section}`;
    const existing = seen.get(key);
    if (!existing || r.score > existing.score) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

/**
 * Format search results as a context block for the system prompt.
 *
 * Truncates to stay within maxChars.
 */
export function formatResultsForPrompt(
  results: SearchResult[],
  maxChars: number = 8000,
): string {
  if (results.length === 0) return '';

  const parts: string[] = [];
  let total = 0;

  for (const r of results) {
    const entry = `### ${r.sourceFile} > ${r.section}\n${r.content}\n`;
    if (total + entry.length > maxChars) break;
    parts.push(entry);
    total += entry.length;
  }

  return parts.join('\n');
}
