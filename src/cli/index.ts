#!/usr/bin/env node

// Enable Node.js module compile cache for faster startup
import { enableCompileCache } from 'node:module';
try {
  enableCompileCache?.();
} catch {
  // Not available in older Node.js versions — ignore
}

/**
 * Clementine CLI — launch, stop, restart, status, doctor, config.
 *
 * Works from any directory. Data lives in ~/.clementine/ (or CLEMENTINE_HOME).
 * Code lives wherever npm installed the package.
 */

import { Command } from 'commander';
import { spawn, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup.js';
import { cmdCronList, cmdCronRun, cmdCronRunDue, cmdCronRuns, cmdCronAdd, cmdCronTest, cmdHeartbeat } from './cron.js';
import { cmdDashboard } from './dashboard.js';
import { cmdChat } from './chat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Path resolution ─────────────────────────────────────────────────

/** Data home — vault, .env, logs, sessions, PID file. */
const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');

/**
 * Package root (wherever npm installed the package).
 * CLI lives at dist/cli/index.js, so two levels up = package root.
 */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/** Compiled entry point for the main process. */
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'index.js');

const ENV_PATH = path.join(BASE_DIR, '.env');

// ── Helpers ──────────────────────────────────────────────────────────

function getAssistantName(): string {
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(/^ASSISTANT_NAME=(.+)$/m);
    if (match) return match[1].trim();
  }
  return 'Clementine';
}

function getPidFilePath(): string {
  const name = getAssistantName().toLowerCase();
  return path.join(BASE_DIR, `.${name}.pid`);
}

function getLaunchdLabel(): string {
  return `com.${getAssistantName().toLowerCase()}.assistant`;
}

function getLaunchdPlistPath(): string {
  const home = process.env.HOME ?? '';
  return path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel()}.plist`);
}

function readPid(): number | null {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    const waitMs = 100;
    const waitUntil = Date.now() + waitMs;
    while (Date.now() < waitUntil) {
      // busy-wait (short)
    }
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already dead
  }
}

/** Stop the daemon safely: unload LaunchAgent first (prevents respawn), then kill the process. */
function stopDaemon(pid: number): void {
  // Unload LaunchAgent BEFORE killing — otherwise launchd respawns it immediately
  if (process.platform === 'darwin') {
    const plist = getLaunchdPlistPath();
    if (existsSync(plist)) {
      try {
        execSync(`launchctl unload "${plist}"`, { stdio: 'pipe' });
      } catch {
        // not loaded — that's fine
      }
    }
  }
  killPid(pid);
}

/** Bootstrap ~/.clementine/ on first run — create data dir and copy vault templates. */
function ensureDataHome(): void {
  if (!existsSync(BASE_DIR)) {
    mkdirSync(BASE_DIR, { recursive: true });
    console.log(`  Created ${BASE_DIR}`);
  }

  const vaultDir = path.join(BASE_DIR, 'vault');
  const pkgVault = path.join(PACKAGE_ROOT, 'vault');
  if (!existsSync(vaultDir) && existsSync(pkgVault)) {
    cpSync(pkgVault, vaultDir, { recursive: true });
    console.log('  Copied vault templates.');
  }
}

// ── Commands ─────────────────────────────────────────────────────────

function cmdLaunch(options: { foreground?: boolean; install?: boolean; uninstall?: boolean }): void {
  if (options.uninstall) {
    const plistPath = getLaunchdPlistPath();
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
      } catch {
        // not loaded
      }
      unlinkSync(plistPath);
      console.log(`  Uninstalled LaunchAgent: ${getLaunchdLabel()}`);
    } else {
      console.log('  LaunchAgent not installed.');
    }
    return;
  }

  if (options.install) {
    const plistPath = getLaunchdPlistPath();
    const plistDir = path.dirname(plistPath);
    if (!existsSync(plistDir)) {
      mkdirSync(plistDir, { recursive: true });
    }

    // Unload existing plist if already installed (idempotent reinstall)
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
      } catch {
        // not loaded — fine
      }
    }

    const nodePath = process.execPath;
    const logDir = path.join(BASE_DIR, 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${getLaunchdLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${DIST_ENTRY}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${BASE_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'clementine.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'clementine-error.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${buildLaunchdPath()}</string>
    <key>CLEMENTINE_HOME</key>
    <string>${BASE_DIR}</string>
  </dict>
</dict>
</plist>`;

    writeFileSync(plistPath, plist);
    try {
      execSync(`launchctl load "${plistPath}"`);
      console.log(`  Installed and loaded LaunchAgent: ${getLaunchdLabel()}`);
      console.log(`  Plist: ${plistPath}`);
      console.log(`  Logs:  ${logDir}/`);
    } catch (err) {
      console.error(`  Failed to load LaunchAgent: ${err}`);
    }

    // Also install the cron scheduler alongside the daemon
    console.log();
    cmdCronInstall();
    return;
  }

  // First-run bootstrap
  ensureDataHome();

  if (!existsSync(ENV_PATH)) {
    console.log(`  No .env file found at ${ENV_PATH}`);
    console.log('  Run: clementine config setup');
    console.log();
    return;
  }

  // Stop any existing instance first (unload LaunchAgent to prevent respawn)
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`  Stopping existing instance (PID ${existingPid})...`);
    stopDaemon(existingPid);
  }

  if (options.foreground) {
    // Foreground mode: import and run the entry point directly
    process.env.CLEMENTINE_HOME = BASE_DIR;
    import('../index.js').catch((err: unknown) => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
    return;
  }

  // Daemon mode (default) — redirect stdout+stderr to log file
  const logDir = path.join(BASE_DIR, 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, 'clementine.log');
  const logFd = openSync(logFile, 'a');

  const child = spawn('node', [DIST_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: BASE_DIR,
    env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
  });

  if (child.pid) {
    writeFileSync(getPidFilePath(), String(child.pid));
    console.log(`  ${getAssistantName()} started in background (PID ${child.pid})`);
    console.log(`  Logs: ${logFile}`);
  }

  child.unref();
  closeSync(logFd);
}

function cmdStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log('  No running instance found.');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`  PID ${pid} is not running. Cleaning up PID file.`);
    try { unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    return;
  }

  console.log(`  Stopping ${getAssistantName()} (PID ${pid})...`);
  stopDaemon(pid);

  if (isProcessAlive(pid)) {
    console.log('  Process did not exit cleanly.');
  } else {
    console.log('  Stopped.');
    try { unlinkSync(getPidFilePath()); } catch { /* ignore */ }
  }
}

function cmdRestart(options: { foreground?: boolean }): void {
  cmdStop();
  cmdLaunch({ foreground: options.foreground });
}

function cmdStatus(): void {
  const pid = readPid();
  const name = getAssistantName();

  if (!pid) {
    console.log(`  ${name} is not running (no PID file).`);
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`  ${name} is not running (stale PID ${pid}).`);
    return;
  }

  console.log(`  ${name} is running (PID ${pid})`);

  // Show uptime from PID file mtime
  try {
    const { mtimeMs } = statSync(getPidFilePath());
    const uptimeMs = Date.now() - mtimeMs;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    console.log(`  Uptime: ${hours}h ${minutes}m`);
  } catch {
    // ignore
  }

  // Show active channels from env
  const channels: string[] = [];
  if (existsSync(ENV_PATH)) {
    const env = readFileSync(ENV_PATH, 'utf-8');
    if (/^DISCORD_TOKEN=.+$/m.test(env)) channels.push('Discord');
    if (/^SLACK_BOT_TOKEN=.+$/m.test(env) && /^SLACK_APP_TOKEN=.+$/m.test(env)) channels.push('Slack');
    if (/^TELEGRAM_BOT_TOKEN=.+$/m.test(env)) channels.push('Telegram');
    if (/^TWILIO_ACCOUNT_SID=.+$/m.test(env)) channels.push('WhatsApp');
    if (/^WEBHOOK_ENABLED=true$/m.test(env)) channels.push('Webhook');
  }
  if (channels.length > 0) {
    console.log(`  Channels: ${channels.join(', ')}`);
  }
}

