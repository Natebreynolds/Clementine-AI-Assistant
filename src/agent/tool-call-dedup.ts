/**
 * tool-call-dedup — PreToolUse hook that detects same-call loops and
 * nudges the model to stop re-fetching identical data.
 *
 * Why this exists (1.18.173)
 * ──────────────────────────
 * The Anthropic SDK's auto-compactor summarizes prior turns when context
 * approaches the model's window. If the working data lived in those
 * earlier turns, compaction loses it — and the model often responds by
 * RE-CALLING the same tool with the same arguments to "re-load" the
 * data. That refill triggers the next compaction, which loses the
 * re-loaded data, which triggers another re-call, … and the SDK's
 * thrashing detector aborts the run after 3 consecutive cycles.
 *
 * Real-world example (2026-05-11 imessage-triage 08:00 UTC, run
 * 839a7d1a-…): four IDENTICAL calls to `get_unread_imessages({limit:20})`
 * in 115 seconds, one after each compaction. The tool-output-guard from
 * 1.18.169 didn't fire because each individual response was under the
 * 30KB cap; the loop was structural, not size-based.
 *
 * What this hook does
 * ───────────────────
 * On every PreToolUse, hash `(toolName, JSON.stringify(input))` and look
 * it up in a per-run cache (60s TTL by default).
 *   • count = 1 (first call): let it through, record.
 *   • count = 2 (second call within TTL): inject an `additionalContext`
 *     hint into the next turn saying "you already called this; the
 *     result hasn't changed; reuse it or change the inputs." Tool still
 *     executes (the model might have legitimate reasons to re-poll).
 *   • count = 3+ (third+ identical call): `permissionDecision: 'deny'`
 *     with a reason that directs the model to either change inputs or
 *     stop the loop. The model receives a denial result instead of new
 *     tool data — breaks the refetch-after-compact cycle.
 *
 * Aligned with Anthropic SDK best practices: PreToolUse + permission
 * decisions are the documented mechanism for controlling tool execution
 * mid-run. `sdk.d.ts:2002-2008` — `PreToolUseHookSpecificOutput` carries
 * `permissionDecision` ('allow'/'deny'/'ask'/'defer') + reason +
 * additionalContext for exactly this case.
 *
 * Failure mode
 * ────────────
 * Never throws. Hash errors, cache errors, anything — degrades to
 * letting the call through. Telemetry must never block execution.
 */

import { createHash } from 'node:crypto';
import pino from 'pino';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const logger = pino({ name: 'clementine.tool-call-dedup' });

// ── Tunables ──────────────────────────────────────────────────────────

/** Entry lifetime — how long we remember a call to compare against. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Tight-burst window for HARD blocks (1.18.184 refinement). Hard-block
 * fires only when ≥ HARD_BLOCK_AT identical calls happen within this
 * window of the FIRST call. The classic refetch-after-compact failure
 * pattern (which is what this hook exists to prevent — see the
 * imessage-triage diagnosis comment up top) reliably completes 4
 * identical calls in <2 minutes; the tight-burst signature is more
 * like ~3 calls in <10 seconds. Polling-with-delay (e.g., "wait 30s
 * and check again") legitimately produces identical calls spread out
 * over the entry lifetime; the wider TTL still warns the model in
 * that case but does not block. User intent for retry > our caution.
 */
const HARD_BLOCK_BURST_WINDOW_MS = 8_000;

/** Second identical call within TTL → soft warn (let it through with a hint). */
const SOFT_WARN_AT = 2;

/** Third+ identical call within HARD_BLOCK_BURST_WINDOW_MS → hard block (deny). */
const HARD_BLOCK_AT = 3;

// ── Types ─────────────────────────────────────────────────────────────

export interface DedupHookOptions {
  /** Stable run identifier — used to scope the cache per run. */
  runId: string;
  /** How long an identical call is considered "the same" (ms). */
  ttlMs?: number;
  /** Override the soft-warn threshold (default 2nd call). */
  softWarnAt?: number;
  /** Override the hard-block threshold (default 3rd call). */
  hardBlockAt?: number;
  /** Optional callback fired on every dedup decision. */
  onDecision?: (info: {
    toolName: string;
    inputHash: string;
    callCount: number;
    decision: 'allow' | 'warn' | 'block';
    sinceFirstMs: number;
  }) => void;
}

export interface DedupRunStats {
  /** Total PreToolUse invocations inspected. */
  inspected: number;
  /** Calls that were warned (let through with hint). */
  warned: number;
  /** Calls that were blocked outright. */
  blocked: number;
}

export interface DedupHookHandles {
  /** Hook map suitable for SDK `query({ options: { hooks } })`. */
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Aggregated telemetry — read after the run completes. */
  stats: DedupRunStats;
}

// ── Cache entry ───────────────────────────────────────────────────────

