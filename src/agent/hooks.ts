/**
 * Clementine TypeScript — Security enforcement and audit logging.
 *
 * Real enforcement via SDK canUseTool callback + disallowed_tools for heartbeats.
 * Layers:
 *   - canUseTool: enforceToolPermissions() blocks destructive/credential/SSRF calls
 *   - disallowed_tools: heartbeat tool restrictions
 *   - System prompt: security rules (defense in depth)
 *   - Audit logging: persistent file + in-memory buffer
 */

import fs from 'node:fs';
import path from 'node:path';
import { OWNER_NAME, BASE_DIR } from '../config.js';

// ── Shared state ───────────────────────────────────────────────────────

let heartbeatActive = false;
let heartbeatTier2Allowed = false;
let activeProfileTier: number | null = null;
let approvalCallback: ((desc: string) => Promise<boolean>) | null = null;
const auditLog: string[] = [];

// ── Persistent audit logger ───────────────────────────────────────────

const logsDir = path.join(BASE_DIR, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const auditLogPath = path.join(logsDir, 'audit.log');
const MAX_AUDIT_SIZE = 5 * 1024 * 1024; // 5 MB

function appendAuditFile(line: string): void {
  try {
    // Simple rotation: if file exceeds max size, rename to .log.1 and start fresh
    if (fs.existsSync(auditLogPath)) {
      const stat = fs.statSync(auditLogPath);
      if (stat.size > MAX_AUDIT_SIZE) {
        const backup = auditLogPath + '.1';
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(auditLogPath, backup);
      }
    }
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(auditLogPath, `${timestamp} ${line}\n`);
  } catch {
    // Non-fatal — audit logging should never crash the assistant
  }
}

// ── State accessors ──────────────────────────────────────────────────

export function setHeartbeatMode(active: boolean, tier2Allowed = false): void {
  heartbeatActive = active;
  heartbeatTier2Allowed = tier2Allowed;
}

export function setApprovalCallback(cb: ((desc: string) => Promise<boolean>) | null): void {
  approvalCallback = cb;
}

export function setProfileTier(tier: number | null): void {
  activeProfileTier = tier;
}

export function getProfileTier(): number | null {
  return activeProfileTier;
}

export function getAuditLog(): string[] {
  return [...auditLog];
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

export function logToolUse(toolName: string, toolInput: Record<string, unknown>): void {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const summary = summarizeToolCall(toolName, toolInput);
  const entry = `- \`${timestamp}\` **${toolName}** — ${summary}`;
  auditLog.push(entry);
  appendAuditFile(`${toolName} — ${summary}`);
}

// ── Heartbeat tool restrictions ─────────────────────────────────────

const HEARTBEAT_DISALLOWED_TIER2 = ['Write', 'Edit', 'Bash'];

const HEARTBEAT_DISALLOWED_ALWAYS = [
  'Bash',      // Never give raw Bash in autonomous mode
  'Task',      // No sub-agents in heartbeats
  'Skill',     // Skill packs load heavy context and waste turns
  'TodoWrite', // Internal bookkeeping wastes autonomous turns
];

export function getHeartbeatDisallowedTools(): string[] {
  const disallowed = [...HEARTBEAT_DISALLOWED_ALWAYS];
  if (!heartbeatTier2Allowed) {
    disallowed.push(...HEARTBEAT_DISALLOWED_TIER2);
  }
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of disallowed) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result;
}

// ── Security patterns ───────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[fd]/i,
  /\brm\s+-r/i,
  /\bgh\s+pr\s+create\b/i,
  /\bgh\s+issue\s+create\b/i,
  /\bcurl\s+.*-X\s+(POST|PUT|DELETE|PATCH)\b/i,
  /\bsendmail\b/i,
  /\bdropdb\b/i,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
];

const PRIVATE_URL_PATTERNS = [
  /localhost/i,
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /192\.168\.\d+\.\d+/,
  /\[::1\]/,
  /file:\/\//,
];

