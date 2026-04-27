/**
 * Per-MCP-server circuit breaker.
 *
 * When an MCP server starts returning errors (auth failures, connector
 * timeouts, "no such tool available") repeatedly, agents keep calling it
 * — burning tool turns on something that isn't going to work. This module
 * tracks per-server failure rates with a sliding window and surfaces a
 * tripped state to the existing insight-engine via advisor-events.jsonl
 * (same path the cron-side circuit breaker uses).
 *
 * Trip rule: K failures of class auth_error/other_error within WINDOW_MS
 * trips the breaker for COOLDOWN_MS. Argument errors are agent-fault, not
 * connector-fault, and don't count toward the trip threshold.
 *
 * Auto-reset: COOLDOWN_MS after the trip moment, the breaker clears and
 * the failure window resets. The next failure starts the count fresh.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.mcp-circuit-breaker' });

/** Threshold to trip the breaker. */
const MAX_CONNECTOR_FAILURES = 5;
/** Sliding window for counting failures. */
const WINDOW_MS = 5 * 60 * 1000;       // 5 minutes
/** How long the breaker stays open before auto-resetting. */
const COOLDOWN_MS = 5 * 60 * 1000;     // 5 minutes

const ADVISOR_EVENTS_FILE = path.join(BASE_DIR, 'cron', 'advisor-events.jsonl');

export type ToolResultClass = 'success' | 'arg_error' | 'auth_error' | 'other_error';

interface ServerState {
  /** Timestamps of recent CONNECTOR-class failures (auth_error / other_error). */
  failureTimestamps: number[];
  /** When the breaker tripped, if open. */
  trippedAt?: number;
  /** Plain-language reason for the most recent trip. */
  trippedReason?: string;
}

const state = new Map<string, ServerState>();

/**
 * Extract the MCP server name from a fully-qualified tool name. Handles
 * server names that themselves contain underscores (e.g. `claude_ai_Gmail`)
 * by treating only the FINAL `__` separator as the server/tool boundary.
 *
 *   mcp__clementine-tools__memory_search        → "clementine-tools"
 *   mcp__claude_ai_Gmail__authenticate          → "claude_ai_Gmail"
 *   mcp__ElevenLabs__text_to_speech             → "ElevenLabs"
 *   mcp__plugin_x_y__do_thing                   → "plugin_x_y"
 *
 * Returns null for non-MCP tools (Bash, Read, etc.).
 */
export function extractServerName(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const lastSep = rest.lastIndexOf('__');
  if (lastSep <= 0) return null;
  return rest.slice(0, lastSep);
}

function getServerState(server: string): ServerState {
  let s = state.get(server);
  if (!s) {
    s = { failureTimestamps: [] };
    state.set(server, s);
  }
  return s;
}

/**
 * Record the outcome of a single tool invocation. Only auth_error /
 * other_error count toward the failure window — arg_error is the agent's
 * fault (bad parameters), and success obviously doesn't count.
 */
export function recordToolOutcome(toolName: string, resultClass: ToolResultClass): void {
  const server = extractServerName(toolName);
  if (!server) return; // built-in tool like Bash/Read — not our concern

  const s = getServerState(server);
  const now = Date.now();

  // Auto-reset if the cooldown has expired since the last trip.
  if (s.trippedAt !== undefined && now - s.trippedAt >= COOLDOWN_MS) {
    s.trippedAt = undefined;
    s.trippedReason = undefined;
    s.failureTimestamps = [];
    logger.info({ server }, 'MCP circuit breaker auto-reset after cooldown');
    emitAdvisorEvent({
      type: 'circuit-breaker',
      jobName: `mcp:${server}`,
      detail: 'Connector breaker reset — probing again on next call',
      reset: true,
    });
  }

  if (resultClass === 'success') {
    // Successful call inside the window — clear the failure list so a flap
    // doesn't accumulate forever. Don't auto-reset a tripped breaker on
    // success though; that needs to wait for the cooldown so we don't
    // ping-pong on intermittent failures.
    if (s.trippedAt === undefined) {
      s.failureTimestamps = [];
    }
    return;
  }

  if (resultClass === 'arg_error') {
    // Agent passed bad args — connector itself is fine.
    return;
  }

  // auth_error or other_error — count toward the failure window.
  s.failureTimestamps.push(now);
  // Drop old timestamps outside the window.
  s.failureTimestamps = s.failureTimestamps.filter(t => now - t <= WINDOW_MS);

  if (s.trippedAt === undefined && s.failureTimestamps.length >= MAX_CONNECTOR_FAILURES) {
    s.trippedAt = now;
    s.trippedReason = `${s.failureTimestamps.length} ${resultClass} failure(s) in the last ${Math.round(WINDOW_MS / 60_000)}m`;
    logger.warn({ server, failures: s.failureTimestamps.length, resultClass }, 'MCP circuit breaker tripped');
    emitAdvisorEvent({
      type: 'circuit-breaker',
      jobName: `mcp:${server}`,
      detail: `MCP connector "${server}" tripped — ${s.trippedReason}. Prefer alternatives until cooldown expires (~${Math.round(COOLDOWN_MS / 60_000)}m).`,
    });
  }
}

/** True when the named server is currently in the open (failing) state. */
export function isServerTripped(server: string): boolean {
  const s = state.get(server);
  if (!s || s.trippedAt === undefined) return false;
  if (Date.now() - s.trippedAt >= COOLDOWN_MS) return false;
  return true;
}

/** Get all currently-tripped servers — useful for status display + system-prompt injection. */
export function getTrippedServers(): Array<{ server: string; trippedAt: string; reason: string; cooldownRemainingMs: number }> {
  const now = Date.now();
  const out: Array<{ server: string; trippedAt: string; reason: string; cooldownRemainingMs: number }> = [];
  for (const [server, s] of state) {
    if (s.trippedAt === undefined) continue;
    const remaining = COOLDOWN_MS - (now - s.trippedAt);
    if (remaining <= 0) continue;
    out.push({
      server,
      trippedAt: new Date(s.trippedAt).toISOString(),
      reason: s.trippedReason ?? 'unknown',
      cooldownRemainingMs: remaining,
    });
  }
  return out;
}

/** Manual reset — used by an `mcp circuit reset` admin command (future). */
export function resetServer(server: string): boolean {
  const s = state.get(server);
  if (!s || s.trippedAt === undefined) return false;
  s.trippedAt = undefined;
  s.trippedReason = undefined;
  s.failureTimestamps = [];
  logger.info({ server }, 'MCP circuit breaker manually reset');
  emitAdvisorEvent({
    type: 'circuit-breaker',
    jobName: `mcp:${server}`,
    detail: 'Manually reset',
    reset: true,
  });
  return true;
}

/** Reset every breaker — used by tests. */
export function _resetAll(): void {
  state.clear();
}

function emitAdvisorEvent(evt: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(ADVISOR_EVENTS_FILE), { recursive: true });
    if (!existsSync(path.dirname(ADVISOR_EVENTS_FILE))) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...evt }) + '\n';
    appendFileSync(ADVISOR_EVENTS_FILE, line);
  } catch (err) {
    // Non-fatal — observability event, not load-bearing for the breaker logic.
    logger.debug({ err }, 'Failed to emit advisor event for MCP circuit breaker');
  }
}
