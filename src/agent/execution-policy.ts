/**
 * Shared Claude Agent SDK execution policy.
 *
 * The SDK permission model has two separate layers:
 *   - `tools` controls which built-in tools are visible.
 *   - `allowedTools` pre-approves built-ins and MCP tools.
 *
 * Critically, `allowedTools` does not constrain `bypassPermissions`.
 * Headless Clementine runs should therefore default to `dontAsk` and
 * explicitly allow the built-ins/MCP servers they need.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, PKG_DIR } from '../config.js';

export type ExecutionPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export const SDK_BUILTIN_TOOLS = new Set([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Monitor',
  'Read',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]);

export interface BuildExecutionPolicyOptions {
  /** Caller-provided allowedTools. Undefined means use defaults; [] means deny all. */
  requestedTools?: string[];
  /** Built-ins used when requestedTools is undefined. */
  defaultBuiltins: readonly string[];
  /** Names of MCP servers mounted for this query. */
  mcpServerNames: string[];
  /** Clementine's own MCP server name, e.g. "clementine-tools". */
  clementineServerName: string;
  /** Optional override. Defaults to dontAsk for headless auto-execution. */
  permissionMode?: ExecutionPermissionMode;
}

export interface ExecutionToolPolicy {
  permissionMode: ExecutionPermissionMode;
  allowDangerouslySkipPermissions?: true;
  /** SDK `tools` option: visible built-ins only. */
  builtinTools: string[];
  /** SDK `allowedTools` option: built-ins + MCP permissions. */
  allowedTools: string[];
  /** Value for CLEMENTINE_TOOL_ALLOWLIST inside the Clementine MCP subprocess. */
  clementineToolAllowlist: string;
  /** Env vars for the SDK subprocess. */
  env: Record<string, string>;
}

interface NormalizedRequestedTool {
  sdkTool: string;
  clementineTool?: string;
  builtinTool?: string;
  scopedBash?: boolean;
}

let _cachedClementineToolNames: Set<string> | null = null;

function discoverToolNamesInDir(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(ts|js|mjs)$/.test(f));
  } catch {
    return;
  }
  const re = /\.tool\(\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g;
  for (const file of files) {
    let text = '';
    try { text = readFileSync(path.join(dir, file), 'utf-8'); } catch { continue; }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.add(m[1]!);
  }
}

function discoverUserToolNames(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(sh|py)$/.test(f));
  } catch {
    return;
  }
  for (const file of files) {
    const name = file.replace(/\.(sh|py)$/, '').replace(/[^a-z0-9_]/gi, '_');
    if (name) out.add(name);
  }
}

/** Best-effort registry of first-party Clementine MCP tool names. */
export function listClementineMcpToolNames(): Set<string> {
  if (_cachedClementineToolNames) return _cachedClementineToolNames;
  const out = new Set<string>();
  discoverToolNamesInDir(path.join(PKG_DIR, 'src', 'tools'), out);
  discoverToolNamesInDir(path.join(PKG_DIR, 'dist', 'tools'), out);
  discoverUserToolNames(path.join(BASE_DIR, 'tools'), out);
  _cachedClementineToolNames = out;
  return out;
}

function mcpWildcard(serverName: string): string {
  return `mcp__${serverName}__*`;
}

function clementineMcpTool(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function commandExistsOnPath(command: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) return false;
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, command))) return true;
  }
  return false;
}

function normalizeRequestedToolName(
  raw: string,
  clementineServerName: string,
  clementineTools: Set<string>,
): NormalizedRequestedTool {
  const tool = String(raw ?? '').trim();
  if (!tool) return { sdkTool: '' };
  if (/^Bash\(.+\)$/.test(tool)) {
    return { sdkTool: tool, builtinTool: 'Bash', scopedBash: tool !== 'Bash(*)' };
  }
  if (tool.startsWith('mcp__')) {
    const prefix = `mcp__${clementineServerName}__`;
    if (tool === mcpWildcard(clementineServerName)) {
      return { sdkTool: tool, clementineTool: '*' };
    }
    if (tool.startsWith(prefix)) {
      const name = tool.slice(prefix.length);
      if (name && name !== '*') return { sdkTool: tool, clementineTool: name };
    }
    return { sdkTool: tool };
  }
  if (SDK_BUILTIN_TOOLS.has(tool)) return { sdkTool: tool, builtinTool: tool };
  if (clementineTools.has(tool)) {
    return { sdkTool: clementineMcpTool(clementineServerName, tool), clementineTool: tool };
  }
  if (commandExistsOnPath(tool)) {
    return { sdkTool: `Bash(${tool}:*)`, builtinTool: 'Bash', scopedBash: true };
  }
  // Unknown names are preserved for forward compatibility with SDK/plugins.
  return { sdkTool: tool };
}

function applyNormalizedTool(
  normalized: NormalizedRequestedTool,
  builtins: Set<string>,
  allowed: Set<string>,
  clementineAllow: Set<string>,
  opts: { skipBroadBash?: boolean } = {},
): void {
  const { sdkTool, clementineTool, builtinTool } = normalized;
  if (!sdkTool) return;
  if (builtinTool && SDK_BUILTIN_TOOLS.has(builtinTool)) builtins.add(builtinTool);
  if (!(opts.skipBroadBash && sdkTool === 'Bash')) allowed.add(sdkTool);
  if (clementineTool === '*') {
    clementineAllow.clear();
    clementineAllow.add('*');
  } else if (clementineTool && !clementineAllow.has('*')) {
    clementineAllow.add(clementineTool);
  }
}

export function buildExecutionToolPolicy(opts: BuildExecutionPolicyOptions): ExecutionToolPolicy {
  const permissionMode = opts.permissionMode ?? 'dontAsk';
  const clementineTools = listClementineMcpToolNames();
  const allowed = new Set<string>();
  const builtins = new Set<string>();
  const clementineAllow = new Set<string>();

  if (opts.requestedTools === undefined) {
    for (const raw of opts.defaultBuiltins) {
      const normalized = normalizeRequestedToolName(raw, opts.clementineServerName, clementineTools);
      applyNormalizedTool(normalized, builtins, allowed, clementineAllow);
    }
    for (const server of opts.mcpServerNames) {
      if (!server) continue;
      allowed.add(mcpWildcard(server));
      if (server === opts.clementineServerName) clementineAllow.add('*');
    }
  } else {
    const normalizedTools = opts.requestedTools.map((raw) =>
      normalizeRequestedToolName(raw, opts.clementineServerName, clementineTools),
    );
    const hasScopedBash = normalizedTools.some((tool) => tool.scopedBash);
    for (const normalized of normalizedTools) {
      applyNormalizedTool(normalized, builtins, allowed, clementineAllow, {
        // In explicit skill/tool scopes, `Bash` plus `some-cli` usually means
        // "make Bash visible and approve that CLI", not "approve all shell".
        skipBroadBash: hasScopedBash,
      });
    }
  }

  const clementineToolAllowlist = clementineAllow.has('*')
    ? '*'
    : [...clementineAllow].sort().join(',');

  return {
    permissionMode,
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true as const } : {}),
    builtinTools: [...builtins].sort(),
    allowedTools: [...allowed].sort(),
    clementineToolAllowlist,
    env: {
      // Tool search is default in current SDKs, but setting this makes the
      // intent explicit and protects large Composio/MCP catalogs.
      ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || 'auto:5',
    },
  };
}
