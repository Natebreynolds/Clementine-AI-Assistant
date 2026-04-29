/**
 * Clementine TypeScript — Configuration and paths.
 *
 * Reads .env into a local record — never pollutes process.env.
 * The Claude Code SDK subprocess inherits process.env, so keeping
 * secrets out of it prevents accidental leakage.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Models } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Path split: code vs data ────────────────────────────────────────

/** Package/code root (wherever npm installed the package). */
export const PKG_DIR = path.resolve(__dirname, '..');

/** Data home — user data, vault, .env, logs, sessions. */
export const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');

// ── .env parser (never sets process.env) ────────────────────────────

import { parseEnvText, shellEscape as _shellEscape } from './config/env-parser.js';

function readEnvFile(): Record<string, string> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return {};
  return parseEnvText(readFileSync(envPath, 'utf-8'));
}

const env = readEnvFile();

// ── Keychain-ref resolution (lazy, cached) ──────────────────────────
//
// `.env` may store keychain stubs ("keychain:clementine-agent-FOO") in place
// of actual values for any key — not just the SECRET-classified ones that
// `getSecret` knows about. Without resolution, getEnv would return the
// literal stub and downstream code (Number(...), comparisons, etc.) would
// silently misbehave.
//
// Resolution is lazy (first read of a ref triggers the keychain shell call)
// and memoised, so users see at most one approval prompt per ref over the
// daemon's lifetime. A failed resolution caches `null` so repeated reads
// don't re-prompt; callers fall through to their own fallback.

const KEYCHAIN_REF_PREFIX = 'keychain:'; // pragma: allowlist secret
const resolvedKeychainRefs = new Map<string, string | null>();

function isKeychainRef(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith(KEYCHAIN_REF_PREFIX);
}

/**
 * Hard cap on each `security find-generic-password` shell call. The macOS
 * keychain prompts the user for read access on first use of any entry created
 * with restrictive ACL (`-T ''`). If the prompt doesn't appear (hidden behind
 * a window, denied silently, or the user is afk), the call would otherwise
 * block indefinitely — which means `clementine` and the daemon would hang at
 * boot. Cap and fall through to the caller's default; the failure caches as
 * null so we don't re-prompt this process. Override via env if needed.
 */
const KEYCHAIN_TIMEOUT_MS = Math.max(
  500,
  parseInt(env['CLEMENTINE_KEYCHAIN_TIMEOUT_MS'] ?? process.env.CLEMENTINE_KEYCHAIN_TIMEOUT_MS ?? '3000', 10) || 3000,
);

function resolveKeychainRef(stub: string): string | undefined {
  if (resolvedKeychainRefs.has(stub)) {
    const cached = resolvedKeychainRefs.get(stub);
    return cached ?? undefined;
  }
  // Stub format: keychain:<service>-<account>. The whole tail after the prefix
  // is the account name under the well-known service "clementine-agent".
  const account = stub.slice(KEYCHAIN_REF_PREFIX.length);
  try {
    const result = execSync(
      `security find-generic-password -s clementine-agent -a ${shellEscape(account)} -w`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS },
    ).trim();
    resolvedKeychainRefs.set(stub, result || null);
    return result || undefined;
  } catch {
    resolvedKeychainRefs.set(stub, null);
    return undefined;
  }
}

function maybeResolveRef(value: string | undefined): string | undefined {
  if (!value) return value;
  if (!isKeychainRef(value)) return value;
  return resolveKeychainRef(value);
}

/**
 * Look up a config value: local .env first, then process.env fallback.
 * Keychain refs in either source are resolved lazily; failed resolution
 * falls through to the fallback rather than returning the literal stub.
 */
function getEnv(key: string, fallback = ''): string {
  const fromLocal = maybeResolveRef(env[key]);
  if (fromLocal !== undefined && fromLocal !== '') return fromLocal;
  const fromProcess = maybeResolveRef(process.env[key]);
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  return fallback;
}

/** Merged view of process.env overlaid with .env. Use for classifyIntegrations / summarizeIntegrationStatus. */
export function envSnapshot(): Record<string, string | undefined> {
  return { ...process.env, ...env };
}

