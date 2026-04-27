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
  readdirSync,
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
import { cmdIngestSeed, cmdIngestRun, cmdIngestList, cmdIngestStatus } from './ingest.js';
import { isSensitiveEnvKey } from '../secrets/sensitivity.js';

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

function getSystemdServiceName(): string {
  return `${getAssistantName().toLowerCase()}.service`;
}

function getSystemdServicePath(): string {
  const home = process.env.HOME ?? '';
  return path.join(home, '.config', 'systemd', 'user', getSystemdServiceName());
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

/** Stop the daemon safely: disable the service manager first (prevents respawn), then kill the process. */
function stopDaemon(pid: number): void {
  if (process.platform === 'darwin') {
    // Unload LaunchAgent BEFORE killing — otherwise launchd respawns it immediately
    const plist = getLaunchdPlistPath();
    if (existsSync(plist)) {
      try {
        execSync(`launchctl unload "${plist}"`, { stdio: 'pipe' });
      } catch {
        // not loaded — that's fine
      }
    }
  } else if (process.platform === 'linux') {
    // Stop systemd service BEFORE killing — otherwise systemd respawns it
    const servicePath = getSystemdServicePath();
    if (existsSync(servicePath)) {
      try {
        execSync(`systemctl --user stop ${getSystemdServiceName()}`, { stdio: 'pipe' });
      } catch {
        // not active — that's fine
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
    if (process.platform === 'darwin') {
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
    } else if (process.platform === 'linux') {
      const servicePath = getSystemdServicePath();
      const serviceName = getSystemdServiceName();
      if (existsSync(servicePath)) {
        try {
          execSync(`systemctl --user stop ${serviceName}`, { stdio: 'ignore' });
          execSync(`systemctl --user disable ${serviceName}`, { stdio: 'ignore' });
        } catch {
          // not active
        }
        unlinkSync(servicePath);
        try {
          execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
        } catch { /* ignore */ }
        console.log(`  Uninstalled systemd service: ${serviceName}`);
      } else {
        console.log('  Systemd service not installed.');
      }
    }
    return;
  }

  if (options.install) {
    if (process.platform === 'darwin') {
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
    } else if (process.platform === 'linux') {
      const servicePath = getSystemdServicePath();
      const serviceName = getSystemdServiceName();
      const serviceDir = path.dirname(servicePath);
      if (!existsSync(serviceDir)) {
        mkdirSync(serviceDir, { recursive: true });
      }

      // Stop existing service if already installed (idempotent reinstall)
      if (existsSync(servicePath)) {
        try {
          execSync(`systemctl --user stop ${serviceName}`, { stdio: 'ignore' });
        } catch {
          // not active — fine
        }
      }

      const nodePath = process.execPath;
      const logDir = path.join(BASE_DIR, 'logs');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      const envPath = path.join(BASE_DIR, '.env');
      const servicePATH = [path.dirname(nodePath), '/usr/local/bin', '/usr/bin', '/bin']
        .join(':');

      const unit = `[Unit]
Description=${getAssistantName()} AI Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${DIST_ENTRY}
WorkingDirectory=${BASE_DIR}
Environment=PATH=${servicePATH}
Environment=CLEMENTINE_HOME=${BASE_DIR}
EnvironmentFile=-${envPath}
Restart=always
RestartSec=5
StandardOutput=append:${path.join(logDir, 'clementine.log')}
StandardError=append:${path.join(logDir, 'clementine-error.log')}

[Install]
WantedBy=default.target
`;

      writeFileSync(servicePath, unit);
      try {
        execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
        execSync(`systemctl --user enable --now ${serviceName}`, { stdio: 'pipe' });
        // Enable lingering so the service runs even when the user is not logged in (VPS)
        try {
          execSync(`loginctl enable-linger $(whoami)`, { stdio: 'pipe' });
        } catch {
          console.log('  Note: Could not enable linger. Run as root: loginctl enable-linger $(whoami)');
        }
        console.log(`  Installed and started systemd service: ${serviceName}`);
        console.log(`  Service: ${servicePath}`);
        console.log(`  Logs:    ${logDir}/`);
        console.log(`  Status:  systemctl --user status ${serviceName}`);
      } catch (err) {
        console.error(`  Failed to enable systemd service: ${err}`);
      }
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

async function cmdRestart(options: { foreground?: boolean }): Promise<void> {
  cmdStop();

  // Kill ALL dashboard processes (not just PID file — catches orphans)
  let dashboardWasRunning = false;
  try {
    const { killExistingDashboards } = await import('./dashboard.js');
    const killed = killExistingDashboards();
    if (killed > 0) {
      dashboardWasRunning = true;
      console.log(`  Stopped ${killed} dashboard process(es).`);
    }
  } catch { /* dashboard module may not be available */ }

  cmdLaunch({ foreground: options.foreground });

  if (dashboardWasRunning) {
    try {
      const { spawn: spawnProc } = await import('node:child_process');
      const child = spawnProc(
        'node', [path.join(PACKAGE_ROOT, 'dist/cli/index.js'), 'dashboard'],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      console.log('  Dashboard relaunched.');
    } catch {
      console.log('  Could not relaunch dashboard — run: clementine dashboard');
    }
  }
}

function cmdStatus(): void {
  const DIM = '\x1b[0;90m';
  const RESET = '\x1b[0m';
  const pid = readPid();
  const name = getAssistantName();
  const localVersion = readPkgVersion(PACKAGE_ROOT);

  if (!pid) {
    console.log(`  ${name} is not running ${DIM}(no PID file, v${localVersion})${RESET}.`);
    surfaceUpdateNudge(localVersion);
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`  ${name} is not running ${DIM}(stale PID ${pid}, v${localVersion})${RESET}.`);
    surfaceUpdateNudge(localVersion);
    return;
  }

  console.log(`  ${name} is running ${DIM}(PID ${pid}, v${localVersion})${RESET}`);

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

  surfaceUpdateNudge(localVersion);
}

/**
 * Print a one-line nudge if a newer version is on npm. Reads the cached
 * result synchronously (no network on the hot path) and fires off an async
 * refresh in the background so the next call has fresh data.
 */
function surfaceUpdateNudge(localVersion: string): void {
  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const YELLOW = '\x1b[1;33m';
  const RESET = '\x1b[0m';
  try {
    const cached = (() => {
      // Lazy require to avoid pulling https/network into trivial CLI calls
      // when the cache module isn't needed.
      const { readCachedUpdateCheck } = require('./version-check.js') as typeof import('./version-check.js');
      return readCachedUpdateCheck(BASE_DIR, localVersion);
    })();
    if (cached?.updateAvailable && cached.latestVersion) {
      console.log(`  ${YELLOW}⬆${RESET}  Update available: ${BOLD}v${cached.latestVersion}${RESET} ${DIM}(you're on v${localVersion})${RESET}`);
      console.log(`     ${DIM}Run: ${BOLD}clementine update restart${RESET}`);
    }
    // Fire-and-forget background refresh — never blocks status output.
    const { checkForUpdate } = require('./version-check.js') as typeof import('./version-check.js');
    void checkForUpdate(BASE_DIR, localVersion).catch(() => { /* silent */ });
  } catch {
    // version-check failed to load — degrade silently
  }
}

function cmdDoctor(opts: { fix?: boolean } = {}): void {
  const DIM = '\x1b[0;90m';
  const GREEN = '\x1b[0;32m';
  const RED = '\x1b[0;31m';
  const YELLOW = '\x1b[1;33m';
  const CYAN = '\x1b[0;36m';
  const RESET = '\x1b[0m';
  const fix = opts.fix ?? false;

  console.log();
  console.log(`  ${DIM}Data home: ${BASE_DIR}${RESET}`);
  console.log(`  ${DIM}Running health checks...${fix ? ` (auto-fix enabled)` : ''}${RESET}`);
  console.log();

  let issues = 0;
  let fixed = 0;
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  let hasBrew = isMac && (() => { try { execSync('which brew', { stdio: 'pipe' }); return true; } catch { return false; } })();
  const hasApt = isLinux && (() => { try { execSync('which apt-get', { stdio: 'pipe' }); return true; } catch { return false; } })();

  // Homebrew official installer. Honors NONINTERACTIVE=1 (set by tryFix) so
  // it won't block on sudo or "Press Return" prompts, though it still needs
  // the password cached or sudoless access. Surfaced as copy-paste guidance
  // when --fix is off.
  const BREW_INSTALL_CMD = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

  /** Resolve the current brew binary path after a fresh install. */
  const brewBin = (): string => {
    for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
      if (existsSync(p)) return p;
    }
    return 'brew';
  };

  /** Attempt a fix command, return true on success. */
  function tryFix(label: string, cmd: string, opts?: { cwd?: string; timeout?: number }): boolean {
    if (!fix) return false;
    console.log(`       ${CYAN}Fixing:${RESET} ${cmd}`);
    try {
      execSync(cmd, {
        stdio: ['pipe', 'inherit', 'inherit'],  // No stdin — prevent interactive prompts
        timeout: opts?.timeout ?? 120000,
        cwd: opts?.cwd,
        env: { ...process.env, NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1' },
      });
      console.log(`       ${GREEN}Fixed!${RESET}  ${label}`);
      fixed++;
      return true;
    } catch {
      console.log(`       ${RED}Fix failed.${RESET} Run manually: ${cmd}`);
      return false;
    }
  }

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
    if (!tryFix('claude CLI', 'npm install -g @anthropic-ai/claude-code')) {
      console.log(`       Install: npm install -g @anthropic-ai/claude-code`);
      issues++;
    }
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
    if (!tryFix('better-sqlite3', 'npm rebuild better-sqlite3', { cwd: PACKAGE_ROOT })) {
      console.log(`       Fix: cd ${PACKAGE_ROOT} && npm rebuild better-sqlite3`);
      issues++;
    }
  }

  // macOS: if Homebrew is missing and --fix is on, install it up front so
  // the subsequent redis-server / libomp checks can auto-resolve. Brew's
  // installer honors NONINTERACTIVE=1 (which tryFix sets), but still needs
  // sudo access — fails gracefully and falls back to copy-paste guidance
  // if sudo isn't available.
  if (isMac && !hasBrew && fix) {
    console.log(`  ${RED}FAIL${RESET}  Homebrew not installed (required to install graph-memory deps)`);
    if (tryFix('Homebrew', BREW_INSTALL_CMD, { timeout: 600000 })) {
      hasBrew = existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew');
    }
    if (!hasBrew) {
      console.log(`       Install manually, then re-run ${CYAN}clementine doctor --fix${RESET}:`);
      console.log(`         ${BREW_INSTALL_CMD}`);
      issues++;
    }
  } else if (isMac && !hasBrew) {
    console.log(`  ${RED}FAIL${RESET}  Homebrew not installed (required to install graph-memory deps)`);
    console.log(`       Install it, then run ${CYAN}clementine doctor --fix${RESET}:`);
    console.log(`         ${BREW_INSTALL_CMD}`);
    issues++;
  }

  // FalkorDB graph engine — system dependencies: redis
  // The knowledge-graph layer is a core memory feature. Missing deps are
  // a blocking issue: the daemon technically launches (graph-store.ts has
  // a no-op degradation path), but memory features the framework depends
  // on are silently absent. Surface it loudly.
  try {
    execSync('which redis-server', { stdio: 'pipe' });
    console.log(`  ${GREEN}OK${RESET}  redis-server found`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  redis-server not found (required for graph memory)`);
    const fixCmd = hasBrew ? `${brewBin()} install redis` : hasApt ? 'sudo apt-get install -y redis-server' : null;
    if (fixCmd && tryFix('redis-server', fixCmd)) {
      // fixed
    } else {
      if (isMac && !hasBrew) {
        console.log(`       Install Homebrew first (see above), then ${CYAN}clementine doctor --fix${RESET}`);
      } else {
        console.log(`       Fix: brew install redis (macOS) or sudo apt install redis-server (Linux)`);
      }
      issues++;
    }
  }

  // FalkorDB graph engine — system dependencies: libomp
  try {
    const libompPaths = process.platform === 'darwin'
      ? ['/opt/homebrew/opt/libomp/lib/libomp.dylib', '/usr/local/opt/libomp/lib/libomp.dylib']
      : ['/usr/lib/libomp.so', '/usr/lib/x86_64-linux-gnu/libomp.so'];
    if (!libompPaths.some(p => existsSync(p))) {
      throw new Error('not found');
    }
    console.log(`  ${GREEN}OK${RESET}  libomp (OpenMP runtime) found`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  libomp (OpenMP runtime) not found (required for graph memory)`);
    const fixCmd = hasBrew ? `${brewBin()} install libomp` : hasApt ? 'sudo apt-get install -y libomp-dev' : null;
    if (fixCmd && tryFix('libomp', fixCmd)) {
      // fixed
    } else {
      if (isMac && !hasBrew) {
        console.log(`       Install Homebrew first (see above), then ${CYAN}clementine doctor --fix${RESET}`);
      } else {
        console.log(`       Fix: brew install libomp (macOS) or sudo apt install libomp-dev (Linux)`);
      }
      issues++;
    }
  }

  // FalkorDB graph engine — module binaries
  try {
    execSync(
      `node -e "const{BinaryManager}=require('falkordblite/dist/binary-manager.js');new BinaryManager().ensureBinaries().then(p=>{console.log(JSON.stringify(p));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`,
      { cwd: PACKAGE_ROOT, stdio: 'pipe', timeout: 30000 },
    );
    console.log(`  ${GREEN}OK${RESET}  FalkorDB graph engine binaries installed`);
  } catch {
    console.log(`  ${RED}FAIL${RESET}  FalkorDB graph engine binaries not available`);
    if (!tryFix('FalkorDB binaries', `node node_modules/falkordblite/scripts/postinstall.js`, { cwd: PACKAGE_ROOT, timeout: 180000 })) {
      console.log(`       Fix: cd ${PACKAGE_ROOT} && node node_modules/falkordblite/scripts/postinstall.js`);
      console.log(`       ${DIM}(Usually self-heals once redis-server + libomp are installed)${RESET}`);
      issues++;
    }
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

  for (const [filePath, _label] of requiredVaultFiles) {
    if (existsSync(path.join(vaultDir, filePath))) {
      console.log(`  ${GREEN}OK${RESET}  vault/${filePath}`);
    } else {
      console.log(`  ${RED}FAIL${RESET}  vault/${filePath} missing`);
      issues++;
    }
  }

  // Vault directories & assets summary
  const vaultDirs = [
    ['00-System/skills', 'Skills (procedural memory)'],
    ['00-System/agents', 'Agent configs'],
  ] as const;
  for (const [dirPath] of vaultDirs) {
    const fullPath = path.join(vaultDir, dirPath);
    if (existsSync(fullPath)) {
      const count = readdirSync(fullPath).filter(f => f.endsWith('.md')).length;
      console.log(`  ${GREEN}OK${RESET}  vault/${dirPath}/ (${count} file${count !== 1 ? 's' : ''})`);
    } else {
      console.log(`  ${YELLOW}WARN${RESET}  vault/${dirPath}/ missing (will be created on launch)`);
    }
  }

  // Optional vault files (informational, not failures)
  const optionalFiles = [
    ['00-System/MEMORY.md', 'Long-term memory'],
    ['00-System/HEARTBEAT.md', 'Heartbeat config'],
    ['00-System/CRON.md', 'Cron jobs'],
    ['00-System/FEEDBACK.md', 'Communication preferences'],
  ] as const;
  for (const [filePath, label] of optionalFiles) {
    if (existsSync(path.join(vaultDir, filePath))) {
      console.log(`  ${GREEN}OK${RESET}  vault/${filePath}`);
    } else {
      console.log(`  ${DIM}  ○  vault/${filePath} (${label} — created on use)${RESET}`);
    }
  }

  // Memory database
  const memDbPath = path.join(vaultDir, '.memory.db');
  if (existsSync(memDbPath)) {
    const sizeKb = Math.round(statSync(memDbPath).size / 1024);
    console.log(`  ${GREEN}OK${RESET}  memory database (${sizeKb} KB)`);
  } else {
    console.log(`  ${DIM}  ○  memory database (created on first launch)${RESET}`);
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

  // Daemon runtime check — verify it's running and channels connected
  const pidFilePath = getPidFilePath();
  if (existsSync(pidFilePath)) {
    const daemonPid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
    let daemonAlive = false;
    try { process.kill(daemonPid, 0); daemonAlive = true; } catch { /* dead */ }
    if (daemonAlive) {
      console.log(`  ${GREEN}OK${RESET}  Daemon running (PID ${daemonPid})`);
      // Check recent logs for startup errors
      const logPath = path.join(BASE_DIR, 'logs', 'clementine.log');
      if (existsSync(logPath)) {
        try {
          const logLines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
          // Check last 200 lines for startup message, last 30 for errors
          const logTail = logLines.slice(-200);
          const recentTail = logLines.slice(-30);
          let discordOk = false;
          const recentErrors: string[] = [];
          for (const line of logTail) {
            try {
              const entry = JSON.parse(line);
              // Startup confirmation
              if (entry.msg?.includes('online as') || entry.msg?.includes('Clementine online')) discordOk = true;
              // Any discord activity (message processing, reactions, etc.) confirms connection
              if (entry.name === 'clementine.discord' && entry.pid === daemonPid) discordOk = true;
            } catch { /* skip */ }
          }
          for (const line of recentTail) {
            try {
              const entry = JSON.parse(line);
              if (entry.level >= 50 && entry.pid === daemonPid) recentErrors.push(entry.msg?.slice(0, 100) ?? '');
            } catch { /* skip */ }
          }
          if (discordOk) {
            console.log(`  ${GREEN}OK${RESET}  Discord connected`);
          } else {
            console.log(`  ${YELLOW}WARN${RESET}  Discord connection not confirmed in recent logs`);
            issues++;
          }
          if (recentErrors.length > 0) {
            console.log(`  ${YELLOW}WARN${RESET}  ${recentErrors.length} error(s) in recent logs:`);
            for (const err of recentErrors.slice(0, 3)) {
              console.log(`       ${DIM}${err}${RESET}`);
            }
            issues++;
          }
        } catch { /* log read failed */ }
      }
    } else {
      console.log(`  ${RED}FAIL${RESET}  Daemon not running (stale PID file: ${daemonPid})`);
      console.log(`       Start it: clementine launch`);
      issues++;
    }
  } else {
    console.log(`  ${DIM}  ○  Daemon not running${RESET}`);
  }

  // Service health check (platform-specific)
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
  } else if (process.platform === 'linux') {
    const servicePath = getSystemdServicePath();
    const serviceName = getSystemdServiceName();
    if (existsSync(servicePath)) {
      try {
        execSync(`systemctl --user is-active ${serviceName}`, { stdio: 'pipe' });
        console.log(`  ${GREEN}OK${RESET}  Systemd service installed and active`);
      } catch {
        console.log(`  ${YELLOW}WARN${RESET}  Systemd service installed but not active`);
        console.log(`       Start it: systemctl --user start ${serviceName}`);
        issues++;
      }
    } else {
      console.log(`  ${YELLOW}WARN${RESET}  Systemd service not installed (run: clementine launch --install)`);
      issues++;
    }
  }

  console.log();
  if (issues === 0 && fixed === 0) {
    console.log(`  ${GREEN}All checks passed.${RESET}`);
  } else if (issues === 0 && fixed > 0) {
    console.log(`  ${GREEN}All issues fixed!${RESET} (${fixed} auto-fixed)`);
  } else if (fixed > 0) {
    console.log(`  ${YELLOW}${issues} issue(s) remaining${RESET} (${fixed} auto-fixed)`);
  } else {
    console.log(`  ${YELLOW}${issues} issue(s) found.${RESET}${!fix ? ` Run ${CYAN}clementine doctor --fix${RESET} to auto-install dependencies.` : ''}`);
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

  // Mode 0o600 — credentials live here; never world-readable. Phase 12
  // hardening also fixes pre-existing .env files via `clementine config
  // harden-permissions`.
  writeFileSync(ENV_PATH, content, { mode: 0o600 });
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
        if (isSensitiveEnvKey(k) && v.length > 8) {
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

// ── Config show ──────────────────────────────────────────────────────

async function cmdConfigShow(opts: { json?: boolean; group?: string }): Promise<void> {
  const { computeEffectiveConfig } = await import('../config/effective-config.js');
  const cfg = computeEffectiveConfig(BASE_DIR);

  if (opts.json) {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[0;36m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const BLUE = '\x1b[0;34m';
  const RESET = '\x1b[0m';

  const sourceColor: Record<string, string> = {
    'process.env': YELLOW,
    '.env': GREEN,
    'clementine.json': CYAN,
    'system': BLUE,
    'default': DIM,
  };

  console.log();
  console.log(`  ${BOLD}Data home:${RESET}        ${cfg.baseDir}`);
  console.log(`  ${BOLD}.env present:${RESET}     ${cfg.hasEnvFile ? GREEN + 'yes' : DIM + 'no'}${RESET}`);
  console.log(`  ${BOLD}clementine.json:${RESET}  ${cfg.hasJsonFile ? GREEN + 'present' : DIM + 'missing — defaults active'}${RESET}`);
  console.log();
  console.log(`  ${DIM}Sources (highest precedence first):${RESET}`);
  console.log(`    ${YELLOW}process.env${RESET}     runtime override`);
  console.log(`    ${GREEN}.env${RESET}            ~/.clementine/.env`);
  console.log(`    ${CYAN}clementine.json${RESET} canonical user config`);
  console.log(`    ${BLUE}system${RESET}          OS-derived default (e.g., timezone)`);
  console.log(`    ${DIM}default${RESET}         compiled fallback`);
  console.log();

  // Group entries
  const filtered = opts.group
    ? cfg.entries.filter(e => e.group === opts.group)
    : cfg.entries;

  const byGroup = new Map<string, typeof filtered>();
  for (const entry of filtered) {
    const g = entry.group ?? 'misc';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(entry);
  }

  if (filtered.length === 0) {
    console.log(`  ${DIM}No entries${opts.group ? ` in group "${opts.group}"` : ''}.${RESET}`);
    console.log();
    return;
  }

  // Column widths
  const keyWidth = Math.max(...filtered.map(e => e.key.length));
  const valueWidth = Math.max(...filtered.map(e => String(e.value).length), 12);

  const RED = '\x1b[0;31m';

  for (const [group, entries] of byGroup) {
    console.log(`  ${BOLD}${group}${RESET}`);
    for (const entry of entries) {
      const c = sourceColor[entry.source] ?? RESET;
      const valueStr = String(entry.value);
      const annotations: string[] = [];
      if (entry.resolvedFrom === 'keychain') annotations.push(`${BLUE}via keychain${RESET}`);
      if (entry.unresolvedRef) annotations.push(`${RED}UNRESOLVED REF — using fallback${RESET}`);
      if (entry.shadowedBy && entry.shadowedBy.length > 0) annotations.push(`${DIM}shadows: ${entry.shadowedBy.join(', ')}${RESET}`);
      const annot = annotations.length > 0 ? ` ${DIM}(${RESET}${annotations.join(`${DIM},${RESET} `)}${DIM})${RESET}` : '';
      console.log(`    ${entry.key.padEnd(keyWidth)}  ${valueStr.padEnd(valueWidth)}  ${c}${entry.source}${RESET}${annot}`);
    }
    console.log();
  }
}

// ── Config doctor ────────────────────────────────────────────────────

async function cmdConfigDoctor(opts: { json?: boolean }): Promise<void> {
  const { runDoctor } = await import('../config/config-doctor.js');
  const report = runDoctor(BASE_DIR);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.exitCode);
  }

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const RED = '\x1b[0;31m';
  const RESET = '\x1b[0m';

  const sevColor = { error: RED, warning: YELLOW, info: DIM };
  const sevSymbol = { error: '✗', warning: '⚠', info: '·' };

  console.log();
  console.log(`  ${BOLD}Data home:${RESET}        ${report.baseDir}`);
  console.log(`  ${BOLD}.env present:${RESET}     ${report.hasEnvFile ? GREEN + 'yes' : DIM + 'no'}${RESET}`);
  console.log(`  ${BOLD}clementine.json:${RESET}  ${report.hasJsonFile ? GREEN + 'present' : DIM + 'missing'}${RESET}`);
  console.log();

  if (report.findings.length === 0) {
    console.log(`  ${GREEN}✓ All checks passed.${RESET}`);
    console.log();
    process.exit(0);
  }

  for (const f of report.findings) {
    const c = sevColor[f.severity];
    const sym = sevSymbol[f.severity];
    const keyTag = f.key ? `${BOLD}${f.key}${RESET} ${DIM}—${RESET} ` : '';
    console.log(`  ${c}${sym}${RESET} ${keyTag}${f.message}`);
    if (f.fix) {
      console.log(`    ${DIM}↳${RESET} ${f.fix}`);
    }
  }

  console.log();
  const summary: string[] = [];
  if (report.counts.error > 0) summary.push(`${RED}${report.counts.error} error${report.counts.error === 1 ? '' : 's'}${RESET}`);
  if (report.counts.warning > 0) summary.push(`${YELLOW}${report.counts.warning} warning${report.counts.warning === 1 ? '' : 's'}${RESET}`);
  if (report.counts.info > 0) summary.push(`${DIM}${report.counts.info} info${RESET}`);
  console.log(`  ${summary.join(', ')}`);
  console.log();
  process.exit(report.exitCode);
}

// ── Config migrate-to-keychain ───────────────────────────────────────

async function cmdConfigMigrateToKeychain(opts: { dryRun?: boolean; key?: string[] }): Promise<void> {
  const { planMigration, applyMigration } = await import('../config/migrate-keychain.js');

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const RED = '\x1b[0;31m';
  const CYAN = '\x1b[0;36m';
  const RESET = '\x1b[0m';

  // Commander gives us either ['a', 'b'] or ['a,b'] depending on how the
  // user passed the flag — normalize.
  const only = opts.key
    ? opts.key.flatMap(k => k.split(',').map(s => s.trim()).filter(Boolean))
    : undefined;

  const plan = planMigration(BASE_DIR, only ? { only } : {});

  console.log();
  console.log(`  ${BOLD}.env path:${RESET}  ${plan.envPath}`);
  console.log();

  if (plan.candidates.length === 0) {
    console.log(`  ${DIM}No env entries found (.env may be empty or missing).${RESET}`);
    console.log();
    return;
  }

  // Group by status for readable output
  const groups: Record<string, typeof plan.candidates> = {};
  for (const c of plan.candidates) {
    (groups[c.status] ??= []).push(c);
  }

  const renderGroup = (label: string, color: string, items: typeof plan.candidates) => {
    if (!items || items.length === 0) return;
    console.log(`  ${color}${label}${RESET} ${DIM}(${items.length})${RESET}`);
    for (const c of items) {
      console.log(`    ${c.key} ${DIM}(${c.valueLength} chars)${RESET}`);
    }
    console.log();
  };

  renderGroup('Will migrate to keychain', CYAN, groups.migrated);
  renderGroup('Already in keychain (skipped)', DIM, groups['already-keychain']);
  renderGroup('Not credential-shaped (skipped)', DIM, groups['not-sensitive']);
  renderGroup('Too short to be a credential (skipped)', DIM, groups['too-short']);

  if (plan.toMigrate.length === 0) {
    console.log(`  ${GREEN}Nothing to migrate.${RESET}`);
    console.log();
    return;
  }

  if (opts.dryRun) {
    console.log(`  ${YELLOW}Dry run — no changes written.${RESET}`);
    console.log(`  ${DIM}Re-run without --dry-run to apply.${RESET}`);
    console.log();
    return;
  }

  console.log(`  ${BOLD}Applying...${RESET}`);
  let result;
  try {
    result = applyMigration(BASE_DIR, only ? { only } : {});
  } catch (err) {
    console.error(`  ${RED}Failed:${RESET} ${(err as Error).message}`);
    process.exit(1);
  }

  if (result.failed.length > 0) {
    console.log(`  ${RED}Some keychain writes failed — .env was NOT modified:${RESET}`);
    for (const f of result.failed) {
      console.log(`    ${RED}✗${RESET} ${f.key}: ${f.error}`);
    }
    console.log();
    process.exit(1);
  }

  for (const key of result.migrated) {
    console.log(`    ${GREEN}✓${RESET} ${key} ${DIM}→ keychain${RESET}`);
  }
  console.log();
  console.log(`  ${GREEN}Migrated ${result.migrated.length} key${result.migrated.length === 1 ? '' : 's'}.${RESET}`);
  console.log(`  ${DIM}First daemon read of each ref will trigger a one-time keychain prompt;${RESET}`);
  console.log(`  ${DIM}choose Always Allow to make the prompt permanent.${RESET}`);
  console.log();
}

// ── Config migrate-from-keychain (inverse of migrate-to-keychain) ───

async function cmdConfigMigrateFromKeychain(opts: { dryRun?: boolean; key?: string[] }): Promise<void> {
  const { planReverseMigration, applyReverseMigration } = await import('../config/migrate-from-keychain.js');

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const RED = '\x1b[0;31m';
  const CYAN = '\x1b[0;36m';
  const RESET = '\x1b[0m';

  const only = opts.key
    ? opts.key.flatMap(k => k.split(',').map(s => s.trim()).filter(Boolean))
    : undefined;

  const plan = planReverseMigration(BASE_DIR, only ? { only } : {});

  console.log();
  console.log(`  ${BOLD}.env path:${RESET}  ${plan.envPath}`);
  console.log();

  const groups: Record<string, typeof plan.candidates> = {};
  for (const c of plan.candidates) (groups[c.status] ??= []).push(c);

  const renderGroup = (label: string, color: string, items: typeof plan.candidates, showRef = false) => {
    if (!items || items.length === 0) return;
    console.log(`  ${color}${label}${RESET} ${DIM}(${items.length})${RESET}`);
    for (const c of items) {
      const refTag = showRef && c.ref ? ` ${DIM}${c.ref}${RESET}` : '';
      console.log(`    ${c.key}${refTag}`);
    }
    console.log();
  };

  renderGroup('Will migrate from keychain → .env', CYAN, groups.migrated);
  renderGroup('Sensitive — left in keychain (correct)', DIM, groups['sensitive-skipped']);
  renderGroup('Unresolvable refs (keychain entry missing)', RED, groups.unresolvable, true);

  if (plan.toMigrate.length === 0) {
    console.log(`  ${GREEN}Nothing to migrate.${RESET}`);
    if (plan.unresolvable.length > 0) {
      console.log(`  ${YELLOW}${plan.unresolvable.length} unresolvable ref(s) above — fix or delete by hand.${RESET}`);
    }
    console.log();
    return;
  }

  if (opts.dryRun) {
    console.log(`  ${YELLOW}Dry run — no changes written.${RESET}`);
    console.log();
    return;
  }

  console.log(`  ${BOLD}Applying...${RESET}`);
  let result;
  try {
    result = applyReverseMigration(BASE_DIR, only ? { only } : {});
  } catch (err) {
    console.error(`  ${RED}Failed:${RESET} ${(err as Error).message}`);
    process.exit(1);
  }

  if (result.failed.length > 0) {
    console.log(`  ${RED}Some keychain reads failed — .env was NOT modified:${RESET}`);
    for (const f of result.failed) console.log(`    ${RED}✗${RESET} ${f.key}: ${f.error}`);
    console.log();
    process.exit(1);
  }

  for (const key of result.migrated) {
    console.log(`    ${GREEN}✓${RESET} ${key} ${DIM}→ .env (keychain entry deleted)${RESET}`);
  }
  console.log();
  console.log(`  ${GREEN}Migrated ${result.migrated.length} key${result.migrated.length === 1 ? '' : 's'} out of keychain.${RESET}`);
  console.log();
}

// ── Config harden-permissions ────────────────────────────────────────

async function cmdConfigHardenPermissions(opts: { dryRun?: boolean; json?: boolean }): Promise<void> {
  const { hardenPermissions } = await import('../config/harden-permissions.js');
  const report = hardenPermissions(BASE_DIR, { dryRun: opts.dryRun });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.failed > 0 ? 1 : 0);
  }

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const RED = '\x1b[0;31m';
  const CYAN = '\x1b[0;36m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${BOLD}Data home:${RESET}  ${report.baseDir}`);
  console.log(`  ${BOLD}Mode:${RESET}        ${opts.dryRun ? `${YELLOW}dry run${RESET}` : `${GREEN}apply${RESET}`}`);
  console.log();

  console.log(`  ${BOLD}Scanned:${RESET}         ${report.scanned}`);
  console.log(`  ${GREEN}Tightened:${RESET}       ${report.tightened}`);
  console.log(`  ${DIM}Already correct:${RESET} ${report.alreadyCorrect}`);
  console.log(`  ${DIM}Skipped:${RESET}         ${report.skipped}`);
  if (report.failed > 0) {
    console.log(`  ${RED}Failed:${RESET}          ${report.failed}`);
  }
  console.log();

  // Show first ~20 tightened entries — enough to see the shape without flooding
  const tightened = report.entries.filter(e => e.status === 'tightened').slice(0, 20);
  if (tightened.length > 0) {
    console.log(`  ${BOLD}${opts.dryRun ? 'Would tighten' : 'Tightened'} (showing first ${tightened.length}):${RESET}`);
    for (const e of tightened) {
      const rel = e.path.startsWith(report.baseDir + '/') ? e.path.slice(report.baseDir.length + 1) : e.path;
      const kindTag = e.kind === 'directory' ? `${CYAN}d${RESET}` : `${DIM}-${RESET}`;
      console.log(`    ${kindTag} ${e.beforeMode} ${DIM}→${RESET} ${GREEN}${e.afterMode}${RESET}  ${rel}`);
    }
    if (report.tightened > tightened.length) {
      console.log(`    ${DIM}... ${report.tightened - tightened.length} more${RESET}`);
    }
    console.log();
  }

  const failed = report.entries.filter(e => e.status === 'failed').slice(0, 10);
  if (failed.length > 0) {
    console.log(`  ${RED}${BOLD}Failed:${RESET}`);
    for (const e of failed) {
      console.log(`    ${RED}✗${RESET} ${e.path} — ${e.error ?? 'unknown'}`);
    }
    console.log();
  }

  if (opts.dryRun) {
    console.log(`  ${DIM}Re-run without --dry-run to apply.${RESET}`);
    console.log();
  } else if (report.tightened > 0) {
    console.log(`  ${GREEN}Done.${RESET} ${DIM}Re-run \`clementine config doctor\` to confirm permissions are now correct.${RESET}`);
    console.log();
  }
  process.exit(report.failed > 0 ? 1 : 0);
}

// ── Config keychain-fix-acl ─────────────────────────────────────────

async function cmdConfigKeychainFixAcl(opts: { list?: boolean }): Promise<void> {
  const { listClementineKeychainEntries, fixAllClementineEntries } =
    await import('../config/keychain-fix-acl.js');

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const RED = '\x1b[0;31m';
  const RESET = '\x1b[0m';

  const entries = listClementineKeychainEntries();

  console.log();
  console.log(`  ${BOLD}Found ${entries.length} clementine-agent keychain entr${entries.length === 1 ? 'y' : 'ies'}.${RESET}`);
  for (const e of entries) console.log(`    ${DIM}${e.account}${RESET}`);
  console.log();

  if (entries.length === 0) {
    console.log(`  ${GREEN}Nothing to fix.${RESET}`);
    console.log();
    return;
  }

  if (opts.list) {
    console.log(`  ${DIM}--list mode — no changes made. Drop the flag to apply.${RESET}`);
    console.log();
    return;
  }

  console.log(`  ${BOLD}Fixing ACLs...${RESET}`);
  console.log(`  ${DIM}macOS may ask for your login keychain password (the system prompt — it DOES appear).${RESET}`);
  console.log(`  ${DIM}You may also be asked to "Always Allow" — pick that.${RESET}`);
  console.log();

  const results = fixAllClementineEntries();
  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.status === 'fixed') {
      console.log(`    ${GREEN}✓${RESET} ${r.account}`);
      okCount++;
    } else {
      console.log(`    ${RED}✗${RESET} ${r.account} ${DIM}— ${r.error}${RESET}`);
      failCount++;
    }
  }
  console.log();
  if (failCount === 0) {
    console.log(`  ${GREEN}All ${okCount} entries fixed.${RESET} ${DIM}Future reads via the security CLI succeed silently.${RESET}`);
  } else {
    console.log(`  ${YELLOW}${okCount} fixed, ${failCount} failed.${RESET}`);
    console.log(`  ${DIM}Failed entries can be fixed manually in Keychain Access.app:${RESET}`);
    console.log(`  ${DIM}  search "clementine-agent" → double-click → Access Control → Allow all applications.${RESET}`);
  }
  console.log();
}

// ── Analytics ────────────────────────────────────────────────────────

async function cmdAnalyticsToolUsage(opts: { hours?: string; json?: boolean; limit?: string }): Promise<void> {
  const { buildToolUsageReport, defaultAuditLogPath } = await import('../analytics/tool-usage.js');
  const hours = Math.max(1, parseInt(opts.hours ?? '24', 10) || 24);
  const limit = Math.max(1, parseInt(opts.limit ?? '10', 10) || 10);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const report = buildToolUsageReport(defaultAuditLogPath(BASE_DIR), start.toISOString(), end.toISOString());

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[0;36m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[0;33m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${BOLD}Window:${RESET} last ${hours}h ${DIM}(${start.toISOString()} → ${end.toISOString()})${RESET}`);
  console.log(`  ${BOLD}Total tool calls:${RESET} ${report.totalToolCalls.toLocaleString()}`);
  console.log(`  ${BOLD}Total queries:${RESET}    ${report.totalQueries.toLocaleString()}`);
  console.log(`  ${BOLD}Total cost:${RESET}       ${GREEN}$${report.totalCostUsd.toFixed(4)}${RESET} ${DIM}(attributed to tools: $${report.attributedCostUsd.toFixed(4)})${RESET}`);
  console.log();

  if (report.families.length === 0) {
    console.log(`  ${DIM}No tool_use events in window.${RESET}`);
    console.log();
    return;
  }

  const top = report.families.slice(0, limit);
  const maxCost = Math.max(...top.map(f => f.estimatedCostUsd), 0.0001);
  const familyWidth = Math.max(...top.map(f => f.family.length), 12);

  console.log(`  ${BOLD}Top ${top.length} tool families ${DIM}(ranked by attributed cost)${RESET}`);
  for (const f of top) {
    const pct = report.attributedCostUsd > 0
      ? ((f.estimatedCostUsd / report.attributedCostUsd) * 100).toFixed(1)
      : '0.0';
    const barLen = Math.round((f.estimatedCostUsd / maxCost) * 24);
    const bar = '█'.repeat(barLen).padEnd(24);
    console.log(
      `    ${CYAN}${f.family.padEnd(familyWidth)}${RESET}  ` +
      `${GREEN}$${f.estimatedCostUsd.toFixed(2).padStart(7)}${RESET} ` +
      `${pct.padStart(5)}%  ` +
      `${DIM}${String(f.totalCalls).padStart(5)} calls${RESET}  ` +
      `${YELLOW}${bar}${RESET}`,
    );
    const topTools = f.byTool.slice(0, 2).map(t => `${t.tool}×${t.count}`).join(', ');
    const topSource = f.bySource[0];
    console.log(`      ${DIM}top tools: ${topTools}${RESET}`);
    if (topSource && topSource.source !== 'unknown') {
      console.log(`      ${DIM}driven by: ${topSource.source} (${topSource.count} calls)${RESET}`);
    }
  }
  console.log();
}

// ── Advisor commands ────────────────────────────────────────────────

const ADVISOR_MODES = ['off', 'shadow', 'primary'] as const;
type AdvisorMode = typeof ADVISOR_MODES[number];

function readAdvisorMode(): AdvisorMode {
  if (!existsSync(ENV_PATH)) return 'off';
  const content = readFileSync(ENV_PATH, 'utf-8');
  const match = content.match(/^CLEMENTINE_ADVISOR_RULES_LOADER=(.*)$/m);
  if (!match) return 'off';
  const raw = match[1].trim().toLowerCase();
  if (raw === 'shadow' || raw === 'primary') return raw;
  return 'off';
}

async function cmdAdvisorStatus(): Promise<void> {
  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[0;36m';
  const YELLOW = '\x1b[0;33m';
  const GREEN = '\x1b[0;32m';
  const RESET = '\x1b[0m';

  const mode = readAdvisorMode();
  const modeColor = mode === 'primary' ? GREEN : mode === 'shadow' ? CYAN : DIM;

  console.log();
  console.log(`  ${BOLD}Advisor mode:${RESET} ${modeColor}${mode}${RESET}`);
  if (mode === 'off') {
    console.log(`  ${DIM}Legacy TS path is the source of truth. Rule engine not loaded.${RESET}`);
  } else if (mode === 'shadow') {
    console.log(`  ${DIM}Rule engine runs alongside TS path; divergences logged but TS path wins.${RESET}`);
  } else {
    console.log(`  ${DIM}Rule engine is the source of truth; TS path used only as fallback.${RESET}`);
  }

  // Load the rules from disk to show the user-visible inventory.
  try {
    const { loadAdvisorRules } = await import('../agent/advisor-rules/loader.js');
    const rules = loadAdvisorRules();
    const builtinCount = rules.filter(r => r._sourcePath?.includes('/builtin/')).length;
    const userCount = rules.length - builtinCount;
    console.log();
    console.log(`  ${BOLD}Loaded rules:${RESET} ${rules.length} ${DIM}(${builtinCount} builtin, ${userCount} user)${RESET}`);
  } catch (err) {
    console.log(`  ${YELLOW}Could not load rules:${RESET} ${(err as Error).message}`);
  }

  console.log();
  console.log(`  ${DIM}Switch mode: clementine advisor mode <off|shadow|primary>${RESET}`);
  console.log(`  ${DIM}List rules:  clementine advisor rules${RESET}`);
  console.log();
}

function cmdAdvisorMode(mode: string): void {
  const YELLOW = '\x1b[0;33m';
  const GREEN = '\x1b[0;32m';
  const RESET = '\x1b[0m';

  const lower = mode.toLowerCase();
  if (!ADVISOR_MODES.includes(lower as AdvisorMode)) {
    console.error(`  Invalid mode "${mode}". Choose one of: ${ADVISOR_MODES.join(', ')}`);
    process.exit(1);
  }
  cmdConfigSet('CLEMENTINE_ADVISOR_RULES_LOADER', lower);
  console.log(`  ${GREEN}Advisor mode set to ${lower}.${RESET}`);
  console.log(`  ${YELLOW}Restart the daemon for the change to take effect:${RESET} clementine restart`);
}

async function cmdAdvisorRules(): Promise<void> {
  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[0;36m';
  const RESET = '\x1b[0m';

  try {
    const { loadAdvisorRules } = await import('../agent/advisor-rules/loader.js');
    const rules = loadAdvisorRules();
    if (rules.length === 0) {
      console.log('  No advisor rules loaded.');
      return;
    }
    console.log();
    console.log(`  ${BOLD}${'PRI'.padEnd(5)}${'ID'.padEnd(38)}SOURCE  DESCRIPTION${RESET}`);
    for (const r of rules) {
      const source = r._sourcePath?.includes('/builtin/') ? 'builtin' : 'user   ';
      const desc = (r.description || '').slice(0, 60);
      console.log(`  ${String(r.priority).padEnd(5)}${CYAN}${r.id.padEnd(38)}${RESET}${DIM}${source}${RESET}  ${desc}`);
    }
    console.log();
  } catch (err) {
    console.error(`  Error loading rules: ${(err as Error).message}`);
    process.exit(1);
  }
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

let pkgVersion = '0.0.0';
try {
  const pkgRaw = readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8');
  pkgVersion = String(JSON.parse(pkgRaw).version ?? '0.0.0');
} catch { /* fall back to placeholder */ }

program
  .name('clementine')
  .description('Clementine Personal AI Assistant')
  .version(pkgVersion);

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
  .command('setup')
  .description('Run interactive setup wizard')
  .action(() => {
    ensureDataHome();
    runSetup().catch((err: unknown) => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
  });

program
  .command('rebuild')
  .description('Rebuild from source and restart all processes (daemon + dashboard)')
  .action(async () => {
    const DIM = '\x1b[0;90m';
    const GREEN = '\x1b[0;32m';
    const RED = '\x1b[0;31m';
    const RESET = '\x1b[0m';

    console.log();
    console.log(`  ${DIM}Rebuilding ${getAssistantName()}...${RESET}`);

    // 1. Build
    console.log(`  [1] Building...`);
    try {
      execSync('npm run build', { cwd: PACKAGE_ROOT, stdio: 'pipe' });
      console.log(`  ${GREEN}OK${RESET}  Build succeeded`);
    } catch (err: unknown) {
      const msg = (err as { stderr?: Buffer }).stderr?.toString() || String(err);
      console.error(`  ${RED}FAIL${RESET}  Build failed:\n${msg}`);
      process.exit(1);
    }

    // 2. Reinstall globally so the `clementine` bin points to fresh code
    console.log(`  [2] Installing...`);
    try {
      execSync('npm install -g .', { cwd: PACKAGE_ROOT, stdio: 'pipe' });
      console.log(`  ${GREEN}OK${RESET}  Installed`);
    } catch {
      console.log(`  ${DIM}(global install skipped — not fatal)${RESET}`);
    }

    // 3. Restart everything
    console.log(`  [3] Restarting...`);
    cmdRestart({});

    console.log();
    console.log(`  ${GREEN}Done.${RESET} All processes restarted with fresh code.`);
    console.log();
  });

program
  .command('login')
  .description('Authenticate with Anthropic and save credentials to ~/.clementine/.env')
  .option('--api-key', 'Skip OAuth and use an API key instead')
  .action(async (opts: { apiKey?: boolean }) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const envPath = path.join(BASE_DIR, '.env');

    const testAuth = async (opts: { apiKey?: string; authToken?: string }): Promise<boolean> => {
      try {
        const client = new Anthropic(opts as any);
        await client.models.list({ limit: 1 });
        return true;
      } catch {
        return false;
      }
    };

    const saveToEnv = (credKey: string, value: string) => {
      mkdirSync(BASE_DIR, { recursive: true });
      let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      content = content.replace(new RegExp(`^${credKey}=.*$\\n?`, 'm'), '').trimEnd();
      content += `\n${credKey}=${value}\n`;
      writeFileSync(envPath, content, { mode: 0o600 });
    };

    // Read explicit credentials from .env
    let oauthToken: string | undefined;
    let authToken: string | undefined;
    let apiKey: string | undefined;
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      const oauthMatch = content.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
      const tokenMatch = content.match(/^ANTHROPIC_AUTH_TOKEN=(.+)$/m);
      const keyMatch = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (oauthMatch) oauthToken = oauthMatch[1].trim();
      if (tokenMatch) authToken = tokenMatch[1].trim();
      if (keyMatch) apiKey = keyMatch[1].trim();
    }
    if (!oauthToken) oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!authToken) authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY;

    // ── --api-key flag: skip straight to manual key entry ────────────
    if (opts.apiKey) {
      const CONSOLE_URL = 'https://console.anthropic.com/settings/keys';
      console.log('\n  Opening Anthropic API keys page...');
      try {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${opener} "${CONSOLE_URL}"`, { stdio: 'ignore' });
      } catch { /* non-fatal */ }
      console.log(`  ${CONSOLE_URL}`);
      console.log('  Paste your API key below and press Enter:\n');
      process.stdout.write('  Paste key > ');
      const key = await new Promise<string>((resolve) => {
        process.stdin.setRawMode?.(false);
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        process.stdin.once('data', (chunk) => { process.stdin.pause(); resolve(String(chunk).trim()); });
      });
      if (!key) { console.error('\n  No input.\n'); process.exit(1); }
      process.stdout.write('\n  Verifying...');
      const isOAuth = key.startsWith('sk-ant-oat') || key.startsWith('sk-ant-rt');
      const credKey = isOAuth ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
      const ok = await testAuth(isOAuth ? { authToken: key } : { apiKey: key });
      if (!ok) { console.error(' invalid.\n'); process.exit(1); }
      console.log(' ✓\n');
      saveToEnv(credKey, key);
      console.log(`  ✓ Saved ${credKey} to ~/.clementine/.env\n`);
      return;
    }

    console.log('\nChecking Anthropic authentication...\n');

    // Test existing explicit credentials first
    if (oauthToken) {
      process.stdout.write(`  CLAUDE_CODE_OAUTH_TOKEN  ${oauthToken.slice(0, 16)}...  `);
      if (await testAuth({ authToken: oauthToken })) { console.log('✓ valid\n'); return; }
      console.log('✗ expired');
    }
    if (authToken) {
      process.stdout.write(`  ANTHROPIC_AUTH_TOKEN     ${authToken.slice(0, 16)}...  `);
      if (await testAuth({ authToken })) { console.log('✓ valid\n'); return; }
      console.log('✗ expired');
    }
    if (apiKey) {
      process.stdout.write(`  ANTHROPIC_API_KEY        ${apiKey.slice(0, 16)}...  `);
      if (await testAuth({ apiKey })) { console.log('✓ valid\n'); return; }
      console.log('✗ expired');
    }

    // ── Try to pull token from Claude Code keychain (macOS) ──────────
    if (process.platform === 'darwin') {
      process.stdout.write('\n  Looking for Claude Code session in Keychain... ');
      try {
        const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const parsed = JSON.parse(raw);
        const token: string | undefined = parsed?.claudeAiOauth?.accessToken;
        if (token) {
          process.stdout.write('found. Verifying... ');
          if (await testAuth({ authToken: token })) {
            console.log('✓\n');
            saveToEnv('ANTHROPIC_AUTH_TOKEN', token);
            console.log('  ✓ Authenticated via Claude Code subscription');
            console.log('  Saved to ~/.clementine/.env — no API key needed.\n');
            return;
          }
          console.log('expired.');
        } else {
          console.log('not found.');
        }
      } catch {
        console.log('not found.');
      }
    }

    // ── Generate a long-lived token via claude setup-token ───────────
    console.log('\n  Generating a long-lived OAuth token via Claude Code...');
    console.log('  A browser window will open — complete the authorization, then come back here.\n');

    // Detect claude binary
    let claudeBin = 'claude';
    try { execSync('claude --version', { stdio: 'pipe' }); } catch {
      console.error('  `claude` not found on PATH.');
      console.error('  Install Claude Code first: https://claude.ai/code\n');
      process.exit(1);
    }

    const token = await new Promise<string | null>((resolve) => {
      let output = '';
      const child = spawn(claudeBin, ['setup-token'], { stdio: ['inherit', 'pipe', 'inherit'] });
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        output += text;
      });
      child.on('close', () => {
        // Token is printed to stdout — extract it
        const match = output.match(/sk-ant-[A-Za-z0-9_-]+/);
        resolve(match ? match[0] : null);
      });
      child.on('error', () => resolve(null));
    });

    if (!token) {
      console.error('\n  Could not extract token from output. Try again or use an API key:\n');
      console.error('  clementine login --api-key\n');
      process.exit(1);
    }

    // CLAUDE_CODE_OAUTH_TOKEN is only usable by the Claude Code subprocess —
    // not by the raw @anthropic-ai/sdk client. Trust that claude setup-token
    // already verified it during the OAuth flow; just save it directly.
    saveToEnv('CLAUDE_CODE_OAUTH_TOKEN', token);
    console.log('\n  ✓ Saved CLAUDE_CODE_OAUTH_TOKEN to ~/.clementine/.env');
    console.log('  This token is valid for one year and uses your Claude subscription.');
    console.log('  Run `clementine rebuild` to restart the daemon with the new token.\n');
  });

program
  .command('auth')
  .description('Show current authentication status')
  .action(async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const envPath = path.join(BASE_DIR, '.env');
    let oauthToken: string | undefined;
    let authToken: string | undefined;
    let apiKey: string | undefined;

    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      const oauthMatch = content.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
      const tokenMatch = content.match(/^ANTHROPIC_AUTH_TOKEN=(.+)$/m);
      const keyMatch = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (oauthMatch) oauthToken = oauthMatch[1].trim();
      if (tokenMatch) authToken = tokenMatch[1].trim();
      if (keyMatch) apiKey = keyMatch[1].trim();
    }
    if (!oauthToken) oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!authToken) authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY;

    const testAuth = async (opts: { apiKey?: string; authToken?: string }): Promise<boolean> => {
      try {
        const client = new Anthropic(opts as any);
        await client.models.list({ limit: 1 });
        return true;
      } catch {
        return false;
      }
    };

    console.log('\nClementine Auth Status');
    console.log('──────────────────────');

    if (oauthToken) {
      // CLAUDE_CODE_OAUTH_TOKEN is only valid for the SDK subprocess, not the raw API client.
      // Just confirm it's present — the daemon will surface auth errors if it's actually expired.
      console.log(`  CLAUDE_CODE_OAUTH_TOKEN  ${oauthToken.slice(0, 16)}...  ✓ set (1-year subscription token)`);
    }
    if (authToken) {
      process.stdout.write(`  ANTHROPIC_AUTH_TOKEN     ${authToken.slice(0, 16)}...  `);
      console.log(await testAuth({ authToken }) ? '✓ valid' : '✗ expired');
    }
    if (apiKey) {
      process.stdout.write(`  ANTHROPIC_API_KEY        ${apiKey.slice(0, 16)}...  `);
      console.log(await testAuth({ apiKey }) ? '✓ valid' : '✗ expired or revoked');
    }
    if (!oauthToken && !authToken && !apiKey) {
      console.log('  No explicit credentials in ~/.clementine/.env');
      console.log('  Daemon subprocess reads from macOS Keychain if Claude Code is installed.\n');
      console.log('  Run `clementine login` to set up credentials.');
    }

    console.log('\n  To refresh: clementine login');
    console.log('  API key only: clementine login --api-key\n');
  });

