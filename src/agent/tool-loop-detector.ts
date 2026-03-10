/**
 * Clementine TypeScript — Tool loop detection system.
 *
 * Detects when the agent gets stuck in repetitive tool-call patterns:
 *   - generic_repeat: Same tool+input called repeatedly
 *   - poll_no_progress: Same tool returning identical results
 *   - ping_pong: Alternating between two tool+input combos with no result change
 *
 * Inspired by OpenClaw's loop detection approach.
 */

import { createHash } from 'node:crypto';
import pino from 'pino';

// ── Constants (configurable) ────────────────────────────────────────

/** Maximum number of tool calls to keep in the sliding window. */
const WINDOW_SIZE = 30;

/** Entries older than this are pruned on each call. */
const WINDOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** generic_repeat: Same tool+inputHash called N times. */
const GENERIC_REPEAT_WARN = 5;
const GENERIC_REPEAT_BLOCK = 8;

/** poll_no_progress: Same tool returning identical resultHash N times. */
const POLL_NO_PROGRESS_WARN = 4;
const POLL_NO_PROGRESS_BLOCK = 7;

/** ping_pong: Alternating between exactly two tool+inputHash combos (pairs). */
const PING_PONG_WARN_PAIRS = 3;  // 6 calls
const PING_PONG_BLOCK_PAIRS = 5; // 10 calls

// ── Types ───────────────────────────────────────────────────────────

export interface LoopCheckResult {
  verdict: 'ok' | 'warn' | 'block';
  detector?: string;  // which detector triggered
  detail?: string;    // human-readable description
}

interface ToolCallEntry {
  toolName: string;
  inputHash: string;
  resultHash: string;
  timestamp: number;
}

// ── Logger ──────────────────────────────────────────────────────────

