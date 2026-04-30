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

  console.log();
  console.log(`  ${BOLD}Browser Harness${RESET} ${DIM}(beta)${RESET}`);
  console.log();
  console.log(`  ${py ? GREEN + '✓' : RED + '✗'}${RESET} python3            ${DIM}${py ?? 'not found'}${RESET}`);
  console.log(`  ${mcpScriptOk ? GREEN + '✓' : RED + '✗'}${RESET} MCP wrapper       ${DIM}${MCP_SCRIPT}${RESET}`);
  console.log(`  ${venvOk ? GREEN + '✓' : YELLOW + '○'}${RESET} venv installed    ${DIM}${VENV_DIR}${RESET}`);
  console.log(`  ${harnessOk ? GREEN + '✓' : YELLOW + '○'}${RESET} harness cloned    ${DIM}${HARNESS_HOME}${RESET}`);
  console.log(`  ${enabled ? GREEN + '✓' : DIM + '○'}${RESET} MCP entry         ${DIM}${enabled ? 'enabled' : 'disabled'} in mcp-servers.json${RESET}`);
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
  } else {
    console.log(`  ${GREEN}Ready.${RESET} ${DIM}Restart the daemon to pick up changes: clementine restart${RESET}`);
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
  console.log(`  ${BOLD}Next steps:${RESET}`);
  console.log(`  1. Enable Chrome remote debugging — open Chrome with:`);
  console.log(`       ${CYAN}/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\${RESET}`);
  console.log(`         ${CYAN}--remote-debugging-port=9222${RESET}`);
  console.log(`  2. Enable the MCP server:  ${BOLD}clementine browser enable${RESET}`);
  console.log(`  3. Restart the daemon:     ${BOLD}clementine restart${RESET}`);
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
  console.log(`  ${DIM}Open Chrome with --remote-debugging-port=9222 to connect.${RESET}`);
  console.log();
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