program
  .command('status')
  .description('Show assistant status')
  .action(cmdStatus);

program
  .command('doctor')
  .description('Run health checks')
  .option('--fix', 'Auto-install missing dependencies')
  .action((opts) => cmdDoctor(opts));

program
  .command('tools')
  .description('List available MCP tools, plugins, and channels')
  .action(cmdTools);

const advisorCmd = program
  .command('advisor')
  .description('Inspect and configure the execution advisor')
  .action(() => cmdAdvisorStatus());

advisorCmd
  .command('mode <mode>')
  .description('Set advisor mode (off | shadow | primary) — restart required')
  .action(cmdAdvisorMode);

advisorCmd
  .command('rules')
  .description('List loaded advisor rules')
  .action(cmdAdvisorRules);

const analyticsCmd = program
  .command('analytics')
  .description('Production telemetry: tool usage, cost breakdowns');

analyticsCmd
  .command('tool-usage')
  .description('Show which tool families are firing most over a time window')
  .option('-h, --hours <n>', 'Window size in hours (default 24)', '24')
  .option('--json', 'Emit machine-readable JSON')
  .option('-l, --limit <n>', 'Show top N families (default 10)', '10')
  .action(async (opts: { hours?: string; json?: boolean; limit?: string }) => {
    await cmdAnalyticsToolUsage(opts);
  });

