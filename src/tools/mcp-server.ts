/**
 * Clementine TypeScript — MCP stdio server entry point.
 *
 * All tool implementations live in separate modules.
 * This file handles server initialization, startup sync, user tools,
 * plugins, and the stdio transport connection.
 *
 * Usage:
 *   npx tsx src/tools/mcp-server.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  BASE_DIR, VAULT_DIR, env, getStore, getStoreSync, logger, textResult, externalResult,
} from './shared.js';

// Re-export for any code that imports from mcp-server.ts directly
export { getStore, textResult, externalResult, incrementalSync, ACTIVE_AGENT_SLUG } from './shared.js';
export type { MemoryStoreType } from './shared.js';

// ── Tool modules ────────────────────────────────────────────────────────
import { registerMemoryTools } from './memory-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { registerExternalTools } from './external-tools.js';
import { registerAdminTools } from './admin-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerSessionTools } from './session-tools.js';

// ── Server ──────────────────────────────────────────────────────────────

const serverName = (env['ASSISTANT_NAME'] ?? 'Clementine').toLowerCase() + '-tools';
const server = new McpServer({ name: serverName, version: '1.0.0' });

// Register all tool groups
registerMemoryTools(server);
registerVaultTools(server);
registerExternalTools(server);
registerAdminTools(server);
registerGoalTools(server);
registerTeamTools(server);
registerSessionTools(server);

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  // Initialize memory store and run full sync on startup
  try {
    const store = await getStore();
    const stats = store.fullSync();
    logger.info(
      { filesScanned: stats.filesScanned, filesUpdated: stats.filesUpdated, chunksTotal: stats.chunksTotal },
      'Startup sync complete',
    );

    const decayed = store.decaySalience();
    const pruned = store.pruneStaleData();
    if (decayed > 0 || pruned.episodicPruned > 0 || pruned.accessLogPruned > 0 || pruned.transcriptsPruned > 0) {
      logger.info({ decayed, ...pruned }, 'Startup maintenance complete');
    }
  } catch (err) {
    logger.warn({ err }, 'Startup sync failed (non-fatal)');
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'MCP server shutting down');
    try { const s = getStoreSync(); if (s && typeof (s as any).close === 'function') (s as any).close(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Auto-register user tool scripts from ~/.clementine/tools/
  const userToolsDir = path.join(BASE_DIR, 'tools');
  if (existsSync(userToolsDir)) {
    for (const file of readdirSync(userToolsDir).filter(f => f.endsWith('.sh') || f.endsWith('.py'))) {
      const toolName = file.replace(/\.(sh|py)$/, '').replace(/[^a-z0-9_]/gi, '_');
      const filePath = path.join(userToolsDir, file);
      const metaPath = filePath + '.meta.json';

      let desc = `Custom tool: ${toolName}`;
      let argsDesc = 'Optional arguments string';
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          desc = meta.description || desc;
          argsDesc = meta.args_description || argsDesc;
        } catch { /* defaults */ }
      } else {
        try {
          const firstLines = readFileSync(filePath, 'utf-8').split('\n').slice(0, 3);
          const commentLine = firstLines.find(l => l.startsWith('#') && !l.startsWith('#!'));
          if (commentLine) desc = commentLine.slice(1).trim();
        } catch { /* default */ }
      }

      try {
        server.tool(toolName, desc, { args: z.string().optional().describe(argsDesc) }, async ({ args }) => {
          const { execSync } = await import('node:child_process');
          try {
            const result = execSync(`"${filePath}" ${args || ''}`, {
              encoding: 'utf-8', timeout: 30000, cwd: BASE_DIR,
              env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
            });
            return textResult(result.trim() || '(no output)');
          } catch (err: any) {
            return textResult(`Tool error: ${err.stderr || err.message || String(err)}`.slice(0, 500));
          }
        });
        logger.info({ tool: toolName, file }, 'Registered user tool');
      } catch (err) {
        logger.warn({ tool: toolName, err }, 'Failed to register user tool');
      }
    }
  }

  // Auto-register plugin modules from ~/.clementine/plugins/
  const pluginsDir = path.join(BASE_DIR, 'plugins');
  if (existsSync(pluginsDir)) {
    for (const file of readdirSync(pluginsDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))) {
      try {
        const plugin = await import(path.join(pluginsDir, file));
        if (typeof plugin.register === 'function') {
          await plugin.register(server, z, { textResult, externalResult, getStore, BASE_DIR, VAULT_DIR, logger });
          logger.info({ plugin: file }, 'Loaded plugin');
        } else {
          logger.warn({ plugin: file }, 'Plugin missing register() export — skipped');
        }
      } catch (err) {
        logger.warn({ err, plugin: file }, 'Failed to load plugin');
      }
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected via stdio');
}

main().catch(err => {
  logger.fatal({ err }, 'MCP server failed to start');
  process.exit(1);
});
