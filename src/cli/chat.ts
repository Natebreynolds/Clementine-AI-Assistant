/**
 * Clementine CLI — Interactive REPL chat session.
 *
 * Usage: clementine chat [--model sonnet] [--project myapp] [--profile researcher]
 *
 * Lazy-initializes a gateway instance and streams responses to stdout.
 * Bang commands: !model, !project, !clear, !help, !q, !d prefixes.
 */

import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import type { Gateway } from '../gateway/router.js';

const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');

// ── ANSI helpers ─────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[0;90m';
const CYAN = '\x1b[0;36m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const RESET = '\x1b[0m';

/** Simple ANSI markdown renderer for terminal output. */
function renderMarkdown(text: string): string {
  return text
    // Bold
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    // Inline code
    .replace(/`([^`]+)`/g, `${DIM}$1${RESET}`)
    // Headers
    .replace(/^(#{1,3})\s+(.+)$/gm, (_m, hashes: string, title: string) => {
      const color = hashes.length === 1 ? CYAN : hashes.length === 2 ? GREEN : YELLOW;
      return `${color}${BOLD}${title}${RESET}`;
    });
}

// ── Lazy gateway init ────────────────────────────────────────────────

let gatewayInstance: Gateway | null = null;

async function getGateway(): Promise<Gateway> {
  if (gatewayInstance) return gatewayInstance;

  process.env.CLEMENTINE_HOME = BASE_DIR;
  delete process.env['CLAUDECODE'];

  const { PersonalAssistant } = await import('../agent/assistant.js');
  const assistant = new PersonalAssistant();
  const { Gateway: GatewayClass } = await import('../gateway/router.js');
  gatewayInstance = new GatewayClass(assistant);

  const { setApprovalCallback } = await import('../agent/hooks.js');
  setApprovalCallback(async () => false);

  return gatewayInstance;
}

// ── REPL ─────────────────────────────────────────────────────────────

export async function cmdChat(opts: {
  model?: string;
  project?: string;
  profile?: string;
}): Promise<void> {
  const sessionKey = `cli:repl:${process.pid}`;

  console.log(`${CYAN}${BOLD}Clementine Chat${RESET} ${DIM}(Ctrl+C to exit)${RESET}`);
  console.log();

  const gateway = await getGateway();

  // Apply initial model override
  if (opts.model) {
    const { MODELS } = await import('../config.js');
    const tier = opts.model.toLowerCase() as keyof typeof MODELS;
    if (tier in MODELS) {
      gateway.setSessionModel(sessionKey, MODELS[tier]);
      console.log(`${DIM}Model: ${tier} (${MODELS[tier]})${RESET}`);
    }
  }

  // Apply initial project override
  if (opts.project) {
    const { findProjectByName } = await import('../agent/assistant.js');
    const project = findProjectByName(opts.project);
    if (project) {
      gateway.setSessionProject(sessionKey, project);
      console.log(`${DIM}Project: ${path.basename(project.path)}${RESET}`);
    } else {
      console.log(`${YELLOW}Project "${opts.project}" not found — using auto-matching${RESET}`);
    }
  }

  // Apply initial profile override
  if (opts.profile) {
    const { PROFILES_DIR, AGENTS_DIR } = await import('../config.js');
    const { AgentManager } = await import('../agent/agent-manager.js');
    const pm = new AgentManager(AGENTS_DIR, PROFILES_DIR);
    const profile = pm.get(opts.profile);
    if (profile) {
      gateway.setSessionProfile(sessionKey, opts.profile);
      console.log(`${DIM}Profile: ${profile.name}${RESET}`);
    } else {
      console.log(`${YELLOW}Profile "${opts.profile}" not found${RESET}`);
    }
  }

  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}>${RESET} `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // ── Bang commands ────────────────────────────────────────────
    if (text === '!help' || text === '!h') {
      console.log([
        `${BOLD}Commands:${RESET}`,
        `  ${CYAN}!model [haiku|sonnet|opus]${RESET} — Switch model`,
        `  ${CYAN}!project <name|list|clear|status>${RESET} — Set project context`,
        `  ${CYAN}!clear${RESET} — Reset conversation`,
        `  ${CYAN}!q <msg>${RESET} — Quick reply (Haiku)`,
        `  ${CYAN}!d <msg>${RESET} — Deep reply (Opus)`,
        `  ${CYAN}!help${RESET} — This message`,
        `  ${DIM}Ctrl+C to exit${RESET}`,
      ].join('\n'));
      rl.prompt();
      return;
    }

    if (text === '!clear') {
      gateway.clearSession(sessionKey);
      console.log(`${DIM}Session cleared.${RESET}`);
      rl.prompt();
      return;
    }

    if (text.startsWith('!model')) {
      const parts = text.split(/\s+/);
      const tier = parts[1]?.toLowerCase();
      const { MODELS } = await import('../config.js');
      if (tier && tier in MODELS) {
        gateway.setSessionModel(sessionKey, MODELS[tier as keyof typeof MODELS]);
        console.log(`${DIM}Model switched to ${tier} (${MODELS[tier as keyof typeof MODELS]})${RESET}`);
      } else {
        const current = gateway.getSessionModel(sessionKey) ?? 'default';
        console.log(`${DIM}Current model: ${current}. Options: haiku, sonnet, opus${RESET}`);
      }
      rl.prompt();
      return;
    }

    if (text.startsWith('!project')) {
      const parts = text.split(/\s+/);
      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === 'clear') {
        gateway.clearSessionProject(sessionKey);
        console.log(`${DIM}Project context cleared.${RESET}`);
      } else if (subCmd === 'status') {
        const current = gateway.getSessionProject(sessionKey);
        if (current) {
          console.log(`${DIM}Active: ${path.basename(current.path)} — ${current.path}${RESET}`);
        } else {
          console.log(`${DIM}No active project. Using auto-matching.${RESET}`);
        }
      } else if (subCmd === 'list' || !subCmd) {
        const { getLinkedProjects } = await import('../agent/assistant.js');
        const projects = getLinkedProjects();
        if (projects.length === 0) {
          console.log(`${DIM}No linked projects.${RESET}`);
        } else {
          const current = gateway.getSessionProject(sessionKey);
          for (const p of projects) {
            const name = path.basename(p.path);
            const active = current && p.path === current.path ? ` ${GREEN}(active)${RESET}` : '';
            console.log(`  ${CYAN}${name}${RESET}${active}`);
          }
        }
      } else {
        // Set project
        const projectName = parts.slice(1).join(' ');
        const { findProjectByName } = await import('../agent/assistant.js');
        const project = findProjectByName(projectName);
        if (project) {
          gateway.clearSession(sessionKey);
          gateway.setSessionProject(sessionKey, project);
          console.log(`${DIM}Switched to ${path.basename(project.path)}. Session cleared.${RESET}`);
        } else {
          console.log(`${YELLOW}Project "${projectName}" not found.${RESET}`);
        }
      }
      rl.prompt();
      return;
    }

    // ── Per-message model prefix ───────────────────────────────
    let effectiveText = text;
    let oneOffModel: string | undefined;
    if (text.startsWith('!q ')) {
      const { MODELS } = await import('../config.js');
      oneOffModel = MODELS.haiku;
      effectiveText = text.slice(3);
    } else if (text.startsWith('!d ')) {
      const { MODELS } = await import('../config.js');
      oneOffModel = MODELS.opus;
      effectiveText = text.slice(3);
    }

    // ── Send message ──────────────────────────────────────────
    process.stdout.write(`\n${DIM}thinking...${RESET}\r`);

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        effectiveText,
        undefined,
        oneOffModel,
      );
      // Clear "thinking..." line
      process.stdout.write('\x1b[2K\r');
      // Show active project if auto-matched
      const matched = gateway.getLastMatchedProject(sessionKey);
      if (matched) {
        console.log(`\x1b[0;90m[project: ${path.basename(matched.path)}]\x1b[0m`);
      }
      console.log(renderMarkdown(response));
      console.log();
    } catch (err) {
      process.stdout.write('\x1b[2K\r');
      console.error(`${YELLOW}Error: ${err}${RESET}`);
      console.log();
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${DIM}Goodbye.${RESET}`);
    process.exit(0);
  });
}
