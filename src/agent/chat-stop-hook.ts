/**
 * chat-stop-hook — Stop hook that keeps chat-initiated multi-step jobs
 * running until they finish OR the user explicitly stops them.
 *
 * Why this exists (1.18.184)
 * ──────────────────────────
 * Before this hook, the SDK loop ended whenever the model produced
 * a final assistant message — even when the model had clearly stated
 * "next, I'll do X" but then stopped. From the user's POV: "I asked her
 * to draft 3 emails and she only drafted 1, no explanation." The model
 * was being prematurely terminated by the SDK's default Stop behavior.
 *
 * The canonical SDK pattern for long-running agentic loops is a Stop
 * hook that:
 *   1. Detects when the model said it would continue but didn't.
 *   2. Returns `decision: 'block'` with a `reason` that re-prompts
 *      the model to keep going.
 *   3. NEVER blocks if Stop hooks have already fired this run
 *      (`input.stop_hook_active === true`) — that's the SDK's
 *      anti-infinite-loop guardrail and we honor it.
 *   4. NEVER blocks if the user has aborted (abortSignal fired) —
 *      user intent always wins.
 *
 * What this hook does NOT do
 * ──────────────────────────
 * It does NOT force every chat turn to keep going. The default path
 * is to LET THE MODEL FINISH. The hook only intervenes when:
 *   (a) the last assistant message contains a clear "more work to do"
 *       signal (e.g., "next, I'll", "step 2:", "I'll continue with"), AND
 *   (b) the user has NOT issued a stop / cancel, AND
 *   (c) we haven't already re-blocked this run.
 *
 * Conservative by design: better to let one job finish slightly short
 * than to spin forever. If a job needs to run long, the user can
 * always re-ask.
 *
 * Aligned with Anthropic SDK best practices: Stop hooks fire even
 * under `bypassPermissions`, which is the canonical lever for
 * "agentic loop that keeps going." See `sdk.d.ts:5483-5492` for the
 * `StopHookInput` shape including the `stop_hook_active` guard.
 */

import pino from 'pino';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const logger = pino({ name: 'clementine.chat-stop-hook' });

/**
 * Phrases in the last assistant message that signal "more work to do."
 * Conservative — we only continue when the model EXPLICITLY said it
 * would. Vague endings ("Let me know if you need anything else.") do
 * NOT trigger; those are clean completions.
 */
const CONTINUATION_SIGNALS: ReadonlyArray<RegExp> = [
  // Explicit "next step" / sequencing
  /\bnext,?\s+(?:i'?ll|i\s+will|let'?s|i'?m\s+going\s+to)\b/i,
  /\bstep\s+\d+:/i,
  /\bphase\s+\d+:/i,
  /\bi'?ll\s+(?:now|then|next)\b/i,
  /\bi\s+will\s+(?:now|then|next)\b/i,
  // "Continuing with" / "moving on"
  /\bcontinuing\s+(?:with|to)\b/i,
  /\bmoving\s+on\s+to\b/i,
  /\bi'?ll\s+continue\s+(?:by|with)\b/i,
  // Promised remainder of a list
  /\b(?:second|third|fourth|fifth|remaining|rest)\s+(?:email|email\.?|draft|item|step)/i,
  // "After this, I'll"
  /\bafter\s+(?:this|that),?\s+i'?ll\b/i,
];

export interface StopHookOptions {
  /** Stable run identifier for telemetry. */
  runId: string;
  /** Optional abort signal to honor — if it fires, the hook will
   *  never re-block. User-initiated stops always win. */
  abortSignal?: AbortSignal;
  /** Optional callback fired on every decision. Useful for the
   *  dashboard "What Clementine sees this turn" panel. */
  onDecision?: (info: {
    decision: 'pass' | 'continue';
    reason?: string;
    lastMessagePreview: string;
    stopHookActive: boolean;
  }) => void;
}

export interface StopHookStats {
  /** Total Stop events inspected. */
  inspected: number;
  /** Stop events that passed through (model finished cleanly). */
  passed: number;
  /** Stop events where we re-prompted the model to continue. */
  continued: number;
}

export interface StopHookHandles {
  /** Hook map suitable for SDK `query({ options: { hooks } })`. */
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Aggregated telemetry — read after the run completes. */
  stats: StopHookStats;
}

/**
 * Build a Stop hook for a chat-initiated agentic run.
 */
export function buildChatStopHook(opts: StopHookOptions): StopHookHandles {
  const stats: StopHookStats = { inspected: 0, passed: 0, continued: 0 };

  const stopHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'Stop') return {} as HookJSONOutput;
    const evt = input as StopHookInput;
    stats.inspected += 1;

    const lastMsg = evt.last_assistant_message ?? '';
    const lastMessagePreview = lastMsg.slice(0, 160).replace(/\s+/g, ' ').trim();

    // ── Guard 1: anti-infinite-loop ───────────────────────────────
    // stop_hook_active is true if Stop hooks have ALREADY fired this
    // run. SDK uses this exact field to prevent us re-blocking
    // forever. If it's set, we must pass through.
    if (evt.stop_hook_active) {
      stats.passed += 1;
      logger.debug({
        runId: opts.runId,
        reason: 'stop_hook_active',
        lastMessagePreview,
      }, 'Stop hook passing — already active');
      opts.onDecision?.({
        decision: 'pass',
        reason: 'stop_hook_active',
        lastMessagePreview,
        stopHookActive: true,
      });
      return {} as HookJSONOutput;
    }

    // ── Guard 2: user-initiated stop ──────────────────────────────
    // If the abort signal has fired, the user wants out. Never
    // re-block. User intent ALWAYS wins.
    if (opts.abortSignal?.aborted) {
      stats.passed += 1;
      logger.debug({
        runId: opts.runId,
        reason: 'user_aborted',
        lastMessagePreview,
      }, 'Stop hook passing — user aborted');
      opts.onDecision?.({
        decision: 'pass',
        reason: 'user_aborted',
        lastMessagePreview,
        stopHookActive: false,
      });
      return {} as HookJSONOutput;
    }

    // ── Detection: did the model say it would continue? ──────────
    const continuationMatched = CONTINUATION_SIGNALS.some((rx) => rx.test(lastMsg));
    if (!continuationMatched) {
      // No continuation signal — let the model finish.
      stats.passed += 1;
      opts.onDecision?.({
        decision: 'pass',
        reason: 'clean_completion',
        lastMessagePreview,
        stopHookActive: false,
      });
      return {} as HookJSONOutput;
    }

    // ── Re-prompt: keep going ──────────────────────────────────────
    stats.continued += 1;
    const reason =
      'You said you would continue with more work but the loop is about to end. ' +
      'Keep going — finish the remaining steps you outlined. ' +
      'If you genuinely cannot continue (waiting on external input, hit a hard error, etc.), say so explicitly in your next message so the owner knows where you stopped.';

    logger.info({
      runId: opts.runId,
      lastMessagePreview,
    }, 'Stop hook re-prompting model to continue work it announced');

    opts.onDecision?.({
      decision: 'continue',
      reason,
      lastMessagePreview,
      stopHookActive: false,
    });

    return {
      decision: 'block' as const,
      reason,
    } as HookJSONOutput;
  };

  return {
    hooks: {
      Stop: [{ hooks: [stopHook] }],
    },
    stats,
  };
}
