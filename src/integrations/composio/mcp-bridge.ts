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
  clementineUserId,
  getComposio,
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

  const targetSlugs = slugs?.length
    ? slugs.filter(s => activeSlugs.has(s))
    : [...activeSlugs];

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

async function buildOne(
  composio: NonNullable<ReturnType<typeof getComposio>>,
  slug: string,
  connected: Awaited<ReturnType<typeof listConnectedToolkits>>,
): Promise<McpSdkServerConfigWithInstance> {
  // If 2+ active connections for this toolkit, force Composio to require
  // explicit account selection per tool call — otherwise it silently picks
  // the default (newest) account.
  const activeCount = connected.filter(
    c => c.slug === slug && c.status === 'ACTIVE',
  ).length;

  // Look up auth config explicitly. Without this, composio.create() tries to
  // auto-create one and 400s for BYO toolkits (Twitter etc.) that don't have
  // a managed OAuth app available.
  const authConfig = (await composio.authConfigs.list({ toolkit: slug })).items[0];

  const session = await composio.create(clementineUserId(), {
    toolkits: [slug],
    manageConnections: false,
    ...(authConfig ? { authConfigs: { [slug]: authConfig.id } } : {}),
    ...(activeCount >= 2
      ? { multiAccount: { enable: true, requireExplicitSelection: true } }
      : {}),
  });
  const tools = await session.tools();
  return createSdkMcpServer({
    name: slug,
    version: '0.1.0',
    tools,
  });
}
