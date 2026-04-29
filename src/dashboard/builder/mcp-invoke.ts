/**
 * MCP invoke handler for the Builder runner.
 *
 * Spawns and pools MCP clients keyed by server name, then routes
 * `runner.executeMcpStep` calls through `client.callTool(...)`.
 *
 * Designed to be wired into the daemon at startup via
 * `runner.registerMcpInvokeHandler(...)`. When this module is loaded
 * but the registration call hasn't happened yet, the runner falls back
 * to its mock-stub behavior.
 *
 * Pooling is per-process: each server gets one stdio client that lives
 * until the daemon shuts down. Idle clients are torn down after
 * IDLE_TIMEOUT_MS to free resources, then re-spawned on demand.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { discoverMcpServers } from '../../agent/mcp-bridge.js';
import { logger } from '../../tools/shared.js';
import { registerMcpInvokeHandler, type McpInvokeFn } from './runner.js';

const PER_CALL_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

interface PooledClient {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  lastUsedAt: number;
  closing: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, PooledClient>();

async function getOrSpawnClient(name: string): Promise<PooledClient | null> {
  const existing = pool.get(name);
  if (existing && !existing.closing) {
    existing.lastUsedAt = Date.now();
    rescheduleIdleTimer(existing);
    return existing;
  }

  const servers = discoverMcpServers();
  const cfg = servers.find(s => s.name === name);
  if (!cfg || !cfg.enabled) return null;
  if (cfg.type !== 'stdio' || !cfg.command) {
    // HTTP/SSE servers aren't pooled here — fall back to mock for now.
    return null;
  }

  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;
  try {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      stderr: 'ignore',
    });
    client = new Client(
      { name: 'clementine-builder-runner', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  } catch (err) {
    logger.warn({ err, server: name }, 'Builder MCP client spawn failed');
    try { await client?.close(); } catch { /* */ }
    try { await transport?.close(); } catch { /* */ }
    return null;
  }

  const pooled: PooledClient = {
    name,
    client,
    transport,
    lastUsedAt: Date.now(),
    closing: false,
  };
  rescheduleIdleTimer(pooled);
  pool.set(name, pooled);
  return pooled;
}

function rescheduleIdleTimer(p: PooledClient): void {
  if (p.idleTimer) clearTimeout(p.idleTimer);
  p.idleTimer = setTimeout(() => { void closeClient(p.name); }, IDLE_TIMEOUT_MS);
}

async function closeClient(name: string): Promise<void> {
  const p = pool.get(name);
  if (!p) return;
  p.closing = true;
  pool.delete(name);
  if (p.idleTimer) clearTimeout(p.idleTimer);
  try { await p.client.close(); } catch { /* */ }
  try { await p.transport.close(); } catch { /* */ }
}

const handler: McpInvokeFn = async ({ server, tool, inputs, signal }) => {
  if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  const pooled = await getOrSpawnClient(server);
  if (!pooled) {
    return {
      _builderMock: true,
      reason: `MCP server "${server}" not available (not configured, disabled, or non-stdio transport).`,
    };
  }

  const work = pooled.client.callTool({ name: tool, arguments: inputs });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error(`MCP tool ${server}.${tool} timed out`), { name: 'TimeoutError' })), PER_CALL_TIMEOUT_MS));
  const onAbort = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true }));

  try {
    const result = await Promise.race([work, timeout, onAbort]);
    pooled.lastUsedAt = Date.now();
    rescheduleIdleTimer(pooled);
    return result;
  } catch (err) {
    // If the connection died, drop it from the pool so the next call respawns.
    const e = err as { code?: string; message?: string };
    if (e.code === 'ERR_PIPE_CLOSED' || /closed|killed|EPIPE/.test(e.message ?? '')) {
      void closeClient(server);
    }
    throw err;
  }
};

let _registered = false;

/**
 * Wire the handler into the runner. Idempotent — safe to call from any
 * daemon entry path.
 */
export function installBuilderMcpHandler(): void {
  if (_registered) return;
  registerMcpInvokeHandler(handler);
  _registered = true;
  logger.info({}, 'Builder MCP invoke handler installed');
}

/**
 * Tear down all pooled clients. Called from daemon graceful shutdown.
 */
export async function shutdownBuilderMcpHandler(): Promise<void> {
  const names = [...pool.keys()];
  await Promise.all(names.map(n => closeClient(n)));
}
