/**
 * precondition-guard — SDK PreToolUse hooks that evaluate the registered
 * precondition classifiers before each tool call. When a classifier
 * matches, the hook returns `permissionDecision: 'deny'` with a reason,
 * captures the PendingAgentDecision in module-scoped state for the run,
 * and runAgent surfaces it to the router via RunAgentResult.
 *
 * Why this exists
 * ───────────────
 * `clarification-gate.ts` already handles owner-decision routing for
 * blocked external actions, but its existing BlockedActionClassifier API
 * is post-hoc: the tool already ran and failed, so we parse the error,
 * inferred the blocker, then asked the owner. That leaves partial state
 * behind (a half-deploy, a created-but-unconfigured target, an emitted
 * webhook that can't be undone).
 *
 * The orchestrator-first north star prefers pre-emptive gates. The SDK
 * exposes PreToolUse hooks that run BEFORE every tool call regardless
 * of permissionMode. We use them to short-circuit known-bad calls
 * before they fire. The same PendingAgentDecision shape flows through
 * the router, so the owner experience is identical — only the failure
 * surface is narrower.
 *
 * Why PreToolUse over canUseTool
 * ──────────────────────────────
 * `canUseTool` is permission-prompt scoped and may be skipped under
 * `bypassPermissions` mode. `PreToolUse` hooks fire universally. The
 * SDK's own doc string on PermissionDeniedMessage confirms:
 *
 *   "PreToolUse hook denies bypass canUseTool and are not covered here."
 *
 * That means PreToolUse decisions run FIRST, even when canUseTool is
 * absent or short-circuited. PreToolUse is also already wired into the
 * runAgent hooks pipeline (`tool-output-guard`, `dedup`,
 * `idempotency`), so this fits the established pattern.
 */

import pino from 'pino';

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import {
  evaluatePreconditionsForToolCall,
  type PendingAgentDecision,
  type PreconditionEnv,
} from './clarification-gate.js';

const logger = pino({ name: 'clementine.precondition-guard' });

export interface PreconditionGuardOptions {
  /** Working directory the agent is running in. Used by classifiers to
   *  resolve relative project paths. */
  cwd: string;
  /** Active project path if the router resolved one. Optional. */
  activeProjectPath?: string;
  /** The original owner request that started this run. Used to populate
   *  PendingAgentDecision.originalRequest when a precondition fires.
   *  Optional — the router can fill it in later if needed. */
  originalRequest?: string;
  /** Stable run UUID. Stored on the decision so post-resume continues
   *  to reference the same run. */
  runId: string;
}

export interface PreconditionGuardHandles {
  /** SDK hook map. Merge into the runAgent hooks pipeline. */
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Read out the captured decision after the SDK stream ends. Null when
   *  no precondition fired during the run. */
  getCapturedDecision(): PendingAgentDecision | null;
}

export function buildPreconditionGuardHooks(opts: PreconditionGuardOptions): PreconditionGuardHandles {
  let capturedDecision: PendingAgentDecision | null = null;

  const env: PreconditionEnv = {
    cwd: opts.cwd,
    ...(opts.activeProjectPath ? { activeProjectPath: opts.activeProjectPath } : {}),
  };

  const preToolUse: HookCallback = async (input, _toolUseID) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {} as HookJSONOutput;
    }
    const evt = input as PreToolUseHookInput;
    const toolName = String(evt.tool_name ?? 'unknown');
    const toolInput = (evt.tool_input ?? {}) as Record<string, unknown>;

    // Already captured a decision earlier in this run — let everything
    // after pass through. The first deny interrupts the loop; subsequent
    // tool calls (if any) shouldn't be re-evaluated.
    if (capturedDecision) return {} as HookJSONOutput;

    const decision = evaluatePreconditionsForToolCall(toolName, toolInput, env, {
      ...(opts.originalRequest ? { originalRequest: opts.originalRequest } : {}),
      runId: opts.runId,
    });
    if (!decision) return {} as HookJSONOutput;

    capturedDecision = decision;

    logger.info({
      toolName,
      classifierId: decision.context.classifierId,
      provider: decision.context.provider,
      runId: opts.runId,
    }, 'precondition-guard: denied tool call pre-flight; surfacing PendingAgentDecision');

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: decision.question,
      },
    } as HookJSONOutput;
  };

  return {
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
    },
    getCapturedDecision() {
      return capturedDecision;
    },
  };
}