const logger = pino({ name: 'clementine.tool-loop-detector' });

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute a truncated SHA-256 hex digest (first 16 chars). */
function shortHash(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** Composite key for a tool call: tool name + input hash. */
function callKey(entry: ToolCallEntry): string {
  return `${entry.toolName}:${entry.inputHash}`;
}

// ── ToolLoopDetector ────────────────────────────────────────────────

/**
 * Detects repetitive tool-call patterns in a sliding window.
 *
 * Usage:
 *   1. Call `recordCall()` before each tool invocation — it returns a verdict.
 *   2. Call `recordResult()` after the tool returns — it updates the last entry's resultHash.
 *   3. Call `reset()` when rotating sessions to clear state.
 */
export class ToolLoopDetector {
  private window: ToolCallEntry[] = [];

  /**
   * Record a new tool call, run all detectors, and return the verdict.
   *
   * @param toolName - Name of the tool being called
   * @param input    - Tool input parameters
   * @returns Loop check result with verdict and optional detector/detail info
   */
  recordCall(toolName: string, input: Record<string, unknown>): LoopCheckResult {
    const now = Date.now();

    // Prune entries older than TTL
    this.window = this.window.filter((e) => now - e.timestamp < WINDOW_TTL_MS);

    const inputHash = shortHash(JSON.stringify(input));

    const entry: ToolCallEntry = {
      toolName,
      inputHash,
      resultHash: '', // filled in by recordResult()
      timestamp: now,
    };

    this.window.push(entry);

    // Trim to max window size (keep most recent)
    if (this.window.length > WINDOW_SIZE) {
      this.window = this.window.slice(this.window.length - WINDOW_SIZE);
    }

    // Run detectors in order of severity (block takes precedence)
    const results = [
      this.detectGenericRepeat(),
      this.detectPollNoProgress(),
      this.detectPingPong(),
    ] as const;

    // Return the most severe result
    const block = results.find((r) => r.verdict === 'block');
    if (block) {
      logger.warn({ detector: block.detector, detail: block.detail }, 'Tool loop blocked');
      return block;
    }

    const warn = results.find((r) => r.verdict === 'warn');
    if (warn) {
      logger.info({ detector: warn.detector, detail: warn.detail }, 'Tool loop warning');
      return warn;
    }

    return { verdict: 'ok' };
  }

  /**
   * Update the most recent call entry with the result hash.
   *
   * @param resultText - The text output returned by the tool
   */
  recordResult(resultText: string): void {
    if (this.window.length === 0) return;
    this.window[this.window.length - 1].resultHash = shortHash(resultText);
  }

  /** Clear the sliding window (e.g. on session rotation). */
  reset(): void {
    this.window = [];
  }

  // ── Detectors ───────────────────────────────────────────────────

  /**
   * generic_repeat: Same tool+inputHash called N times in the window.
   */
  private detectGenericRepeat(): LoopCheckResult {
    if (this.window.length === 0) return { verdict: 'ok' };

    const latest = this.window[this.window.length - 1];
    const key = callKey(latest);
    let count = 0;

    for (const entry of this.window) {
      if (callKey(entry) === key) count++;
    }

    if (count >= GENERIC_REPEAT_BLOCK) {
      return {
        verdict: 'block',
        detector: 'generic_repeat',
        detail: `Tool ${latest.toolName} called ${count} times with identical input (threshold: ${GENERIC_REPEAT_BLOCK})`,
      };
    }

    if (count >= GENERIC_REPEAT_WARN) {
      return {
        verdict: 'warn',
        detector: 'generic_repeat',
        detail: `Tool ${latest.toolName} called ${count} times with identical input (warn threshold: ${GENERIC_REPEAT_WARN})`,
      };
    }

    return { verdict: 'ok' };
  }

  /**
   * poll_no_progress: Same tool returning identical resultHash N times.
   * Only considers entries that have a resultHash set.
   */
  private detectPollNoProgress(): LoopCheckResult {
    if (this.window.length === 0) return { verdict: 'ok' };

    const latest = this.window[this.window.length - 1];
    const key = callKey(latest);

    // Gather entries with matching call key that have results
    const withResults = this.window.filter(
      (e) => callKey(e) === key && e.resultHash !== '',
    );

    if (withResults.length === 0) return { verdict: 'ok' };

    // Count how many share the most common resultHash
    const resultCounts = new Map<string, number>();
    for (const e of withResults) {
      resultCounts.set(e.resultHash, (resultCounts.get(e.resultHash) ?? 0) + 1);
    }

    const maxCount = Math.max(...resultCounts.values());

    if (maxCount >= POLL_NO_PROGRESS_BLOCK) {
      return {
        verdict: 'block',
        detector: 'poll_no_progress',
        detail: `Tool ${latest.toolName} returned identical results ${maxCount} times (threshold: ${POLL_NO_PROGRESS_BLOCK})`,
      };
    }

    if (maxCount >= POLL_NO_PROGRESS_WARN) {
      return {
        verdict: 'warn',
        detector: 'poll_no_progress',
        detail: `Tool ${latest.toolName} returned identical results ${maxCount} times (warn threshold: ${POLL_NO_PROGRESS_WARN})`,
      };
    }

    return { verdict: 'ok' };
  }

  /**
   * ping_pong: Alternating between exactly two tool+inputHash combos
   * with no result change. Scans the tail of the window for the pattern.
   */
  private detectPingPong(): LoopCheckResult {
    const w = this.window;
    if (w.length < 4) return { verdict: 'ok' };

    // Work backwards from the end — look for A-B-A-B pattern
    const a = callKey(w[w.length - 2]);
    const b = callKey(w[w.length - 1]);

    // Must be two distinct combos
    if (a === b) return { verdict: 'ok' };

    // Count consecutive alternating pairs from the end
    let pairs = 0;
    let resultsStatic = true;

    for (let i = w.length - 1; i >= 1; i -= 2) {
      const curKey = callKey(w[i]);
      const prevKey = callKey(w[i - 1]);

      if (curKey === b && prevKey === a) {
        pairs++;

        // Check if results are changing (only for entries with results)
        if (w[i].resultHash !== '' && w[i - 1].resultHash !== '') {
          // Check if the B results differ across pairs, or A results differ
          // We consider it "static" if same-key entries all share the same resultHash
        }
      } else {
        break;
      }
    }

    // Verify results are static across the alternating calls
    if (pairs >= PING_PONG_WARN_PAIRS) {
      const startIdx = w.length - pairs * 2;
      const aResults = new Set<string>();
      const bResults = new Set<string>();

      for (let i = startIdx; i < w.length; i += 2) {
        if (w[i].resultHash !== '') aResults.add(w[i].resultHash);
        if (i + 1 < w.length && w[i + 1].resultHash !== '') bResults.add(w[i + 1].resultHash);
      }

      // If results vary, it's not a stuck loop
      resultsStatic = aResults.size <= 1 && bResults.size <= 1;
    }

    if (!resultsStatic) return { verdict: 'ok' };

    if (pairs >= PING_PONG_BLOCK_PAIRS) {
      const toolA = w[w.length - 2].toolName;
      const toolB = w[w.length - 1].toolName;
      return {
        verdict: 'block',
        detector: 'ping_pong',
        detail: `Alternating between ${toolA} and ${toolB} for ${pairs} pairs (${pairs * 2} calls, threshold: ${PING_PONG_BLOCK_PAIRS} pairs)`,
      };
    }

    if (pairs >= PING_PONG_WARN_PAIRS) {
      const toolA = w[w.length - 2].toolName;
      const toolB = w[w.length - 1].toolName;
      return {
        verdict: 'warn',
        detector: 'ping_pong',
        detail: `Alternating between ${toolA} and ${toolB} for ${pairs} pairs (${pairs * 2} calls, warn threshold: ${PING_PONG_WARN_PAIRS} pairs)`,
      };
    }

    return { verdict: 'ok' };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

/** Shared singleton instance for the process. */
export const toolLoopDetector = new ToolLoopDetector();
