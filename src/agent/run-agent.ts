/**
 * Clementine TypeScript — runAgent: canonical Claude Agent SDK wrapper.
 *
 * Canonical execution wrapper for chat, skills, schedules, heartbeat,
 * and team-task runs.
 *
 * Design principles (from the SDK docs):
 * 1. ONE query() call — no nested phase wrappers.
 * 2. Subagents via the `agents` param — not via prompt-injected
 *    fanout directives.
 * 3. SDK handles: agent loop, compaction, tool execution, parallel
 *    sub-spawning, prompt caching, session resume.
 * 4. App handles: prompt + options assembly, transcript mirroring,
 *    cost logging, channel delivery.
 * 5. NO context-thrash recovery, NO manual session rotation, NO
 *    long-task preflight, NO mode=unleashed wrapper.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, type AgentDefinition, type SDKAssistantMessage, type SDKResultMessage, type SessionStore } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { EventLog } from '../gateway/event-log.js';
import type { RunEvent, TerminalReason } from '../types.js';

/**
 * Module-level cache of MCP server statuses from the most recent SDK
 * init message. Populated by every runAgent / PersonalAssistant query
 * stream that captures `system/init`. Read by Assistant.getMcpStatus()
 * and the dashboard's Tools & MCP catalog page.
 *
 * Pre-1.18.84 the assistant declared a private _lastMcpStatus but no
 * code wrote to it — getMcpStatus() always returned empty, making the
 * catalog status pills misleading. The shared module cache fixes that
 * without coupling assistant.ts to runAgent's stream loop.
 */
let _lastMcpStatusSnapshot: { servers: Array<{ name: string; status: string }>; updatedAt: string } = {
  servers: [],
  updatedAt: '',
};

/** Read the latest MCP status snapshot. Safe to call from any module. */
export function getLatestMcpStatusSnapshot(): { servers: Array<{ name: string; status: string }>; updatedAt: string } {
  return { servers: [..._lastMcpStatusSnapshot.servers], updatedAt: _lastMcpStatusSnapshot.updatedAt };
}

/** Write a fresh snapshot. Called from system/init handlers. */
export function recordMcpStatusFromSystemInit(rawMcpServers: unknown): void {
  if (!Array.isArray(rawMcpServers)) return;
  const servers: Array<{ name: string; status: string }> = [];
  for (const entry of rawMcpServers) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { name?: unknown; status?: unknown };
    if (typeof e.name !== 'string' || !e.name) continue;
    servers.push({ name: e.name, status: typeof e.status === 'string' ? e.status : 'unknown' });
  }
  _lastMcpStatusSnapshot = { servers, updatedAt: new Date().toISOString() };
}

/**
 * Truncate a value for the Event store so a single huge tool input/output
 * doesn't blow out the JSONL line. Object/array shapes are JSON-stringified
 * and capped; primitive strings are sliced; everything else is returned as-is.
 */
function truncateForLog(value: unknown, maxBytes: number): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxBytes ? value.slice(0, maxBytes) + '...[truncated]' : value;
  }
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxBytes) return value;
    return { _truncated: true, preview: json.slice(0, maxBytes) + '...[truncated]', _bytes: json.length };
  } catch {
    return { _unstringifiable: true };
  }
}

/** True when the SDK emits an internal context-pressure diagnostic as an
 * assistant text block. These are operational warnings, not useful user
 * output, and they can appear while the run is still recovering/continuing. */
export function isSdkContextDiagnosticText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^Autocompact is thrashing:\s*the context refilled to the limit/i.test(t)
    || /^rapid_refill_breaker\b/i.test(t);
}

/** Drop one server from the cache so the next query repopulates it. */
export function invalidateMcpStatusEntry(name: string): { cleared: boolean; updatedAt: string } {
  const before = _lastMcpStatusSnapshot.servers.length;
  _lastMcpStatusSnapshot = {
    servers: _lastMcpStatusSnapshot.servers.filter((s) => s.name !== name),
    updatedAt: new Date().toISOString(),
  };
  return { cleared: _lastMcpStatusSnapshot.servers.length < before, updatedAt: _lastMcpStatusSnapshot.updatedAt };
}
import {
  BASE_DIR,
  PKG_DIR,
  CLAUDE_CODE_OAUTH_TOKEN,
  ANTHROPIC_API_KEY as CONFIG_ANTHROPIC_API_KEY,
  normalizeClaudeSdkOptionsForOneMillionContext,
  TOOL_OUTPUT_GUARD,
} from '../config.js';
import { buildGuardHooks, type ToolOutputGuardConfig } from './tool-output-guard.js';
import { buildDedupHook } from './tool-call-dedup.js';
import { buildChatStopHook } from './chat-stop-hook.js';
import type { AgentProfile } from '../types.js';
import type { AgentManager } from './agent-manager.js';
import type { MemoryStore } from '../memory/store.js';
import type { MemoryStoreType } from '../tools/shared.js';
import { buildAgentMap } from './agent-definitions.js';
import {
  buildExecutionToolPolicy,
  type ExecutionPermissionMode,
} from './execution-policy.js';

const MCP_SERVER_SCRIPT = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
const ASSISTANT_NAME = (process.env.ASSISTANT_NAME ?? 'Clementine').toLowerCase();
const TOOLS_SERVER = `${ASSISTANT_NAME}-tools`;