const CREDENTIAL_FILE_PATTERNS = [
  /\.env($|\.)/i,
  /credentials\.json$/i,
  /\.secret/i,
  /token\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
];

const CREDENTIAL_EXPOSURE_PATTERNS = [
  /cat\s+.*\.env/i,
  /echo\s+\$\w*(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i,
  /printenv\s.*(TOKEN|KEY|SECRET)/i,
  /env\s*\|/i,
  /set\s*\|.*grep/i,
];

const CREDENTIAL_CONTENT_PATTERNS = [
  /(?:token|key|secret|password)\s*[=:]\s*\S{20,}/i,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/, // JWT
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /xoxb-[0-9]+-/,
];

// ── Pattern matchers ────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ── SDK-level permission enforcement ────────────────────────────────

export async function enforceToolPermissions(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
  // ── Heartbeat restrictions ─────────────────────────────────────
  if (heartbeatActive) {
    const disallowed = getHeartbeatDisallowedTools();
    if (disallowed.includes(toolName)) {
      return {
        behavior: 'deny',
        message: `${toolName} is not allowed during autonomous execution.`,
      };
    }
  }

  // ── Profile tier restrictions (restrict, never elevate) ────────
  if (activeProfileTier !== null) {
    if (activeProfileTier < 2 && ['Bash', 'Write', 'Edit'].includes(toolName)) {
      return {
        behavior: 'deny',
        message: `${toolName} exceeds this profile's security tier.`,
      };
    }
  }

  // ── Credential file read blocking ──────────────────────────────
  if (toolName === 'Read') {
    const filePath = String(toolInput.file_path ?? '');
    if (matchesAny(filePath, CREDENTIAL_FILE_PATTERNS)) {
      return {
        behavior: 'deny',
        message: 'Cannot read credential files. Secrets are managed by the system, not the assistant.',
      };
    }
  }

  // ── Bash command checks ────────────────────────────────────────
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    if (matchesAny(cmd, CREDENTIAL_EXPOSURE_PATTERNS)) {
      return {
        behavior: 'deny',
        message: 'This command could expose credentials.',
      };
    }
    if (matchesAny(cmd, DESTRUCTIVE_PATTERNS)) {
      if (heartbeatActive) {
        return {
          behavior: 'deny',
          message: 'Destructive commands are forbidden during autonomous execution.',
        };
      }
      return {
        behavior: 'deny',
        message: 'This command requires explicit user approval. Ask the user first.',
      };
    }
  }

  // ── SSRF protection ────────────────────────────────────────────
  if (toolName === 'WebFetch') {
    const url = String(toolInput.url ?? '');
    if (matchesAny(url, PRIVATE_URL_PATTERNS)) {
      return {
        behavior: 'deny',
        message: 'Requests to private/internal URLs are blocked.',
      };
    }
  }

  // ── Credential write blocking ──────────────────────────────────
  if (toolName === 'Write' || toolName === 'Edit') {
    const content = String(toolInput.content ?? toolInput.new_string ?? '');
    if (matchesAny(content, CREDENTIAL_CONTENT_PATTERNS)) {
      return {
        behavior: 'deny',
        message: 'Content appears to contain credentials. Never write secrets to files. Use .env instead.',
      };
    }
  }

  // ── Allow with audit log ───────────────────────────────────────
  logToolUse(toolName, toolInput);
  return { behavior: 'allow' };
}

// ── System prompt security addendum ─────────────────────────────────