function cmdDoctor(): void {
  const DIM = '\x1b[0;90m';
  const GREEN = '\x1b[0;32m';
  const RED = '\x1b[0;31m';
  const YELLOW = '\x1b[1;33m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${DIM}Data home: ${BASE_DIR}${RESET}`);
  console.log(`  ${DIM}Running health checks...${RESET}`);
  console.log();

  let issues = 0;

  // Node version (require 20–24 LTS)
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major >= 20 && major <= 24) {
    console.log(`  ${GREEN}OK${RESET}  Node.js ${nodeVersion}`);
  } else if (major > 24) {
    console.log(`  ${RED}FAIL${RESET}  Node.js ${nodeVersion} — SDK requires Node 20–24 LTS`);
    console.log(`       Install Node 22: nvm install 22`);
    issues++;
  } else {
    console.log(`  ${RED}FAIL${RESET}  Node.js ${nodeVersion} (need >= 20)`);
    issues++;
  }

  // Claude CLI
  try {
    execSync('which claude', { stdio: 'pipe' });
    console.log(`  ${GREEN}OK${RESET}  claude CLI found`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  claude CLI not found`);
    console.log(`       Install: npm install -g @anthropic-ai/claude-code`);
    issues++;
  }

  // SDK smoke test — verify claude CLI can actually execute
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 10000 });
    console.log(`  ${GREEN}OK${RESET}  claude CLI executes successfully`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  claude CLI found but failed to execute`);
    console.log(`       Check Node version compatibility and run: npm install -g @anthropic-ai/claude-code`);
    issues++;
  }

  // better-sqlite3 native module
  try {
    execSync('node -e "require(\'better-sqlite3\')"', {
      cwd: PACKAGE_ROOT,
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log(`  ${GREEN}OK${RESET}  better-sqlite3 native module loads`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  better-sqlite3 native module broken (Node version mismatch)`);
    console.log(`       Fix: cd ${PACKAGE_ROOT} && npm rebuild better-sqlite3`);
    issues++;
  }

  // FalkorDB graph engine — system dependencies
  try {
    execSync('which redis-server', { stdio: 'pipe' });
    console.log(`  ${GREEN}OK${RESET}  redis-server found`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  redis-server not found (required for knowledge graph)`);
    console.log(`       Fix: brew install redis (macOS) or sudo apt install redis-server (Linux)`);
    issues++;
  }

  try {
    const libompPath = process.platform === 'darwin'
      ? '/opt/homebrew/opt/libomp/lib/libomp.dylib'
      : '/usr/lib/libomp.so';
    if (existsSync(libompPath)) {
      console.log(`  ${GREEN}OK${RESET}  libomp (OpenMP runtime) found`);
    } else {
      throw new Error('not found');
    }
  } catch {
    console.log(`  ${RED}FAIL${RESET}  libomp (OpenMP runtime) not found (required for knowledge graph)`);
    console.log(`       Fix: brew install libomp (macOS) or sudo apt install libomp-dev (Linux)`);
    issues++;
  }

  // FalkorDB graph engine — module binaries
  try {
    const result = execSync(
      `node -e "const{BinaryManager}=require('falkordblite/dist/binary-manager.js');new BinaryManager().ensureBinaries().then(p=>{console.log(JSON.stringify(p));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`,
      { cwd: PACKAGE_ROOT, stdio: 'pipe', timeout: 30000 },
    );
    console.log(`  ${GREEN}OK${RESET}  FalkorDB graph engine binaries installed`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  FalkorDB graph engine binaries not available`);
    console.log(`       Fix: cd ${PACKAGE_ROOT} && node node_modules/falkordblite/scripts/postinstall.js`);
    issues++;
  }

  // Data home
  if (existsSync(BASE_DIR)) {
    console.log(`  ${GREEN}OK${RESET}  Data home exists (${BASE_DIR})`);
  } else {
    console.log(`  ${YELLOW}WARN${RESET}  Data home not found (run: clementine launch)`);
    issues++;
  }

  // .env file
  if (existsSync(ENV_PATH)) {
    console.log(`  ${GREEN}OK${RESET}  .env file exists`);
  } else {
    console.log(`  ${YELLOW}WARN${RESET}  .env file not found (run: clementine config setup)`);
    issues++;
  }

  // Vault files
  const vaultDir = path.join(BASE_DIR, 'vault');
  const requiredVaultFiles = [
    ['00-System/SOUL.md', 'SOUL.md'],
    ['00-System/AGENTS.md', 'AGENTS.md'],
  ] as const;

  for (const [filePath, label] of requiredVaultFiles) {
    if (existsSync(path.join(vaultDir, filePath))) {
      console.log(`  ${GREEN}OK${RESET}  vault/${filePath}`);
    } else {
      console.log(`  ${RED}FAIL${RESET}  vault/${filePath} missing`);
      issues++;
    }
  }

  // Channel tokens (informational)
  if (existsSync(ENV_PATH)) {
    const env = readFileSync(ENV_PATH, 'utf-8');
    const channelChecks = [
      ['DISCORD_TOKEN', 'Discord'],
      ['TELEGRAM_BOT_TOKEN', 'Telegram'],
      ['SLACK_BOT_TOKEN', 'Slack'],
    ] as const;
    let anyChannel = false;
    for (const [key, name] of channelChecks) {
      const re = new RegExp(`^${key}=(.+)$`, 'm');
      if (re.test(env)) {
        console.log(`  ${GREEN}OK${RESET}  ${name} token configured`);
        anyChannel = true;
      }
    }
    if (!anyChannel) {
      console.log(`  ${YELLOW}WARN${RESET}  No channel tokens configured`);
      issues++;
    }
  }

  // LaunchAgent health check (macOS only)
  if (process.platform === 'darwin') {
    const plistPath = getLaunchdPlistPath();
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl list ${getLaunchdLabel()}`, { stdio: 'pipe' });
        console.log(`  ${GREEN}OK${RESET}  LaunchAgent installed and loaded`);
      } catch {
        console.log(`  ${YELLOW}WARN${RESET}  LaunchAgent installed but not loaded`);
        console.log(`       Load it: launchctl load "${plistPath}"`);
        issues++;
      }
    } else {
      console.log(`  ${YELLOW}WARN${RESET}  LaunchAgent not installed (run: clementine launch --install)`);
      issues++;
    }
  }

  console.log();
  if (issues === 0) {
    console.log(`  ${GREEN}All checks passed.${RESET}`);
  } else {
    console.log(`  ${YELLOW}${issues} issue(s) found.${RESET}`);
  }
  console.log();
}

function cmdConfigSet(key: string, value: string): void {
  ensureDataHome();

  let content = '';
  if (existsSync(ENV_PATH)) {
    content = readFileSync(ENV_PATH, 'utf-8');
  }

  const upperKey = key.toUpperCase();
  const re = new RegExp(`^${upperKey}=.*$`, 'm');

  if (re.test(content)) {
    content = content.replace(re, `${upperKey}=${value}`);
  } else {
    content = content.trimEnd() + `\n${upperKey}=${value}\n`;
  }

  writeFileSync(ENV_PATH, content);
  console.log(`  Set ${upperKey}=${value}`);
}