/**
 * Build a minimal env for the SDK subprocess. Mirrors the existing
 * SAFE_ENV pattern in assistant.ts but exposed here so runAgent can be
 * its own thing without depending on the legacy assistant module.
 *
 * Priority: CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY.
 * When all are absent, HOME lets the subprocess find Keychain OAuth.
 */
function buildRunAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    USER: process.env.USER ?? '',
    SHELL: process.env.SHELL ?? '',
    CLEMENTINE_HOME: BASE_DIR,
  };
  const oauthTok = CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const authTok = process.env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = CONFIG_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (oauthTok) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthTok;
  } else if (authTok) {
    env.ANTHROPIC_AUTH_TOKEN = authTok;
  } else if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return env;
}

const logger = pino({ name: 'clementine.run-agent' });

/**
 * Map a sessionKey to the CLEMENTINE_INTERACTION_SOURCE value the MCP
 * subprocess will read. Mirrors `inferInteractionSource` in assistant.ts
 * (kept inline here to avoid a circular import — assistant.ts already
 * imports from this module). Owner-DM-only admin tools like
 * refresh_tool_inventory / allow_tool / env_set check for exactly
 * 'owner-dm', so the previous hardcoded 'interactive' value broke them
 * for every chat session routed through runAgent.
 */
function interactionSourceForSession(
  sessionKey: string | null | undefined,
  source: string,
): 'owner-dm' | 'owner-channel' | 'member-channel' | 'autonomous' {
  if (source === 'cron' || source === 'heartbeat') return 'autonomous';
  if (!sessionKey) return 'autonomous';
  if (sessionKey.startsWith('discord:member')) return 'member-channel';
  if (sessionKey.startsWith('discord:channel:')) return 'owner-channel';
  if (sessionKey.includes(':')) return 'owner-dm';
  return 'autonomous';
}

export interface RunAgentOptions {
  /** Stable session key for this conversation/run. Used for transcript mirroring + resume. */
  sessionKey: string;

  /** Source classification for telemetry: 'chat' | 'cron' | 'heartbeat' | 'team-task' | 'test'. */
  source: string;

  /** Optional hired-agent profile. When set, this profile becomes the MAIN
   *  agent (its system prompt is appended). When unset, Clementine is the main agent. */
  profile?: AgentProfile | null;

  /** Optional subagent slug to invoke explicitly (bypasses Claude's automatic routing).
   *  When set, the prompt is wrapped to direct Claude to use this subagent first. */
  forceSubagent?: string | null;

  /** Hired-agent registry — used to construct the AgentDefinition map for delegation. */
  agentManager?: AgentManager | null;

  /** Memory store for transcript mirroring + cost logging. */
  memoryStore?: MemoryStore | null;

  /** Optional model override. Defaults to SDK default (Sonnet) unless profile sets one. */
  model?: string;

  /** Reasoning effort. Defaults vary by source: chat='medium', cron='medium', heartbeat='low'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Hard budget cap (USD). Default varies by source. SDK aborts the run when hit. */
  maxBudgetUsd?: number;

  /** Hard turn cap. Default: no cap (SDK runs until done). */
  maxTurns?: number;

  /** Optional resume — when set, the SDK continues from the prior session. */
  resumeSessionId?: string;

  /** Streaming callback for partial assistant text. Best-effort. */
  onText?: (chunk: string) => void | Promise<void>;

  /** Streaming callback when a tool is invoked (name + input). Best-effort. */
  onToolActivity?: (info: { tool: string; input: Record<string, unknown> }) => void | Promise<void>;

  /** Abort signal — when triggered, the SDK stream is cancelled. */
  abortSignal?: AbortSignal;

  /** Optional override of the AgentDefinition map. Mostly for tests. */
  agents?: Record<string, AgentDefinition>;

  /** Optional explicit allowedTools list. When unset, falls back to a sensible default
   *  including Agent (so subagents can be spawned) + core SDK tools + Clementine MCP. */
  allowedTools?: string[];

  /** Extra tools to pre-approve without making their built-in tools visible to
   *  the main agent. Useful when the main agent may only call Agent, but the
   *  forced subagent still needs pre-approved MCP/Clementine tools. */
  permissionTools?: string[];

  /** SDK permission mode. Defaults to dontAsk so allowedTools is enforceable.
   *  Only explicit operator/full-surface paths should request bypassPermissions. */
  permissionMode?: ExecutionPermissionMode;

  /** Optional SDK skill filter for the main session. This filters skill
   *  context/tooling only; it is not a filesystem sandbox. */
  skills?: string[] | 'all';

  /** Enable SDK file checkpointing for project-editing runs. */
  enableFileCheckpointing?: boolean;

  /** Working directory for SDK built-in tools. Defaults to Clementine home. */
  cwd?: string;

  /** Optional CLAUDE.md / project setting source. Defaults to ['project', 'local']. */
  settingSources?: ('project' | 'user' | 'local')[];

  /** Extra directories the SDK should make available to the agent's tools
   *  (Read/Bash/Glob/Grep) beyond `cwd`. Maps directly to the SDK's
   *  `additionalDirectories` option. The cron runtime uses this to surface
   *  pinned-skill folders so the agent can `Bash python3 scripts/render.py`
   *  inside a skill bundle without the cwd being set to that folder.
   *  Captured in CronJobDefinition.addDirs and piped through buildPrompt. */
  additionalDirectories?: string[];