/** Test-only: clear the keychain ref cache so re-resolution can be tested. */
export function _resetKeychainRefCache(): void {
  resolvedKeychainRefs.clear();
}

/**
 * Return the keychain stubs that couldn't be resolved this process. Used by
 * the daemon entrypoint to log a clear remediation hint at boot if any
 * keychain reads are failing (typically: ACL not yet partition-listed →
 * `clementine config keychain-fix-acl` fixes it).
 */
export function getFailedKeychainResolutions(): string[] {
  const out: string[] = [];
  for (const [stub, value] of resolvedKeychainRefs) {
    if (value === null) out.push(stub);
  }
  return out;
}

// ── Paths ────────────────────────────────────────────────────────────

export const VAULT_DIR = path.join(BASE_DIR, 'vault');

export const SYSTEM_DIR = path.join(VAULT_DIR, '00-System');
export const DAILY_NOTES_DIR = path.join(VAULT_DIR, '01-Daily-Notes');
export const PEOPLE_DIR = path.join(VAULT_DIR, '02-People');
export const PROJECTS_DIR = path.join(VAULT_DIR, '03-Projects');
export const TOPICS_DIR = path.join(VAULT_DIR, '04-Topics');
export const TASKS_DIR = path.join(VAULT_DIR, '05-Tasks');
export const TEMPLATES_DIR = path.join(VAULT_DIR, '06-Templates');
export const INBOX_DIR = path.join(VAULT_DIR, '07-Inbox');
// PROFILES_DIR (vault/00-System/profiles/) removed in Phase 14 cleanup —
// the legacy profile format hasn't been used in production for a long time.
// AGENTS_DIR is the canonical home for agent definitions.
export const AGENTS_DIR = path.join(SYSTEM_DIR, 'agents');

export const SOUL_FILE = path.join(SYSTEM_DIR, 'SOUL.md');
export const AGENTS_FILE = path.join(SYSTEM_DIR, 'AGENTS.md');
export const MEMORY_FILE = path.join(SYSTEM_DIR, 'MEMORY.md');
export const HEARTBEAT_FILE = path.join(SYSTEM_DIR, 'HEARTBEAT.md');
export const CRON_FILE = path.join(SYSTEM_DIR, 'CRON.md');
export const WORKFLOWS_DIR = path.join(SYSTEM_DIR, 'workflows');
export const TASKS_FILE = path.join(TASKS_DIR, 'TASKS.md');
export const DAILY_TEMPLATE = path.join(TEMPLATES_DIR, '_Daily-Template.md');
export const PEOPLE_TEMPLATE = path.join(TEMPLATES_DIR, '_People-Template.md');
export const PROJECTS_META_FILE = path.join(BASE_DIR, 'projects.json');
export const WORKING_MEMORY_FILE = path.join(BASE_DIR, 'working-memory.md');
export const IDENTITY_FILE = path.join(SYSTEM_DIR, 'IDENTITY.md');

// ── Assistant identity ───────────────────────────────────────────────

// JSON config — loaded once at module init. Lower precedence than .env.
import { loadClementineJson, resolveNumber, resolveString } from './config/clementine-json.js';
const json = loadClementineJson(BASE_DIR);

/** Wrap resolveString with this module's getEnv lookup so call sites stay terse. */
function getEnvOrJson(envKey: string, jsonValue: string | undefined, fallback: string): string {
  return resolveString(getEnv(envKey, ''), jsonValue, fallback);
}

/** Numeric variant — env > JSON > default; non-finite env is ignored. */
function getEnvOrJsonNumber(envKey: string, jsonValue: number | undefined, fallback: number): number {
  return resolveNumber(getEnv(envKey, ''), jsonValue, fallback);
}

export const ASSISTANT_NAME = getEnvOrJson('ASSISTANT_NAME', json.assistantName, 'Clementine');
export const ASSISTANT_NICKNAME = getEnv('ASSISTANT_NICKNAME', 'Clemmy');
export const OWNER_NAME = getEnvOrJson('OWNER_NAME', json.ownerName, '');

// ── Secrets (with macOS Keychain fallback) ───────────────────────────