const dashCmd = program
  .command('dashboard')
  .description('Launch local command center')
  .option('-p, --port <n>', 'Port (default 3030)', '3030')
  .action((opts: { port?: string }) => {
    cmdDashboard(opts).catch((err: unknown) => {
      console.error('Dashboard error:', err);
      process.exit(1);
    });
  });

dashCmd
  .command('restart')
  .description('Kill all running dashboard processes and relaunch')
  .option('-p, --port <n>', 'Port (default 3030)', '3030')
  .action(async (opts: { port?: string }) => {
    const { killExistingDashboards } = await import('./dashboard.js');
    const killed = killExistingDashboards();
    console.log(killed > 0 ? `  Killed ${killed} dashboard process(es).` : '  No dashboard processes found.');
    console.log('  Relaunching dashboard...');
    const { spawn } = await import('node:child_process');
    const child = spawn(
      'node', [path.join(PACKAGE_ROOT, 'dist/cli/index.js'), 'dashboard', '-p', opts.port ?? '3030'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    console.log('  Dashboard restarted.');
    process.exit(0);
  });

dashCmd
  .command('stop')
  .description('Stop all running dashboard processes')
  .action(async () => {
    const { killExistingDashboards } = await import('./dashboard.js');
    const killed = killExistingDashboards();
    console.log(killed > 0 ? `  Killed ${killed} dashboard process(es).` : '  No dashboard processes running.');
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
  .description('Pull latest code, rebuild, and reinstall (preserves config). Pass "history" to show recent updates.')
  .argument('[action]', 'Optional: "restart" = restart daemon after update; "history" = show update log')
  .option('--restart', 'Restart daemon after update')
  .option('--dry-run', 'Preview what would happen without making changes')
  .option('-n, --limit <n>', 'For history mode: max entries to show', '10')
  .action((action: string | undefined, options: { restart?: boolean; dryRun?: boolean; limit?: string }) => {
    if (action === 'history') {
      cmdUpdateHistory(parseInt(options.limit ?? '10', 10));
      return;
    }
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

configCmd
  .command('show')
  .description('Show effective config with provenance (env / json / default)')
  .option('--json', 'Emit machine-readable JSON instead of a table')
  .option('-g, --group <name>', 'Filter to a single group (e.g. budgets)')
  .action(async (opts: { json?: boolean; group?: string }) => {
    await cmdConfigShow(opts);
  });

configCmd
  .command('doctor')
  .description('Validate config: stale keychain refs, type errors, missing channel deps')
  .option('--json', 'Emit machine-readable JSON instead of a checklist')
  .action(async (opts: { json?: boolean }) => {
    await cmdConfigDoctor(opts);
  });

configCmd
  .command('migrate-to-keychain')
  .description('Move plaintext credentials in .env into the macOS keychain (NOT recommended in v1.1.4+ — keychain entries can produce per-process approval prompts; plain .env at mode 0600 is the supported default)')
  .option('--dry-run', 'Show what would migrate without writing anything')
  .option('-k, --key <name...>', 'Limit to specific key(s); repeat or comma-separate for multiple')
  .action(async (opts: { dryRun?: boolean; key?: string[] }) => {
    await cmdConfigMigrateToKeychain(opts);
  });

configCmd
  .command('migrate-from-keychain')
  .description('Pull non-credential values OUT of keychain back to plaintext .env (only API keys belong in keychain)')
  .option('--dry-run', 'Show what would migrate without writing anything')
  .option('-k, --key <name...>', 'Limit to specific key(s); repeat or comma-separate for multiple')
  .action(async (opts: { dryRun?: boolean; key?: string[] }) => {
    await cmdConfigMigrateFromKeychain(opts);
  });

configCmd
  .command('keychain-fix-acl')
  .description('One-shot fix for clementine-agent keychain entries that prompt on every read (one master prompt then no more)')
  .option('--list', 'List entries without changing anything')
  .action(async (opts: { list?: boolean }) => {
    await cmdConfigKeychainFixAcl(opts);
  });

configCmd
  .command('harden-permissions')
  .description('Tighten file modes in ~/.clementine/ — files to 0600, directories to 0700')
  .option('--dry-run', 'Preview without changing anything')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
    await cmdConfigHardenPermissions(opts);
  });

configCmd
  .command('edit')
  .description('Open .env in your editor')
  .action(() => {
    if (!existsSync(ENV_PATH)) {
      console.log('  No .env file found. Run: clementine config setup');
      process.exit(1);
    }
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    try {
      execSync(`${editor} "${ENV_PATH}"`, { stdio: 'inherit' });
    } catch {
      console.error(`  Failed to open editor: ${editor}`);
    }
  });

// ── Agent commands ──────────────────────────────────────────────────

const agentCmd = program
  .command('agent')
  .description('Hire, list, and manage specialist agents');

agentCmd
  .command('list')
  .description('List all agents with status and tier')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[0;90m';
    const GREEN = '\x1b[0;32m';
    const YELLOW = '\x1b[0;33m';
    const RED = '\x1b[0;31m';
    const RESET = '\x1b[0m';
    try {
      const { AgentManager } = await import('../agent/agent-manager.js');
      const AGENTS_DIR = path.join(BASE_DIR, 'agents');
      const mgr = new AgentManager(AGENTS_DIR);
      const agents = mgr.listAll();
      if (opts.json) {
        console.log(JSON.stringify(agents.map(a => ({
          slug: a.slug, name: a.name, status: a.status, tier: a.tier,
          description: a.description, hasChannel: !!a.team?.channelName,
        })), null, 2));
        return;
      }
      if (agents.length === 0) {
        console.log(`\n  No agents found in ${AGENTS_DIR}.`);
        console.log(`  Hire one: ${BOLD}clementine agent new <slug>${RESET}\n`);
        return;
      }
      console.log();
      console.log(`  ${BOLD}${'SLUG'.padEnd(28)}${'NAME'.padEnd(24)}${'STATUS'.padEnd(12)}${'TIER'.padEnd(6)}${RESET}`);
      console.log(`  ${DIM}${'─'.repeat(70)}${RESET}`);
      for (const a of agents) {
        const statusColor = a.status === 'active' ? GREEN : a.status === 'paused' ? YELLOW : RED;
        const statusStr = `${statusColor}${(a.status ?? 'active').padEnd(10)}${RESET}`;
        console.log(`  ${a.slug.padEnd(28)}${(a.name ?? '').slice(0, 22).padEnd(24)}${statusStr}  ${String(a.tier).padEnd(6)}`);
      }
      console.log();
    } catch (err) {
      console.error(`  Error listing agents: ${err}`);
      process.exit(1);
    }
  });

agentCmd
  .command('new <slug>')
  .description('Scaffold a new agent at agents/<slug>/agent.md (does not overwrite)')
  .option('-n, --name <name>', 'Display name (default: title-case of slug)')
  .option('-d, --description <text>', 'One-line description of what the agent does')
  .option('-r, --role <role>', 'Role template — auto-scaffolds CRON.md / PLAYBOOK.md (sdr, researcher)')
  .option('-t, --tier <tier>', 'Security tier — 1 = vault-only, 2 = bash/git allowed', '1')
  .option('-m, --model <model>', 'Default model (sonnet, haiku, opus). Inherits global default if omitted.')
  .option('--channel <name>', 'Discord/Slack channel name the agent listens in (enables team mode)')
  .action(async (slug: string, opts: {
    name?: string; description?: string; role?: string;
    tier?: string; model?: string; channel?: string;
  }) => {
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[0;90m';
    const GREEN = '\x1b[0;32m';
    const RED = '\x1b[0;31m';
    const RESET = '\x1b[0m';

    // Validate slug — lowercase, dashes, alphanumeric, no leading/trailing dash.
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.length < 3) {
      console.error(`  ${RED}Invalid slug${RESET}: must be 3+ chars, lowercase letters/digits/dashes, no leading/trailing dash. Got: "${slug}"`);
      process.exit(1);
    }
    if (slug === 'clementine') {
      console.error(`  ${RED}Reserved slug${RESET}: "clementine" is the master assistant. Pick a different name.`);
      process.exit(1);
    }

    const tier = Math.max(1, Math.min(2, parseInt(opts.tier ?? '1', 10) || 1));
    const name = opts.name ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const description = opts.description ?? `${name} — specialist agent.`;

    try {
      const { AgentManager } = await import('../agent/agent-manager.js');
      const AGENTS_DIR = path.join(BASE_DIR, 'agents');
      const mgr = new AgentManager(AGENTS_DIR);

      // Refuse if already taken (createAgent throws but we want a friendly error)
      if (mgr.get(slug)) {
        console.error(`  ${RED}Agent "${slug}" already exists${RESET}. Edit ${path.join(AGENTS_DIR, slug, 'agent.md')} or pick a different slug.`);
        process.exit(1);
      }

      const config: Parameters<typeof mgr.createAgent>[0] = {
        name,
        description,
        tier,
      };
      if (opts.model) config.model = opts.model;
      if (opts.channel) config.channelName = opts.channel;
      if (opts.role) config.role = opts.role;

      const profile = mgr.createAgent(config);
      const agentMdPath = path.join(profile.agentDir ?? path.join(AGENTS_DIR, slug), 'agent.md');

      console.log();
      console.log(`  ${GREEN}✓${RESET} Created agent ${BOLD}${profile.name}${RESET} (${profile.slug})`);
      console.log(`  ${DIM}File: ${agentMdPath}${RESET}`);
      if (opts.role) {
        console.log(`  ${DIM}Role scaffold "${opts.role}" wrote CRON.md / PLAYBOOK.md / SEQUENCES.md if applicable.${RESET}`);
      }
      console.log();
      console.log(`  Next steps:`);
      console.log(`    1. Edit ${BOLD}agent.md${RESET} to refine personality / standing instructions`);
      if (!opts.channel) {
        console.log(`    2. Add a ${BOLD}channelName${RESET} (and DISCORD/SLACK token via 'clementine config set') to give them their own bot`);
      }
      console.log(`    3. Edit ${BOLD}~/.clementine/agents/${slug}/CRON.md${RESET} to schedule autonomous work`);
      console.log(`    4. Restart the daemon: ${BOLD}clementine restart${RESET}`);
      console.log();
    } catch (err) {
      console.error(`  ${RED}Failed to create agent${RESET}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

agentCmd
  .command('show <slug>')
  .description('Show an agent\'s file path and parsed profile summary')
  .action(async (slug: string) => {
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[0;90m';
    const RED = '\x1b[0;31m';
    const RESET = '\x1b[0m';
    try {
      const { AgentManager } = await import('../agent/agent-manager.js');
      const AGENTS_DIR = path.join(BASE_DIR, 'agents');
      const mgr = new AgentManager(AGENTS_DIR);
      const profile = mgr.get(slug);
      if (!profile) {
        console.error(`  ${RED}Agent "${slug}" not found${RESET}.`);
        console.error(`  List agents: ${BOLD}clementine agent list${RESET}`);
        process.exit(1);
      }
      const agentMdPath = path.join(profile.agentDir ?? path.join(AGENTS_DIR, slug), 'agent.md');
      console.log();
      console.log(`  ${BOLD}${profile.name}${RESET}  ${DIM}(${profile.slug})${RESET}`);
      console.log(`  ${DIM}${agentMdPath}${RESET}`);
      console.log();
      console.log(`  Status:       ${profile.status ?? 'active'}`);
      console.log(`  Tier:         ${profile.tier}`);
      if (profile.model) console.log(`  Model:        ${profile.model}`);
      console.log(`  Description:  ${profile.description || DIM + '(none)' + RESET}`);
      if (profile.team?.channelName) {
        const ch = Array.isArray(profile.team.channelName) ? profile.team.channelName.join(', ') : profile.team.channelName;
        console.log(`  Channel:      ${ch}`);
      }
      if (profile.activeHours) {
        console.log(`  Active hours: ${profile.activeHours.start.toFixed(2)}–${profile.activeHours.end.toFixed(2)} (decimal hours)`);
      }
      if (profile.budgetMonthlyCents != null && profile.budgetMonthlyCents > 0) {
        console.log(`  Budget/mo:    $${(profile.budgetMonthlyCents / 100).toFixed(2)}`);
      }
      console.log(`  Strict mem:   ${profile.strictMemoryIsolation === false ? 'no (soft boost)' : 'yes (default)'}`);
      console.log();
    } catch (err) {
      console.error(`  Error reading agent: ${err}`);
      process.exit(1);
    }
  });

// ── Memory commands ─────────────────────────────────────────────────

const memoryCmd = program
  .command('memory')
  .description('Search and manage memory');

memoryCmd
  .command('status')
  .description('Show memory store stats — chunk count, embeddings coverage, agent/category breakdown, salience')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[0;90m';
    const CYAN = '\x1b[0;36m';
    const RESET = '\x1b[0m';
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const VAULT_DIR = path.join(BASE_DIR, 'vault');
      const DB_PATH = path.join(VAULT_DIR, '.memory.db');
      const store = new MemoryStore(DB_PATH, VAULT_DIR);
      const stats = store.getMemoryStats();
      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      const pct = stats.totalChunks > 0
        ? ((stats.chunksWithEmbeddings / stats.totalChunks) * 100).toFixed(1)
        : '0.0';
      console.log();
      console.log(`  ${BOLD}Memory store${RESET}  ${DIM}${DB_PATH}${RESET}`);
      console.log();
      console.log(`  Total chunks:         ${BOLD}${stats.totalChunks.toLocaleString()}${RESET}`);
      console.log(`  With embeddings:      ${stats.chunksWithEmbeddings.toLocaleString()} ${DIM}(${pct}%, TF-IDF 512-dim)${RESET}`);
      console.log(`  Pinned (manual):      ${stats.pinnedChunks}`);
      console.log(`  Avg salience:         ${stats.avgSalience.toFixed(3)} ${DIM}(0 = no access boost; >1 = strong reinforcement)${RESET}`);
      if (stats.oldestUpdated) {
        console.log(`  Date range:           ${stats.oldestUpdated.slice(0, 10)} → ${stats.newestUpdated?.slice(0, 10)}`);
      }
      console.log();
      console.log(`  ${BOLD}Per agent${RESET}`);
      for (const a of stats.perAgent.slice(0, 10)) {
        console.log(`    ${CYAN}${a.agentSlug.padEnd(28)}${RESET}${a.count.toLocaleString().padStart(8)}`);
      }
      if (stats.perAgent.length > 10) console.log(`    ${DIM}…and ${stats.perAgent.length - 10} more${RESET}`);
      console.log();
      console.log(`  ${BOLD}Per category${RESET}`);
      for (const c of stats.perCategory.slice(0, 10)) {
        console.log(`    ${CYAN}${c.category.padEnd(28)}${RESET}${c.count.toLocaleString().padStart(8)}`);
      }
      console.log();
    } catch (err) {
      console.error(`  Error reading memory stats: ${err}`);
      process.exit(1);
    }
  });

memoryCmd
  .command('pin <chunkId>')
  .description('Pin a chunk — gives its score a 2x boost in recall (use chunk IDs from `memory search`)')
  .action(async (chunkIdStr: string) => {
    const GREEN = '\x1b[0;32m';
    const RED = '\x1b[0;31m';
    const RESET = '\x1b[0m';
    const chunkId = parseInt(chunkIdStr, 10);
    if (!Number.isFinite(chunkId) || chunkId <= 0) {
      console.error(`  ${RED}Invalid chunk id${RESET}: "${chunkIdStr}". Use IDs from \`clementine memory search\`.`);
      process.exit(1);
    }
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const VAULT_DIR = path.join(BASE_DIR, 'vault');
      const DB_PATH = path.join(VAULT_DIR, '.memory.db');
      const store = new MemoryStore(DB_PATH, VAULT_DIR);
      const ok = store.setPinned(chunkId, true);
      if (!ok) {
        console.error(`  ${RED}Chunk ${chunkId} not found.${RESET}`);
        process.exit(1);
      }
      console.log(`  ${GREEN}✓${RESET} Pinned chunk ${chunkId}. It now gets a 2× boost in memory_recall.`);
    } catch (err) {
      console.error(`  Error pinning chunk: ${err}`);
      process.exit(1);
    }
  });

memoryCmd
  .command('unpin <chunkId>')
  .description('Unpin a chunk — removes the manual 2x boost, leaves automatic salience untouched')
  .action(async (chunkIdStr: string) => {
    const GREEN = '\x1b[0;32m';
    const RED = '\x1b[0;31m';
    const RESET = '\x1b[0m';
    const chunkId = parseInt(chunkIdStr, 10);
    if (!Number.isFinite(chunkId) || chunkId <= 0) {
      console.error(`  ${RED}Invalid chunk id${RESET}: "${chunkIdStr}".`);
      process.exit(1);
    }
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const VAULT_DIR = path.join(BASE_DIR, 'vault');
      const DB_PATH = path.join(VAULT_DIR, '.memory.db');
      const store = new MemoryStore(DB_PATH, VAULT_DIR);
      const ok = store.setPinned(chunkId, false);
      if (!ok) {
        console.error(`  ${RED}Chunk ${chunkId} not found.${RESET}`);
        process.exit(1);
      }
      console.log(`  ${GREEN}✓${RESET} Unpinned chunk ${chunkId}.`);
    } catch (err) {
      console.error(`  Error unpinning chunk: ${err}`);
      process.exit(1);
    }
  });

memoryCmd
  .command('dedup')
  .description('Find near-duplicate chunks via embedding cosine similarity. Dry-run by default.')
  .option('--threshold <n>', 'Cosine similarity threshold (0-1)', '0.95')
  .option('--apply', 'Actually delete duplicates (default: dry-run preview only)')
  .option('--limit <n>', 'Max clusters to report', '50')
  .action(async (opts: { threshold: string; apply?: boolean; limit: string }) => {
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[0;90m';
    const GREEN = '\x1b[0;32m';
    const YELLOW = '\x1b[0;33m';
    const RESET = '\x1b[0m';
    const threshold = parseFloat(opts.threshold);
    const limit = parseInt(opts.limit, 10);
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const VAULT_DIR = path.join(BASE_DIR, 'vault');
      const DB_PATH = path.join(VAULT_DIR, '.memory.db');
      const store = new MemoryStore(DB_PATH, VAULT_DIR);
      const clusters = store.findNearDuplicates({ threshold, limit });
      if (clusters.length === 0) {
        console.log(`  ${GREEN}No near-duplicates found above threshold ${threshold}.${RESET}`);
        return;
      }
      const totalDupes = clusters.reduce((sum, c) => sum + c.duplicates.length, 0);
      console.log();
      console.log(`  ${BOLD}Found ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} (${totalDupes} duplicate chunk${totalDupes === 1 ? '' : 's'})${RESET}`);
      console.log(`  ${DIM}Keeping the most-recent chunk per cluster; older copies will be removed if --apply is passed.${RESET}`);
      console.log();
      for (const cluster of clusters.slice(0, 20)) {
        const keepLabel = `${cluster.keep.sourceFile} > ${cluster.keep.section}`;
        const agent = cluster.keep.agentSlug ?? 'global';
        console.log(`  ${BOLD}KEEP${RESET} #${cluster.keep.chunkId}  ${DIM}[${agent}]${RESET}  ${keepLabel}`);
        for (const dup of cluster.duplicates) {
          const dupLabel = `${dup.sourceFile} > ${dup.section}`;
          console.log(`    ${YELLOW}drop${RESET} #${dup.chunkId}  sim=${dup.similarity.toFixed(3)}  ${DIM}${dupLabel}${RESET}`);
        }
      }
      if (clusters.length > 20) {
        console.log(`  ${DIM}…and ${clusters.length - 20} more clusters (raise --limit to see them).${RESET}`);
      }
      console.log();
      if (opts.apply) {
        const allDupeIds = clusters.flatMap(c => c.duplicates.map(d => d.chunkId));
        const removed = store.deleteChunks(allDupeIds);
        console.log(`  ${GREEN}✓${RESET} Deleted ${removed} duplicate chunk${removed === 1 ? '' : 's'}.`);
      } else {
        console.log(`  ${DIM}This was a preview. Re-run with ${BOLD}--apply${RESET}${DIM} to delete the duplicates.${RESET}`);
      }
      console.log();
    } catch (err) {
      console.error(`  Error during dedup: ${err}`);
      process.exit(1);
    }
  });

memoryCmd
  .command('cross-agent')
  .description('Surface chunks that recur across 3+ agents — candidates for promotion to global memory')
  .option('--threshold <n>', 'Cosine similarity threshold for "same idea" (0-1)', '0.88')
  .option('--min-agents <n>', 'Minimum distinct agents touched by a cluster', '3')
  .option('--limit <n>', 'Max clusters to report', '30')
  .action(async (opts: { threshold: string; minAgents: string; limit: string }) => {
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[0;90m';
    const CYAN = '\x1b[0;36m';
    const GREEN = '\x1b[0;32m';
    const RESET = '\x1b[0m';
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const VAULT_DIR = path.join(BASE_DIR, 'vault');
      const DB_PATH = path.join(VAULT_DIR, '.memory.db');
      const store = new MemoryStore(DB_PATH, VAULT_DIR);
      const clusters = store.findCrossAgentRecurrence({
        threshold: parseFloat(opts.threshold),
        minAgents: parseInt(opts.minAgents, 10),
        limit: parseInt(opts.limit, 10),
      });
      if (clusters.length === 0) {
        console.log(`  ${GREEN}No cross-agent recurrence found above threshold ${opts.threshold} touching ${opts.minAgents}+ agents.${RESET}`);
        return;
      }
      console.log();
      console.log(`  ${BOLD}Found ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} recurring across ${opts.minAgents}+ agents${RESET}`);
      console.log(`  ${DIM}These are candidates for promotion to global memory — facts the team has independently arrived at.${RESET}`);
      console.log();
      for (const c of clusters) {
        const preview = c.representative.content.replace(/\n/g, ' ').slice(0, 140);
        console.log(`  ${BOLD}Cluster (${c.agents.length} agents)${RESET}  ${CYAN}${c.agents.join(', ')}${RESET}`);
        console.log(`    representative #${c.representative.chunkId}  ${DIM}${c.representative.sourceFile} > ${c.representative.section}${RESET}`);
        console.log(`    ${DIM}${preview}${preview.length >= 140 ? '…' : ''}${RESET}`);
        for (const m of c.members.slice(1, 4)) {
          console.log(`    ${DIM}└─ #${m.chunkId} [${m.agentSlug}] sim=${m.similarity.toFixed(3)}${RESET}`);
        }
        if (c.members.length > 4) {
          console.log(`    ${DIM}└─ +${c.members.length - 4} more${RESET}`);
        }
        console.log();
      }
      console.log(`  ${DIM}To promote a chunk to global, use the agent-side ${BOLD}memory_promote${RESET}${DIM} tool with the chunk id, or pin it with ${BOLD}clementine memory pin <id>${RESET}${DIM} for now.${RESET}`);
      console.log();
    } catch (err) {
      console.error(`  Error finding cross-agent recurrence: ${err}`);
      process.exit(1);
    }
  });

memoryCmd
  .command('search <query>')
  .description('Search memory (full-text)')
  .option('-n, --limit <n>', 'Max results', '10')
  .action(async (query: string, opts: { limit: string }) => {
    const DIM = '\x1b[0;90m';
    const BOLD = '\x1b[1m';
    const CYAN = '\x1b[0;36m';
    const RESET = '\x1b[0m';
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const VAULT_DIR = path.join(BASE_DIR, 'vault');
      const DB_PATH = path.join(VAULT_DIR, '.memory.db');
      const store = new MemoryStore(DB_PATH, VAULT_DIR);
      const results = store.searchFts(query, parseInt(opts.limit, 10));
      if (results.length === 0) {
        console.log(`  No results for "${query}".`);
        return;
      }
      console.log();
      for (const r of results) {
        const source = r.sourceFile ? path.basename(r.sourceFile) : 'unknown';
        const section = r.section || '';
        const snippet = r.content.replace(/\n/g, ' ').slice(0, 120);
        const pinned = r.pinned ? ' 📌' : '';
        console.log(`  ${DIM}#${r.chunkId}${RESET}  ${BOLD}${source}${RESET}${section ? ` › ${CYAN}${section}${RESET}` : ''}${pinned}`);
        console.log(`  ${DIM}${snippet}${snippet.length >= 120 ? '…' : ''}${RESET}`);
        console.log();
      }
      console.log(`  ${DIM}Tip: pin a chunk to boost its score in recall — ${BOLD}clementine memory pin <id>${RESET}`);
      console.log();
    } catch (err) {
      console.error(`  Error searching memory: ${err}`);
    }
  });