interface CacheEntry {
  count: number;
  firstSeen: number;
  lastSeen: number;
}

// ── Hashing ───────────────────────────────────────────────────────────

/**
 * Compute a stable hash of a tool call's input shape. JSON.stringify
 * with a sorted-keys replacer so `{a:1,b:2}` and `{b:2,a:1}` collide
 * (same semantic call); other minor differences (object key order) don't
 * spuriously evade the dedup.
 */
export function hashToolInput(input: unknown): string {
  try {
    const stable = JSON.stringify(input, replaceForStableHash);
    return createHash('sha256').update(stable).digest('hex').slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

function replaceForStableHash(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) sorted[k] = (value as Record<string, unknown>)[k];
    return sorted;
  }
  return value;
}

// ── Hook builder ──────────────────────────────────────────────────────

/**
 * Build a PreToolUse dedup hook for a single runAgent invocation.
 * Per-run cache (no cross-run state) — short-lived agentic runs don't
 * need persistence and we don't want stale cache to deny legitimate
 * post-restart re-polls.
 */
export function buildDedupHook(opts: DedupHookOptions): DedupHookHandles {
  const cache = new Map<string, CacheEntry>();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const softAt = opts.softWarnAt ?? SOFT_WARN_AT;
  const hardAt = opts.hardBlockAt ?? HARD_BLOCK_AT;
  const stats: DedupRunStats = { inspected: 0, warned: 0, blocked: 0 };

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {} as HookJSONOutput;
    const evt = input as PreToolUseHookInput;
    const toolName = String(evt.tool_name ?? 'unknown');
    const inputHash = hashToolInput(evt.tool_input);
    const key = `${toolName}:${inputHash}`;
    const now = Date.now();

    stats.inspected += 1;

    let entry = cache.get(key);
    // Treat expired entries as fresh — drop and restart the count.
    if (entry && now - entry.lastSeen > ttl) {
      cache.delete(key);
      entry = undefined;
    }

    if (!entry) {
      cache.set(key, { count: 1, firstSeen: now, lastSeen: now });
      opts.onDecision?.({ toolName, inputHash, callCount: 1, decision: 'allow', sinceFirstMs: 0 });
      return {} as HookJSONOutput;
    }

    entry.count += 1;
    entry.lastSeen = now;
    const sinceFirstMs = now - entry.firstSeen;

    // 1.18.184: hard-block ONLY on tight bursts (≤ HARD_BLOCK_BURST_WINDOW_MS
    // from first call). This is the refetch-after-compact failure signature.
    // Calls spread out across the wider TTL get a warning but not a block —
    // legitimate polling ("wait 30s, retry") is preserved.
    if (entry.count >= hardAt && sinceFirstMs <= HARD_BLOCK_BURST_WINDOW_MS) {
      stats.blocked += 1;
      logger.warn({
        toolName,
        inputHash,
        callCount: entry.count,
        sinceFirstMs,
        burstWindowMs: HARD_BLOCK_BURST_WINDOW_MS,
        runId: opts.runId,
      }, 'tool-call-dedup: hard-blocking tight-burst identical call');
      opts.onDecision?.({ toolName, inputHash, callCount: entry.count, decision: 'block', sinceFirstMs });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            `Tool \`${toolName}\` was just called with these exact arguments ${entry.count - 1} time(s) within the last ${Math.floor(sinceFirstMs / 1000)}s — a tight-burst refetch pattern that almost always indicates a refetch-after-compaction loop. ` +
            `STOP re-calling — use the result from your earlier context, ` +
            `change the arguments to fetch different data, or finish the task with what you already know. ` +
            `If you genuinely need fresh data (polling), wait at least ${Math.ceil(HARD_BLOCK_BURST_WINDOW_MS / 1000)}s before the next identical call.`,
        },
      } as HookJSONOutput;
    }

    if (entry.count >= softAt) {
      stats.warned += 1;
      logger.info({
        toolName,
        inputHash,
        callCount: entry.count,
        sinceFirstMs,
        runId: opts.runId,
      }, 'tool-call-dedup: warning on repeat call');
      opts.onDecision?.({ toolName, inputHash, callCount: entry.count, decision: 'warn', sinceFirstMs });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          additionalContext:
            `Note: you've already called \`${toolName}\` with these exact arguments ${entry.count - 1} time(s) in the last ${Math.floor(sinceFirstMs / 1000)}s. ` +
            `The result will be identical. Consider re-using the prior result rather than letting this call burn turns/budget. ` +
            `One more identical re-call will be blocked.`,
        },
      } as HookJSONOutput;
    }

    opts.onDecision?.({ toolName, inputHash, callCount: entry.count, decision: 'allow', sinceFirstMs });
    return {} as HookJSONOutput;
  };

  return {
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
    },
    stats,
  };
}
