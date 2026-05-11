/**
 * Clementine TypeScript — runAgent heartbeat wrapper.
 *
 * Phase 4 of the SDK-canonical migration (see
 * /Users/nathan.reynolds/.claude/plans/sdk-canonical-migration.md).
 *
 * Heartbeats are tool-free decision-makers. They look at standing
 * instructions, what changed, and the time of day, and decide whether
 * there's anything worth flagging to the owner. Output is plain text;
 * no MCP servers, no Composio toolkits, no subagents.
 *
 * Mirrors the legacy assistant.heartbeat() prompt shape exactly so the
 * voice/dedup behavior stays identical, but routes the actual LLM call
 * through the canonical runAgent() instead of buildOptions+query.
 */
import pino from 'pino';
import {
  OWNER_NAME,
  MODELS,
  BUDGET,
  currentTimeZone,
} from '../config.js';
import { formatDateInTimeZone, formatTimeInTimeZone } from '../lib/time.js';

const OWNER = OWNER_NAME || 'the user';

function formatDate(d: Date): string {
  return formatDateInTimeZone(d, currentTimeZone());
}

function formatTime(d: Date): string {
  return formatTimeInTimeZone(d, currentTimeZone());
}
import type { AgentProfile } from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import { runAgent, type RunAgentResult } from './run-agent.js';

const logger = pino({ name: 'clementine.run-agent-heartbeat' });

export interface RunAgentHeartbeatOptions {
  standingInstructions: string;
  changesSummary?: string;
  timeContext?: string;
  dedupContext?: string;
  profile?: AgentProfile | null;
  memoryStore?: MemoryStore | null;
  abortSignal?: AbortSignal;
  /** Optional model override — defaults to Haiku (cheapest, fastest). */
  model?: string;
  /** Optional budget override — defaults to $0.15 (heartbeats are 1 turn). */
  maxBudgetUsd?: number;
}

/**
 * Run a heartbeat decision via the canonical SDK runAgent path.
 *
 * No tools. No MCP. Single turn. The agent looks at the context
 * blocks, decides, emits text, returns.
 */
export async function runAgentHeartbeat(opts: RunAgentHeartbeatOptions): Promise<RunAgentResult> {
  const now = new Date();
  const localTime = formatTime(now);
  const localDate = formatDate(now);
  const tz = currentTimeZone();
  const owner = OWNER;
  const agentName = opts.profile?.name ?? 'personal assistant';

  const promptParts: string[] = [
    `[Heartbeat — ${localTime}, ${localDate} (${tz})]`,
    `You're ${agentName}, casually checking in with ${owner}. Talk like a teammate — not a system.`,
    `Do NOT call any tools. Everything you need is in the context below. ` +
    `If you notice something that would need a tool to investigate or act on, just mention it conversationally and ask ${owner} if he wants you to look into it.`,
  ];
  if (opts.dedupContext) {
    promptParts.push(`\n${opts.dedupContext}\n\nIf all of the above are unchanged, respond with exactly: __NOTHING__`);
  }
  if (opts.timeContext) {
    promptParts.push(`\nTime of day: ${opts.timeContext}`);
  }
  if (opts.changesSummary) {
    promptParts.push(`\nWhat's new:\n${opts.changesSummary}`);
  }
  promptParts.push(
    `\nIf nothing changed, respond with exactly: __NOTHING__\n` +
    `Otherwise, keep it casual and brief (1-3 sentences). No bullet lists, no formal reports, no repeating info from previous check-ins. ` +
    `Only mention what's genuinely new or worth flagging. Be a person, not a dashboard. ` +
    `Tag topics with [topic: key] for dedup tracking.\n\n` +
    `Standing instructions:\n${opts.standingInstructions}`,
  );

  const prompt = promptParts.join('\n');

  logger.info({
    agentName,
    profile: opts.profile?.slug,
    promptChars: prompt.length,
  }, 'runAgentHeartbeat: dispatching to runAgent (no tools)');

  // Heartbeat cap from config (BUDGET.heartbeat). Sourced from env /
  // clementine.json / dashboard writes. 0 = uncapped — runAgent
  // omits the SDK option in that case.
  const heartbeatBudget: number | undefined =
    opts.maxBudgetUsd ?? (BUDGET.heartbeat > 0 ? BUDGET.heartbeat : undefined);

  const sessionKey = `heartbeat:${opts.profile?.slug ?? 'clementine'}`;
  const result = await runAgent(prompt, {
    sessionKey,
    source: 'heartbeat',
    profile: opts.profile,
    memoryStore: opts.memoryStore,
    model: opts.model ?? MODELS.haiku,
    effort: 'low',
    ...(heartbeatBudget !== undefined ? { maxBudgetUsd: heartbeatBudget } : {}),
    maxTurns: 1,
    // No tools — heartbeats are decision-only. Empty list bypasses the
    // CORE_TOOLS_FOR_AGENT_PARENT default and stops the SDK from
    // exposing any tool schemas, keeping the prompt small.
    allowedTools: [],
    abortSignal: opts.abortSignal,
  });

  // Heartbeat output is NOT mirrored to transcripts. Heartbeats fire
  // up to 28x/day per agent and most output is low-value (status
  // pings, dedup'd reminders). The heartbeat dedup that prior versions
  // wanted recall for actually lives in the prompt itself (the
  // dedupContext block + the __NOTHING__ sentinel), not in DB queries.
  // Saving rows here just polluted FTS and the dashboard memory panel
  // for no recall benefit.

  return result;
}
