/**
 * Clementine CLI — browser-harness integration (Phase 1, beta).
 *
 * Subcommands:
 *   clementine browser status   — show install / enable / CDP state
 *   clementine browser install  — set up Python venv + clone harness
 *   clementine browser enable   — register MCP server in mcp-servers.json
 *   clementine browser disable  — remove the MCP entry (keeps files)
 *
 * Safety:
 *   - All subcommands fail soft. Missing Python or unsupported OS just prints
 *     a clear message and exits 0 (or 1 for hard errors); the daemon never
 *     auto-installs anything.
 *   - Enabling only writes a single entry to ~/.clementine/mcp-servers.json
 *     that mcp-bridge.ts already understands. No changes to assistant.ts.
 *   - If Python or the MCP server fail at runtime, the SDK logs the error and
 *     the rest of Clementine keeps running (every other MCP server is
 *     unaffected).
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[0;90m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const RED = '\x1b[0;31m';
const CYAN = '\x1b[0;36m';
const RESET = '\x1b[0m';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const MCP_SCRIPT = path.join(PACKAGE_ROOT, 'vendor', 'browser-harness-mcp', 'server.py');
const HARNESS_HOME = path.join(BASE_DIR, 'browser-harness');
const VENV_DIR = path.join(BASE_DIR, 'browser-harness-mcp-venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python3');
const MCP_SERVERS_FILE = path.join(BASE_DIR, 'mcp-servers.json');
const HARNESS_REPO = 'https://github.com/browser-use/browser-harness.git';
const SERVER_NAME = 'browser-harness';
const DISMISSED_MARKER = path.join(BASE_DIR, '.browser-harness-dismissed');

function commandExists(cmd: string): boolean {
  const result = spawnSync('which', [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

/** Probe the CDP socket — returns true if Chrome is listening on :9222. */
function probeCdp(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get('http://localhost:9222/json/version', { timeout: 1500 }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** True if a Google Chrome process is currently running. */
function isChromeRunning(): boolean {
  if (process.platform === 'darwin') {
    const r = spawnSync('pgrep', ['-x', 'Google Chrome'], { stdio: 'pipe' });
    return r.status === 0;
  }
  // Linux: chrome / chromium / google-chrome
  for (const name of ['google-chrome', 'chromium', 'chrome']) {
    const r = spawnSync('pgrep', ['-x', name], { stdio: 'pipe' });
    if (r.status === 0) return true;
  }
  return false;
}

function pythonVersion(): string | null {
  try {
    const out = execSync('python3 --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim();
  } catch {
    return null;
  }
}

function loadMcpServers(): Record<string, unknown> {
  if (!existsSync(MCP_SERVERS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMcpServers(servers: Record<string, unknown>): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
  writeFileSync(MCP_SERVERS_FILE, JSON.stringify(servers, null, 2) + '\n');
}

export async function cmdBrowserStatus(): Promise<void> {
  const py = pythonVersion();
  const mcpScriptOk = existsSync(MCP_SCRIPT);
  const venvOk = existsSync(VENV_PYTHON);
  const harnessOk = existsSync(path.join(HARNESS_HOME, 'src'));
  const servers = loadMcpServers();
  const enabled = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const cdpOk = await probeCdp();

  console.log();
  console.log(`  ${BOLD}Browser Harness${RESET} ${DIM}(beta)${RESET}`);
  console.log();
  console.log(`  ${py ? GREEN + '✓' : RED + '✗'}${RESET} python3            ${DIM}${py ?? 'not found'}${RESET}`);
  console.log(`  ${mcpScriptOk ? GREEN + '✓' : RED + '✗'}${RESET} MCP wrapper       ${DIM}${MCP_SCRIPT}${RESET}`);
  console.log(`  ${venvOk ? GREEN + '✓' : YELLOW + '○'}${RESET} venv installed    ${DIM}${VENV_DIR}${RESET}`);
  console.log(`  ${harnessOk ? GREEN + '✓' : YELLOW + '○'}${RESET} harness cloned    ${DIM}${HARNESS_HOME}${RESET}`);
  console.log(`  ${enabled ? GREEN + '✓' : DIM + '○'}${RESET} MCP entry         ${DIM}${enabled ? 'enabled' : 'disabled'} in mcp-servers.json${RESET}`);
  console.log(`  ${cdpOk ? GREEN + '✓' : YELLOW + '○'}${RESET} Chrome CDP        ${DIM}${cdpOk ? 'connected on :9222' : 'not connected — run: clementine browser connect'}${RESET}`);
  console.log();
  if (!py) {
    console.log(`  ${YELLOW}Install Python 3.10+ first:${RESET}`);
    console.log(`    ${CYAN}brew install python@3.12${RESET}`);
    console.log();
  } else if (!venvOk || !harnessOk) {
    console.log(`  Next: ${BOLD}clementine browser install${RESET}`);
    console.log();
  } else if (!enabled) {
    console.log(`  Next: ${BOLD}clementine browser enable${RESET}`);
    console.log();
  } else if (!cdpOk) {
    console.log(`  Next: ${BOLD}clementine browser connect${RESET}`);
    console.log();
  } else {
    console.log(`  ${GREEN}Ready.${RESET} ${DIM}Browser harness is fully connected.${RESET}`);
    console.log();
  }
}

/**
 * Core install logic. Returns true on success, false on any failure.
 * Prints progress + errors to stdout/stderr but never calls process.exit.
 */
async function runInstall(): Promise<boolean> {
  console.log();
  console.log(`  ${BOLD}Installing browser-harness${RESET} ${DIM}(beta)${RESET}`);
  console.log();

  if (!pythonVersion()) {
    console.error(`  ${RED}python3 not found.${RESET} Install Python 3.10+ first:`);
    console.error(`    ${CYAN}brew install python@3.12${RESET}`);
    console.error();
    return false;
  }

  if (!existsSync(MCP_SCRIPT)) {
    console.error(`  ${RED}MCP wrapper not found at:${RESET} ${MCP_SCRIPT}`);
    console.error(`  ${DIM}This means the package was installed without vendor/ files. Reinstall:${RESET}`);
    console.error(`    ${CYAN}npm install -g clementine-agent@latest${RESET}`);
    return false;
  }

  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });

  // Step 1: clone the harness if missing
  if (!existsSync(HARNESS_HOME)) {
    if (!commandExists('git')) {
      console.error(`  ${RED}git not found.${RESET} Install git, then re-run.`);
      return false;
    }
    console.log(`  ${DIM}→ cloning ${HARNESS_REPO}${RESET}`);
    try {
      execSync(`git clone --depth 1 ${HARNESS_REPO} "${HARNESS_HOME}"`, { stdio: 'inherit' });
    } catch {
      console.error(`  ${RED}Clone failed.${RESET} Check network / git access and try again.`);
      return false;
    }
  } else {
    console.log(`  ${GREEN}✓${RESET} harness already cloned at ${DIM}${HARNESS_HOME}${RESET}`);
  }

  // Step 2: create venv if missing
  if (!existsSync(VENV_PYTHON)) {
    console.log(`  ${DIM}→ creating venv at ${VENV_DIR}${RESET}`);
    try {
      execSync(`python3 -m venv "${VENV_DIR}"`, { stdio: 'inherit' });
    } catch {
      console.error(`  ${RED}venv creation failed.${RESET}`);
      return false;
    }
  } else {
    console.log(`  ${GREEN}✓${RESET} venv already exists`);
  }

  // Step 3: install MCP deps + harness deps
  console.log(`  ${DIM}→ installing python deps (mcp, websockets, browser-harness)${RESET}`);
  try {
    execSync(`"${VENV_PYTHON}" -m pip install --upgrade pip --quiet`, { stdio: 'inherit' });
    execSync(`"${VENV_PYTHON}" -m pip install --quiet "mcp>=1.0.0" "websockets>=12.0"`, { stdio: 'inherit' });
    // Install harness deps from its pyproject.toml if present
    const harnessPyproject = path.join(HARNESS_HOME, 'pyproject.toml');
    if (existsSync(harnessPyproject)) {
      execSync(`"${VENV_PYTHON}" -m pip install --quiet -e "${HARNESS_HOME}"`, { stdio: 'inherit' });
    }
  } catch {
    console.error(`  ${RED}pip install failed.${RESET} Inspect output above and re-run when fixed.`);
    return false;
  }

  console.log();
  console.log(`  ${GREEN}✓${RESET} Install complete.`);
  return true;
}

/**
 * Core enable logic. Returns true on success, false on any failure.
 */
function runEnable(): boolean {
  if (!existsSync(VENV_PYTHON) || !existsSync(MCP_SCRIPT)) {
    console.error();
    console.error(`  ${RED}Not installed yet.${RESET} Run ${BOLD}clementine browser install${RESET} first.`);
    console.error();
    return false;
  }

  const servers = loadMcpServers();
  servers[SERVER_NAME] = {
    type: 'stdio',
    command: VENV_PYTHON,
    args: [MCP_SCRIPT],
    env: {
      BROWSER_HARNESS_HOME: HARNESS_HOME,
      BROWSER_CDP_URL: process.env.BROWSER_CDP_URL || 'ws://localhost:9222',
    },
    description: 'Drive the user\'s real Chrome via CDP (browser-use/browser-harness)',
    enabled: true,
    source: 'user',
  };
  saveMcpServers(servers);

  console.log();
  console.log(`  ${GREEN}✓${RESET} Registered ${BOLD}${SERVER_NAME}${RESET} in mcp-servers.json`);
  return true;
}

export async function cmdBrowserInstall(): Promise<void> {
  const ok = await runInstall();
  if (!ok) process.exit(1);
  console.log();
  console.log(`  ${BOLD}Next:${RESET} ${BOLD}clementine browser enable${RESET} — register the MCP server`);
  console.log(`  ${DIM}Then connect Chrome with: clementine browser connect${RESET}`);
  console.log();
}

export async function cmdBrowserEnable(): Promise<void> {
  const ok = runEnable();
  if (!ok) process.exit(1);
  console.log(`  ${DIM}Restart the daemon to pick up the change: clementine restart${RESET}`);
  console.log();
}

/**
 * Auto-prompt during `clementine update`. Stays silent unless there's
 * something actionable — mirrors the keychain wizard's behavior.
 *
 * Skips prompting when:
 *   - Not in an interactive TTY
 *   - The MCP wrapper isn't shipped with this version
 *   - Browser harness is already installed AND enabled
 *   - User previously dismissed the prompt
 */
export async function maybePromptBrowserHarness(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (!existsSync(MCP_SCRIPT)) return;

  const servers = loadMcpServers();
  const enabled = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const installed = existsSync(VENV_PYTHON);
  if (enabled && installed) return;

  if (existsSync(DISMISSED_MARKER)) return;

  console.log();
  console.log(`  ${BOLD}Browser Harness available${RESET} ${DIM}(beta, opt-in)${RESET}`);
  console.log(`  ${DIM}Lets Clementine drive your real Chrome — fill forms, post on LinkedIn,${RESET}`);
  console.log(`  ${DIM}book appointments — using your live browser session.${RESET}`);
  console.log();

  let answer: boolean;
  try {
    answer = await confirm({
      message: 'Install Browser Harness now?',
      default: false,
    });
  } catch {
    // User Ctrl+C'd or terminal closed — treat as decline, don't dismiss permanently
    return;
  }

  if (!answer) {
    try {
      writeFileSync(DISMISSED_MARKER, new Date().toISOString() + '\n');
    } catch { /* non-fatal */ }
    console.log(`  ${DIM}Skipped. To install later: clementine browser install${RESET}`);
    console.log();
    return;
  }

  // User said yes — run install + enable inline
  const installOk = await runInstall();
  if (!installOk) {
    console.error(`  ${YELLOW}Install failed.${RESET} ${DIM}You can retry with: clementine browser install${RESET}`);
    console.log();
    return;
  }
  const enableOk = runEnable();
  if (!enableOk) {
    console.error(`  ${YELLOW}Enable failed.${RESET} ${DIM}Retry with: clementine browser enable${RESET}`);
    console.log();
    return;
  }
  console.log();
  console.log(`  ${GREEN}✓${RESET} Browser Harness installed and enabled.`);
  console.log();

  // Offer to connect Chrome right now
  let connectNow = false;
  try {
    connectNow = await confirm({
      message: 'Connect Chrome now? (relaunches Chrome with debugging — will close current windows)',
      default: false,
    });
  } catch {
    // Ctrl+C — bail without dismissing
    return;
  }

  if (connectNow) {
    await runConnect({ confirmQuit: false });
  } else {
    console.log(`  ${DIM}Connect later with: ${BOLD}clementine browser connect${RESET}`);
    console.log();
  }
}

export async function cmdBrowserDisable(): Promise<void> {
  const servers = loadMcpServers();
  if (!Object.prototype.hasOwnProperty.call(servers, SERVER_NAME)) {
    console.log();
    console.log(`  ${DIM}${SERVER_NAME} is already disabled.${RESET}`);
    console.log();
    return;
  }
  delete servers[SERVER_NAME];
  saveMcpServers(servers);
  console.log();
  console.log(`  ${GREEN}✓${RESET} Removed ${BOLD}${SERVER_NAME}${RESET} from mcp-servers.json`);
  console.log(`  ${DIM}venv and harness clone are kept. To fully remove:${RESET}`);
  console.log(`    ${CYAN}rm -rf "${VENV_DIR}" "${HARNESS_HOME}"${RESET}`);
  console.log(`  ${DIM}Restart the daemon: clementine restart${RESET}`);
  console.log();
}

/**
 * Non-interactive connect — meant for callers that aren't a TTY (MCP tool,
 * daemon-internal callers). Returns a structured result instead of prompting
 * or printing decorative output. Caller decides how to surface failures.
 *
 * Behavior:
 *   - CDP already up → { ok: true, alreadyConnected: true }
 *   - No Chrome running → launch with flag, poll, return result
 *   - Chrome running without flag → if allowQuitChrome=false, refuse with
 *     a clear message; if true, quit + relaunch (DESTRUCTIVE — closes tabs).
 */
export async function runConnectNonInteractive(
  opts: { allowQuitChrome?: boolean } = {},
): Promise<{ ok: boolean; message: string; alreadyConnected?: boolean; needsForceQuit?: boolean }> {
  if (await probeCdp()) {
    return { ok: true, alreadyConnected: true, message: 'Already connected — Chrome is running with remote debugging on :9222.' };
  }

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return {
      ok: false,
      message: 'Auto-connect is only supported on macOS and Linux. Launch Chrome manually with --remote-debugging-port=9222.',
    };
  }

  if (isChromeRunning() && !opts.allowQuitChrome) {
    return {
      ok: false,
      needsForceQuit: true,
      message:
        'Chrome is running without remote debugging. Connecting requires quitting Chrome and relaunching with --remote-debugging-port=9222 (this closes your current Chrome windows). Re-run with force_quit=true to proceed, or quit Chrome yourself first and call this again.',
    };
  }

  if (isChromeRunning() && opts.allowQuitChrome) {
    try {
      if (process.platform === 'darwin') {
        execSync('osascript -e \'tell application "Google Chrome" to quit\'', { stdio: 'pipe' });
      } else {
        try { execSync('pkill -TERM -x "google-chrome|chromium|chrome"', { stdio: 'pipe' }); } catch { /* ok */ }
      }
      for (let i = 0; i < 15; i++) {
        if (!isChromeRunning()) break;
        await new Promise(r => setTimeout(r, 300));
      }
    } catch {
      return { ok: false, message: 'Failed to quit Chrome. Quit it manually and try again.' };
    }
  }

  try {
    if (process.platform === 'darwin') {
      execSync('open -na "Google Chrome" --args --remote-debugging-port=9222', { stdio: 'pipe' });
    } else {
      const candidates = ['google-chrome', 'chromium', 'chrome'];
      const bin = candidates.find(commandExists);
      if (!bin) {
        return { ok: false, message: 'No Chrome / Chromium binary found in PATH.' };
      }
      execSync(`nohup ${bin} --remote-debugging-port=9222 >/dev/null 2>&1 &`, { stdio: 'pipe' });
    }
  } catch (e) {
    return { ok: false, message: `Failed to launch Chrome: ${String(e).slice(0, 200)}` };
  }

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await probeCdp()) {
      return { ok: true, message: 'Connected — Chrome is running with remote debugging on :9222.' };
    }
  }

  return {
    ok: false,
    message: 'Chrome launched, but CDP socket isn\'t responding yet. Check that Chrome started successfully, then verify with: curl http://localhost:9222/json/version',
  };
}