  /** Additional MCP servers to merge with the always-on clementine-tools
   *  server. Use to wire Composio + claude.ai integrations on chat-path
   *  invocations that need Outlook/Salesforce/etc. */
  extraMcpServers?: Record<string, {
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;

  /** String appended to the SDK's `claude_code` system-prompt preset.
   *  Caller-built so chat callers can inject vault context (SOUL.md,
   *  MEMORY.md, AGENTS.md) while autonomous callers (cron/heartbeat/
   *  team-task) keep the prompt small. When unset, falls back to
   *  profile.systemPromptBody (legacy single-source behavior). */
  systemPromptAppend?: string;

  /** Per-run override for the tool-output-guard config (1.18.169).
   *  Defaults come from src/config.ts TOOL_OUTPUT_GUARD (env +
   *  clementine.json). Pass null to disable the guard for this run
   *  (rarely needed — almost always a sign that perTool overrides
   *  would be safer). */
  toolOutputGuard?: Partial<ToolOutputGuardConfig> | null;
}

export interface RunAgentResult {
  /** Final text response from the agent. */
  text: string;

  /** Total cost in USD as reported by the SDK. */
  totalCostUsd: number;

  /** Number of agentic turns the loop took. */
  numTurns: number;

  /** SDK session ID — capture for resume. */
  sessionId: string;

  /** Final stop reason from the SDK (success, error_max_turns, error_max_budget_usd, etc). */
  subtype: string;

  /** Precise SDK loop terminal reason, when available. */
  terminalReason?: TerminalReason;

  /** Token usage breakdown (input, output, cache). */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  /** PRD §6 / 1.18.85: stable run UUID. The Event store keys off this id;
   *  callers (cron-scheduler, cron CLI) stamp it on CronRunEntry so the
   *  Run detail page can join run row → events. */
  runId: string;

