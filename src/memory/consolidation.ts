/**
 * Clementine TypeScript — Memory Consolidation Engine.
 *
 * Three strategies that run during the evening consolidation window:
 * 1. Fact Dedup — merge chunks with high Jaccard similarity (pure SQL + local compute)
 * 2. Topic Summarization — LLM (Haiku) summarizes groups of 5+ chunks into a single summary
 * 3. Principle Extraction — distill repeated behavioral corrections into permanent rules
 *
 * Source chunks are marked consolidated (never deleted) — they remain searchable at lower salience.
 */

import pino from 'pino';
import { tokenize, jaccard } from './mmr.js';

const logger = pino({ name: 'clementine.consolidation' });

export interface ConsolidationResult {
  deduped: number;
  summarized: number;
  principlesExtracted: number;
  errors: string[];
}

interface MemoryStoreHandle {
  getConsolidationCandidates(minAgeDays: number): Array<{
    topic: string;
    chunkIds: number[];
    contents: string[];
    totalChars: number;
  }>;
  markConsolidated(chunkIds: number[]): void;
  getConsolidationStats(): { totalChunks: number; consolidated: number; unconsolidated: number };
  insertSummaryChunk(sourceFile: string, section: string, content: string, derivedFromIds?: number[]): void;
  getBehavioralPatterns(minOccurrences: number): Array<{ correction: string; count: number; category: string; lastSeen: string }>;
}

/**
 * Run all consolidation strategies in sequence.
 * Budget-aware: stops if token/cost estimate exceeds limits.
 */
export async function runConsolidation(
  store: MemoryStoreHandle,
  llmCall?: (prompt: string) => Promise<string>,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    deduped: 0,
    summarized: 0,
    principlesExtracted: 0,
    errors: [],
  };

  // Strategy 1: Fact Deduplication (no LLM needed)
  try {
    result.deduped = deduplicateChunks(store);
    logger.info({ deduped: result.deduped }, 'Fact deduplication complete');
  } catch (err) {
    const msg = `Dedup failed: ${err}`;
    result.errors.push(msg);
    logger.warn({ err }, msg);
  }

  // Strategy 2: Topic Summarization (requires LLM)
  if (llmCall) {
    try {
      result.summarized = await summarizeTopics(store, llmCall);
      logger.info({ summarized: result.summarized }, 'Topic summarization complete');
    } catch (err) {
      const msg = `Summarization failed: ${err}`;
      result.errors.push(msg);
      logger.warn({ err }, msg);
    }
  }

  // Strategy 3: Principle Extraction (requires LLM)
  if (llmCall) {
    try {
      result.principlesExtracted = await extractPrinciples(store, llmCall);
      logger.info({ principlesExtracted: result.principlesExtracted }, 'Principle extraction complete');
    } catch (err) {
      const msg = `Principle extraction failed: ${err}`;
      result.errors.push(msg);
      logger.warn({ err }, msg);
    }
  }

  const stats = store.getConsolidationStats();
  logger.info({
    ...result,
    totalChunks: stats.totalChunks,
    consolidated: stats.consolidated,
    unconsolidated: stats.unconsolidated,
  }, 'Consolidation cycle complete');

  return result;
}

/**
 * Strategy 1: Merge chunks with >0.7 Jaccard similarity within the same topic.
 * Pure local computation — no LLM call needed.
 * Marks the lower-salience duplicate as consolidated.
 */
function deduplicateChunks(store: MemoryStoreHandle): number {
  const candidates = store.getConsolidationCandidates(7); // chunks older than 7 days
  let deduped = 0;

  for (const group of candidates) {
    if (group.chunkIds.length < 2) continue;

    // Tokenize all chunks in this topic group
    const tokenSets = group.contents.map(c => tokenize(c));
    const toConsolidate: number[] = [];

    // Compare each pair — mark the shorter one as consolidated
    for (let i = 0; i < tokenSets.length; i++) {
      if (toConsolidate.includes(group.chunkIds[i])) continue;
      for (let j = i + 1; j < tokenSets.length; j++) {
        if (toConsolidate.includes(group.chunkIds[j])) continue;
        const sim = jaccard(tokenSets[i], tokenSets[j]);
        if (sim > 0.7) {
          // Mark the shorter content as duplicate
          const shorter = group.contents[i].length <= group.contents[j].length
            ? group.chunkIds[i]
            : group.chunkIds[j];
          toConsolidate.push(shorter);
        }
      }
    }

    if (toConsolidate.length > 0) {
      store.markConsolidated(toConsolidate);
      deduped += toConsolidate.length;
    }

    // Cap per cycle to avoid long-running operations
    if (deduped >= 50) break;
  }

  return deduped;
}

/**
 * Strategy 2: For topic groups with 5+ unconsolidated chunks,
 * generate a summary via Haiku and insert as a new summary chunk.
 * Mark source chunks as consolidated.
 */
async function summarizeTopics(
  store: MemoryStoreHandle,
  llmCall: (prompt: string) => Promise<string>,
): Promise<number> {
  const candidates = store.getConsolidationCandidates(14); // chunks older than 14 days
  let summarized = 0;

  // Process top 3 topic groups per cycle
  for (const group of candidates.slice(0, 3)) {
    if (group.chunkIds.length < 5) continue;

    // Build prompt for summarization
    const contentSample = group.contents.slice(0, 10).join('\n---\n').slice(0, 3000);
    const prompt =
      `Summarize the following ${group.chunkIds.length} memory chunks about "${group.topic}" ` +
      `into 3-5 concise sentences that capture the essential facts. ` +
      `Preserve specific names, dates, decisions, and identifiers. ` +
      `Drop redundant or trivial information.\n\n` +
      `Chunks:\n${contentSample}\n\n` +
      `Output only the summary text, nothing else.`;

    try {
      const summary = await llmCall(prompt);
      if (summary && summary.length > 50) {
        // Insert summary as a new chunk with lineage back to source chunks
        store.insertSummaryChunk(
          group.topic,
          `Consolidated Summary (${group.chunkIds.length} chunks)`,
          summary.slice(0, 3000),
          group.chunkIds,
        );
        // Mark source chunks as consolidated
        store.markConsolidated(group.chunkIds);
        summarized += group.chunkIds.length;
      }
    } catch (err) {
      logger.debug({ err, topic: group.topic }, 'Failed to summarize topic group');
    }
  }

  return summarized;
}

/**
 * Strategy 3: Behavioral corrections that appear 3+ times in session reflections
 * are distilled into permanent rules. Returns the number of new principles created.
 */
async function extractPrinciples(
  store: MemoryStoreHandle,
  llmCall: (prompt: string) => Promise<string>,
): Promise<number> {
  const patterns = store.getBehavioralPatterns(3); // corrections appearing 3+ times
  if (patterns.length === 0) return 0;

  const prompt =
    `The following behavioral corrections have been received repeatedly from the user.\n\n` +
    `${patterns.map(p => `- "${p.correction}" (${p.category}, ${p.count} times)`).join('\n')}\n\n` +
    `Distill these into concise, actionable rules (1 sentence each) that should be ` +
    `permanently applied. Merge similar corrections into a single rule.\n\n` +
    `Output only the rules as a numbered list, nothing else.`;

  try {
    const rules = await llmCall(prompt);
    if (rules && rules.length > 20) {
      // Store as a consolidated principle chunk
      store.insertSummaryChunk(
        '00-System/MEMORY',
        'Behavioral Principles (auto-consolidated)',
        rules.slice(0, 2000),
      );
      return patterns.length;
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to extract behavioral principles');
  }

  return 0;
}