/**
 * Interactive CLI connect — wraps runConnectNonInteractive with TTY prompts
 * and decorative output. Used by `clementine browser connect` and the auto-
 * prompt flow.
 */
async function runConnect(opts: { confirmQuit?: boolean } = {}): Promise<boolean> {
  // 1. Already connected? Done.
  if (await probeCdp()) {
    console.log();
    console.log(`  ${GREEN}✓${RESET} Already connected — Chrome is running with remote debugging on :9222`);
    console.log();
    return true;
  }

  // 2. Platform check — auto-launch is currently macOS only
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    console.error();
    console.error(`  ${YELLOW}Auto-connect is only supported on macOS and Linux.${RESET}`);
    console.error(`  Launch Chrome manually with the flag: ${BOLD}--remote-debugging-port=9222${RESET}`);
    console.error();
    return false;
  }

  // 3. Chrome already running without the flag? Need to quit first.
  if (isChromeRunning()) {
    console.log();
    console.log(`  ${YELLOW}Chrome is running, but without remote debugging.${RESET}`);
    console.log(`  ${DIM}To connect, Chrome needs to be quit and relaunched with the flag.${RESET}`);
    console.log(`  ${DIM}This will close your current Chrome windows.${RESET}`);
    console.log();
    let confirmed = !opts.confirmQuit; // skip prompt when caller already confirmed
    if (opts.confirmQuit) {
      try {
        confirmed = await confirm({
          message: 'Quit Chrome and relaunch with debugging?',
          default: false,
        });
      } catch {
        return false;
      }
    }
    if (!confirmed) {
      console.log(`  ${DIM}Skipped. To do it yourself: quit Chrome (Cmd+Q), then run:${RESET}`);
      console.log(`    ${BOLD}clementine browser connect${RESET}`);
      console.log();
      return false;
    }
    console.log(`  ${DIM}→ quitting Chrome...${RESET}`);
    try {
      if (process.platform === 'darwin') {
        execSync('osascript -e \'tell application "Google Chrome" to quit\'', { stdio: 'pipe' });
      } else {
        // Linux: graceful TERM, then KILL if needed
        try { execSync('pkill -TERM -x "google-chrome|chromium|chrome"', { stdio: 'pipe' }); } catch { /* ok */ }
      }
      // Wait briefly for Chrome to actually exit
      for (let i = 0; i < 15; i++) {
        if (!isChromeRunning()) break;
        await new Promise(r => setTimeout(r, 300));
      }
    } catch {
      console.error(`  ${RED}Failed to quit Chrome.${RESET} Please quit it manually and re-run.`);
      return false;
    }
  }

  // 4. Launch Chrome with the debugging flag
  console.log(`  ${DIM}→ launching Chrome with --remote-debugging-port=9222${RESET}`);
  try {
    if (process.platform === 'darwin') {
      execSync('open -na "Google Chrome" --args --remote-debugging-port=9222', { stdio: 'pipe' });
    } else {
      // Linux — find a chrome binary in PATH
      const candidates = ['google-chrome', 'chromium', 'chrome'];
      const bin = candidates.find(commandExists);
      if (!bin) {
        console.error(`  ${RED}No Chrome / Chromium binary found in PATH.${RESET}`);
        return false;
      }
      // Launch detached so this command returns immediately
      execSync(`nohup ${bin} --remote-debugging-port=9222 >/dev/null 2>&1 &`, { stdio: 'pipe' });
    }
  } catch (e) {
    console.error(`  ${RED}Failed to launch Chrome:${RESET} ${String(e).slice(0, 200)}`);
    return false;
  }

  // 5. Poll for CDP availability (up to ~6s)
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await probeCdp()) {
      console.log();
      console.log(`  ${GREEN}✓${RESET} Connected — Chrome is running with remote debugging on :9222`);
      console.log(`  ${DIM}Browser harness can now control your live session.${RESET}`);
      console.log();
      return true;
    }
  }

  console.error();
  console.error(`  ${YELLOW}Chrome launched, but CDP socket isn't responding yet.${RESET}`);
  console.error(`  ${DIM}Check that Chrome started, then verify with:${RESET}`);
  console.error(`    ${CYAN}curl http://localhost:9222/json/version${RESET}`);
  console.error();
  return false;
}

export async function cmdBrowserConnect(): Promise<void> {
  const ok = await runConnect({ confirmQuit: true });
  if (!ok) process.exit(1);
}
