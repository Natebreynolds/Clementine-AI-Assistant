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
    // Add relative time annotation so the agent can reference recency naturally
    let timeHint = '';
    if (r.lastUpdated) {
      const daysAgo = Math.floor((Date.now() - new Date(r.lastUpdated).getTime()) / 86_400_000);
      if (daysAgo === 0) timeHint = ' (today)';
      else if (daysAgo === 1) timeHint = ' (yesterday)';
      else if (daysAgo < 7) timeHint = ` (${daysAgo} days ago)`;
      else if (daysAgo < 30) timeHint = ` (${Math.floor(daysAgo / 7)} weeks ago)`;
      else if (daysAgo < 365) timeHint = ` (${Math.floor(daysAgo / 30)} months ago)`;
    }
    const entry = `### ${r.sourceFile} > ${r.section}${timeHint}\n${r.content}\n`;
    if (total + entry.length > maxChars) break;
    parts.push(entry);
    total += entry.length;
  }

  return parts.join('\n');
}