  /** Effective SDK execution policy, useful in Run detail diagnostics. */
  permissionMode?: ExecutionPermissionMode;
  allowedToolsApplied?: string[];
  builtinToolsApplied?: string[];
  mcpServersApplied?: string[];
}

// Last-resort fallbacks for callers that pass NO maxBudgetUsd. The
// production callers (`runAgent` from gateway/router, runAgentCron,
// runAgentHeartbeat) read `BUDGET.*` from src/config.ts — which is
// itself sourced from env / clementine.json / dashboard writes — and
// pass it explicitly. Chat is intentionally omitted: the chat path
// must always go through `BUDGET.chat` (0 = uncapped), never a silent
// hardcoded floor. If `source: 'chat'` ever lands here without an
// explicit budget, we treat it as uncapped.
const DEFAULT_BUDGETS: Record<string, number> = {
  cron: 1.00,
  heartbeat: 0.25,
  'team-task': 1.00,
  test: 2.00,
};

const DEFAULT_EFFORTS: Record<string, RunAgentOptions['effort']> = {
  chat: 'medium',
  cron: 'medium',
  heartbeat: 'low',
  'team-task': 'medium',
  test: 'medium',
};

const CORE_TOOLS_FOR_AGENT_PARENT = [
  'Agent', // REQUIRED — without this, subagents can't be invoked
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  // 1.18.184 — Clementine's identity tools. Memory + capture are not
  // optional skills; they are part of who she is. Surfacing them in
  // the canonical SDK tools channel (NOT in the system prompt) means
  // the model always sees them as available — no dependency on
  // skill-match score thresholds widening the surface mid-turn.
  // The MCP wildcard at execution-policy.ts:233 also exposes them, but
  // when the MCP server hiccups during init the wildcard goes empty;
  // explicit listing here guarantees the surface.
  'mcp__clementine-tools__memory_search',
  'mcp__clementine-tools__transcript_search',
  'mcp__clementine-tools__memory_write',
  'mcp__clementine-tools__note_take',
  'mcp__clementine-tools__note_create',
  'mcp__clementine-tools__task_add',
];

/**
 * Run a single agent invocation via the canonical SDK pattern.
 *
 * Returns when the SDK loop completes (final assistant message with no
 * tool calls, OR maxTurns/maxBudget hit, OR error).
 */
export async function runAgent(prompt: string, opts: RunAgentOptions): Promise<RunAgentResult> {
  const source = opts.source ?? 'chat';
  const effort = opts.effort ?? DEFAULT_EFFORTS[source] ?? 'medium';
  // 0 (or undefined) means "no cap" — matches the dashboard's
  // "Remove spend caps" preset contract. We omit `maxBudgetUsd` from
  // sdkOptions entirely in that case so the SDK runs uncapped.
  const requestedBudget = opts.maxBudgetUsd ?? DEFAULT_BUDGETS[source];
  const maxBudgetUsd: number | undefined =
    typeof requestedBudget === 'number' && requestedBudget > 0
      ? requestedBudget
      : undefined;
  const startedAt = Date.now();

  // Build the AgentDefinition map.
  // - Default: planner/researcher/cron-fixer + hired-agent profiles.
  // - Caller-supplied agents (opts.agents) MERGE over the defaults rather
  //   than REPLACE them (1.18.173). `runSkill`'s auto-delegation path
  //   needs to inject a per-run `skill-worker` definition while keeping
  //   the planner/researcher/etc. available for deeper delegation.
  //   Tests that want a fully isolated map pass an explicit override
  //   via the `replaceAgents` option below.
  const defaultAgents = buildAgentMap({
    profileManager: opts.agentManager ?? undefined,
    isAutonomous: source === 'cron' || source === 'heartbeat',
    activeAgentSlug: opts.profile?.slug,
  });
  const agents = opts.agents ? { ...defaultAgents, ...opts.agents } : defaultAgents;

  // Wrap prompt to direct Claude to a specific subagent when caller asks.
  // Per SDK docs: explicit invocation = "Use the X agent to..."
  const effectivePrompt = opts.forceSubagent && agents[opts.forceSubagent]
    ? `Use the ${opts.forceSubagent} agent to handle this request:\n\n${prompt}`
    : prompt;

  // Compose system-prompt append. The caller has already merged any
  // vault context (SOUL.md, MEMORY.md, AGENTS.md) and profile body
  // into a single string when needed; otherwise we fall back to the
  // profile body alone for autonomous paths.
  const profileAppend = opts.systemPromptAppend?.trim()
    ? opts.systemPromptAppend
    : opts.profile?.systemPromptBody?.trim()
      ? opts.profile.systemPromptBody
      : undefined;

  // Allowed tools at the main-agent level.
  //   1. Caller-provided opts.allowedTools wins (e.g. heartbeat passes []).
  //   2. When a hired-agent profile is the main agent and it has a
  //      team.allowedTools allowlist, use it (with `Agent` always
  //      included so subagent delegation still works).
  //   3. Otherwise the core set. Per-subagent tool restrictions live
  //      on each AgentDefinition.tools field, not here.
  const profileMainAllow = opts.profile?.team?.allowedTools?.length
    ? Array.from(new Set(['Agent', ...opts.profile.team.allowedTools]))
    : null;
  const allowedTools = opts.allowedTools
    ?? profileMainAllow
    ?? CORE_TOOLS_FOR_AGENT_PARENT;

  // Wire the Clementine MCP server so the agent can reach memory/cron/
  // broken-job tools. Without this, the cron-fixer subagent's `tools`
  // list references mcp__clementine-tools__* that don't exist in the
  // session, and the agent falls back to reading raw JSON files.
  const subprocessEnv = buildRunAgentEnv();
  const baseMcpServers: Record<string, Record<string, unknown>> = {
    ...(opts.extraMcpServers ?? {}),
  };
  const policyMcpServerNames = [TOOLS_SERVER, ...Object.keys(baseMcpServers)];
  const toolPolicy = buildExecutionToolPolicy({
    requestedTools: opts.allowedTools ?? profileMainAllow ?? undefined,
    defaultBuiltins: CORE_TOOLS_FOR_AGENT_PARENT,
    mcpServerNames: policyMcpServerNames,
    clementineServerName: TOOLS_SERVER,
    permissionMode: opts.permissionMode,
  });
  const permissionToolPolicy = opts.permissionTools
    ? buildExecutionToolPolicy({
        requestedTools: opts.permissionTools,
        defaultBuiltins: CORE_TOOLS_FOR_AGENT_PARENT,
        mcpServerNames: policyMcpServerNames,
        clementineServerName: TOOLS_SERVER,
        permissionMode: opts.permissionMode,
      })
    : null;
  const sdkAllowedTools = permissionToolPolicy
    ? Array.from(new Set([...toolPolicy.allowedTools, ...permissionToolPolicy.allowedTools])).sort()
    : toolPolicy.allowedTools;
  const clementineToolAllowlist = (() => {
    if (!permissionToolPolicy) return toolPolicy.clementineToolAllowlist;
    const parts = [toolPolicy.clementineToolAllowlist, permissionToolPolicy.clementineToolAllowlist]
      .flatMap(v => v.split(',').map(s => s.trim()).filter(Boolean));
    if (parts.includes('*')) return '*';
    return Array.from(new Set(parts)).sort().join(',');
  })();

  // SDK accepts a Record<string, McpServerConfig> here. We cast on
  // assignment because we mix the always-on Clementine stdio server
  // with caller-supplied servers of various types.
  const mcpServers: Record<string, Record<string, unknown>> = {
    [TOOLS_SERVER]: {
      type: 'stdio' as const,
      command: 'node',
      args: [MCP_SERVER_SCRIPT],
      env: {
        ...subprocessEnv,
        CLEMENTINE_HOME: BASE_DIR,
        ...(opts.profile?.slug ? { CLEMENTINE_TEAM_AGENT: opts.profile.slug } : {}),
        CLEMENTINE_SESSION_KEY: opts.sessionKey,
        CLEMENTINE_INTERACTION_SOURCE: interactionSourceForSession(opts.sessionKey, source),
        CLEMENTINE_TOOL_ALLOWLIST: clementineToolAllowlist,
      },
    },
    ...baseMcpServers,
  };

  // Bridge an external AbortSignal to a real AbortController the SDK
  // can act on. The SDK calls .abort() internally on budget/turn caps,
  // so we cannot pass a fake { signal } object — it must be a real
  // controller. When the caller's signal fires we propagate.
  let sdkAbortController: AbortController | undefined;
  if (opts.abortSignal) {
    sdkAbortController = new AbortController();
    if (opts.abortSignal.aborted) {
      sdkAbortController.abort();
    } else {
      opts.abortSignal.addEventListener('abort', () => sdkAbortController!.abort(), { once: true });
    }
  }

  // PRD §6 / 1.18.85: stable run id created before sdkOptions so the
  // tool-output guard (1.18.169) can namespace its on-disk archive by
  // runId. EventLog writers below also reference this id.
  const runId = randomUUID();
  const eventLog = new EventLog();
  let eventSeq = 0;
  const writeEvent = (e: Omit<RunEvent, 'runId' | 'seq'>): void => {
    try {
      eventLog.append({
        ...e,
        runId,
        seq: eventSeq++,
      } as RunEvent);
    } catch { /* never block */ }
  };

  // Durable SDK session store: mirror parent + subagent SDK transcripts into
  // Clementine's SQLite memory store. The chat gateway already persists the
  // SDK session id; this store makes restart resume independent of local JSONL
  // files and keeps session inspection/querying in the same memory backend.
  let sessionStore: SessionStore | undefined;
  if (opts.memoryStore) {
    try {
      const { createMemorySessionStore } = await import('./session-store-adapter.js');
      sessionStore = createMemorySessionStore(opts.memoryStore as unknown as MemoryStoreType);
    } catch (err) {
      logger.debug({ err }, 'runAgent: SessionStore adapter unavailable (non-fatal)');
    }
  }

  // ── Tool-output guard hooks (1.18.169) ─────────────────────────────
  // Bounds the per-tool-call output that reaches the model so SDK
  // auto-compaction never thrashes on a runaway MCP result. The hook
  // ALSO mirrors compression events into the run's EventLog so the Run
  // detail page can show "[guard] outlook_inbox: 412KB → 28KB" badges.
  // Per-run config merges over the static TOOL_OUTPUT_GUARD defaults;
  // pass opts.toolOutputGuard = null to opt out entirely.
  //
  // `mostRecentUsageTokens` is updated from each assistant message's
  // usage block (input + cache_read + cache_creation tokens). The
  // window estimate is a conservative 180K — even 1M-context runs
  // benefit from staying near 200K because compaction kicks in
  // earlier and tools.outputs amplify thrash regardless of window.
  let mostRecentUsageTokens = 0;
  const usageWindowEstimate = 180_000; // tokens, conservative
  const guardConfig: ToolOutputGuardConfig | null = opts.toolOutputGuard === null
    ? null
    : {
        softLimitBytes: opts.toolOutputGuard?.softLimitBytes ?? TOOL_OUTPUT_GUARD.softLimitBytes,
        hardLimitBytes: opts.toolOutputGuard?.hardLimitBytes ?? TOOL_OUTPUT_GUARD.hardLimitBytes,
        adaptive: opts.toolOutputGuard?.adaptive ?? TOOL_OUTPUT_GUARD.adaptive,
        perTool: { ...TOOL_OUTPUT_GUARD.perTool, ...(opts.toolOutputGuard?.perTool ?? {}) },
      };
  const guard = guardConfig
    ? buildGuardHooks({
        runId,
        config: guardConfig,
        usageRatio: () => mostRecentUsageTokens / usageWindowEstimate,
        onCompress: (info) => {
          writeEvent({
            kind: 'tool_result',
            ts: new Date().toISOString(),
            sessionId,
            toolUseId: info.toolUseId,
            toolResult: {
              _clementine_guard: true,
              tool: info.toolName,
              originalBytes: info.originalBytes,
              capBytes: info.capBytes,
              bytesShed: info.bytesShed,
              ceilingHit: info.ceilingHit,
              ...(info.archivePath ? { archivePath: info.archivePath } : {}),
            },
          });
        },
      })
    : { hooks: {}, stats: { inspected: 0, compressed: 0, ceilingHits: 0, bytesShed: 0, compactions: 0 } };

  // ── Tool-call dedup hook (1.18.173) ─────────────────────────────────
  // Breaks the "re-fetch after compaction" loop that crashed the
  // imessage-triage cron on 2026-05-11 (4× identical tool calls →
  // SDK autocompact-thrashing abort). PreToolUse hook detects same
  // (toolName, inputHash) within 60s: 2nd call gets a soft hint, 3rd+
  // is denied so the model can't burn turns re-calling the same data.
  // Defense-in-depth — the cleaner fix (delegating to a subagent so the
  // parent never re-fetches in the first place) lives in run-skill.ts.
  const dedup = buildDedupHook({
    runId,
    onDecision: (info) => {
      if (info.decision === 'allow') return;
      writeEvent({
        kind: 'error',
        ts: new Date().toISOString(),
        sessionId,
        toolError: `_clementine_dedup:${info.decision} ${info.toolName} call#${info.callCount} @${info.sinceFirstMs}ms`,
      });
    },
  });

  // ── Chat persistence Stop hook (1.18.184, source='chat' only) ─────
  // Keeps chat-initiated multi-step jobs running until they finish.
  // Inspects the model's last assistant message for continuation
  // signals ("next, I'll...", "step 2:", etc.) and re-prompts the
  // model when it would otherwise stop mid-job. Honors
  // stop_hook_active (anti-infinite-loop) and abortSignal
  // (user-initiated stop always wins). Autonomous paths
  // (cron / scheduled-skill / heartbeat / team-task) intentionally
  // skip this — they have their own completion semantics and a
  // continue-on-stop hook would fight them.
  const isChatPath = source === 'chat';
  const stopHook = isChatPath
    ? buildChatStopHook({
        runId,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        onDecision: (info) => {
          if (info.decision !== 'continue') return;
          writeEvent({
            kind: 'hook',
            ts: new Date().toISOString(),
            sessionId,
            hookEventName: 'Stop',
            text: `clementine_stop_hook:continue last="${info.lastMessagePreview}"`,
          });
        },
      })
    : null;

  // Merge hook maps from the modules. SDK accepts arrays of
  // HookCallbackMatcher per event; we concatenate.
  const mergedHooks: typeof guard.hooks = { ...guard.hooks };
  for (const [evt, matchers] of Object.entries(dedup.hooks) as Array<[keyof typeof dedup.hooks, NonNullable<typeof dedup.hooks[keyof typeof dedup.hooks]>]>) {
    const existing = mergedHooks[evt] ?? [];
    mergedHooks[evt] = [...existing, ...matchers];
  }
  if (stopHook) {
    for (const [evt, matchers] of Object.entries(stopHook.hooks) as Array<[keyof typeof stopHook.hooks, NonNullable<typeof stopHook.hooks[keyof typeof stopHook.hooks]>]>) {
      const existing = mergedHooks[evt] ?? [];
      mergedHooks[evt] = [...existing, ...matchers];
    }
  }

  // Apply 1M-context env normalization (existing infra)
  const sdkOptionsRaw = {
    systemPrompt: profileAppend
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: profileAppend }
      : { type: 'preset' as const, preset: 'claude_code' as const },
    // PRD §6 Phase 4d / 1.18.102: read both project and local sources by
    // default. The path B installer writes to .claude/settings.local.json
    // (which the SDK reads under the 'local' source) so we never clobber
    // the user's hand-written .claude/settings.json. Callers can still
    // override settingSources via opts.
    settingSources: opts.settingSources ?? ['project', 'local'] as ('project' | 'user' | 'local')[],
    agents,
    // SDK's McpServerConfig is a union; cast at the boundary since
    // callers can mix stdio + http + sse server shapes.
    mcpServers: mcpServers as unknown as Parameters<typeof query>[0]['options'] extends infer O
      ? O extends { mcpServers?: infer M } ? M : never : never,
    tools: toolPolicy.builtinTools,
    allowedTools: sdkAllowedTools,
    permissionMode: toolPolicy.permissionMode,
    ...(sessionStore ? { sessionStore } : {}),
    ...(toolPolicy.allowDangerouslySkipPermissions
      ? { allowDangerouslySkipPermissions: toolPolicy.allowDangerouslySkipPermissions }
      : {}),
    cwd: opts.cwd ?? BASE_DIR,
    env: { ...subprocessEnv, ...toolPolicy.env },
    effort,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    ...(sdkAbortController ? { abortController: sdkAbortController } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
    // 1.18.121 — pipe additionalDirectories through to the SDK so agents
    // can Read / Bash inside pinned-skill folders, project-scoped skills,
    // and any cron's add_dirs scope without their cwd being set to those
    // folders. Was captured in CronJobDefinition.addDirs since 1.18.77 but
    // never reached the SDK call site — this closes that gap.
    ...(opts.additionalDirectories && opts.additionalDirectories.length > 0
      ? { additionalDirectories: opts.additionalDirectories }
      : {}),
    // 1.18.169 — install the tool-output guard hooks.
    // 1.18.173 — merged with the tool-call dedup hooks (PreToolUse).
    // SDK types accept `hooks` keyed by HookEvent; the empty object is
    // a no-op when both guards are disabled.
    ...(Object.keys(mergedHooks).length > 0 ? { hooks: mergedHooks } : {}),
  };

  const sdkOptions = normalizeClaudeSdkOptionsForOneMillionContext(sdkOptionsRaw);

  logger.info({
    sessionKey: opts.sessionKey,
    source,
    profile: opts.profile?.slug,
    forceSubagent: opts.forceSubagent,
    effort,
    maxBudgetUsd: maxBudgetUsd ?? 'uncapped',
    agentCount: Object.keys(agents).length,
    allowedToolCount: allowedTools.length,
    sdkAllowedToolCount: sdkAllowedTools.length,
    builtinToolCount: toolPolicy.builtinTools.length,
    permissionMode: toolPolicy.permissionMode,
    mcpServerCount: Object.keys(mcpServers).length,
    sessionStore: !!sessionStore,
  }, 'runAgent: starting query');

  // PRD §6 / 1.18.85: path A in-process tap. runId / eventLog / writeEvent
  // are declared earlier (above sdkOptionsRaw) because the tool-output
  // guard's onCompress callback needs them at hook-registration time.

  let finalText = '';
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let subtype = 'unknown';
  let terminalReason: TerminalReason | undefined;
  let usage: RunAgentResult['usage'];

  const stream = query({ prompt: effectivePrompt, options: sdkOptions });

  try {
  for await (const message of stream) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = (message as { session_id?: string }).session_id ?? '';
      // PRD Phase 2 / 1.18.84 correctness: capture the SDK-reported MCP
      // server status so getMcpStatus() (and the dashboard's Tools & MCP
      // catalog) actually has data. The init message includes
      // mcp_servers: Array<{ name, status }> per the SDK protocol.
      const mcpServersRaw = (message as { mcp_servers?: unknown }).mcp_servers;
      if (mcpServersRaw) {
        try { recordMcpStatusFromSystemInit(mcpServersRaw); }
        catch { /* non-fatal */ }
      }
      // PRD Phase 4a / 1.18.85: write the session_start Event row.
      writeEvent({ kind: 'session_start', ts: new Date().toISOString(), sessionId });
      // PRD Phase 4d / 1.18.101: register this session in the path B
      // hook-session registry so /api/hooks/event POSTs from the SDK can
      // resolve sessionId → runId/eventLog and write into the same JSONL.
      // Best-effort — telemetry must never block the run from progressing.
      try {
        const { registerRunSession } = await import('./hook-session-registry.js');
        registerRunSession(sessionId, runId, eventLog, eventSeq);
      } catch (regErr) {
        logger.debug({ regErr }, 'runAgent: hook-session registry register failed (non-fatal)');
      }
      logger.debug({ sessionKey: opts.sessionKey, sdkSessionId: sessionId, runId }, 'runAgent: SDK session initialized');
      continue;
    }

    if (message.type === 'assistant') {
      const am = message as SDKAssistantMessage;
      // 1.18.169 — capture this turn's usage so the tool-output guard can
      // adaptively tighten its cap as cumulative context climbs. We sum
      // input + cache_read + cache_creation because all three count
      // against the model's window for the NEXT turn. Output_tokens isn't
      // included — it's not retained in context after the model response
      // is processed.
      const tokenUsage = (am.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
      if (tokenUsage) {
        const recent = (tokenUsage.input_tokens ?? 0)
          + (tokenUsage.cache_read_input_tokens ?? 0)
          + (tokenUsage.cache_creation_input_tokens ?? 0);
        if (Number.isFinite(recent) && recent > 0) {
          mostRecentUsageTokens = recent;
        }
      }
      // SDK content blocks include text, tool_use, and (when extended-thinking
      // is enabled) thinking. We tap each kind into the Event store.
      const blocks = (am.message?.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string; thinking?: string }>;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (isSdkContextDiagnosticText(block.text)) {
            logger.warn({
              sessionKey: opts.sessionKey,
              source,
              subtype,
              preview: block.text.slice(0, 240),
            }, 'runAgent: suppressed SDK context diagnostic text');
            continue;
          }
          finalText += block.text;
          // PRD Phase 4a / 1.18.85: llm_text Event. Truncate at 8KB to keep
          // the JSONL light — full text is reachable via the SDK transcript.
          writeEvent({
            kind: 'llm_text',
            ts: new Date().toISOString(),
            sessionId,
            text: block.text.slice(0, 8000),
          });
          if (opts.onText) {
            try { await opts.onText(block.text); } catch { /* streaming is best-effort */ }
          }
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          // Extended-thinking block — captured separately so the Run detail
          // page can render thinking distinctly from final text.
          writeEvent({
            kind: 'thinking',
            ts: new Date().toISOString(),
            sessionId,
            thinking: block.thinking.slice(0, 8000),
          });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          // PRD Phase 4a: tool_call Event. The tool_use id pairs with the
          // tool_result Event written when the SDK reports back. Inputs
          // truncated at 8KB; the dashboard can fetch the full transcript
          // if a deeper drill-down is needed.
          writeEvent({
            kind: 'tool_call',
            ts: new Date().toISOString(),
            sessionId,
            toolName: block.name,
            toolUseId: block.id,
            toolInput: truncateForLog(block.input ?? {}, 8000),
          });
          if (opts.onToolActivity) {
            try {
              await opts.onToolActivity({ tool: block.name, input: block.input ?? {} });
            } catch { /* best-effort */ }
          }
        }
      }
      continue;
    }
    // SDK user messages carry tool_result blocks back from tool execution.
    // We pair them with the earlier tool_call Event via toolUseId so the
    // Run detail waterfall renders call → result side by side.
    if ((message as { type?: string }).type === 'user') {
      const um = message as { message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } };
      const blocks = um.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          writeEvent({
            kind: 'tool_result',
            ts: new Date().toISOString(),
            sessionId,
            toolUseId: block.tool_use_id,
            toolResult: truncateForLog(block.content, 16000),
            ...(block.is_error ? { toolError: 'tool reported is_error' } : {}),
          });
        }
      }
      continue;
    }

    if (message.type === 'result') {
      const result = message as SDKResultMessage;
      sessionId = sessionId || (result.session_id ?? '');
      subtype = result.subtype ?? 'unknown';
      terminalReason = (result as { terminal_reason?: TerminalReason }).terminal_reason;
      numTurns = (result as { num_turns?: number }).num_turns ?? numTurns;
      totalCostUsd = (result as { total_cost_usd?: number }).total_cost_usd ?? 0;
      const u = (result as { usage?: RunAgentResult['usage'] }).usage;
      if (u) usage = u;

      if (subtype === 'success') {
        // success carries `result` field with the final text.
        const r = (result as { result?: string }).result;
        if (r) finalText = r;
      }

      // PRD Phase 4a / 1.18.85: session_end Event — closes the run in the
      // event store and stamps the cost + stop reason for the Run detail page.
      writeEvent({
        kind: 'session_end',
        ts: new Date().toISOString(),
        sessionId,
        costUsd: totalCostUsd,
        stopReason: terminalReason && terminalReason !== 'completed' ? `${subtype}:${terminalReason}` : subtype,
      });
      // PRD Phase 4d / 1.18.101: unregister from the hook-session registry.
      // Late-arriving hook events for this sessionId silently drop after this.
      try {
        const { unregisterRunSession } = await import('./hook-session-registry.js');
        unregisterRunSession(sessionId);
      } catch { /* non-fatal */ }

      // Mirror cost to usage_log. Same shape as the existing
      // logQueryResult, but standalone so we don't depend on
      // PersonalAssistant's instance state.
      const modelUsage = (result as { modelUsage?: Record<string, {
        inputTokens: number; outputTokens: number;
        cacheReadInputTokens: number; cacheCreationInputTokens: number;
      }> }).modelUsage;
      if (opts.memoryStore && modelUsage) {
        try {
          opts.memoryStore.logUsage({
            sessionKey: `${source}:${opts.sessionKey}`,
            source: `runagent.${source}`,
            modelUsage,
            numTurns,
            durationMs: Date.now() - startedAt,
            agentSlug: opts.profile?.slug,
            totalCostUsd: totalCostUsd,
          });
        } catch (err) {
          logger.debug({ err }, 'runAgent: usage logging failed (non-fatal)');
        }
      }
      continue;
    }
    // Other message types (UserMessage with tool_result, StreamEvent,
    // SDKCompactBoundaryMessage) — observed but not acted on. The SDK
    // handles compaction internally; we just let it run.
  }
  } catch (err) {
    // PRD Phase 4a / 1.18.85: error Event closes the run if the SDK throws.
    // Lets the Run detail page render an explicit failure span instead of a
    // run that just trails off after the last successful tool_call.
    const errMsg = String((err as Error)?.message ?? err).slice(0, 1000);
    writeEvent({
      kind: 'error',
      ts: new Date().toISOString(),
      sessionId,
      toolError: errMsg,
    });
    // PRD Phase 4d / 1.18.101: also clear path B registry on error path so
    // the map doesn't leak entries when runs fail before session_end fires.
    try {
      const { unregisterRunSession } = await import('./hook-session-registry.js');
      if (sessionId) unregisterRunSession(sessionId);
    } catch { /* non-fatal */ }
    // Translate the SDK's budget-exhaustion throw into a message that
    // tells the user (a) what cap tripped and (b) how to raise it.
    // The raw SDK string ("Claude Code returned an error result:
    // Reached maximum budget ($0.5)") leaks through the channel layer
    // as a generic "Something went wrong:" with no actionable hint.
    if (/Reached maximum budget|error_max_budget_usd/i.test(errMsg)) {
      const cap = maxBudgetUsd?.toFixed(2) ?? '?';
      const envKey = `BUDGET_${source.toUpperCase().replace(/-/g, '_')}_USD`;
      throw new Error(
        `Hit the $${cap} ${source} budget cap before finishing. ` +
        `Raise it in the dashboard (Budgets & Costs) or set ${envKey}=0 to remove caps.`,
      );
    }
    throw err;
  }

  logger.info({
    sessionKey: opts.sessionKey,
    source,
    sdkSessionId: sessionId,
    subtype,
    numTurns,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    durationMs: Date.now() - startedAt,
    finalTextChars: finalText.length,
    // 1.18.169 — tool-output guard summary, surfaced for observability.
    // Non-zero `compressed` means the guard kept the SDK from thrashing.
    guard: guard.stats.inspected > 0 ? {
      inspected: guard.stats.inspected,
      compressed: guard.stats.compressed,
      bytesShed: guard.stats.bytesShed,
      compactions: guard.stats.compactions,
      ceilingHits: guard.stats.ceilingHits,
    } : undefined,
    // 1.18.173 — tool-call dedup summary. Non-zero warned/blocked means
    // the model tried to re-fetch identical data (typically a
    // post-compaction refetch loop).
    dedup: dedup.stats.inspected > 0 ? {
      inspected: dedup.stats.inspected,
      warned: dedup.stats.warned,
      blocked: dedup.stats.blocked,
    } : undefined,
  }, 'runAgent: query complete');

  // PRD §6 Phase 4e: subagent transcript backfill (Path C). The SDK persists
  // every subagent's full message stream to ~/.claude/projects/<encoded-cwd>/
  // <sessionId>/subagents/agent-*.jsonl. Path A only sees the parent's Task
  // tool_use, so subagent-internal LLM/tool calls are invisible without this.
  // Best-effort — telemetry must never block the run from returning.
  try {
    const { backfillSubagentEvents } = await import('./subagent-backfill.js');
    const projectCwd = sdkOptionsRaw.cwd || BASE_DIR;
    const backfillResult = await backfillSubagentEvents({
      runId,
      sessionId,
      cwd: projectCwd,
      eventLog,
      startSeq: eventSeq,
    });
    eventSeq += backfillResult.backfilled;
    if (backfillResult.backfilled > 0) {
      logger.info({
        runId,
        sessionId,
        backfilled: backfillResult.backfilled,
        agents: backfillResult.agents,
      }, 'runAgent: subagent backfill (Path C) complete');
    }
  } catch (err) {
    logger.debug({ err }, 'runAgent: subagent backfill failed (non-fatal)');
  }

  return {
    text: finalText,
    totalCostUsd,
    numTurns,
    sessionId,
    subtype,
    ...(terminalReason ? { terminalReason } : {}),
    ...(usage ? { usage } : {}),
    runId,
    permissionMode: toolPolicy.permissionMode,
    allowedToolsApplied: sdkAllowedTools,
    builtinToolsApplied: toolPolicy.builtinTools,
    mcpServersApplied: Object.keys(mcpServers),
  };
}
