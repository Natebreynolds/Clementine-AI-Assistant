/**
 * Clementine TypeScript — runAgent team-task wrapper.
 *
 * Phase 4 of the SDK-canonical migration (see
 * /Users/nathan.reynolds/.claude/plans/sdk-canonical-migration.md).
 *
 * A "team task" is one hired agent (or Clementine herself) sending a
 * direct message to another agent. The recipient processes it
 * autonomously — same toolset as cron, plus Composio + external MCP.
 *
 * Legacy `assistant.runTeamTask` ran a 10-phase loop with deadlines,
 * stall guards, manual session resume, and a "recovery" phase. The
 * canonical pattern is one runAgent call with a generous budget — the
 * SDK owns the inner loop, compaction, and retry. Phases were a
 * pre-SDK workaround; we don't need them anymore.
 */
import pino from 'pino';
import type { AgentProfile } from '../types.js';
import type { AgentManager } from './agent-manager.js';
import type { MemoryStore } from '../memory/store.js';
import { runAgent, type RunAgentResult } from './run-agent.js';
import { buildExtraMcpForRunAgent } from './run-agent-mcp.js';
import { buildAutonomousMemoryContext } from './run-agent-context.js';

const logger = pino({ name: 'clementine.run-agent-team-task' });

/** Minimal post-task hook interface. The PersonalAssistant implements
 *  this directly; passing it through keeps the wrapper decoupled from
 *  the full assistant graph. */
export interface TeamTaskPostHooks {
  triggerMemoryExtractionPostExchange: (
    userMessage: string,
    assistantResponse: string,
    sessionKey?: string,
    profile?: AgentProfile,
  ) => Promise<void>;
}

export interface RunAgentTeamTaskOptions {
  fromName: string;
  fromSlug: string;
  content: string;
  profile: AgentProfile;
  agentManager?: AgentManager | null;
  memoryStore?: MemoryStore | null;
  abortSignal?: AbortSignal;
  /** Optional model override. Default: SDK default (Sonnet). */
  model?: string;
  /** Optional max-budget override. Default: $1.50 (more than cron because team tasks are
   *  often ad-hoc and may need more research/tool calls). */
  maxBudgetUsd?: number;
  /** Optional max-turns cap. Default: undefined (SDK runs until done, bounded by budget). */
  maxTurns?: number;
  /** Post-task hooks (memory extraction). Pass the PersonalAssistant.
   *  Optional so the helper still works in tests. */
  postTaskHooks?: TeamTaskPostHooks | null;
}

export interface RunAgentTeamTaskResult extends RunAgentResult {
  builtPrompt: string;
  composioConnected: string[];
  externalConnected: string[];
}

export async function runAgentTeamTask(opts: RunAgentTeamTaskOptions): Promise<RunAgentTeamTaskResult> {
  const taskName = `team-msg:${opts.fromSlug}-to-${opts.profile.slug}`;
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');

  // Inject the recipient's own long-term memory so they have context
  // about prior work, preferences, and team relationships before
  // processing the message.
  const memoryContext = buildAutonomousMemoryContext(opts.profile);

  // Match the legacy phase-1 prompt shape so existing agent training
  // (Sasha/Ross/Nora) keeps responding the same way. Phases 2+ are no
  // longer needed — the SDK keeps the conversation in one session.
  const builtPrompt =
    `[TEAM MESSAGE from ${opts.fromName} (${opts.fromSlug}) — ${timestamp}]\n\n` +
    memoryContext +
    `You received a direct message from a teammate. Process it fully and autonomously.\n\n` +
    `MESSAGE:\n${opts.content}\n\n` +
    `IMPORTANT:\n` +
    `- Complete the full task described in the message\n` +
    `- Use all tools available to you — Salesforce, DataForSEO, Discord, etc.\n` +
    `- Post results to Discord channels as instructed\n` +
    `- When finished, output "TASK_COMPLETE:" followed by a brief summary of what you did`;

  const mcp = await buildExtraMcpForRunAgent({
    scopeText: [taskName, opts.content, opts.profile.description, opts.profile.systemPromptBody]
      .filter(Boolean)
      .join('\n\n'),
    profile: opts.profile,
  });

  logger.info({
    taskName,
    fromSlug: opts.fromSlug,
    toSlug: opts.profile.slug,
    composioConnected: mcp.composioConnected,
    externalConnected: mcp.externalConnected,
    droppedClaudeAi: mcp.droppedClaudeAi,
    droppedComposio: mcp.droppedComposio,
    promptChars: builtPrompt.length,
  }, 'runAgentTeamTask: dispatching to runAgent');

  const sessionKey = `team-task:${opts.fromSlug}->${opts.profile.slug}`;
  const result = await runAgent(builtPrompt, {
    sessionKey,
    source: 'team-task',
    profile: opts.profile,
    agentManager: opts.agentManager,
    memoryStore: opts.memoryStore,
    model: opts.model,
    effort: 'medium',
    maxBudgetUsd: opts.maxBudgetUsd ?? 1.50,
    maxTurns: opts.maxTurns,
    abortSignal: opts.abortSignal,
    extraMcpServers: mcp.servers as unknown as Parameters<typeof runAgent>[1]['extraMcpServers'],
  });

  // Mirror the inbound message + outbound response into transcripts so
  // future recall sees who-asked-whom and what got done.
  if (opts.memoryStore) {
    try {
      opts.memoryStore.saveTurn(sessionKey, `team-from:${opts.fromSlug}`, opts.content, '');
      if (result.text?.trim()) {
        opts.memoryStore.saveTurn(sessionKey, `team-to:${opts.profile.slug}`, result.text, opts.model ?? '');
      }
    } catch {
      /* non-fatal */
    }
  }

  // Auto-memory extraction — distill any new facts the recipient
  // learned during the task into their MEMORY.md. Fire-and-forget,
  // scoped to the recipient's profile so writes route to
  // agents/<slug>/MEMORY.md, not the global one.
  if (opts.postTaskHooks && result.text?.trim()) {
    opts.postTaskHooks
      .triggerMemoryExtractionPostExchange(opts.content, result.text, sessionKey, opts.profile)
      .catch(err => logger.debug({ err, fromSlug: opts.fromSlug, toSlug: opts.profile.slug }, 'runAgentTeamTask: memory extraction failed (non-fatal)'));
  }

  return {
    ...result,
    builtPrompt,
    composioConnected: mcp.composioConnected,
    externalConnected: mcp.externalConnected,
  };
}
