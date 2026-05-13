/**
 * Live per-run state fed by SDK hooks.
 *
 * Event logs are the durable source of truth. RunState is the hot-path cache:
 * enough structured state for Stop hooks to make one good decision before the
 * run ends, without reading JSONL from disk or expanding prompts.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PostToolUseHookInput,
  SessionEndHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { classifyToolCall, isToolResultSuccessful } from './side-effect-classifier.js';
import { buildSideEffectFingerprint } from './side-effect-idempotency.js';

export interface RunStateSideEffect {
  toolName: string;
  toolUseId?: string;
  summary: string;
  kind: 'side_effect' | 'unknown';
  successful: boolean;
  successReason?: string;
  statusCode?: number;
  ts: string;
}

export interface RunStateTodoSnapshot {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export interface LiveRunState {
  runId: string;
  sessionKey?: string;
  startedAt: number;
  lastUpdatedAt: number;
  readOnlyToolCalls: number;
  unknownToolCalls: number;
  totalToolCalls: number;
  successfulSideEffects: RunStateSideEffect[];
  failedSideEffects: RunStateSideEffect[];
  todo?: RunStateTodoSnapshot;
  ended?: { reason?: string; endedAt: number };
}

export interface RunStateStats {
  inspected: number;
  sideEffects: number;
  todosUpdated: number;
}

export interface RunStateHookOptions {
  runId: string;
  sessionKey?: string;
  now?: () => number;
}

export interface RunStateHookHandles {
  state: LiveRunState;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  stats: RunStateStats;
}

const LIVE_RUNS = new Map<string, LiveRunState>();

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function summarizeToolCall(toolName: string, input: unknown): string {
  const fp = buildSideEffectFingerprint(toolName, input);
  if (fp) return fp.summary;
  if (toolName === 'Bash') {
    const command = asRecord(input)?.command;
    if (typeof command === 'string' && command.trim()) {
      const preview = command.trim().replace(/\s+/g, ' ').slice(0, 96);
      return `Bash mutation: ${preview}`;
    }
  }
  return toolName;
}

function readTodoSnapshot(input: unknown): RunStateTodoSnapshot | undefined {
  const rec = asRecord(input);
  const todos = rec?.todos;
  if (!Array.isArray(todos)) return undefined;
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const item of todos) {
    const status = asRecord(item)?.status;
    if (status === 'completed') completed += 1;
    else if (status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  return {
    total: todos.length,
    pending,
    inProgress,
    completed,
  };
}

export function getRunState(runId: string): LiveRunState | undefined {
  return LIVE_RUNS.get(runId);
}

export function clearRunState(runId: string): void {
  LIVE_RUNS.delete(runId);
}

export function buildRunStateHooks(opts: RunStateHookOptions): RunStateHookHandles {
  const now = opts.now ?? (() => Date.now());
  const state: LiveRunState = {
    runId: opts.runId,
    ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    startedAt: now(),
    lastUpdatedAt: now(),
    readOnlyToolCalls: 0,
    unknownToolCalls: 0,
    totalToolCalls: 0,
    successfulSideEffects: [],
    failedSideEffects: [],
  };
  const stats: RunStateStats = { inspected: 0, sideEffects: 0, todosUpdated: 0 };
  LIVE_RUNS.set(opts.runId, state);

  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {} as HookJSONOutput;
    const evt = input as PostToolUseHookInput;
    const toolName = String(evt.tool_name ?? 'unknown');
    stats.inspected += 1;
    state.totalToolCalls += 1;
    state.lastUpdatedAt = now();

    if (toolName === 'TodoWrite') {
      const snapshot = readTodoSnapshot(evt.tool_input);
      if (snapshot) {
        state.todo = snapshot;
        stats.todosUpdated += 1;
      }
      return {} as HookJSONOutput;
    }

    const inputRecord = asRecord(evt.tool_input);
    const verdict = classifyToolCall(toolName, inputRecord);
    if (verdict.kind === 'read_only') {
      state.readOnlyToolCalls += 1;
      return {} as HookJSONOutput;
    }
    if (verdict.kind === 'unknown') {
      state.unknownToolCalls += 1;
      return {} as HookJSONOutput;
    }

    const result = isToolResultSuccessful(evt.tool_response, false);
    const sideEffect: RunStateSideEffect = {
      toolName,
      toolUseId: evt.tool_use_id,
      summary: summarizeToolCall(toolName, evt.tool_input),
      kind: 'side_effect',
      successful: result.successful,
      ...(result.successful ? { successReason: result.reason } : {}),
      ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
      ts: nowIso(now),
    };
    stats.sideEffects += 1;
    if (result.successful) state.successfulSideEffects.push(sideEffect);
    else state.failedSideEffects.push(sideEffect);
    return {} as HookJSONOutput;
  };

  const sessionEnd: HookCallback = async (input) => {
    if (input.hook_event_name !== 'SessionEnd') return {} as HookJSONOutput;
    const evt = input as SessionEndHookInput;
    state.ended = { reason: String(evt.reason ?? ''), endedAt: now() };
    // Keep the state object alive for closures that already hold it, but drop
    // the global index to prevent stale cross-run reads.
    LIVE_RUNS.delete(opts.runId);
    return {} as HookJSONOutput;
  };

  return {
    state,
    hooks: {
      PostToolUse: [{ hooks: [postToolUse] }],
      SessionEnd: [{ hooks: [sessionEnd] }],
    },
    stats,
  };
}

export function hasCompletedManifest(text: string): boolean {
  return /✅\s*\*\*Completed\*\*/.test(text);
}

export function summarizeRunStateForManifest(state: LiveRunState): string {
  const groups = new Map<string, number>();
  for (const effect of state.successfulSideEffects) {
    const key = effect.summary;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const completed = Array.from(groups.entries())
    .slice(0, 5)
    .map(([summary, count]) => `- ${count > 1 ? `${count}x ` : ''}${summary}`)
    .join('\n') || '- No side effects recorded';
  const pending = state.todo && (state.todo.pending + state.todo.inProgress) > 0
    ? `- TodoWrite: ${state.todo.pending + state.todo.inProgress} unfinished item(s)`
    : '- None known';
  return [
    'Use this concise manifest before ending:',
    '',
    '✅ **Completed**',
    completed,
    '',
    '⚠️ **Pending**',
    pending,
  ].join('\n');
}
