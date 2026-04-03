/**
 * Clementine TypeScript — Maximal Marginal Relevance re-ranking.
 *
 * Ensures search results are both relevant AND diverse by penalizing
 * results too similar to already-selected ones.
 * Uses Jaccard similarity on tokenized content (no embedding provider needed).
 */

import type { SearchResult } from '../types.js';

/** Tokenize text into lowercase word set for Jaccard similarity. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

/** Jaccard similarity between two token sets: |A∩B| / |A∪B| */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Re-rank results using Maximal Marginal Relevance.
 *
 * @param results - Scored search results (higher score = more relevant)
 * @param lambda - Balance: 0 = max diversity, 1 = max relevance (default 0.7)
 * @param limit - Max results to return
 */
export function mmrRerank(
  results: SearchResult[],
  lambda: number = 0.7,
  limit?: number,
): SearchResult[] {
  if (results.length === 0) return [];

  const maxResults = limit ?? results.length;
  if (results.length <= 1) return results.slice(0, maxResults);

  // Normalize scores to [0, 1]
  const scores = results.map(r => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;
  const normScores = scores.map(s => range === 0 ? 1 : (s - minScore) / range);

  // Cache tokenized content
  const tokens: Set<string>[] = results.map(r => tokenize(r.content));

  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  for (let step = 0; step < maxResults && remaining.size > 0; step++) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const i of remaining) {
      const relevance = normScores[i];

      // Max similarity to any already-selected result
      let maxSim = 0;
      for (const j of selected) {
        const sim = jaccard(tokens[i], tokens[j]);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;

      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected.map(i => results[i]);
}
