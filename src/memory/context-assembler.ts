/**
 * Clementine TypeScript — Token-Budgeted Context Assembler.
 *
 * Assembles context for system prompt injection within a strict character budget.
 * Fills slots by priority so the most important context always fits, with
 * graceful degradation when budget is tight.
 *
 * Inspired by Phantom's MemoryContextBuilder pattern.
 */

import fs from 'node:fs';
import type { SearchResult } from '../types.js';
import { formatResultsForPrompt } from './search.js';

/** A context slot with priority and a budget allocation. */
interface ContextSlot {
  /** Unique slot name for debugging. */
  name: string;
  /** Lower = higher priority (filled first). */
  priority: number;
  /** Maximum characters this slot can consume. */
  maxChars: number;
  /** Minimum remaining budget required before this slot is filled. 0 = always attempt. */
  minRemainingBudget: number;
  /** Resolve the content for this slot. Returns empty string to skip. */
  resolve: () => string | Promise<string>;
}

export interface AssembledContext {
  /** Combined context string ready for prompt injection. */
  text: string;
  /** Total characters used. */
  charsUsed: number;
  /** Which slots were included. */
  slotsIncluded: string[];
  /** Which slots were skipped (due to budget or empty). */
  slotsSkipped: string[];
}

export interface AssemblerOptions {
  /** Total character budget for all context. Default: 12000. */
  totalBudget?: number;
  /** Working memory file path (null to skip). */
  workingMemoryPath?: string | null;
  /** Pre-searched memory results. */
  memoryResults?: SearchResult[];
  /** Pre-resolved skill context string. */
  skillContext?: string;
  /** Pre-resolved graph context string. */
  graphContext?: string;
  /** Whether this is an autonomous run (truncates aggressively). */
  isAutonomous?: boolean;
}

/**
 * Assemble context from multiple sources within a character budget.
 *
 * Priority order:
 *  1. Working memory (persistent scratchpad — always relevant)
 *  2. Procedural skills (high-value, rarely large)
 *  3. Memory search results (core recall)
 *  4. Graph relationships (supplementary enrichment)
 *
 * Each slot truncates independently to its own maxChars limit.
 * If total budget is exhausted, lower-priority slots are skipped entirely.
 */
export async function assembleContext(options: AssemblerOptions): Promise<AssembledContext> {
  const totalBudget = options.totalBudget ?? 12_000;
  const isAutonomous = options.isAutonomous ?? false;

  const slots: ContextSlot[] = [];

  // Slot 1: Working memory (highest priority — always fits)
  if (options.workingMemoryPath) {
    const wmPath = options.workingMemoryPath;
    slots.push({
      name: 'working-memory',
      priority: 1,
      maxChars: isAutonomous ? 1000 : 2000,
      minRemainingBudget: 0,
      resolve: () => {
        if (!fs.existsSync(wmPath)) return '';
        try {
          const content = fs.readFileSync(wmPath, 'utf-8').trim();
          if (!content) return '';
          return `## Working Memory (scratchpad)\n\n${content}`;
        } catch { return ''; }
      },
    });
  }

  // Slot 2: Procedural skills (high value, small footprint)
  if (options.skillContext) {
    const skillCtx = options.skillContext;
    slots.push({
      name: 'skills',
      priority: 2,
      maxChars: isAutonomous ? 1000 : 2000,
      minRemainingBudget: 500,
      resolve: () => skillCtx,
    });
  }

  // Slot 3: Memory search results (core recall)
  if (options.memoryResults && options.memoryResults.length > 0) {
    const results = options.memoryResults;
    slots.push({
      name: 'memory-recall',
      priority: 3,
      maxChars: isAutonomous ? 2000 : 8000,
      minRemainingBudget: 200,
      resolve: () => {
        // formatResultsForPrompt already handles truncation within its own budget
        return formatResultsForPrompt(results, isAutonomous ? 2000 : 8000);
      },
    });
  }

  // Slot 4: Graph relationships (supplementary)
  if (options.graphContext) {
    const graphCtx = options.graphContext;
    slots.push({
      name: 'graph',
      priority: 4,
      maxChars: 2000,
      minRemainingBudget: 500,
      resolve: () => graphCtx,
    });
  }

  // Sort by priority (lower number = higher priority)
  slots.sort((a, b) => a.priority - b.priority);

  // Fill slots within budget
  let remaining = totalBudget;
  const parts: string[] = [];
  const included: string[] = [];
  const skipped: string[] = [];

  for (const slot of slots) {
    // Check if we have enough remaining budget
    if (remaining < slot.minRemainingBudget) {
      skipped.push(slot.name);
      continue;
    }

    try {
      let content = await slot.resolve();
      if (!content) {
        skipped.push(slot.name);
        continue;
      }

      // Truncate to the smaller of slot max and remaining budget
      const limit = Math.min(slot.maxChars, remaining);
      if (content.length > limit) {
        content = content.slice(0, limit) + '\n...(truncated)';
      }

      parts.push(content);
      remaining -= content.length;
      included.push(slot.name);
    } catch {
      skipped.push(slot.name);
    }
  }

  return {
    text: parts.join('\n\n'),
    charsUsed: totalBudget - remaining,
    slotsIncluded: included,
    slotsSkipped: skipped,
  };
}