function cmdConfigGet(key: string): void {
  if (!existsSync(ENV_PATH)) {
    console.log('  No .env file found.');
    return;
  }
  const content = readFileSync(ENV_PATH, 'utf-8');
  const upperKey = key.toUpperCase();
  const re = new RegExp(`^${upperKey}=(.*)$`, 'm');
  const match = content.match(re);
  if (match) {
    console.log(`  ${upperKey}=${match[1]}`);
  } else {
    console.log(`  ${upperKey} is not set.`);
  }
}

function cmdConfigList(): void {
  if (!existsSync(ENV_PATH)) {
    console.log('  No .env file found. Run: clementine config setup');
    return;
  }

  const content = readFileSync(ENV_PATH, 'utf-8');
  const DIM = '\x1b[0;90m';
  const RESET = '\x1b[0m';

  console.log();
  for (const line of content.split('\n')) {
    if (line.startsWith('#')) {
      console.log(`  ${DIM}${line}${RESET}`);
    } else if (line.trim()) {
      // Mask secret values
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) {
        const [, k, v] = match;
        const sensitiveKeys = ['TOKEN', 'SECRET', 'API_KEY', 'AUTH_TOKEN', 'SID'];
        const isSensitive = sensitiveKeys.some((s) => k.includes(s));
        if (isSensitive && v.length > 8) {
          console.log(`  ${k}=${v.slice(0, 4)}${'*'.repeat(v.length - 8)}${v.slice(-4)}`);
        } else {
          console.log(`  ${line}`);
        }
      } else {
        console.log(`  ${line}`);
      }
    }
  }
  console.log();
}

// ── Tools command ───────────────────────────────────────────────────

function cmdTools(): void {
  const DIM = '\x1b[0;90m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[1;33m';
  const CYAN = '\x1b[0;36m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';

  console.log();

  // ── 1. Clementine MCP tools (parse from source) ──────────────────
  const mcpServerSrc = path.join(PACKAGE_ROOT, 'src', 'tools', 'mcp-server.ts');
  const mcpTools: Array<{ name: string; description: string }> = [];

  if (existsSync(mcpServerSrc)) {
    const src = readFileSync(mcpServerSrc, 'utf-8');
    // Match: server.tool(\n  'name',\n  'description' or "description",
    const toolPattern = /server\.tool\(\s*'([^']+)',\s*(['"])(.+?)\2/gs;
    let match;
    while ((match = toolPattern.exec(src)) !== null) {
      mcpTools.push({ name: match[1], description: match[3] });
    }
  }

  if (mcpTools.length > 0) {
    console.log(`  ${BOLD}Clementine MCP Tools${RESET} ${DIM}(${mcpTools.length} tools)${RESET}`);
    console.log();
    const maxName = Math.max(...mcpTools.map((t) => t.name.length));
    for (const tool of mcpTools) {
      console.log(`    ${CYAN}${tool.name.padEnd(maxName)}${RESET}  ${DIM}${tool.description}${RESET}`);
    }
    console.log();
  }

  // ── 2. SDK built-in tools ────────────────────────────────────────
  const sdkTools = [
    { name: 'Read', description: 'Read files from the filesystem' },
    { name: 'Write', description: 'Write/create files' },
    { name: 'Edit', description: 'Edit files with string replacements' },
    { name: 'Bash', description: 'Execute shell commands' },
    { name: 'Glob', description: 'Find files by pattern' },
    { name: 'Grep', description: 'Search file contents' },
    { name: 'WebSearch', description: 'Search the web' },
    { name: 'WebFetch', description: 'Fetch and process web pages' },
    { name: 'Agent', description: 'Spawn sub-agents for complex tasks' },
    { name: 'Task', description: 'Multi-agent task coordination' },
  ];

  console.log(`  ${BOLD}SDK Built-in Tools${RESET} ${DIM}(${sdkTools.length} tools)${RESET}`);
  console.log();
  const maxSdk = Math.max(...sdkTools.map((t) => t.name.length));
  for (const tool of sdkTools) {
    console.log(`    ${CYAN}${tool.name.padEnd(maxSdk)}${RESET}  ${DIM}${tool.description}${RESET}`);
  }
  console.log();

  // ── 3. Claude Code plugins ───────────────────────────────────────
  const home = process.env.HOME ?? '';
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const plugins: Array<{ name: string; source: string }> = [];

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const enabledPlugins = settings.enabledPlugins ?? {};
      for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
        if (enabled) {
          const [name, source] = pluginId.split('@');
          plugins.push({ name, source: source ?? 'unknown' });
        }
      }
    } catch { /* ignore */ }
  }

  if (plugins.length > 0) {
    console.log(`  ${BOLD}Claude Code Plugins${RESET} ${DIM}(global)${RESET}`);
    console.log();
    const maxPlugin = Math.max(...plugins.map((p) => p.name.length));
    for (const plugin of plugins) {
      console.log(`    ${GREEN}${plugin.name.padEnd(maxPlugin)}${RESET}  ${DIM}${plugin.source}${RESET}`);
    }
    console.log();
  }

  // ── 4. Project MCP servers ───────────────────────────────────────
  const projectSettingsPath = path.join(PACKAGE_ROOT, '.claude', 'settings.json');
  const projectMcpServers: string[] = [];

  if (existsSync(projectSettingsPath)) {
    try {
      const projSettings = JSON.parse(readFileSync(projectSettingsPath, 'utf-8'));
      const servers = projSettings.mcpServers ?? {};
      for (const serverName of Object.keys(servers)) {
        projectMcpServers.push(serverName);
      }
    } catch { /* ignore */ }
  }

  if (projectMcpServers.length > 0) {
    console.log(`  ${BOLD}Project MCP Servers${RESET} ${DIM}(from .claude/settings.json)${RESET}`);
    console.log();
    for (const name of projectMcpServers) {
      console.log(`    ${YELLOW}${name}${RESET}`);
    }
    console.log();
  }

  // ── 5. Active channels ──────────────────────────────────────────
  const channels: string[] = [];
  if (existsSync(ENV_PATH)) {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    if (/^DISCORD_TOKEN=.+$/m.test(envContent)) channels.push('Discord');
    if (/^SLACK_BOT_TOKEN=.+$/m.test(envContent) && /^SLACK_APP_TOKEN=.+$/m.test(envContent)) channels.push('Slack');
    if (/^TELEGRAM_BOT_TOKEN=.+$/m.test(envContent)) channels.push('Telegram');
    if (/^TWILIO_ACCOUNT_SID=.+$/m.test(envContent)) channels.push('WhatsApp');
    if (/^WEBHOOK_ENABLED=true$/m.test(envContent)) channels.push('Webhook');
  }

  if (channels.length > 0) {
    console.log(`  ${BOLD}Active Channels${RESET}`);
    console.log();
    for (const ch of channels) {
      console.log(`    ${GREEN}${ch}${RESET}`);
    }
    console.log();
  }
}

// ── Program ──────────────────────────────────────────────────────────

const program = new Command();

program
  .name('clementine')
  .description('Clementine Personal AI Assistant')
  .version('1.0.0');

program
  .command('launch')
  .description('Start the assistant (daemon by default)')
  .option('-f, --foreground', 'Run in foreground (attached to terminal)')
  .option('--install', 'Install as macOS LaunchAgent')
  .option('--uninstall', 'Remove macOS LaunchAgent')
  .action(cmdLaunch);

program
  .command('stop')
  .description('Stop the running assistant')
  .action(cmdStop);

program
  .command('restart')
  .description('Restart the assistant (daemon by default)')
  .option('-f, --foreground', 'Run in foreground after restart')
  .action(cmdRestart);

program
  .command('status')
  .description('Show assistant status')
  .action(cmdStatus);

