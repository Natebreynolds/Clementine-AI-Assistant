/**
 * Clementine TypeScript — MCP Server Bridge.
 *
 * Discovers external MCP servers from Claude Desktop config, Claude Code
 * settings, and user-managed config. Merges them into the SDK mcpServers
 * option alongside Clementine's own MCP server.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ManagedMcpServer } from '../types.js';

const MCP_SERVERS_FILE = path.join(BASE_DIR, 'mcp-servers.json');
const CACHE_TTL_MS = 60_000; // 60s cache

// ── Known server descriptions ───────────────────────────────────────

const KNOWN_DESCRIPTIONS: Record<string, string> = {
  slack: 'Slack workspace messaging and channels',
  linear: 'Linear issue tracking and project management',
  notion: 'Notion workspace — pages, databases, search',
  github: 'GitHub repositories, issues, PRs',
  gitlab: 'GitLab repository management',
  supabase: 'Supabase database and auth',
  firecrawl: 'Web crawling and scraping',
  exa: 'Neural web search',
  playwright: 'Browser testing and automation',
  kernel: 'Kernel browser automation',
  context7: 'Library documentation lookup',
  dataforseo: 'SEO data, keyword research, SERP analysis',
  'Bright Data': 'Web scraping and data collection',
  browsermcp: 'Browser automation via MCP',
  ElevenLabs: 'Voice synthesis, text-to-speech, audio AI',
  apify: 'Web scraping actors and automation',
  vapi: 'Voice AI phone calls and assistants',
  greptile: 'Codebase search and understanding',
  terraform: 'Infrastructure as code management',
  discord: 'Discord bot integration',
  imessage: 'iMessage — read and send messages on macOS',
  figma: 'Figma design files — read, inspect, and export',
};

// ── Cache ────────────────────────────────────────────────────────────

let _cachedServers: ManagedMcpServer[] | null = null;
let _cacheExpiry = 0;

function invalidateCache(): void {
  _cachedServers = null;
  _cacheExpiry = 0;
}

// ── Discovery ───────────────────────────────────────────────────────

/** Discover all available MCP servers from Claude Desktop, Claude Code, and user config. */
export function discoverMcpServers(): ManagedMcpServer[] {
  const now = Date.now();
  if (_cachedServers && now < _cacheExpiry) return _cachedServers;

  const servers = new Map<string, ManagedMcpServer>();

  // 1. Claude Desktop config
  const desktopConfig = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  try {
    if (existsSync(desktopConfig)) {
      const data = JSON.parse(readFileSync(desktopConfig, 'utf-8'));
      for (const [name, config] of Object.entries(data.mcpServers ?? {})) {
        const cfg = config as any;
        servers.set(name, {
          name,
          type: cfg.type || 'stdio',
          command: cfg.command,
          args: cfg.args,
          url: cfg.url,
          headers: cfg.headers,
          env: cfg.env,
          description: KNOWN_DESCRIPTIONS[name] ?? `${name} MCP server`,
          enabled: true,
          source: 'auto-detected',
        });
      }
    }
  } catch { /* ignore */ }

  // 2. Claude Code settings — project-level MCP configs
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const settingsFile = path.join(claudeDir, 'settings.json');
    if (existsSync(settingsFile)) {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      // Check mcpServers in settings
      for (const [name, config] of Object.entries(settings.mcpServers ?? {})) {
        if (servers.has(name)) continue;
        const cfg = config as any;
        servers.set(name, {
          name,
          type: cfg.type || 'stdio',
          command: cfg.command,
          args: cfg.args,
          url: cfg.url,
          headers: cfg.headers,
          env: cfg.env,
          description: KNOWN_DESCRIPTIONS[name] ?? `${name} MCP server`,
          enabled: true,
          source: 'auto-detected',
        });
      }
    }
  } catch { /* ignore */ }

  // 3. Claude Desktop Extensions (newer format — ant.dir.* directories)
  try {
    const extensionsDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'Claude Extensions');
    const extensionsSettingsDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'Claude Extensions Settings');
    if (existsSync(extensionsDir) && existsSync(extensionsSettingsDir)) {
      const settingsFiles = readdirSync(extensionsSettingsDir).filter(f => f.endsWith('.json'));
      for (const settingsFile of settingsFiles) {
        try {
          const settings = JSON.parse(readFileSync(path.join(extensionsSettingsDir, settingsFile), 'utf-8'));
          if (!settings.isEnabled) continue;

          const extId = settingsFile.replace('.json', '');
          const extDir = path.join(extensionsDir, extId);
          if (!existsSync(extDir)) continue;

          // Read package.json for name and entry point
          const pkgPath = path.join(extDir, 'package.json');
          if (!existsSync(pkgPath)) continue;
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          const serverEntry = path.join(extDir, pkg.main || 'server/index.js');

          // Derive a friendly name from the extension ID
          // ant.dir.ant.anthropic.imessage → imessage
          // ant.dir.ant.figma.figma → figma
          const parts = extId.split('.');
          const friendlyName = parts[parts.length - 1] || extId;

          if (servers.has(friendlyName)) continue;

          servers.set(friendlyName, {
            name: friendlyName,
            type: 'stdio',
            command: 'node',
            args: [serverEntry],
            description: pkg.description || KNOWN_DESCRIPTIONS[friendlyName] || `${friendlyName} (Claude Extension)`,
            enabled: true,
            source: 'auto-detected',
          });
        } catch { /* skip malformed extension */ }
      }
    }
  } catch { /* ignore */ }

  // 4. User-managed config (overrides auto-detected)
  try {
    if (existsSync(MCP_SERVERS_FILE)) {
      const userServers = JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8')) as Record<string, any>;
      for (const [name, cfg] of Object.entries(userServers)) {
        servers.set(name, {
          name,
          type: cfg.type || 'stdio',
          command: cfg.command,
          args: cfg.args,
          url: cfg.url,
          headers: cfg.headers,
          env: cfg.env,
          description: cfg.description || KNOWN_DESCRIPTIONS[name] || `${name} MCP server`,
          enabled: cfg.enabled !== false,
          source: cfg.source === 'auto-detected' ? 'auto-detected' : 'user',
        });
      }
    }
  } catch { /* ignore */ }

  const result = [...servers.values()];
  _cachedServers = result;
  _cacheExpiry = now + CACHE_TTL_MS;
  return result;
}

