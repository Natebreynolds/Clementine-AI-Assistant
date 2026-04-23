/**
 * Per-server MCP schema fetcher.
 *
 * Spawns each discovered stdio MCP server, issues `initialize` + `tools/list`,
 * captures the full inputSchema per tool, and writes everything to
 * `~/.clementine/.tool-schemas.json`. Per-server 10s timeout so one flaky
 * server doesn't block the rest.
 *
 * Why per-server instead of one big SDK probe: the SDK's init message only
 * returns tool name strings, not schemas. And the SDK probe is flaky under
 * concurrent MCP server spawn — iMessage routinely missed the init window.
 * Direct per-server probes are deterministic and give us canonical schemas.
 *
 * This is the ground-truth source for auto-skill synthesis downstream.
 */

import path from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { BASE_DIR } from '../config.js';
import { logger } from '../tools/shared.js';
import { discoverMcpServers } from './mcp-bridge.js';

const SCHEMAS_FILE = path.join(BASE_DIR, '.tool-schemas.json');
const PER_SERVER_TIMEOUT_MS = 10_000;

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ServerSchemas {
  /** How the server was spawned — for regenerate-on-change detection */
  command?: string;
  args?: string[];
  /** ISO timestamp of last successful fetch */
  fetchedAt: string;
  /** Tools the server declared */
  tools: ToolSchema[];
  /** Set when the probe failed; diagnostic only */
  error?: string;
}

export interface AllSchemas {
  fetchedAt: string;
  servers: Record<string, ServerSchemas>;
}

/** Load cached schemas from disk, or null if not yet fetched. */
export function loadSchemas(): AllSchemas | null {
  try {
    if (!existsSync(SCHEMAS_FILE)) return null;
    return JSON.parse(readFileSync(SCHEMAS_FILE, 'utf-8')) as AllSchemas;
  } catch { return null; }
}

function saveSchemas(s: AllSchemas): void {
  try { writeFileSync(SCHEMAS_FILE, JSON.stringify(s, null, 2)); }
  catch (err) { logger.warn({ err }, 'Failed to persist .tool-schemas.json'); }
}

/** Fetch schemas from a single stdio server. Returns null if it failed/timed out. */
async function fetchOneServer(name: string, command: string, args: string[], env: Record<string, string>): Promise<ServerSchemas | null> {
  const started = Date.now();
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  try {
    transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: 'ignore',
    });
    client = new Client(
      { name: 'clementine-schema-probe', version: '1.0.0' },
      { capabilities: {} },
    );

    // Race the connect+list against a timeout. stdio servers that hang or
    // crash on startup shouldn't block the whole discovery pass.
    const work = (async () => {
      await client!.connect(transport!);
      const listed = await client!.listTools();
      return listed.tools;
    })();
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${PER_SERVER_TIMEOUT_MS}ms`)), PER_SERVER_TIMEOUT_MS),
    );
    const tools = await Promise.race([work, timeout]);

    logger.debug({ server: name, toolCount: tools.length, ms: Date.now() - started }, 'Fetched MCP schemas');
    return {
      command,
      args,
      fetchedAt: new Date().toISOString(),
      tools: tools.map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.debug({ server: name, err: errMsg, ms: Date.now() - started }, 'MCP schema fetch failed');
    return {
      command,
      args,
      fetchedAt: new Date().toISOString(),
      tools: [],
      error: errMsg,
    };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
  }
}

/**
 * Fetch schemas from every discovered stdio server in parallel.
 * Merges with any existing cache — servers that errored this round keep
 * their last successful schemas (fail-soft).
 */
export async function fetchAllSchemas(): Promise<AllSchemas> {
  const existing = loadSchemas();
  const result: AllSchemas = {
    fetchedAt: new Date().toISOString(),
    servers: { ...(existing?.servers ?? {}) },
  };

  const servers = discoverMcpServers().filter(s => s.enabled && s.type === 'stdio' && s.command);
  if (servers.length === 0) {
    saveSchemas(result);
    return result;
  }

  const fetches = servers.map(async (s) => {
    const fetched = await fetchOneServer(s.name, s.command!, s.args ?? [], s.env ?? {});
    return { name: s.name, fetched };
  });
  const settled = await Promise.allSettled(fetches);

  let ok = 0, failed = 0;
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value.fetched) { failed++; continue; }
    const { name, fetched } = r.value;
    // Only overwrite on success — preserve last-good schemas on transient failure.
    if (fetched.tools.length > 0 || !result.servers[name]) {
      result.servers[name] = fetched;
    }
    if (fetched.error) failed++; else ok++;
  }

  logger.info({ ok, failed, total: servers.length }, 'MCP schema fetch pass complete');
  saveSchemas(result);
  return result;
}

/** Flat list of every tool with its schema and originating server. */
export function flattenSchemas(all: AllSchemas): Array<{ server: string; tool: ToolSchema }> {
  const out: Array<{ server: string; tool: ToolSchema }> = [];
  for (const [server, s] of Object.entries(all.servers)) {
    for (const tool of s.tools) out.push({ server, tool });
  }
  return out;
}
