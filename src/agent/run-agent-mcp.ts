/**
 * Clementine TypeScript — MCP server wiring helper for runAgent.
 *
 * Phase 3 of the SDK-canonical migration (see
 * /Users/nathan.reynolds/.claude/plans/sdk-canonical-migration.md).
 *
 * runAgent always wires the Clementine MCP server. This helper builds
 * the EXTRA MCP servers callers may need (Composio toolkits, external
 * claude.ai integrations, browser-harness, etc.), applying the same
 * service dedup logic from 1.18.34 so we don't load duplicates of the
 * same service from two providers.
 *
 * The legacy assistant.ts:buildOptions path does roughly the same
 * thing for chat/cron — this is the standalone equivalent.
 */

import pino from 'pino';
import { routeToolSurface, applyServiceDedup, type ToolRouteDecision } from './tool-router.js';
import { loadClaudeIntegrations, getMcpServersForAgent } from './mcp-bridge.js';
import { loadToolPreferences, KNOWN_SERVICES } from '../integrations/tool-preferences.js';
import type { AgentProfile } from '../types.js';

const logger = pino({ name: 'clementine.run-agent-mcp' });

export interface BuildExtraMcpOptions {
  /** The text we're routing on (job prompt, user message, etc). Used to pick which
   *  Composio toolkits + external servers are relevant via the existing bundle router. */
  scopeText?: string;
  /** Active agent profile. When set, profile.allowedMcpServers and
   *  profile.allowedComposioToolkits override the bundle router's choices. */
  profile?: AgentProfile | null;
  /** When true, build the FULL surface (no bundle filtering, no dedup).
   *  Used by admin/debug callers; not the cron-path default. */
  fullSurface?: boolean;
}

export interface BuildExtraMcpResult {
  /** Map of additional MCP servers to merge into runAgent's mcpServers. */
  servers: Record<string, Record<string, unknown>>;
  /** Diagnostics: which Composio toolkits / external servers ended up live. */
  composioConnected: string[];
  externalConnected: string[];
  /** Diagnostics: which services were de-duped (we kept Composio over claude.ai etc). */
  droppedClaudeAi: string[];
  droppedComposio: string[];
}

/**
 * Build the extra MCP servers (Composio + external) for a runAgent call.
 *
 * Mirrors the legacy assistant.ts:buildOptions chain but as a standalone
 * function so the runAgent path doesn't depend on PersonalAssistant
 * instance state.
 */
export async function buildExtraMcpForRunAgent(
  opts: BuildExtraMcpOptions = {},
): Promise<BuildExtraMcpResult> {
  const result: BuildExtraMcpResult = {
    servers: {},
    composioConnected: [],
    externalConnected: [],
    droppedClaudeAi: [],
    droppedComposio: [],
  };

  // 1. Route the tool surface based on scope text.
  let route: ToolRouteDecision = opts.fullSurface
    ? {
      bundles: [],
      externalMcpServers: undefined,
      composioToolkits: undefined,
      inheritFullClaudeEnv: true,
      fullSurface: true,
      reason: 'full_surface',
    }
    : routeToolSurface(opts.scopeText ?? '');

  // 2. Build Composio MCP servers, honoring profile allowlist when set.
  let composioMcpServers: Record<string, Record<string, unknown>> = {};
  try {
    const { buildComposioMcpServers } = await import('../integrations/composio/mcp-bridge.js');
    const profileAllowList = (opts.profile as { allowedComposioToolkits?: string[] } | null | undefined)?.allowedComposioToolkits;
    const composioAllow = Array.isArray(profileAllowList)
      ? profileAllowList
      : route.composioToolkits;
    composioMcpServers = await buildComposioMcpServers(composioAllow) as Record<string, Record<string, unknown>>;
  } catch (err) {
    logger.debug({ err }, 'Composio MCP servers unavailable (non-fatal)');
  }

  // 3. Build external MCP servers (claude.ai integrations, etc).
  let externalMcpServers: Record<string, Record<string, unknown>> = {};
  try {
    const profileAllowList = Array.isArray(opts.profile?.allowedMcpServers)
      ? opts.profile?.allowedMcpServers
      : undefined;
    const externalAllow = profileAllowList ?? route.externalMcpServers;
    externalMcpServers = getMcpServersForAgent(externalAllow) as Record<string, Record<string, unknown>>;
  } catch (err) {
    logger.debug({ err }, 'External MCP servers unavailable (non-fatal)');
  }

  // 4. Apply service dedup so Composio outlook + claude.ai Microsoft 365
  //    don't both load (same logic as 1.18.34).
  if (!opts.fullSurface) {
    try {
      const composioConnected = new Set(Object.keys(composioMcpServers));
      const cdIntegrations = loadClaudeIntegrations();
      const claudeDesktopActive = new Set(
        Object.values(cdIntegrations).filter(i => i.connected).map(i => i.name),
      );
      const prefs = loadToolPreferences();
      const dedup = applyServiceDedup(route, {
        composioConnected,
        claudeDesktopActive,
        preferences: prefs.preferences,
        knownServices: KNOWN_SERVICES,
      });
      route = dedup.route;
      result.droppedClaudeAi = dedup.droppedClaudeAi;
      result.droppedComposio = dedup.droppedComposio;
      for (const name of dedup.droppedClaudeAi) delete externalMcpServers[name];
      for (const slug of dedup.droppedComposio) delete composioMcpServers[slug];
    } catch (err) {
      logger.debug({ err }, 'Service dedup failed (non-fatal — using full surface)');
    }
  }

  // 5. Merge into one map.
  result.servers = { ...externalMcpServers, ...composioMcpServers };
  result.composioConnected = Object.keys(composioMcpServers);
  result.externalConnected = Object.keys(externalMcpServers);

  return result;
}
