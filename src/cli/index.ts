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
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
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

  // Stop any existing instance first
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`  Stopping existing instance (PID ${existingPid})...`);
    killPid(existingPid);
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
  killPid(pid);

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

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major >= 20) {
    console.log(`  ${GREEN}OK${RESET}  Node.js ${nodeVersion}`);
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

program.parse();