export function getSecurityPrompt(): string {
  const owner = OWNER_NAME || 'the user';
  return `
## Security Rules (MANDATORY)

You operate under a 3-tier security model. Violating these rules is not allowed.

### Tier 1 — Auto-approved (do freely):
- Read any file
- Write/edit files within the vault
- WebSearch, WebFetch
- Git: status, log, diff, branch, checkout, pull
- Memory and task tools

### Tier 2 — Allowed with caution:
- Write/create files outside the vault
- Git: add, commit (but NEVER auto-push)
- Bash commands for development (build, test, lint)

### Tier 3 — NEVER do without asking ${owner} first:
- git push (any form)
- gh pr create, gh issue create
- Sending emails, messages, or any outbound communication
- rm -rf, git reset --hard, git clean, or any destructive command
- Form submission or data entry on websites
- Anything involving credentials, payments, or accounts
- Login / authentication flows in a browser

If you need to do a Tier 3 action, tell ${owner} what you want to do and wait
for explicit approval. Do NOT proceed without it.

### SSRF Protection:
Never make requests to localhost, 127.0.0.1, 0.0.0.0, 10.x.x.x, 172.16-31.x.x,
192.168.x.x, [::1], or file:// URLs.

### Credential Safety:
Never write passwords, API keys, tokens, or secrets to vault notes. Credentials
belong in .env files only.
`;
}

export function getHeartbeatSecurityPrompt(): string {
  const owner = OWNER_NAME || 'the user';
  return `
## Heartbeat Security (MANDATORY)

This is an autonomous heartbeat — ${owner} is NOT watching. Extra restrictions apply:

- **Tier 3 actions are FORBIDDEN.** Do not push, delete, or communicate externally.
- **Stay within your tools.** If a tool is not available, do not try to work around it.
- **Keep it brief.** Max 5 tool calls. Check tasks, check daily note, log and move on.
- **Only alert ${owner} if something is genuinely urgent.**
`;
}

export function getCronSecurityPrompt(tier = 1): string {
  const owner = OWNER_NAME || 'the user';
  const tierNote =
    tier < 2
      ? 'You have **Tier 1 only** — read operations and vault writes.'
      : 'You have **Tier 1 + Tier 2** — reads, vault writes, and external write tools.';
  return `
## Cron Job Security (MANDATORY)

This is a scheduled cron job — ${owner} is NOT watching. Restrictions apply:

- **Tier 3 actions are FORBIDDEN.** Do not push, delete, or communicate externally.
- ${tierNote}
- **Stay within your tools.** If a tool is not available, do not try to work around it.
- **Execute the full job.** Follow every phase in the prompt. Use as many tool calls as needed to complete the task thoroughly.
- **Only alert ${owner} if something is genuinely urgent.**
`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function summarizeToolCall(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Read') {
    return `read \`${toolInput.file_path ?? '?'}\``;
  }
  if (toolName === 'Write') {
    return `wrote \`${toolInput.file_path ?? '?'}\``;
  }
  if (toolName === 'Edit') {
    return `edited \`${toolInput.file_path ?? '?'}\``;
  }
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    return `\`${cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd}\``;
  }
  if (toolName === 'WebSearch') {
    return `searched: ${toolInput.query ?? '?'}`;
  }
  if (toolName === 'WebFetch') {
    return `fetched: ${toolInput.url ?? '?'}`;
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    return `pattern: ${toolInput.pattern ?? '?'}`;
  }
  if (toolName.includes('memory_read')) {
    return `read note: ${toolInput.name ?? '?'}`;
  }
  if (toolName.includes('memory_write')) {
    return `wrote: ${toolInput.action ?? '?'}`;
  }
  if (toolName.includes('memory_search')) {
    return `searched vault: ${toolInput.query ?? '?'}`;
  }
  if (toolName.includes('memory_recall')) {
    return `recalled: ${toolInput.query ?? '?'}`;
  }
  if (toolName.includes('task_add')) {
    return `added task: ${toolInput.description ?? '?'}`;
  }
  if (toolName.includes('task_update')) {
    return `updated task: ${toolInput.description ?? '?'}`;
  }
  const keys = Object.keys(toolInput).slice(0, 3);
  return keys.length > 0 ? keys.join(', ') : '(no args)';
}