// Re-export shellEscape from the shared helper so existing call sites
// (config.ts internal uses + downstream importers) keep working.
export const shellEscape = _shellEscape;

function getSecret(envKey: string, keychainService?: string): string {
  // Resolve keychain refs from .env in place so secrets stored as stubs
  // come back as their real values (same blind spot as getEnv had pre-fix).
  const local = maybeResolveRef(env[envKey]);
  if (local) return local;

  const service = keychainService ?? ASSISTANT_NAME.toLowerCase();
  try {
    const result = execSync(
      `security find-generic-password -s ${shellEscape(service)} -a ${shellEscape(envKey)} -w`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return result.trim();
  } catch {
    return '';
  }
}

// ── Models ───────────────────────────────────────────────────────────

export const MODELS: Models = {
  haiku: getEnvOrJson('HAIKU_MODEL', json.models?.haiku, 'claude-haiku-4-5-20251001'),
  sonnet: getEnvOrJson('SONNET_MODEL', json.models?.sonnet, 'claude-sonnet-4-6'),
  opus: getEnvOrJson('OPUS_MODEL', json.models?.opus, 'claude-opus-4-6'),
};

// ── Budget caps (USD per query) ──────────────────────────────────────
// User-tunable via `clementine config set BUDGET_<NAME>_USD <value>`
// (writes to ~/.clementine/.env, survives npm update -g) or via
// `budgets.*` keys in clementine.json.

export const BUDGET = {
  heartbeat: getEnvOrJsonNumber('BUDGET_HEARTBEAT_USD', json.budgets?.heartbeat, 0.50), // per heartbeat (Haiku)
  cronT1: getEnvOrJsonNumber('BUDGET_CRON_T1_USD', json.budgets?.cronT1, 2.00),         // per tier-1 cron job
  cronT2: getEnvOrJsonNumber('BUDGET_CRON_T2_USD', json.budgets?.cronT2, 5.00),         // per tier-2 cron job
  chat: getEnvOrJsonNumber('BUDGET_CHAT_USD', json.budgets?.chat, 5.00),                // per interactive chat
  unleashedPhase: undefined,
  memoryExtraction: undefined,
  summarization: undefined,
  reflection: undefined,
};

// ── Task budget caps (tokens per query) ──────────────────────────────
// Passed to the Claude Agent SDK as `taskBudget: { total }`. The model is
// told its remaining token budget so it can pace tool use and wrap up
// before the cap — a soft brake that prevents runaway loops in
// autonomous contexts. Undefined = no cap. Tunable via env.
//
// Zero means "disabled" — treat as undefined so the SDK sees no cap.

function optionalTokenEnv(name: string, def: number | undefined): number | undefined {
  const raw = getEnv(name, def === undefined ? '' : String(def));
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export const TASK_BUDGET_TOKENS = {
  heartbeat: optionalTokenEnv('TASK_BUDGET_HEARTBEAT', 30_000),
  cronT1: optionalTokenEnv('TASK_BUDGET_CRON_T1', 80_000),
  cronT2: optionalTokenEnv('TASK_BUDGET_CRON_T2', 250_000),
  unleashedPhase: optionalTokenEnv('TASK_BUDGET_UNLEASHED', 500_000),
  planStep: optionalTokenEnv('TASK_BUDGET_PLAN_STEP', 50_000),
  // Interactive chat: off by default — let the user and maxTurns drive it.
  chat: optionalTokenEnv('TASK_BUDGET_CHAT', undefined),
};

export const DEFAULT_MODEL_TIER = (getEnvOrJson('DEFAULT_MODEL_TIER', json.models?.default, 'sonnet')) as keyof Models;
export const MODEL = MODELS[DEFAULT_MODEL_TIER] ?? MODELS.sonnet;

/** Enable 1M context window for Sonnet (beta). Toggle via ENABLE_1M_CONTEXT=true in .env or dashboard. */
export let ENABLE_1M_CONTEXT = getEnv('ENABLE_1M_CONTEXT', 'false').toLowerCase() === 'true';

/** Update 1M context flag at runtime (called from dashboard settings API). */
export function setEnable1MContext(value: boolean): void {
  ENABLE_1M_CONTEXT = value;
}

// ── Discord ──────────────────────────────────────────────────────────

export const DISCORD_TOKEN = getSecret('DISCORD_TOKEN');
export const DISCORD_OWNER_ID = getEnv('DISCORD_OWNER_ID', '0');
export const DISCORD_WATCHED_CHANNELS: string[] = getEnv('DISCORD_WATCHED_CHANNELS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Slack ────────────────────────────────────────────────────────────

export const SLACK_BOT_TOKEN = getSecret('SLACK_BOT_TOKEN');
export const SLACK_APP_TOKEN = getSecret('SLACK_APP_TOKEN');
export const SLACK_OWNER_USER_ID = getEnv('SLACK_OWNER_USER_ID');

// ── Telegram ─────────────────────────────────────────────────────────

export const TELEGRAM_BOT_TOKEN = getSecret('TELEGRAM_BOT_TOKEN');
export const TELEGRAM_OWNER_ID = getEnv('TELEGRAM_OWNER_ID', '0');

// ── WhatsApp (Twilio) ────────────────────────────────────────────────

export const TWILIO_ACCOUNT_SID = getSecret('TWILIO_ACCOUNT_SID');
export const TWILIO_AUTH_TOKEN = getSecret('TWILIO_AUTH_TOKEN');
export const WHATSAPP_OWNER_PHONE = getEnv('WHATSAPP_OWNER_PHONE');
export const WHATSAPP_FROM_PHONE = getEnv('WHATSAPP_FROM_PHONE');
export const WHATSAPP_WEBHOOK_PORT = parseInt(getEnv('WHATSAPP_WEBHOOK_PORT', '8421'), 10);

// ── Webhook ──────────────────────────────────────────────────────────

export const WEBHOOK_ENABLED = getEnv('WEBHOOK_ENABLED', 'false').toLowerCase() === 'true';
export const WEBHOOK_PORT = parseInt(getEnv('WEBHOOK_PORT', '8420'), 10);
export const WEBHOOK_SECRET = getSecret('WEBHOOK_SECRET');
// Default bind to localhost only — flip to 0.0.0.0 explicitly via WEBHOOK_BIND
// for tunneled or LAN-exposed setups. Avoids the OpenClaw CVE-2026-25253 shape.
export const WEBHOOK_BIND = getEnv('WEBHOOK_BIND', '127.0.0.1');

// ── Voice ────────────────────────────────────────────────────────────

export const GROQ_API_KEY = getSecret('GROQ_API_KEY');
export const ELEVENLABS_API_KEY = getSecret('ELEVENLABS_API_KEY');
export const ELEVENLABS_VOICE_ID = getEnv('ELEVENLABS_VOICE_ID');

// ── Video ────────────────────────────────────────────────────────────

export const GOOGLE_API_KEY = getSecret('GOOGLE_API_KEY');

// ── Outlook (Microsoft Graph) ───────────────────────────────────────

export const MS_TENANT_ID = getEnv('MS_TENANT_ID');
export const MS_CLIENT_ID = getEnv('MS_CLIENT_ID');
export const MS_CLIENT_SECRET = getSecret('MS_CLIENT_SECRET');
export const MS_USER_EMAIL = getEnv('MS_USER_EMAIL');

// ── Salesforce CRM ─────────────────────────────────────────────────

export const SF_INSTANCE_URL = getEnv('SF_INSTANCE_URL');
export const SF_CLIENT_ID = getEnv('SF_CLIENT_ID');
export const SF_CLIENT_SECRET = getSecret('SF_CLIENT_SECRET');
export const SF_USERNAME = getEnv('SF_USERNAME');
export const SF_PASSWORD = getSecret('SF_PASSWORD');
export const SF_API_VERSION = getEnv('SF_API_VERSION', 'v62.0');

// ── Security ─────────────────────────────────────────────────────────

export const ALLOW_ALL_USERS = getEnv('ALLOW_ALL_USERS', 'false').toLowerCase() === 'true';

// ── Timezone ─────────────────────────────────────────────────────────

/** User-configurable timezone. Falls back to system-detected timezone. */
export const TIMEZONE = getEnvOrJson('TIMEZONE', json.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);

// ── Heartbeat ────────────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MINUTES = Math.floor(
  getEnvOrJsonNumber('HEARTBEAT_INTERVAL_MINUTES', json.heartbeat?.intervalMinutes, 30),
) || 30;
export const HEARTBEAT_ACTIVE_START = Math.floor(
  getEnvOrJsonNumber('HEARTBEAT_ACTIVE_START', json.heartbeat?.activeStart, 8),
);
export const HEARTBEAT_ACTIVE_END = Math.floor(
  getEnvOrJsonNumber('HEARTBEAT_ACTIVE_END', json.heartbeat?.activeEnd, 22),
);
export const HEARTBEAT_MAX_TURNS = 5;
export const HEARTBEAT_WORK_QUEUE_FILE = path.join(BASE_DIR, 'heartbeat', 'work-queue.json');

// ── Unleashed mode ──────────────────────────────────────────────────

/** Max turns per phase in unleashed mode before checkpointing. */
export const UNLEASHED_PHASE_TURNS = Math.floor(
  getEnvOrJsonNumber('UNLEASHED_PHASE_TURNS', json.unleashed?.phaseTurns, 75),
);
/** Default max duration for unleashed tasks (hours). */
export const UNLEASHED_DEFAULT_MAX_HOURS = getEnvOrJsonNumber(
  'UNLEASHED_DEFAULT_MAX_HOURS', json.unleashed?.defaultMaxHours, 6,
);
/** Max phases before forcing completion. */
export const UNLEASHED_MAX_PHASES = Math.floor(
  getEnvOrJsonNumber('UNLEASHED_MAX_PHASES', json.unleashed?.maxPhases, 50),
);

// ── Workspace ───────────────────────────────────────────────────────

export const WORKSPACE_DIRS: string[] = getEnv('WORKSPACE_DIRS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Channel availability flags ───────────────────────────────────────

export const CHANNEL_DISCORD = Boolean(DISCORD_TOKEN);
export const CHANNEL_SLACK = Boolean(SLACK_BOT_TOKEN && SLACK_APP_TOKEN);
export const CHANNEL_TELEGRAM = Boolean(TELEGRAM_BOT_TOKEN);
export const CHANNEL_WHATSAPP = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && WHATSAPP_OWNER_PHONE);
export const CHANNEL_WEBHOOK = WEBHOOK_ENABLED && Boolean(WEBHOOK_SECRET);
export const CHANNEL_OUTLOOK = Boolean(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MS_USER_EMAIL);
export const CHANNEL_SALESFORCE = Boolean(SF_INSTANCE_URL && SF_CLIENT_ID && SF_CLIENT_SECRET);

// ── Fail-closed secret validation ───────────────────────────────────
//
// If a secret is explicitly configured in .env but resolves to empty,
// that's a misconfiguration — fail loud instead of silently degrading.
// Only checks keys that are present in .env (not absent ones).

interface SecretValidation {
  key: string;
  channel: string;
  requiredWith?: string[]; // other keys that must also be set
}

const SECRET_VALIDATIONS: SecretValidation[] = [
  { key: 'DISCORD_TOKEN', channel: 'Discord' },
  { key: 'SLACK_BOT_TOKEN', channel: 'Slack', requiredWith: ['SLACK_APP_TOKEN'] },
  { key: 'SLACK_APP_TOKEN', channel: 'Slack', requiredWith: ['SLACK_BOT_TOKEN'] },
  { key: 'TELEGRAM_BOT_TOKEN', channel: 'Telegram' },
  { key: 'TWILIO_ACCOUNT_SID', channel: 'WhatsApp', requiredWith: ['TWILIO_AUTH_TOKEN', 'WHATSAPP_OWNER_PHONE'] },
  // Auth is optional here — clementine login sets CLAUDE_CODE_OAUTH_TOKEN (preferred).
  // SDK subprocess reads CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > Keychain.
  { key: 'CLAUDE_CODE_OAUTH_TOKEN', channel: 'API (preferred — set via `clementine login`)' },
  { key: 'ANTHROPIC_API_KEY', channel: 'API (legacy — use `clementine login` for OAuth instead)' },
  { key: 'SF_CLIENT_SECRET', channel: 'Salesforce', requiredWith: ['SF_CLIENT_ID', 'SF_INSTANCE_URL'] },
];

/**
 * Validate that explicitly configured secrets actually resolved.
 * Call at startup — throws on misconfiguration.
 */
export function validateSecrets(): string[] {
  const warnings: string[] = [];
  for (const v of SECRET_VALIDATIONS) {
    // Only check if the key is explicitly present in .env (not process.env fallback)
    const explicitlyConfigured = v.key in env;
    if (!explicitlyConfigured) continue;

    const value = getSecret(v.key);
    if (!value) {
      warnings.push(
        `${v.channel}: ${v.key} is configured in .env but resolved to empty. ` +
        `Check your .env file or Keychain entry.`,
      );
    }

    // Check companion keys
    if (value && v.requiredWith) {
      for (const companion of v.requiredWith) {
        const companionValue = env[companion] ?? '';
        // Only warn if the companion is also in .env but empty
        if (companion in env && !companionValue) {
          warnings.push(
            `${v.channel}: ${v.key} is set but companion ${companion} is empty.`,
          );
        }
      }
    }
  }
  return warnings;
}

// ── Team ────────────────────────────────────────────────────────────

export const TEAM_COMMS_CHANNEL = getEnv('TEAM_COMMS_CHANNEL');
export const TEAM_COMMS_LOG = path.join(BASE_DIR, 'logs', 'team-comms.jsonl');

// ── Link Extraction ──────────────────────────────────────────────────

export const LINK_EXTRACT_MAX_URLS = 3;
export const LINK_EXTRACT_MAX_CHARS = 4000;

// ── Memory / Search ──────────────────────────────────────────────────

export const MEMORY_DB_PATH = path.join(VAULT_DIR, '.memory.db');
export const GRAPH_DB_DIR = path.join(BASE_DIR, '.graph.db');
export const SEARCH_CONTEXT_LIMIT = 6;
export const SEARCH_RECENCY_LIMIT = 4;
export const SYSTEM_PROMPT_MAX_CONTEXT_CHARS = 12000;

// ── Session Persistence ──────────────────────────────────────────────

export const SESSION_EXCHANGE_HISTORY_SIZE = 10;
export const SESSION_EXCHANGE_MAX_CHARS = 2000;
export const INJECTED_CONTEXT_MAX_CHARS = 6000;

// ── Search Ranking ───────────────────────────────────────────────────

export const TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
export const EPISODIC_DECAY_HALF_LIFE_DAYS = 7;

// ── Self-Improvement ─────────────────────────────────────────────────

export const SELF_IMPROVE_DIR = path.join(BASE_DIR, 'self-improve');
export const SOURCE_MODS_DIR = path.join(SELF_IMPROVE_DIR, 'source-mods');
export const PENDING_SKILLS_DIR = path.join(SELF_IMPROVE_DIR, 'pending-skills');

// ── Goals & Cron Progress ───────────────────────────────────────────

export const GOALS_DIR = path.join(BASE_DIR, 'goals');
export const SEEN_CHANNELS_FILE = path.join(BASE_DIR, 'seen-channels.json');
export const CRON_PROGRESS_DIR = path.join(BASE_DIR, 'cron', 'progress');
export const CRON_REFLECTIONS_DIR = path.join(BASE_DIR, 'cron', 'reflections');
export const DELEGATIONS_DIR = path.join(VAULT_DIR, '00-System', 'agents');
export const HANDOFFS_DIR = path.join(BASE_DIR, 'handoffs');
export const PLAN_STATE_DIR = path.join(BASE_DIR, 'plan-state');
export const VAULT_MIGRATIONS_STATE = path.join(BASE_DIR, '.vault-migrations.json');

// ── Daily Plans ─────────────────────────────────────────────────────

export const PLANS_DIR = path.join(BASE_DIR, 'plans');

// ── Advisor Decision Log ────────────────────────────────────────────

export const ADVISOR_LOG_PATH = path.join(BASE_DIR, 'cron', 'advisor-decisions.jsonl');

// ── Remote Access ──────────────────────────────────────────────────

export const REMOTE_ACCESS_CONFIG = path.join(BASE_DIR, 'remote-access.json');

/** Persistent session store for the dashboard /auth flow (mode 0600 enforced on write). */
export const SESSIONS_FILE = path.join(BASE_DIR, '.sessions.json');

// ── Source Self-Edit Staging ─────────────────────────────────────────

export const STAGING_DIR = path.join(BASE_DIR, 'staging');

// Source self-editing is deprecated. The data-driven path (advisor rules,
// CRON.md frontmatter, prompt overrides) is the supported way to evolve
// behavior without requiring a new release. Set CLEMENTINE_ALLOW_SOURCE_EDITS=1
// in ~/.clementine/.env to re-enable for genuine engine bugs that can't be
// expressed as data — the primitive itself stays on disk for that escape hatch.
export const ALLOW_SOURCE_EDITS = (() => {
  const raw = getEnv('CLEMENTINE_ALLOW_SOURCE_EDITS', '').toLowerCase().trim();
  return raw === '1' || raw === 'true' || raw === 'yes';
})();

// Advisor rule engine mode:
//   off     — no rule loader (default, identical to pre-2a behavior)
//   shadow  — rule engine runs alongside the legacy TS path; differences
//             are logged but TS path's advice is what's returned.
//   primary — rule engine is the source of truth; legacy TS path is only
//             consulted as a fallback if the loader is unavailable.
export const ADVISOR_RULES_LOADER: 'off' | 'shadow' | 'primary' = (() => {
  const raw = getEnv('CLEMENTINE_ADVISOR_RULES_LOADER', '').toLowerCase().trim();
  if (raw === 'shadow') return 'shadow';
  if (raw === 'primary') return 'primary';
  return 'off';
})();

// ── API ──────────────────────────────────────────────────────────────

// Long-lived OAuth token from `clementine login` / `claude setup-token`.
// Takes priority over ANTHROPIC_API_KEY in the SDK subprocess env.
export const CLAUDE_CODE_OAUTH_TOKEN = getSecret('CLAUDE_CODE_OAUTH_TOKEN');
export const ANTHROPIC_API_KEY = getSecret('ANTHROPIC_API_KEY');

// ── Brain credentials ────────────────────────────────────────────────
//
// User-managed secrets referenced by Brain sources (scheduled REST polls,
// webhook HMAC secrets). Stored plaintext in ~/.clementine/credentials.json
// — gitignored, mode 0600 enforced on write. Keychain integration can come
// later; for now this matches the rest of Clementine's "local-first, single
// user" model.

export const CREDENTIALS_FILE = path.join(BASE_DIR, 'credentials.json');

let _credentialsCache: Record<string, string> | null = null;
let _credentialsMtime = 0;

export function getCredential(ref: string): string | null {
  try {
    const stat = fs.statSync(CREDENTIALS_FILE);
    if (stat.mtimeMs !== _credentialsMtime) {
      const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
      _credentialsCache = JSON.parse(raw) as Record<string, string>;
      _credentialsMtime = stat.mtimeMs;
    }
  } catch {
    // File doesn't exist or is unreadable — fall back to env var
    _credentialsCache = _credentialsCache ?? {};
  }
  const fromFile = _credentialsCache?.[ref];
  if (fromFile) return fromFile;
  // Env-var fallback so users can set credentials without the file
  return process.env[ref] ?? null;
}

/** Set a credential (creates the file if needed, enforces 0600). */
export function setCredential(ref: string, value: string): void {
  let current: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    current = JSON.parse(raw) as Record<string, string>;
  } catch { /* new file */ }
  current[ref] = value;
  if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
  _credentialsCache = current;
  _credentialsMtime = fs.statSync(CREDENTIALS_FILE).mtimeMs;
}

/** List known credential refs (not their values) for dashboard display. */
export function listCredentialRefs(): string[] {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    return Object.keys(JSON.parse(raw) as Record<string, string>);
  } catch { return []; }
}
