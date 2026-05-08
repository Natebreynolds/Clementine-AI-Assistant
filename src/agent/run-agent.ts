/**
 * Clementine TypeScript — runAgent: canonical Claude Agent SDK wrapper.
 *
 * Phase 1 of the SDK-canonical migration (see
 * /Users/nathan.reynolds/.claude/plans/sdk-canonical-migration.md).
 *
 * This is the new code path that will eventually replace runCronJob /
 * runUnleashedTask / runHeartbeat / runTeamTask / chat. For now it
 * runs in PARALLEL with those — only the dashboard's
 * /api/runagent/test endpoint exercises it. Production traffic still
 * uses legacy paths until Phase 2.
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
import { query, type AgentDefinition, type SDKAssistantMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';

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
} from '../config.js';
import type { AgentProfile } from '../types.js';
import type { AgentManager } from './agent-manager.js';
import type { MemoryStore } from '../memory/store.js';
import { buildAgentMap } from './agent-definitions.js';

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

  /** Optional CLAUDE.md / project setting source. Defaults to ['project']. */
  settingSources?: ('project' | 'user' | 'local')[];

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

  /** Token usage breakdown (input, output, cache). */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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

  // Build the AgentDefinition map. Caller can override; otherwise we
  // use the standard system subagents + hired-agent profiles.
  const agents = opts.agents ?? buildAgentMap({
    profileManager: opts.agentManager ?? undefined,
    isAutonomous: source === 'cron' || source === 'heartbeat',
    activeAgentSlug: opts.profile?.slug,
  });

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
        CLEMENTINE_INTERACTION_SOURCE: source === 'cron' || source === 'heartbeat' ? 'autonomous' : 'interactive',
      },
    },
    ...(opts.extraMcpServers ?? {}),
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

  // Apply 1M-context env normalization (existing infra)
  const sdkOptionsRaw = {
    systemPrompt: profileAppend
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: profileAppend }
      : { type: 'preset' as const, preset: 'claude_code' as const },
    settingSources: opts.settingSources ?? ['project'] as ('project' | 'user' | 'local')[],
    agents,
    // SDK's McpServerConfig is a union; cast at the boundary since
    // callers can mix stdio + http + sse server shapes.
    mcpServers: mcpServers as unknown as Parameters<typeof query>[0]['options'] extends infer O
      ? O extends { mcpServers?: infer M } ? M : never : never,
    allowedTools,
    permissionMode: 'bypassPermissions' as const,
    // SDK spec requires this companion flag whenever permissionMode is
    // 'bypassPermissions'. Without it, autonomous runs can silently
    // hang waiting for permission prompts.
    allowDangerouslySkipPermissions: true,
    cwd: BASE_DIR,
    env: subprocessEnv,
    effort,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    ...(sdkAbortController ? { abortController: sdkAbortController } : {}),
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
  }, 'runAgent: starting query');

  let finalText = '';
  let sessionId = '';
  let totalCostUsd = 0;
  let numTurns = 0;
  let subtype = 'unknown';
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
      logger.debug({ sessionKey: opts.sessionKey, sdkSessionId: sessionId }, 'runAgent: SDK session initialized');
      continue;
    }

    if (message.type === 'assistant') {
      const am = message as SDKAssistantMessage;
      const blocks = (am.message?.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          finalText += block.text;
          if (opts.onText) {
            try { await opts.onText(block.text); } catch { /* streaming is best-effort */ }
          }
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          if (opts.onToolActivity) {
            try {
              await opts.onToolActivity({ tool: block.name, input: block.input ?? {} });
            } catch { /* best-effort */ }
          }
        }
      }
      continue;
    }

    if (message.type === 'result') {
      const result = message as SDKResultMessage;
      sessionId = sessionId || (result.session_id ?? '');
      subtype = result.subtype ?? 'unknown';
      numTurns = (result as { num_turns?: number }).num_turns ?? numTurns;
      totalCostUsd = (result as { total_cost_usd?: number }).total_cost_usd ?? 0;
      const u = (result as { usage?: RunAgentResult['usage'] }).usage;
      if (u) usage = u;

      if (subtype === 'success') {
        // success carries `result` field with the final text.
        const r = (result as { result?: string }).result;
        if (r) finalText = r;
      }

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
    // Translate the SDK's budget-exhaustion throw into a message that
    // tells the user (a) what cap tripped and (b) how to raise it.
    // The raw SDK string ("Claude Code returned an error result:
    // Reached maximum budget ($0.5)") leaks through the channel layer
    // as a generic "Something went wrong:" with no actionable hint.
    const msg = String((err as Error)?.message ?? err);
    if (/Reached maximum budget|error_max_budget_usd/i.test(msg)) {
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
  }, 'runAgent: query complete');

  return {
    text: finalText,
    totalCostUsd,
    numTurns,
    sessionId,
    subtype,
    ...(usage ? { usage } : {}),
  };
}
