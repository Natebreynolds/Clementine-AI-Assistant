/**
 * Clementine TypeScript — Agent Heartbeat MCP tools.
 *
 * `wake_agent` lets an agent (typically Clementine, but anyone permitted
 * via `canMessage`) wake another agent's heartbeat right now instead of
 * waiting for their poll cycle. Useful when you've just delegated work
 * and want them to react in seconds, not minutes.
 *
 * Implementation: writes a sentinel file at
 *   ~/.clementine/heartbeat/wake/<slug>.json
 * which AgentHeartbeatManager watches via fs.watch (set up in start()).
 * On detection it consumes the sentinel and calls scheduler.markDue(),
 * which makes the agent due on the next outerTick (≤60s, usually within
 * the WAKE_DEBOUNCE_MS window).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ACTIVE_AGENT_SLUG, AGENTS_DIR, BASE_DIR, logger, textResult } from './shared.js';

const WAKE_DIR = path.join(BASE_DIR, 'heartbeat', 'wake');

function isKnownAgent(slug: string): boolean {
  // A known agent is one with vault/00-System/agents/<slug>/agent.md present.
  return existsSync(path.join(AGENTS_DIR, slug, 'agent.md'));
}

function listKnownAgentSlugs(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  try {
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .filter((d) => existsSync(path.join(AGENTS_DIR, d.name, 'agent.md')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function registerAgentHeartbeatTools(server: McpServer): void {
  server.tool(
    'wake_agent',
    'Wake an agent\'s heartbeat right now instead of waiting for their next poll cycle. Use after delegating urgent work or when an external signal needs immediate attention. The target agent will tick within ~3 seconds (debounced) and decide what to do.',
    {
      slug: z.string().describe('Slug of the agent to wake (e.g., "ross-the-sdr")'),
      reason: z.string().optional().describe('One-line reason for the wake — appears in the agent\'s next tick context'),
    },
    async ({ slug, reason }) => {
      const callerSlug = ACTIVE_AGENT_SLUG || 'clementine';

      if (!slug || typeof slug !== 'string') {
        return textResult('wake_agent: slug is required.');
      }
      if (slug === callerSlug) {
        return textResult(`wake_agent: cannot wake yourself (${slug}). You're already awake.`);
      }
      if (!isKnownAgent(slug)) {
        const known = listKnownAgentSlugs();
        return textResult(
          `wake_agent: unknown agent "${slug}". Known agents: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
        );
      }

      try {
        mkdirSync(WAKE_DIR, { recursive: true });
        const sentinel = {
          targetSlug: slug,
          fromSlug: callerSlug,
          reason: reason ?? '',
          requestedAt: new Date().toISOString(),
        };
        writeFileSync(path.join(WAKE_DIR, `${slug}.json`), JSON.stringify(sentinel, null, 2));
        logger.info({ from: callerSlug, to: slug, reason: reason ?? '' }, 'wake_agent: sentinel written');
        return textResult(
          `Woke ${slug}. They'll tick within ~3 seconds.${reason ? ` (Reason: ${reason})` : ''}`,
        );
      } catch (err) {
        return textResult(`wake_agent: failed to write sentinel — ${String(err).slice(0, 200)}`);
      }
    },
  );
}
