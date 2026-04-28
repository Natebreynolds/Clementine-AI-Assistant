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
  /**
   * Resolve the content for this slot. Receives the effective budget
   * (min of slot's maxChars and actually-remaining total), so the slot can
   * produce content that fits exactly rather than relying on the outer
   * mid-string truncation which cuts entries in half.
   */
  resolve: (effectiveBudget: number) => string | Promise<string>;
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
  /** Identity file path (null to skip). */
  identityPath?: string | null;
  /** Pre-rendered user model block (MemGPT-style core memory). */
  userModelBlock?: string | null;
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

  // Slot -1: User mental model (MemGPT-style core memory). Highest priority,
  // always loaded. Coherent "what we know about the user" surface that the
  // agent can self-edit via the user_model MCP tool. Capped at 8K chars
  // total across all slots; auto-truncated to whatever budget remains.
  if (options.userModelBlock) {
    const umBlock = options.userModelBlock;
    slots.push({
      name: 'user-model',
      priority: -1,
      maxChars: isAutonomous ? 4000 : 8000,
      minRemainingBudget: 0,
      resolve: (budget) => umBlock.length > budget ? umBlock.slice(0, budget) : umBlock,
    });
  }

  // Slot 0: Identity seed (always loaded, tiny footprint)
  if (options.identityPath) {
    const idPath = options.identityPath;
    slots.push({
      name: 'identity',
      priority: 0,
      maxChars: 500,
      minRemainingBudget: 0,
      resolve: (budget) => {
        if (!fs.existsSync(idPath)) return '';
        try {
          const content = fs.readFileSync(idPath, 'utf-8').trim();
          if (!content) return '';
          const block = `## Identity\n\n${content}`;
          return block.length > budget ? block.slice(0, budget) : block;
        } catch { return ''; }
      },
    });
  }

  // Slot 1: Working memory (highest priority — always fits)
  if (options.workingMemoryPath) {
    const wmPath = options.workingMemoryPath;
    slots.push({
      name: 'working-memory',
      priority: 1,
      maxChars: isAutonomous ? 1000 : 2000,
      minRemainingBudget: 0,
      resolve: (budget) => {
        if (!fs.existsSync(wmPath)) return '';
        try {
          const content = fs.readFileSync(wmPath, 'utf-8').trim();
          if (!content) return '';
          const block = `## Working Memory (scratchpad)\n\n${content}`;
          return block.length > budget ? block.slice(0, budget) : block;
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
      resolve: (budget) => skillCtx.length > budget ? skillCtx.slice(0, budget) : skillCtx,
    });
  }

  // Slot 3: Memory search results (core recall)
  // formatResultsForPrompt respects the effective budget and breaks on
  // entry boundaries (not mid-string), so we don't need the outer
  // slice-truncation to kick in here. Previously this slot was double-
  // truncated: formatter used its own 8000 cap, then the outer loop cut
  // further by Math.min(maxChars, remaining), chopping entries in half.
  if (options.memoryResults && options.memoryResults.length > 0) {
    const results = options.memoryResults;
    slots.push({
      name: 'memory-recall',
      priority: 3,
      maxChars: isAutonomous ? 2000 : 8000,
      minRemainingBudget: 200,
      resolve: (budget) => formatResultsForPrompt(results, budget),
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
      resolve: (budget) => graphCtx.length > budget ? graphCtx.slice(0, budget) : graphCtx,
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
      // The slot's effective budget is the smaller of its own maxChars and
      // what's actually remaining across all slots. Passed into resolve so
      // the slot produces right-sized content up front, not a mid-entry
      // truncation after the fact.
      const effectiveBudget = Math.min(slot.maxChars, remaining);
      const content = await slot.resolve(effectiveBudget);
      if (!content) {
        skipped.push(slot.name);
        continue;
      }

      // Safety net: if resolve() ignored the budget and returned too much,
      // clip at a line boundary rather than a character boundary so we don't
      // leave a malformed half-block in the prompt.
      let finalContent = content;
      if (content.length > effectiveBudget) {
        const trimmed = content.slice(0, effectiveBudget);
        const lastNewline = trimmed.lastIndexOf('\n');
        finalContent = (lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed) + '\n...(truncated)';
      }

      parts.push(finalContent);
      remaining -= finalContent.length;
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
