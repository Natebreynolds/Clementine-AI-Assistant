#!/usr/bin/env node
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
  .command('update')
  .description('Pull latest code, rebuild, and reinstall (preserves config)')
  .option('--restart', 'Restart daemon after update')
  .option('--dry-run', 'Preview what would happen without making changes')
  .action((options: { restart?: boolean; dryRun?: boolean }) => {
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

  // 2. Stash any local customizations so pull succeeds
  let didStash = false;
  try {
    const status = execSync('git status --porcelain', { cwd: PACKAGE_ROOT, encoding: 'utf-8' }).trim();
    if (status) {
      console.log(`  ${DIM}Local customizations detected — stashing...${RESET}`);
      const stashOut = execSync('git stash', { cwd: PACKAGE_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      didStash = !stashOut.includes('No local changes');
      if (didStash) {
        console.log(`  ${GREEN}OK${RESET}  Stashed local customizations`);
      }
    }
  } catch {
    // not fatal — pull may still succeed if changes don't conflict
  }

  // 3. Back up user config
  const backupDir = path.join(BASE_DIR, 'backups', `pre-update-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`);
  console.log(`  ${DIM}Backing up config to ${backupDir}${RESET}`);

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
    console.log(`  Stopping daemon (PID ${pid})...`);
    if (!options.dryRun) {
      stopDaemon(pid!);
      try { unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    }
    console.log(`  ${GREEN}OK${RESET}  Daemon stopped`);
  }

  if (options.dryRun) {
    console.log();
    console.log(`  ${DIM}Dry run — would execute:${RESET}`);
    console.log(`    git -C "${PACKAGE_ROOT}" pull --ff-only`);
    console.log(`    npm install --loglevel=error --no-audit  (in ${PACKAGE_ROOT})`);
    console.log(`    npm run build`);
    console.log(`    npm install -g . --loglevel=error --no-audit`);
    console.log(`    clementine doctor`);
    if (options.restart || wasRunning) {
      console.log('    clementine launch');
    }
    console.log();
    return;
  }

  // 5. Git pull
  console.log(`  Pulling latest...`);
  try {
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
    console.log();
    console.log(`  ${DIM}Config backup is at: ${backupDir}${RESET}`);
    process.exit(1);
  }

  // 6. npm install
  console.log('  Installing dependencies...');
  try {
    execSync('npm install --loglevel=error --no-audit', {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  ${GREEN}OK${RESET}  Dependencies installed`);
  } catch (err) {
    console.error(`  ${RED}FAIL${RESET}  npm install failed: ${String(err).slice(0, 200)}`);
    console.log(`  ${DIM}Config backup is at: ${backupDir}${RESET}`);
    process.exit(1);
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

  // 7. Build
  console.log('  Building...');
  try {
    execSync('npm run build', {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  ${GREEN}OK${RESET}  Build succeeded`);
  } catch (err) {
    console.error(`  ${RED}FAIL${RESET}  Build failed: ${String(err).slice(0, 200)}`);
    console.log(`  ${DIM}Config backup is at: ${backupDir}${RESET}`);
    process.exit(1);
  }

  // 8. Reinstall globally
  console.log('  Reinstalling CLI globally...');
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

  // 9. Restore stashed local customizations
  if (didStash) {
    try {
      execSync('git stash pop', {
        cwd: PACKAGE_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`  ${GREEN}OK${RESET}  Local customizations restored`);
    } catch {
      console.error(`  ${YELLOW}WARN${RESET}  Could not auto-restore local changes (conflict)`);
      console.log(`       Your changes are saved in: git -C "${PACKAGE_ROOT}" stash list`);
      console.log(`       Restore manually with: git -C "${PACKAGE_ROOT}" stash pop`);
    }
  }

  // 10. Doctor check
  console.log();
  console.log(`  ${DIM}Running health check...${RESET}`);
  cmdDoctor();

  // 11. Restart if requested or was running
  if (options.restart || wasRunning) {
    console.log('  Restarting daemon...');
    cmdLaunch({});
  }

  // 12. Show current version
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: PACKAGE_ROOT,
      encoding: 'utf-8',
    }).trim();
    const date = execSync('git log -1 --format=%ci HEAD', {
      cwd: PACKAGE_ROOT,
      encoding: 'utf-8',
    }).trim().slice(0, 10);
    console.log();
    console.log(`  ${GREEN}Updated to ${hash} (${date})${RESET}`);
  } catch {
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

program.parse();