/** Get enabled MCP servers as SDK-compatible config, filtered by allowed list. */
export function getMcpServersForAgent(allowedMcpServers?: string[]): Record<string, any> {
  const servers = discoverMcpServers().filter(s => s.enabled);

  // Filter by agent's allowed list (if specified)
  const filtered = allowedMcpServers
    ? servers.filter(s => allowedMcpServers.includes(s.name))
    : servers;

  const result: Record<string, any> = {};
  for (const s of filtered) {
    if (s.type === 'stdio' && s.command) {
      result[s.name] = {
        type: 'stdio',
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
      };
    } else if ((s.type === 'http' || s.type === 'sse') && s.url) {
      result[s.name] = {
        type: s.type,
        url: s.url,
        headers: s.headers ?? {},
      };
    }
  }
  return result;
}

// ── User Config Management ──────────────────────────────────────────

export function loadUserMcpServers(): Record<string, any> {
  try {
    if (existsSync(MCP_SERVERS_FILE)) {
      return JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function saveUserMcpServers(servers: Record<string, any>): void {
  writeFileSync(MCP_SERVERS_FILE, JSON.stringify(servers, null, 2));
  invalidateCache();
}

export function upsertMcpServer(name: string, config: Partial<ManagedMcpServer>): void {
  const servers = loadUserMcpServers();
  servers[name] = { ...servers[name], ...config, source: 'user' };
  saveUserMcpServers(servers);
}

export function removeMcpServer(name: string): void {
  const servers = loadUserMcpServers();
  delete servers[name];
  saveUserMcpServers(servers);
}