// ── Projects commands ───────────────────────────────────────────────

const projectsCmd = program
  .command('projects')
  .description('Manage linked projects');

projectsCmd
  .command('list')
  .description('Show all linked projects')
  .action(async () => {
    const DIM = '\x1b[0;90m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';
    try {
      const { getLinkedProjects } = await import('../agent/assistant.js');
      const projects = getLinkedProjects();
      if (projects.length === 0) {
        console.log('  No projects linked. Use: clementine projects add <path>');
        return;
      }
      console.log();
      for (const p of projects) {
        console.log(`  ${BOLD}${path.basename(p.path)}${RESET}`);
        console.log(`  ${DIM}${p.path}${RESET}`);
        if (p.description) console.log(`  ${p.description}`);
        if (p.keywords?.length) console.log(`  ${DIM}Keywords: ${p.keywords.join(', ')}${RESET}`);
        console.log();
      }
    } catch (err) {
      console.error(`  Error listing projects: ${err}`);
    }
  });

projectsCmd
  .command('add <path>')
  .description('Link a project directory')
  .option('-d, --description <desc>', 'Project description')
  .option('-k, --keywords <kw>', 'Comma-separated keywords')
  .action(async (projectPath: string, opts: { description?: string; keywords?: string }) => {
    const resolved = path.resolve(projectPath);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      console.error(`  Not a directory: ${resolved}`);
      process.exit(1);
    }
    try {
      const { addProject } = await import('../agent/assistant.js');
      const keywords = opts.keywords?.split(',').map(k => k.trim()).filter(Boolean);
      addProject(resolved, opts.description, keywords);
      console.log(`  Linked: ${resolved}`);
    } catch (err) {
      console.error(`  Error adding project: ${err}`);
    }
  });