program
  .command('doctor')
  .description('Run health checks')
  .action(cmdDoctor);

program
  .command('tools')
  .description('List available MCP tools, plugins, and channels')
  .action(cmdTools);

program
  .command('dashboard')
  .description('Launch local command center')
  .option('-p, --port <n>', 'Port (default 3030)', '3030')
  .action((opts: { port?: string }) => {
    cmdDashboard(opts).catch((err: unknown) => {
      console.error('Dashboard error:', err);
      process.exit(1);
    });
  });

program
  .command('chat')
  .description('Interactive REPL chat session')
  .option('-m, --model <tier>', 'Model tier (haiku, sonnet, opus)')
  .option('--project <name>', 'Set active project context')
  .option('--profile <slug>', 'Set agent profile')
  .action((opts: { model?: string; project?: string; profile?: string }) => {
    cmdChat(opts).catch((err: unknown) => {
      console.error('Chat error:', err);
      process.exit(1);
    });
  });

program
  .command('update')
  .description('Pull latest code, rebuild, and reinstall (preserves config)')
  .argument('[action]', 'Optional: "restart" to restart daemon after update')
  .option('--restart', 'Restart daemon after update')
  .option('--dry-run', 'Preview what would happen without making changes')
  .action((action: string | undefined, options: { restart?: boolean; dryRun?: boolean }) => {
    if (action === 'restart') options.restart = true;
    cmdUpdate(options).catch((err: unknown) => {
      console.error('Update failed:', err);
      process.exit(1);
    });
  });

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('setup')
  .description('Run interactive setup wizard')
  .action(() => {
    ensureDataHome();
    runSetup().catch((err: unknown) => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value in .env')
  .action(cmdConfigSet);

configCmd
  .command('get <key>')
  .description('Get a config value from .env')
  .action(cmdConfigGet);

configCmd
  .command('list')
  .description('List all config values')
  .action(cmdConfigList);

// ── Update command ──────────────────────────────────────────────────

async function cmdUpdate(options: { restart?: boolean; dryRun?: boolean }): Promise<void> {
  const DIM = '\x1b[0;90m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[1;33m';
  const RED = '\x1b[0;31m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${DIM}Updating ${getAssistantName()}...${RESET}`);
  console.log();

  // 1. Check we're in a git repo
  if (!existsSync(path.join(PACKAGE_ROOT, '.git'))) {
    console.error(`  ${RED}FAIL${RESET}  Package root is not a git repository: ${PACKAGE_ROOT}`);
    console.error('  Update requires a git-cloned installation.');
    process.exit(1);
  }

  let step = 0;
  const S = () => `[${++step}]`;

  // 2. Ensure we're on main and reset any local src/ changes.
  //    Source modifications are tracked in ~/.clementine/ (not git),
  //    so resetting the working tree is safe — mods get re-applied after pull.
  if (!options.dryRun) {
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: PACKAGE_ROOT,
        encoding: 'utf-8',
      }).trim();
      if (currentBranch !== 'main') {
        console.log(`  ${S()} Switching to main branch...`);
        execSync('git checkout main', { cwd: PACKAGE_ROOT, stdio: 'pipe' });
        console.log(`  ${GREEN}OK${RESET}  Switched to main`);
      }
    } catch { /* best effort */ }

    try {
      execSync('git checkout -- src/', { cwd: PACKAGE_ROOT, stdio: 'pipe' });
    } catch { /* no local src/ changes to reset */ }
  }

  // 3. Stash any remaining local changes (package-lock.json, etc.)
  let didStash = false;
  try {
    const status = execSync('git status --porcelain', { cwd: PACKAGE_ROOT, encoding: 'utf-8' }).trim();
    if (status) {
      console.log(`  ${S()} Stashing local changes...`);
      const stashOut = execSync('git stash', { cwd: PACKAGE_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      didStash = !stashOut.includes('No local changes');
      if (didStash) {
        console.log(`  ${GREEN}OK${RESET}  Stashed local changes`);
      }
    }
  } catch {
    // not fatal — pull may still succeed if changes don't conflict
  }

  // 3. Back up user config
  const backupDir = path.join(BASE_DIR, 'backups', `pre-update-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`);
  console.log(`  ${S()} Backing up config...`);

  if (!options.dryRun) {
    mkdirSync(backupDir, { recursive: true });

    // .env
    if (existsSync(ENV_PATH)) {
      const envContent = readFileSync(ENV_PATH, 'utf-8');
      writeFileSync(path.join(backupDir, '.env'), envContent);
    }

    // Cron state
    const cronStateFile = path.join(BASE_DIR, '.cron_last_run.json');
    if (existsSync(cronStateFile)) {
      writeFileSync(
        path.join(backupDir, '.cron_last_run.json'),
        readFileSync(cronStateFile, 'utf-8'),
      );
    }

    // Heartbeat state
    const hbStateFile = path.join(BASE_DIR, '.heartbeat_state.json');
    if (existsSync(hbStateFile)) {
      writeFileSync(
        path.join(backupDir, '.heartbeat_state.json'),
        readFileSync(hbStateFile, 'utf-8'),
      );
    }

    // Sessions
    const sessionsFile = path.join(BASE_DIR, '.sessions.json');
    if (existsSync(sessionsFile)) {
      writeFileSync(
        path.join(backupDir, '.sessions.json'),
        readFileSync(sessionsFile, 'utf-8'),
      );
    }

    console.log(`  ${GREEN}OK${RESET}  Config backed up`);
  } else {
    console.log(`  ${DIM}(dry run — skipping backup)${RESET}`);
  }

  // 4. Stop running daemon
  const pid = readPid();
  const wasRunning = pid && isProcessAlive(pid);
  if (wasRunning) {
    console.log(`  ${S()} Stopping daemon (PID ${pid})...`);
    if (!options.dryRun) {
      stopDaemon(pid!);
      try { unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    }
    console.log(`  ${GREEN}OK${RESET}  Daemon stopped`);
  }

  // Helper: if update fails after stopping daemon, relaunch before exiting
  function failAndRestart(backupDir: string): never {
    if (wasRunning) {
      console.log();
      console.log(`  Restarting daemon (was running before update)...`);
      try {
        cmdLaunch({});
        console.log(`  ${GREEN}OK${RESET}  Daemon restarted`);
      } catch {
        console.error(`  ${YELLOW}WARN${RESET}  Could not restart daemon — run: clementine launch`);
      }
    }
    console.log();
    console.log(`  ${DIM}Config backup is at: ${backupDir}${RESET}`);
    process.exit(1);
  }

  if (options.dryRun) {
    console.log();
    console.log(`  ${DIM}Dry run — would execute:${RESET}`);
    console.log(`    ${S()} Reset local src/ (mods tracked in ~/.clementine/)`);
    console.log(`    ${S()} Pull latest (git pull --ff-only)`);
    console.log(`    ${S()} Install dependencies (npm install)`);
    console.log(`    ${S()} Build (clean)`);
    console.log(`    ${S()} Verify build output`);
    console.log(`    ${S()} Reinstall CLI globally`);
    console.log(`    ${S()} Restore local changes`);
    console.log(`    ${S()} Reconcile source modifications`);
    console.log(`    ${S()} Run vault migrations`);
    console.log(`    ${S()} Run health check (clementine doctor)`);
    if (options.restart || wasRunning) {
      console.log(`    ${S()} Restart daemon`);
    }
    console.log();
    return;
  }

  // 5. Git pull
  console.log(`  ${S()} Pulling latest...`);
  let commitsPulled = 0;
  let pullSummary = '';
  try {
    // Count how many commits we're behind before pulling
    try {
      execSync('git fetch origin main --quiet', { cwd: PACKAGE_ROOT, stdio: 'pipe', timeout: 30_000 });
      const countStr = execSync('git rev-list HEAD..origin/main --count', {
        cwd: PACKAGE_ROOT, encoding: 'utf-8',
      }).trim();
      commitsPulled = parseInt(countStr, 10) || 0;
      if (commitsPulled > 0) {
        pullSummary = execSync('git log HEAD..origin/main --oneline --no-decorate', {
          cwd: PACKAGE_ROOT, encoding: 'utf-8',
        }).trim();
      }
    } catch { /* non-fatal — we'll still pull */ }

    const pullOutput = execSync('git pull --ff-only', {
      cwd: PACKAGE_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (pullOutput.includes('Already up to date')) {
      console.log(`  ${GREEN}OK${RESET}  Already up to date`);
    } else {
      console.log(`  ${GREEN}OK${RESET}  Pulled updates`);
    }
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes('local changes') || errStr.includes('overwritten by merge')) {
      console.error(`  ${RED}FAIL${RESET}  Local file changes conflict with the update.`);
      console.error();
      console.error(`  Fix — run these commands, then retry:`);
      console.error(`    cd ${PACKAGE_ROOT}`);
      console.error(`    git stash`);
      console.error(`    clementine update`);
      console.error();
      console.error(`  ${DIM}Your local changes will be saved. Restore after update with: git stash pop${RESET}`);
    } else if (errStr.includes('Not possible to fast-forward')) {
      console.error(`  ${RED}FAIL${RESET}  Cannot fast-forward. Local commits conflict with upstream.`);
      console.error();
      console.error(`  Fix — run these commands, then retry:`);
      console.error(`    cd ${PACKAGE_ROOT}`);
      console.error(`    git stash`);
      console.error(`    git pull --rebase`);
      console.error(`    git stash pop`);
    } else {
      console.error(`  ${RED}FAIL${RESET}  git pull failed: ${errStr.slice(0, 200)}`);
    }
    if (didStash) {
      console.log(`  ${DIM}Restoring stashed changes...${RESET}`);
      try { execSync('git stash pop', { cwd: PACKAGE_ROOT, stdio: 'pipe' }); } catch { /* best effort */ }
    }
    failAndRestart(backupDir);
  }

  // 6. npm install
  console.log(`  ${S()} Installing dependencies...`);
  try {
    execSync('npm install --loglevel=error --no-audit', {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  ${GREEN}OK${RESET}  Dependencies installed`);
  } catch (err) {
    console.error(`  ${RED}FAIL${RESET}  npm install failed: ${String(err).slice(0, 200)}`);
    failAndRestart(backupDir);
  }

  // 6b. Rebuild native modules (better-sqlite3) for current Node version
  try {
    execSync('npm rebuild better-sqlite3', {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  ${GREEN}OK${RESET}  Native modules rebuilt`);
  } catch {
    console.error(`  ${YELLOW}WARN${RESET}  Native module rebuild failed — memory search may not work`);
  }

  // 6c. Verify graph engine system dependencies + binaries
  console.log(`  ${S()} Verifying graph engine...`);
  const missingDeps: string[] = [];
  try { execSync('which redis-server', { stdio: 'pipe' }); } catch { missingDeps.push('redis-server'); }
  const libompPath = process.platform === 'darwin'
    ? '/opt/homebrew/opt/libomp/lib/libomp.dylib'
    : '/usr/lib/libomp.so';
  if (!existsSync(libompPath)) missingDeps.push('libomp');

  if (missingDeps.length > 0) {
    console.error(`  ${YELLOW}WARN${RESET}  Knowledge graph dependencies missing: ${missingDeps.join(', ')}`);
    if (process.platform === 'darwin') {
      console.error(`       Fix: brew install ${missingDeps.map(d => d === 'redis-server' ? 'redis' : d).join(' ')}`);
    } else {
      console.error(`       Fix: sudo apt install ${missingDeps.map(d => d === 'redis-server' ? 'redis-server' : 'libomp-dev').join(' ')}`);
    }
  }

  try {
    execSync(
      `node -e "const{BinaryManager}=require('falkordblite/dist/binary-manager.js');new BinaryManager().ensureBinaries().then(()=>process.exit(0)).catch(()=>process.exit(1))"`,
      { cwd: PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 },
    );
    if (missingDeps.length === 0) {
      console.log(`  ${GREEN}OK${RESET}  FalkorDB graph engine ready`);
    } else {
      console.log(`  ${GREEN}OK${RESET}  FalkorDB binaries ready (install system deps above for full graph support)`);
    }
  } catch {
    console.error(`  ${YELLOW}WARN${RESET}  FalkorDB graph engine setup failed — knowledge graph features will be disabled`);
    console.error(`       Run: cd ${PACKAGE_ROOT} && node node_modules/falkordblite/scripts/postinstall.js`);
  }

  // 7. Build (clean)
  console.log(`  ${S()} Building (clean)...`);
  try {
    execSync('npm run build', {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  ${GREEN}OK${RESET}  Build succeeded`);
  } catch (err) {
    // Build failed — retry with fresh npm install (handles missing typescript after pull)
    console.error(`  ${YELLOW}WARN${RESET}  Build failed — retrying with fresh dependency install...`);
    try {
      execSync('npm install --loglevel=error --no-audit && npm run build', {
        cwd: PACKAGE_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`  ${GREEN}OK${RESET}  Build succeeded (after reinstall)`);
    } catch (retryErr) {
      console.error(`  ${RED}FAIL${RESET}  Build failed after update: ${String(retryErr).slice(0, 200)}`);
      failAndRestart(backupDir);
    }
  }

  // 7b. Verify build output is fresh
  const distEntry = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
  if (existsSync(distEntry)) {
    const distStat = statSync(distEntry);
    const ageMs = Date.now() - distStat.mtimeMs;
    if (ageMs > 30_000) {
      console.error(`  ${YELLOW}WARN${RESET}  Build output appears stale (${Math.round(ageMs / 1000)}s old) — retrying with clean build...`);
      try {
        execSync('rm -rf dist && npm run build', { cwd: PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
        console.log(`  ${GREEN}OK${RESET}  Clean rebuild succeeded`);
      } catch (err) {
        console.error(`  ${RED}FAIL${RESET}  Clean rebuild failed: ${String(err).slice(0, 200)}`);
        failAndRestart(backupDir);
      }
    }
  }

  // 8. Reinstall globally
  console.log(`  ${S()} Reinstalling CLI globally...`);
  try {
    execSync('npm install -g . --loglevel=error --no-audit', {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  ${GREEN}OK${RESET}  CLI reinstalled`);
  } catch (err) {
    console.error(`  ${YELLOW}WARN${RESET}  Global reinstall failed (may need sudo): ${String(err).slice(0, 200)}`);
    // Non-fatal — local dist is already updated
  }

  // 9. Restore stashed local changes
  if (didStash) {
    console.log(`  ${S()} Restoring local changes...`);
    try {
      execSync('git stash pop', {
        cwd: PACKAGE_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`  ${GREEN}OK${RESET}  Local changes restored`);
    } catch {
      console.error(`  ${YELLOW}WARN${RESET}  Could not auto-restore stashed changes`);
      console.log(`       Your changes are saved in: git -C "${PACKAGE_ROOT}" stash list`);
    }
  }

  // 10. Reconcile source modifications from self-improve
  //     Source mods are tracked in ~/.clementine/self-improve/source-mods/
  //     After pulling new code, we check each active mod and re-apply if needed.
  console.log(`  ${S()} Reconciling source modifications...`);
  let reconcileResult: { reapplied: string[]; superseded: string[]; needsReconciliation: string[]; failed: string[] } | null = null;
  try {
    const { reconcileSourceMods } = await import('../agent/source-mods.js');
    const result = reconcileSourceMods(PACKAGE_ROOT);
    reconcileResult = result;

    const total = result.reapplied.length + result.superseded.length +
      result.needsReconciliation.length + result.failed.length;

    if (total === 0) {
      console.log(`  ${GREEN}OK${RESET}  No source modifications to reconcile`);
    } else {
      if (result.superseded.length > 0) {
        console.log(`  ${GREEN}OK${RESET}  ${result.superseded.length} mod(s) already in upstream — marked superseded`);
      }
      if (result.reapplied.length > 0) {
        console.log(`  ${GREEN}OK${RESET}  ${result.reapplied.length} mod(s) re-applied successfully`);
        // Rebuild with re-applied mods
        console.log(`  ${S()} Rebuilding with re-applied modifications...`);
        try {
          execSync('npm run build', { cwd: PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
          console.log(`  ${GREEN}OK${RESET}  Rebuild succeeded`);
        } catch {
          console.error(`  ${YELLOW}WARN${RESET}  Rebuild failed — continuing with base build`);
          try { execSync('git checkout -- src/', { cwd: PACKAGE_ROOT, stdio: 'pipe' }); } catch { /* best effort */ }
        }
      }
      if (result.needsReconciliation.length > 0) {
        console.log(`  ${YELLOW}NOTE${RESET}  ${result.needsReconciliation.length} mod(s) need reconciliation`);
        console.log(`       ${getAssistantName()} will re-apply these intelligently on next startup.`);
      }
      if (result.failed.length > 0) {
        console.error(`  ${YELLOW}WARN${RESET}  ${result.failed.length} mod(s) failed typecheck — reverted`);
      }
    }
  } catch (err) {
    console.error(`  ${YELLOW}WARN${RESET}  Source mod reconciliation failed: ${String(err).slice(0, 150)}`);
  }

  // 10b. Run vault migrations (structural updates to user vault files)
  console.log(`  ${S()} Running vault migrations...`);
  try {
    const { runVaultMigrations } = await import('../vault-migrations/runner.js');
    const migResult = await runVaultMigrations(
      path.join(BASE_DIR, 'vault'),
      backupDir,
    );

    const migApplied = migResult.applied.length;
    const migSkipped = migResult.skipped.length;
    const migFailed = migResult.failed.length;

    if (migApplied > 0) {
      console.log(`  ${GREEN}OK${RESET}  Applied ${migApplied} vault migration(s): ${migResult.applied.join(', ')}`);
    }
    if (migSkipped > 0) {
      console.log(`  ${GREEN}OK${RESET}  ${migSkipped} migration(s) already present — skipped`);
    }
    if (migFailed > 0) {
      console.error(`  ${YELLOW}WARN${RESET}  ${migFailed} migration(s) failed — will retry on next update`);
      for (const e of migResult.errors) {
        console.error(`       ${e.id}: ${e.error}`);
      }
    }
    if (migApplied === 0 && migSkipped === 0 && migFailed === 0) {
      console.log(`  ${GREEN}OK${RESET}  No new vault migrations`);
    }
  } catch (err) {
    console.error(`  ${YELLOW}WARN${RESET}  Vault migration failed: ${String(err).slice(0, 150)}`);
  }

  // 11. Doctor check
  console.log();
  console.log(`  ${S()} Running health check...`);
  cmdDoctor();

  // 11. Kill any running dashboard process so it picks up new code on next start
  try {
    const dashPids = execSync("pgrep -f 'clementine.*dashboard' || true", { encoding: 'utf-8' }).trim();
    if (dashPids) {
      for (const dp of dashPids.split('\n').filter(Boolean)) {
        const dpid = parseInt(dp, 10);
        if (!isNaN(dpid) && dpid !== process.pid) {
          try { process.kill(dpid, 'SIGTERM'); } catch { /* ignore */ }
        }
      }
      console.log(`  ${GREEN}OK${RESET}  Stopped dashboard process (restart with: clementine dashboard)`);
    }
  } catch { /* no dashboard running */ }

  // 12. Write update sentinel so the daemon can report what happened
  let commitHash = '';
  let commitDate = '';
  try {
    commitHash = execSync('git rev-parse --short HEAD', {
      cwd: PACKAGE_ROOT, encoding: 'utf-8',
    }).trim();
    commitDate = execSync('git log -1 --format=%ci HEAD', {
      cwd: PACKAGE_ROOT, encoding: 'utf-8',
    }).trim().slice(0, 10);
  } catch { /* best effort */ }

  if (options.restart || wasRunning) {
    const sentinelPath = path.join(BASE_DIR, '.restart-sentinel.json');
    const sentinel: import('../types.js').RestartSentinel = {
      previousPid: process.pid,
      restartedAt: new Date().toISOString(),
      reason: 'update',
      updateDetails: {
        commitHash,
        commitDate,
        commitsBehind: commitsPulled,
        summary: pullSummary.split('\n').slice(0, 5).join('; '),
        modsReapplied: reconcileResult?.reapplied.length ?? 0,
        modsSuperseded: reconcileResult?.superseded.length ?? 0,
        modsNeedReconciliation: reconcileResult?.needsReconciliation.length ?? 0,
        modsFailed: reconcileResult?.failed.length ?? 0,
      },
    };
    writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2));

    // Ensure build output is fully flushed before spawning new process
    execSync('sync', { stdio: 'pipe' });
    console.log(`  ${S()} Restarting daemon...`);
    cmdLaunch({});
  }

  // 13. Show current version
  console.log();
  if (commitHash) {
    console.log(`  ${GREEN}Updated to ${commitHash} (${commitDate})${RESET}`);
  } else {
    console.log(`  ${GREEN}Update complete.${RESET}`);
  }

  console.log(`  ${DIM}Config backup: ${backupDir}${RESET}`);
  console.log();
}

// ── Cron commands ───────────────────────────────────────────────────

const cronCmd = program
  .command('cron')
  .description('Manage and run cron jobs');

cronCmd
  .command('list')
  .description('List all cron jobs from CRON.md')
  .action(() => {
    cmdCronList().catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

cronCmd
  .command('run <jobName>')
  .description('Run a specific cron job')
  .action((jobName: string) => {
    cmdCronRun(jobName).catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

cronCmd
  .command('run-due')
  .description('Run all jobs that are due now (for OS scheduler)')
  .action(() => {
    cmdCronRunDue().catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

cronCmd
  .command('runs [jobName]')
  .description('View run history (all jobs or a specific job)')
  .action((jobName?: string) => {
    cmdCronRuns(jobName).catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

cronCmd
  .command('add <name> <schedule> <prompt>')
  .description('Add a new cron job to CRON.md')
  .option('--tier <n>', 'Security tier (1-3)', '1')
  .action(async (name: string, schedule: string, prompt: string, opts: { tier?: string }) => {
    await cmdCronAdd(name, schedule, prompt, opts).catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

cronCmd
  .command('test <job>')
  .description('Dry-run a cron job immediately (does not log to history)')
  .action(async (job: string) => {
    await cmdCronTest(job).catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

cronCmd
  .command('install')
  .description('Install OS-level scheduler (launchd on macOS, crontab on Linux)')
  .action(cmdCronInstall);

cronCmd
  .command('uninstall')
  .description('Remove OS-level cron scheduler')
  .action(cmdCronUninstall);

// ── Workflow commands ────────────────────────────────────────────────

const workflowCmd = program
  .command('workflow')
  .description('Manage and run multi-step workflows');

workflowCmd
  .command('list')
  .description('List all workflows from vault/00-System/workflows/')
  .action(async () => {
    try {
      const { parseAllWorkflows } = await import('../agent/workflow-runner.js');
      const config = await import('../config.js');
      const workflows = parseAllWorkflows(config.WORKFLOWS_DIR);

      if (workflows.length === 0) {
        console.log('No workflows found. Add .md files to vault/00-System/workflows/.');
        return;
      }

      for (const wf of workflows) {
        const status = wf.enabled ? 'enabled' : 'disabled';
        const trigger = wf.trigger.schedule ? `schedule: ${wf.trigger.schedule}` : 'manual';
        console.log(`  ${wf.name} [${status}] — ${trigger}`);
        if (wf.description) console.log(`    ${wf.description}`);
        console.log(`    Steps: ${wf.steps.map(s => s.id).join(' → ')}`);
        if (Object.keys(wf.inputs).length > 0) {
          const inputStr = Object.entries(wf.inputs)
            .map(([k, v]) => `${k}${v.default ? `="${v.default}"` : ''}`)
            .join(', ');
          console.log(`    Inputs: ${inputStr}`);
        }
      }
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

workflowCmd
  .command('run <name>')
  .description('Run a workflow by name')
  .option('--input <key=val...>', 'Input overrides', (val: string, prev: string[]) => {
    prev.push(val);
    return prev;
  }, [] as string[])
  .action(async (name: string, opts: { input: string[] }) => {
    try {
      const { parseAllWorkflows, WorkflowRunner } = await import('../agent/workflow-runner.js');
      const config = await import('../config.js');
      const { PersonalAssistant } = await import('../agent/assistant.js');

      const workflows = parseAllWorkflows(config.WORKFLOWS_DIR);
      const wf = workflows.find(w => w.name === name);
      if (!wf) {
        const available = workflows.map(w => w.name).join(', ');
        console.error(`Workflow "${name}" not found. Available: ${available || 'none'}`);
        process.exit(1);
      }

      // Parse inputs
      const inputs: Record<string, string> = {};
      for (const kv of opts.input) {
        const eq = kv.indexOf('=');
        if (eq > 0) inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
      }

      console.log(`Running workflow: ${name} (${wf.steps.length} steps)`);

      const assistant = new PersonalAssistant();
      const runner = new WorkflowRunner(assistant);

      const result = await runner.run(wf, inputs, (updates) => {
        // Print progress
        for (const u of updates) {
          if (u.status === 'running') console.log(`  [running] ${u.stepId}`);
          else if (u.status === 'done') console.log(`  [done]    ${u.stepId} (${Math.round((u.durationMs ?? 0) / 1000)}s)`);
          else if (u.status === 'failed') console.log(`  [failed]  ${u.stepId}`);
        }
      });

      console.log(`\nResult (${result.status}):\n${result.output}`);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

// ── Self-Improvement commands ────────────────────────────────────────

const siCmd = program
  .command('self-improve')
  .description('Manage Clementine self-improvement');

siCmd
  .command('status')
  .description('Show self-improvement state and baseline metrics')
  .action(async () => {
    try {
      const { SelfImproveLoop } = await import('../agent/self-improve.js');
      const { PersonalAssistant } = await import('../agent/assistant.js');
      const assistant = new PersonalAssistant();
      const loop = new SelfImproveLoop(assistant);
      const state = loop.loadState();
      const m = state.baselineMetrics;
      console.log(`Status: ${state.status}`);
      console.log(`Last run: ${state.lastRunAt || 'never'}`);
      console.log(`Total experiments: ${state.totalExperiments}`);
      console.log(`Pending approvals: ${state.pendingApprovals}`);
      console.log(`Baseline — Feedback: ${(m.feedbackPositiveRatio * 100).toFixed(0)}% positive, Cron: ${(m.cronSuccessRate * 100).toFixed(0)}% success, Quality: ${m.avgResponseQuality.toFixed(2)}`);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

siCmd
  .command('run')
  .description('Trigger a self-improvement cycle')
  .action(async () => {
    try {
      const { SelfImproveLoop } = await import('../agent/self-improve.js');
      const { PersonalAssistant } = await import('../agent/assistant.js');
      const assistant = new PersonalAssistant();
      const loop = new SelfImproveLoop(assistant);

      console.log('Starting self-improvement cycle...');
      const state = await loop.run(async (experiment) => {
        console.log(`  Proposal: ${experiment.area} | "${experiment.hypothesis.slice(0, 60)}" | ${(experiment.score * 10).toFixed(1)}/10`);
      });
      console.log(`\nCompleted: ${state.status}, ${state.currentIteration} iterations, ${state.pendingApprovals} pending approvals`);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

siCmd
  .command('history')
  .description('Show experiment history')
  .option('-n, --limit <n>', 'Number of entries to show', '10')
  .action(async (opts: { limit: string }) => {
    try {
      const { SelfImproveLoop } = await import('../agent/self-improve.js');
      const { PersonalAssistant } = await import('../agent/assistant.js');
      const assistant = new PersonalAssistant();
      const loop = new SelfImproveLoop(assistant);
      const limit = parseInt(opts.limit, 10) || 10;
      const log = loop.loadExperimentLog().slice(-limit).reverse();

      if (log.length === 0) {
        console.log('No experiment history yet.');
        return;
      }

      for (const e of log) {
        const status = e.accepted
          ? (e.approvalStatus === 'approved' ? '✅ approved' : '⏳ pending')
          : '❌ rejected';
        console.log(`#${e.iteration} | ${e.area} | ${(e.score * 10).toFixed(1)}/10 | ${status}`);
        console.log(`  ${e.hypothesis.slice(0, 80)}`);
      }
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

siCmd
  .command('apply <id>')
  .description('Approve and apply a pending change')
  .action(async (id: string) => {
    try {
      const { SelfImproveLoop } = await import('../agent/self-improve.js');
      const { PersonalAssistant } = await import('../agent/assistant.js');
      const assistant = new PersonalAssistant();
      const loop = new SelfImproveLoop(assistant);
      const result = await loop.applyApprovedChange(id);
      console.log(result);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

// ── Heartbeat command ───────────────────────────────────────────────

program
  .command('heartbeat')
  .description('Run a one-shot heartbeat check')
  .action(() => {
    cmdHeartbeat().catch((err: unknown) => {
      console.error('Error:', err);
      process.exit(1);
    });
  });

// ── OS scheduler install/uninstall ──────────────────────────────────

const CRON_LAUNCHD_LABEL = `com.${getAssistantName().toLowerCase()}.cron`;

function getCronPlistPath(): string {
  const home = process.env.HOME ?? '';
  return path.join(home, 'Library', 'LaunchAgents', `${CRON_LAUNCHD_LABEL}.plist`);
}

/**
 * Build a PATH string for launchd plists that includes all directories needed
 * to find node, claude CLI, and standard system binaries.
 */
function buildLaunchdPath(): string {
  const dirs = new Set<string>();

  // Include the directory containing the current node binary (nvm, homebrew, etc.)
  dirs.add(path.dirname(process.execPath));

  // Include directories where claude CLI might live
  const home = process.env.HOME ?? '';
  if (home) {
    dirs.add(path.join(home, '.local', 'bin'));  // common claude CLI location
  }

  // Standard system paths
  dirs.add('/usr/local/bin');
  dirs.add('/opt/homebrew/bin');
  dirs.add('/usr/bin');
  dirs.add('/bin');

  return [...dirs].join(':');
}

function cmdCronInstall(): void {
  const cliEntry = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
  const nodePath = process.execPath;
  const logDir = path.join(BASE_DIR, 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  const cronLog = path.join(logDir, 'cron.log');

  if (process.platform === 'darwin') {
    // macOS: launchd plist
    const plistPath = getCronPlistPath();
    const plistDir = path.dirname(plistPath);
    if (!existsSync(plistDir)) {
      mkdirSync(plistDir, { recursive: true });
    }

    // Unload existing plist if already installed (idempotent reinstall)
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
      } catch {
        // not loaded — fine
      }
    }

    // Generate StartCalendarInterval entries for every 5th minute (wall-clock aligned)
    const calendarEntries = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
      .map((m) => `    <dict>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>`)
      .join('\n');

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CRON_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliEntry}</string>
    <string>cron</string>
    <string>run-due</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${calendarEntries}
  </array>
  <key>StandardOutPath</key>
  <string>${cronLog}</string>
  <key>StandardErrorPath</key>
  <string>${cronLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${buildLaunchdPath()}</string>
    <key>CLEMENTINE_HOME</key>
    <string>${BASE_DIR}</string>
  </dict>
</dict>
</plist>`;

    writeFileSync(plistPath, plist);
    try {
      execSync(`launchctl load "${plistPath}"`);
      console.log(`  Installed cron scheduler: ${CRON_LAUNCHD_LABEL}`);
      console.log(`  Runs every 5 minutes via launchd`);
      console.log(`  Plist: ${plistPath}`);
      console.log(`  Logs:  ${cronLog}`);
      console.log();
      console.log(`  Note: This is a fallback for when the daemon is not running.`);
      console.log(`  If the daemon is active, its built-in scheduler handles cron jobs`);
      console.log(`  and the standalone runner will skip automatically.`);
    } catch (err) {
      console.error(`  Failed to load LaunchAgent: ${err}`);
    }
  } else {
    // Linux: crontab entry
    const marker = `# clementine-cron-runner`;
    const entry = `*/5 * * * * ${nodePath} ${cliEntry} cron run-due >> ${cronLog} 2>&1 ${marker}`;

    let existing = '';
    try {
      existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    } catch {
      // no existing crontab
    }

    if (existing.includes(marker)) {
      // Replace existing entry
      const lines = existing.split('\n').filter((l) => !l.includes(marker));
      lines.push(entry);
      const tempFile = path.join(os.tmpdir(), 'clementine-crontab.tmp');
      writeFileSync(tempFile, lines.join('\n') + '\n');
      execSync(`crontab "${tempFile}"`);
      unlinkSync(tempFile);
      console.log('  Updated existing crontab entry.');
    } else {
      const tempFile = path.join(os.tmpdir(), 'clementine-crontab.tmp');
      writeFileSync(tempFile, existing.trimEnd() + '\n' + entry + '\n');
      execSync(`crontab "${tempFile}"`);
      unlinkSync(tempFile);
      console.log('  Installed crontab entry.');
    }

    console.log(`  Runs every 5 minutes`);
    console.log(`  Logs: ${cronLog}`);
  }
}

function cmdCronUninstall(): void {
  if (process.platform === 'darwin') {
    const plistPath = getCronPlistPath();
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
      } catch {
        // not loaded
      }
      unlinkSync(plistPath);
      console.log(`  Uninstalled cron scheduler: ${CRON_LAUNCHD_LABEL}`);
    } else {
      console.log('  Cron scheduler not installed.');
    }
  } else {
    const marker = `# clementine-cron-runner`;
    let existing = '';
    try {
      existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    } catch {
      console.log('  No crontab found.');
      return;
    }

    if (!existing.includes(marker)) {
      console.log('  Cron scheduler not installed in crontab.');
      return;
    }

    const lines = existing.split('\n').filter((l) => !l.includes(marker));
    const tempFile = path.join(os.tmpdir(), 'clementine-crontab.tmp');
    writeFileSync(tempFile, lines.join('\n'));
    execSync(`crontab "${tempFile}"`);
    unlinkSync(tempFile);
    console.log('  Removed crontab entry.');
  }
}

// ── Logs command ────────────────────────────────────────────────────

function formatLogLine(line: string): string {
  try {
    const entry = JSON.parse(line);
    const ts = typeof entry.time === 'number'
      ? new Date(entry.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : String(entry.time ?? '').slice(11, 19);

    const level = entry.level ?? 30;
    const levelName = level <= 20 ? 'DEBUG' : level <= 30 ? 'INFO' : level <= 40 ? 'WARN' : 'ERROR';
    const levelColors: Record<string, string> = {
      DEBUG: '\x1b[0;90m', INFO: '\x1b[0;32m', WARN: '\x1b[1;33m', ERROR: '\x1b[0;31m',
    };
    const color = levelColors[levelName] ?? '';
    const RESET = '\x1b[0m';
    const DIM = '\x1b[0;90m';
    const component = entry.name ? entry.name.replace('clementine.', '') : '';
    const msg = entry.msg ?? '';
    return `${DIM}${ts}${RESET} ${color}${levelName.padEnd(5)}${RESET} ${DIM}[${component}]${RESET} ${msg}`;
  } catch {
    return line;
  }
}

function cmdLogs(opts: { follow?: boolean; lines?: string; filter?: string; cron?: boolean; json?: boolean }): void {
  const logDir = path.join(BASE_DIR, 'logs');
  const logFile = opts.cron
    ? path.join(logDir, 'cron.log')
    : path.join(logDir, 'clementine.log');

  if (!existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  const numLines = parseInt(opts.lines ?? '50', 10) || 50;
  const filter = opts.filter?.toLowerCase();

  // Read last N lines
  const content = readFileSync(logFile, 'utf-8');
  let lines = content.split('\n').filter(Boolean);
  lines = lines.slice(-numLines);

  // Apply component filter
  if (filter) {
    lines = lines.filter(line => {
      try {
        const entry = JSON.parse(line);
        const name = String(entry.name ?? '').toLowerCase();
        return name.includes(filter);
      } catch {
        return line.toLowerCase().includes(filter);
      }
    });
  }

  // Output
  for (const line of lines) {
    if (opts.json) {
      console.log(line);
    } else {
      console.log(formatLogLine(line));
    }
  }

  // Follow mode
  if (opts.follow) {
    let lastSize = statSync(logFile).size;

    const poll = setInterval(() => {
      try {
        const currentSize = statSync(logFile).size;
        if (currentSize < lastSize) {
          // Log rotation — reset
          lastSize = 0;
        }
        if (currentSize === lastSize) return;

        // Read new bytes
        const fd = openSync(logFile, 'r');
        const buf = Buffer.alloc(currentSize - lastSize);
        readSync(fd, buf, 0, buf.length, lastSize);
        closeSync(fd);
        lastSize = currentSize;

        const newLines = buf.toString('utf-8').split('\n').filter(Boolean);
        for (const line of newLines) {
          if (filter) {
            try {
              const entry = JSON.parse(line);
              const name = String(entry.name ?? '').toLowerCase();
              if (!name.includes(filter)) continue;
            } catch {
              if (!line.toLowerCase().includes(filter)) continue;
            }
          }
          if (opts.json) {
            console.log(line);
          } else {
            console.log(formatLogLine(line));
          }
        }
      } catch {
        // File may be temporarily unavailable during rotation
      }
    }, 500);

    process.on('SIGINT', () => {
      clearInterval(poll);
      process.exit(0);
    });
  }
}

program
  .command('logs')
  .description('Tail and filter daemon logs')
  .option('-f, --follow', 'Follow mode (tail -f)')
  .option('-n, --lines <n>', 'Number of lines (default 50)', '50')
  .option('--filter <component>', 'Filter by component (e.g. discord, cron, gateway)')
  .option('--cron', 'Show cron log instead of daemon log')
  .option('--json', 'Raw JSON output')
  .action(cmdLogs);

program.parse();
