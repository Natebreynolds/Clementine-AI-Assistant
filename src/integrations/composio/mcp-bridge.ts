/**
 * Composio MCP bridge — converts Composio toolkits into in-process SDK MCP
 * servers that the Claude Agent SDK's `query()` can spawn directly.
 *
 * Why per-toolkit servers (instead of one big "composio" server)?
 *   - Per-agent scoping. A scheduler-bot doesn't need GitHub tools; spawning
 *     a Calendar-only sub-agent shouldn't drag in 200 tools across 20
 *     toolkits.
 *   - Tool-name namespacing. Each MCP server registers its tools under its
 *     own name, so we get `mcp__gmail__GMAIL_SEND_EMAIL` not
 *     `mcp__composio__GMAIL_SEND_EMAIL` collisions across toolkits.
 *   - Concurrency. Composio's TS provider opens one session per server, so
 *     having one server per toolkit lets unrelated toolkits load in parallel.
 *
 * Returns an empty map when COMPOSIO_API_KEY is unset, so the agent path
 * always works — Composio is purely additive.
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import {
  getComposio,
  getPreferredUserId,
  listConnectedToolkits,
} from './client.js';

const logger = pino({ name: 'clementine.composio.mcp' });

/**
 * Build SDK MCP server configs for the given toolkit slugs (or all active
 * connected toolkits when omitted). Each toolkit becomes one MCP server.
 */
export async function buildComposioMcpServers(
  slugs?: string[],
): Promise<Record<string, McpSdkServerConfigWithInstance>> {
  const composio = getComposio();
  if (!composio) return {};

  const connected = await listConnectedToolkits();
  const activeSlugs = new Set(
    connected.filter(c => c.status === 'ACTIVE').map(c => c.slug),
  );

  const targetSlugs = slugs === undefined
    ? [...activeSlugs]
    : slugs.filter(s => activeSlugs.has(s));

  if (targetSlugs.length === 0) return {};

  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  // Build serially to avoid hammering Composio with parallel session opens
  // on every agent query. Sessions are cached upstream by Composio's SDK,
  // so repeat calls within a process are cheap after the first hit.
  for (const slug of targetSlugs) {
    try {
      out[slug] = await buildOne(composio, slug, connected);
    } catch (err) {
      logger.warn({ err, slug }, 'failed to build Composio MCP server — skipping');
    }
  }
  return out;
}

export async function listComposioToolkitTools(
  slugs?: string[],
): Promise<Record<string, string[]>> {
  const composio = getComposio();
  if (!composio) return {};

  const connected = await listConnectedToolkits();
  const activeSlugs = new Set(
    connected.filter(c => c.status === 'ACTIVE').map(c => c.slug),
  );

  const targetSlugs = slugs === undefined
    ? [...activeSlugs]
    : slugs.filter(s => activeSlugs.has(s));

  const out: Record<string, string[]> = {};
  for (const slug of targetSlugs) {
    try {
      const tools = await fetchToolkitTools(composio, slug);
      out[slug] = tools.map((t: any) => t.name).filter((name: unknown): name is string => typeof name === 'string');
    } catch (err) {
      logger.warn({ err, slug }, 'failed to list Composio toolkit tools');
    }
  }
  return out;
}

async function buildOne(
  composio: NonNullable<ReturnType<typeof getComposio>>,
  slug: string,
  _connected: Awaited<ReturnType<typeof listConnectedToolkits>>,
): Promise<McpSdkServerConfigWithInstance> {
  // composio.tools.get() returns the FLAT toolkit tools (OUTLOOK_LIST_MESSAGES,
  // GMAIL_SEND_EMAIL, …) — exactly the namespacing the agent expects as
  // mcp__outlook__OUTLOOK_LIST_MESSAGES. The alternative, composio.create()
  // + session.tools(), uses Composio's tool-router pattern and only returns
  // 5 meta-tools (COMPOSIO_SEARCH_TOOLS, COMPOSIO_MULTI_EXECUTE_TOOL, …),
  // which doesn't match what the agent calls.
  //
  // Limit MUST be high enough to include every alphabetically-late tool.
  // Outlook has ~400+ tools; capping at 200 silently dropped the message-
  // reading tools (OUTLOOK_LIST_MESSAGES, OUTLOOK_GET_MESSAGES, etc.) which
  // alphabetically come after OUTLOOK_LIST_CALENDAR_GROUP_*. GitHub has
  // 800+. Set 1000 — comfortable headroom for any single toolkit.
  const tools = await fetchToolkitTools(composio, slug);
  return createSdkMcpServer({
    name: slug,
    version: '0.1.0',
    tools: tools as any,
  });
}

async function fetchToolkitTools(
  composio: NonNullable<ReturnType<typeof getComposio>>,
  slug: string,
): Promise<any[]> {
  const userId = await getPreferredUserId();
  const toolsRaw = await composio.tools.get(userId, { toolkits: [slug], limit: 1000 });
  // tools.get can return an array OR an object depending on provider; normalise.
  const toolsArr = Array.isArray(toolsRaw) ? toolsRaw : Object.values(toolsRaw);
  return toolsArr.filter((t: any) => t && typeof t.name === 'string' && typeof t.handler === 'function');
}