projectsCmd
  .command('remove <path>')
  .description('Unlink a project directory')
  .action(async (projectPath: string) => {
    const resolved = path.resolve(projectPath);
    try {
      const { removeProject } = await import('../agent/assistant.js');
      if (removeProject(resolved)) {
        console.log(`  Removed: ${resolved}`);
      } else {
        console.log(`  Not found: ${resolved}`);
      }
    } catch (err) {
      console.error(`  Error removing project: ${err}`);
    }
  });

// ── Update command ──────────────────────────────────────────────────

/** Print the last N entries from update-history.jsonl. */
function cmdUpdateHistory(limit: number): void {
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[0;90m';
  const GREEN = '\x1b[0;32m';
  const RED = '\x1b[0;31m';
  const RESET = '\x1b[0m';
  const historyPath = path.join(BASE_DIR, 'update-history.jsonl');
  if (!existsSync(historyPath)) {
    console.log();
    console.log(`  ${DIM}No update history yet (${historyPath} doesn't exist).${RESET}`);
    console.log(`  Run ${BOLD}clementine update${RESET} once to start the log.`);
    console.log();
    return;
  }
  const lines = readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean);
  const entries = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e): e is Record<string, unknown> => e !== null)
    .slice(-Math.max(1, limit))
    .reverse();
  if (entries.length === 0) {
    console.log(`  ${DIM}History file exists but is empty or unparseable.${RESET}`);
    return;
  }
  console.log();
  console.log(`  ${BOLD}Update history${RESET}  ${DIM}(${historyPath})${RESET}`);
  console.log();
  for (const e of entries) {
    const ts = String(e.timestamp ?? '').slice(0, 19).replace('T', ' ');
    const from = String(e.fromVersion ?? '?');
    const to = String(e.toVersion ?? '?');
    const flavor = String(e.flavor ?? 'git');
    const failed = e.failed === true;
    const arrow = from === to ? '=' : '→';
    const verLabel = failed
      ? `${RED}v${from} ${arrow} v${to} FAILED${RESET}`
      : (from === to ? `${DIM}v${from}${RESET}` : `v${from} ${arrow} ${BOLD}v${to}${RESET}`);
    const dur = typeof e.durationMs === 'number' ? ` ${DIM}(${Math.round(e.durationMs / 1000)}s)${RESET}` : '';
    console.log(`  ${DIM}${ts}${RESET}  ${verLabel}  ${DIM}[${flavor}]${RESET}${dur}`);
    if (typeof e.commitHash === 'string' && e.commitHash) {
      console.log(`     ${DIM}commit ${e.commitHash}${e.commitDate ? ` (${e.commitDate})` : ''}, ${e.commitsPulled ?? 0} commit${e.commitsPulled === 1 ? '' : 's'} pulled${RESET}`);
    }
    if (typeof e.summary === 'string' && e.summary) {
      const trimmed = e.summary.length > 100 ? e.summary.slice(0, 100) + '…' : e.summary;
      console.log(`     ${DIM}${trimmed}${RESET}`);
    }
    if (failed && typeof e.error === 'string') {
      console.log(`     ${RED}error: ${e.error.slice(0, 120)}${RESET}`);
    }
    const modSummary: string[] = [];
    if (typeof e.modsReapplied === 'number' && e.modsReapplied > 0) modSummary.push(`${e.modsReapplied} re-applied`);
    if (typeof e.modsSuperseded === 'number' && e.modsSuperseded > 0) modSummary.push(`${e.modsSuperseded} superseded`);
    if (typeof e.modsNeedReconciliation === 'number' && e.modsNeedReconciliation > 0) modSummary.push(`${e.modsNeedReconciliation} need attention`);
    if (typeof e.modsFailed === 'number' && e.modsFailed > 0) modSummary.push(`${e.modsFailed} failed`);
    if (modSummary.length > 0) {
      console.log(`     ${DIM}source mods: ${modSummary.join(', ')}${RESET}`);
    }
  }
  console.log();
  console.log(`  ${GREEN}Showing ${entries.length}${RESET}${DIM} of ${lines.length} total entries.${RESET}`);
  console.log();
}

