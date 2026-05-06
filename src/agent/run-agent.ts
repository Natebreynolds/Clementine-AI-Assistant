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

const DEFAULT_BUDGETS: Record<string, number> = {
  chat: 0.50,
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
  const maxBudgetUsd = opts.maxBudgetUsd ?? DEFAULT_BUDGETS[source] ?? 0.50;
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

  // Compose system prompt. When a hired-agent profile is active, that
  // becomes the main agent's identity — append to the claude_code preset.
  const profileAppend = opts.profile?.systemPromptBody
    ? opts.profile.systemPromptBody
    : undefined;

  // Allowed tools. Default to core + Clementine MCP. Per-subagent tool
  // restrictions live on each AgentDefinition.tools field.
  const allowedTools = opts.allowedTools ?? CORE_TOOLS_FOR_AGENT_PARENT;

  // Wire the Clementine MCP server so the agent can reach memory/cron/
  // broken-job tools. Without this, the cron-fixer subagent's `tools`
  // list references mcp__clementine-tools__* that don't exist in the
  // session, and the agent falls back to reading raw JSON files.
  const subprocessEnv = buildRunAgentEnv();
  const mcpServers: Record<string, {
    type: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
  }> = {
    [TOOLS_SERVER]: {
      type: 'stdio',
      command: 'node',
      args: [MCP_SERVER_SCRIPT],
      env: {
        ...subprocessEnv,
        CLEMENTINE_HOME: BASE_DIR,
        ...(opts.profile?.slug ? { CLEMENTINE_TEAM_AGENT: opts.profile.slug } : {}),
        CLEMENTINE_INTERACTION_SOURCE: source === 'cron' || source === 'heartbeat' ? 'autonomous' : 'interactive',
      },
    },
  };

  // Apply 1M-context env normalization (existing infra)
  const sdkOptionsRaw = {
    systemPrompt: profileAppend
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: profileAppend }
      : { type: 'preset' as const, preset: 'claude_code' as const },
    settingSources: opts.settingSources ?? ['project'] as ('project' | 'user' | 'local')[],
    agents,
    mcpServers,
    allowedTools,
    permissionMode: 'bypassPermissions' as const,
    cwd: BASE_DIR,
    env: subprocessEnv,
    maxBudgetUsd,
    effort,
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    ...(opts.abortSignal ? { abortController: { signal: opts.abortSignal } as AbortController } : {}),
  };

  const sdkOptions = normalizeClaudeSdkOptionsForOneMillionContext(sdkOptionsRaw);

  logger.info({
    sessionKey: opts.sessionKey,
    source,
    profile: opts.profile?.slug,
    forceSubagent: opts.forceSubagent,
    effort,
    maxBudgetUsd,
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

  for await (const message of stream) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = (message as { session_id?: string }).session_id ?? '';
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