/** Read the npm version from a package.json (returns 'unknown' on failure). */
function readPkgVersion(packageRoot: string): string {
  try {
    const pkgPath = path.join(packageRoot, 'package.json');
    if (!existsSync(pkgPath)) return 'unknown';
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Append one line to the update-history log. Append-only, never throws. */
function appendUpdateHistory(entry: Record<string, unknown>): void {
  try {
    const historyPath = path.join(BASE_DIR, 'update-history.jsonl');
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    require('node:fs').appendFileSync(historyPath, line, { mode: 0o600 });
  } catch {
    // Non-fatal — history is observability, not critical state.
  }
}

async function cmdUpdate(options: { restart?: boolean; dryRun?: boolean }): Promise<void> {
  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[1;33m';
  const RED = '\x1b[0;31m';
  const RESET = '\x1b[0m';

  const updateStartedAt = Date.now();
  const previousVersion = readPkgVersion(PACKAGE_ROOT);

  console.log();
  console.log(`  ${DIM}Updating ${getAssistantName()} (current: v${previousVersion})...${RESET}`);
  console.log();

  // 1. Detect install flavor. Two valid paths:
  //    - git-clone install (PACKAGE_ROOT has .git) → pull + rebuild path below
  //    - npm-global install (no .git) → delegate to `npm install -g clementine-agent@latest`
  const isGitInstall = existsSync(path.join(PACKAGE_ROOT, '.git'));
  if (!isGitInstall) {
    if (options.dryRun) {
      console.log(`  ${DIM}[dry-run]${RESET}  Would run: npm install -g clementine-agent@latest`);
      if (options.restart) console.log(`  ${DIM}[dry-run]${RESET}  Would restart the daemon`);
      return;
    }
    console.log(`  ${DIM}npm-global install detected at ${PACKAGE_ROOT}${RESET}`);
    console.log(`  ${DIM}Running: npm install -g clementine-agent@latest${RESET}`);
    console.log();
    try {
      execSync('npm install -g clementine-agent@latest', { stdio: 'inherit' });
      const newVersion = readPkgVersion(PACKAGE_ROOT);
      console.log();
      if (previousVersion !== 'unknown' && newVersion !== 'unknown' && previousVersion !== newVersion) {
        console.log(`  ${GREEN}OK${RESET}  Updated v${previousVersion} → ${BOLD}v${newVersion}${RESET}`);
      } else if (previousVersion === newVersion) {
        console.log(`  ${GREEN}OK${RESET}  Already on latest (v${newVersion})`);
      } else {
        console.log(`  ${GREEN}OK${RESET}  Updated via npm`);
      }
      appendUpdateHistory({
        flavor: 'npm-global',
        fromVersion: previousVersion,
        toVersion: newVersion,
        durationMs: Date.now() - updateStartedAt,
        restartRequested: !!options.restart,
      });
    } catch (err) {
      console.error(`  ${RED}FAIL${RESET}  npm update failed: ${String(err).slice(0, 200)}`);
      console.error(`  ${YELLOW}Hint${RESET}  If you see EACCES, see README "Troubleshooting" for npm prefix setup.`);
      appendUpdateHistory({
        flavor: 'npm-global',
        fromVersion: previousVersion,
        toVersion: previousVersion,
        durationMs: Date.now() - updateStartedAt,
        failed: true,
        error: String(err).slice(0, 300),
      });
      process.exit(1);
    }
    if (options.restart) {
      try {
        console.log(`  ${DIM}Restarting daemon...${RESET}`);
        execSync('clementine restart', { stdio: 'inherit' });
        console.log(`  ${GREEN}OK${RESET}  Daemon restarted`);
      } catch (err) {
        console.error(`  ${YELLOW}WARN${RESET}  Restart failed: ${String(err).slice(0, 200)}. Run \`clementine restart\` manually.`);
      }
    } else {
      console.log();
      console.log(`  ${DIM}Restart your daemon to pick up the new code:${RESET}`);
      console.log(`    clementine restart`);
    }
    return;
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
      if (options.dryRun) {
        console.log(`  ${S()} Would stash local changes`);
      } else {
        console.log(`  ${S()} Stashing local changes...`);
        const stashOut = execSync('git stash', { cwd: PACKAGE_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        didStash = !stashOut.includes('No local changes');
        if (didStash) {
          console.log(`  ${GREEN}OK${RESET}  Stashed local changes`);
        }
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

    // .env (mode 0o600 — backup carries credentials, same protection as live file)
    if (existsSync(ENV_PATH)) {
      const envContent = readFileSync(ENV_PATH, 'utf-8');
      writeFileSync(path.join(backupDir, '.env'), envContent, { mode: 0o600 });
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
    if (options.dryRun) {
      console.log(`  ${S()} Would stop daemon (PID ${pid})`);
    } else {
      console.log(`  ${S()} Stopping daemon (PID ${pid})...`);
      stopDaemon(pid!);
      try { unlinkSync(getPidFilePath()); } catch { /* ignore */ }
      console.log(`  ${GREEN}OK${RESET}  Daemon stopped`);
    }
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

  // 6d. Ensure cloudflared is installed (for remote dashboard access)
  try {
    execSync('which cloudflared', { stdio: 'pipe' });
    console.log(`  ${GREEN}OK${RESET}  cloudflared available`);
  } catch {
    if (process.platform === 'darwin') {
      console.log(`  ${S()} Installing cloudflared (remote dashboard access)...`);
      try {
        execSync('brew install cloudflared', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
        console.log(`  ${GREEN}OK${RESET}  cloudflared installed`);
      } catch {
        console.error(`  ${YELLOW}WARN${RESET}  Could not install cloudflared — remote access won't be available`);
        console.error(`       Fix: brew install cloudflared`);
      }
    } else {
      console.error(`  ${YELLOW}WARN${RESET}  cloudflared not installed — remote dashboard access won't be available`);
      console.error(`       See: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
    }
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

  // 7c. Smoke test — verify the build is actually runnable.
  // CLEMENTINE_SMOKE_TEST causes main() to exit(0) immediately, so
  // this just verifies the module loads without starting the full daemon.
  try {
    execSync('node -e "require(\'./dist/index.js\')"', {
      cwd: PACKAGE_ROOT,
      stdio: 'pipe',
      timeout: 15000,
      env: { ...process.env, CLEMENTINE_SMOKE_TEST: '1' },
    });
    console.log(`  ${GREEN}OK${RESET}  Build output verified`);
  } catch {
    console.log(`  ${YELLOW}WARN${RESET}  Build output may have issues — check after restart`);
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
      console.error(`  ${YELLOW}WARN${RESET}  Could not auto-restore stashed changes — falling back to backup`);
      // Restore .env from backup if stash pop failed
      const backupEnv = path.join(backupDir, '.env');
      if (existsSync(backupEnv)) {
        try {
          cpSync(backupEnv, ENV_PATH);
          console.log(`  ${GREEN}OK${RESET}  .env restored from backup`);
        } catch {
          console.error(`  ${RED}FAIL${RESET}  Could not restore .env — copy manually from: ${backupEnv}`);
        }
      }
      // Drop the stash so it doesn't interfere with future updates
      try { execSync('git stash drop', { cwd: PACKAGE_ROOT, stdio: 'pipe' }); } catch { /* ignore */ }
    }
  }

  // 9b. Verify .env survived the update
  if (existsSync(ENV_PATH)) {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    if (envContent.trim().length < 10) {
      console.error(`  ${RED}FAIL${RESET}  .env appears empty — restoring from backup`);
      const backupEnv = path.join(backupDir, '.env');
      if (existsSync(backupEnv)) {
        try {
          cpSync(backupEnv, ENV_PATH);
          console.log(`  ${GREEN}OK${RESET}  .env restored from backup`);
        } catch {
          console.error(`  ${RED}FAIL${RESET}  Restore failed — copy manually from: ${backupEnv}`);
        }
      }
    }
  } else {
    console.error(`  ${RED}FAIL${RESET}  .env missing after update — restoring from backup`);
    const backupEnv = path.join(backupDir, '.env');
    if (existsSync(backupEnv)) {
      try {
        const { copyFileSync } = require('node:fs') as typeof import('node:fs');
        copyFileSync(backupEnv, ENV_PATH);
        console.log(`  ${GREEN}OK${RESET}  .env restored from backup`);
      } catch {
        console.error(`  ${RED}FAIL${RESET}  Restore failed — run: clementine config setup`);
      }
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

  // 11. Doctor check (auto-fix during updates)
  // Shell out to the newly built dist/ so the latest doctor code runs, not the old in-memory version.
  console.log();
  console.log(`  ${S()} Running health check...`);
  try {
    execSync(`node "${path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js')}" doctor --fix`, {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
      timeout: 300000,
    });
  } catch {
    // Doctor exits cleanly even with issues; a throw here means something unexpected.
    cmdDoctor({ fix: true }); // Fallback to in-memory version
  }

  // 11. Kill ALL running dashboard processes (not just PID file) and relaunch
  let dashboardWasRunning = false;
  try {
    const { killExistingDashboards } = await import('./dashboard.js');
    const killed = killExistingDashboards();
    if (killed > 0) {
      dashboardWasRunning = true;
      console.log(`  ${GREEN}OK${RESET}  Stopped ${killed} dashboard process(es)`);
    }
  } catch { /* no dashboard running */ }

  // Don't auto-relaunch dashboard during update — it causes duplicate process issues.
  // The daemon restart below will handle it, or user can run: clementine dashboard
  if (dashboardWasRunning) {
    console.log(`  Dashboard stopped. Relaunch with: ${DIM}clementine dashboard${RESET}`);
  }

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

  // Capture the new version once the build is verified — package.json on
  // disk is now authoritative for the version we're about to run.
  const newVersion = readPkgVersion(PACKAGE_ROOT);

  // Persist update history before the restart (in case daemon restart fails,
  // we still have the record of what was attempted).
  appendUpdateHistory({
    flavor: 'git',
    fromVersion: previousVersion,
    toVersion: newVersion,
    commitHash,
    commitDate,
    commitsPulled,
    summary: pullSummary.split('\n').slice(0, 5).join('; '),
    modsReapplied: reconcileResult?.reapplied.length ?? 0,
    modsSuperseded: reconcileResult?.superseded.length ?? 0,
    modsNeedReconciliation: reconcileResult?.needsReconciliation.length ?? 0,
    modsFailed: reconcileResult?.failed.length ?? 0,
    durationMs: Date.now() - updateStartedAt,
    restartRequested: !!(options.restart || wasRunning),
  });

  if (options.restart || wasRunning) {
    const sentinelPath = path.join(BASE_DIR, '.restart-sentinel.json');
    const sentinel: import('../types.js').RestartSentinel = {
      previousPid: process.pid,
      restartedAt: new Date().toISOString(),
      reason: 'update',
      updateDetails: {
        previousVersion,
        newVersion,
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

  // 13. Post-restart health check — verify daemon started and channels connected
  if (options.restart || wasRunning) {
    console.log(`  ${S()} Verifying startup...`);
    // Wait for daemon to initialize
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if process is alive
    const newPid = (() => {
      try {
        const pidFile = getPidFilePath();
        return existsSync(pidFile) ? parseInt(readFileSync(pidFile, 'utf-8').trim(), 10) : null;
      } catch { return null; }
    })();

    if (newPid) {
      try {
        process.kill(newPid, 0); // Signal 0 = check if alive
        console.log(`  ${GREEN}OK${RESET}  Daemon running (PID ${newPid})`);
      } catch {
        console.log(`  ${RED}FAIL${RESET}  Daemon crashed after restart — check: tail ~/.clementine/logs/clementine.log`);
      }
    } else {
      console.log(`  ${RED}FAIL${RESET}  No PID file — daemon may not have started`);
    }

    // Check logs for startup errors
    try {
      const logPath = path.join(BASE_DIR, 'logs', 'clementine.log');
      if (existsSync(logPath)) {
        const logTail = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).slice(-20);
        const startupErrors: string[] = [];
        let discordOnline = false;
        for (const line of logTail) {
          try {
            const entry = JSON.parse(line);
            if (entry.level >= 50) startupErrors.push(entry.msg?.slice(0, 120) ?? 'Unknown error');
            if (entry.msg?.includes('online as') || entry.msg?.includes('Clementine online')) discordOnline = true;
          } catch { /* skip */ }
        }
        if (discordOnline) {
          console.log(`  ${GREEN}OK${RESET}  Discord connected`);
        } else {
          console.log(`  ${YELLOW}WARN${RESET}  Discord connection not confirmed — check logs`);
        }
        if (startupErrors.length > 0) {
          for (const err of startupErrors.slice(0, 3)) {
            console.log(`  ${RED}ERR${RESET}  ${err}`);
          }
        }
      }
    } catch { /* non-fatal */ }

    // Verify .env survived the update (critical keys still present)
    try {
      const envContent = readFileSync(ENV_PATH, 'utf-8');
      const criticalKeys = ['DISCORD_TOKEN', 'DISCORD_OWNER_ID'];
      const missingKeys = criticalKeys.filter(k => {
        const re = new RegExp(`^${k}=.+`, 'm');
        return !re.test(envContent);
      });
      if (missingKeys.length > 0) {
        console.log(`  ${RED}FAIL${RESET}  .env missing: ${missingKeys.join(', ')} — run: clementine config setup`);
      }
    } catch { /* .env read failed */ }
  }

  // 14. Show current version
  console.log();
  if (previousVersion !== 'unknown' && newVersion !== 'unknown' && previousVersion !== newVersion) {
    console.log(`  ${GREEN}Updated v${previousVersion} → ${BOLD}v${newVersion}${RESET}${commitHash ? ` ${DIM}(${commitHash})${RESET}` : ''}`);
  } else if (previousVersion === newVersion && previousVersion !== 'unknown') {
    console.log(`  ${GREEN}Already on latest (v${newVersion})${RESET}${commitHash ? ` ${DIM}(${commitHash})${RESET}` : ''}`);
  } else if (commitHash) {
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

// ── Brain / Ingest ──────────────────────────────────────────────────

const ingestCmd = program
  .command('ingest')
  .description('Seed and manage external data sources for the brain');

ingestCmd
  .command('seed <path>')
  .description('Bulk import a file or folder (CSV, JSON, PDF, email, DOCX, MD) into the brain')
  .option('--slug <slug>', 'Source slug (defaults to filename)')
  .option('--intelligence <mode>', "Intelligence mode: 'auto' | 'template-only' | 'llm-per-record'", 'auto')
  .action((input: string, opts: { slug?: string; intelligence?: 'auto' | 'template-only' | 'llm-per-record' }) =>
    cmdIngestSeed(input, opts));

ingestCmd
  .command('run <slug>')
  .description('Re-run a previously registered source')
  .action(cmdIngestRun);

ingestCmd
  .command('list')
  .description('List all registered sources')
  .action(cmdIngestList);

ingestCmd
  .command('status <slug>')
  .description('Show recent runs and metadata for a source')
  .action(cmdIngestStatus);

program.parse();
