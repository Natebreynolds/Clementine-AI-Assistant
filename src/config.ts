/**
 * Clementine TypeScript — Configuration and paths.
 *
 * Reads .env into a local record — never pollutes process.env.
 * The Claude Code SDK subprocess inherits process.env, so keeping
 * secrets out of it prevents accidental leakage.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

function readEnvFile(): Record<string, string> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const env = readEnvFile();

/** Look up a config value: local .env first, then process.env fallback. */
function getEnv(key: string, fallback = ''): string {
  return env[key] ?? process.env[key] ?? fallback;
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
export const PROFILES_DIR = path.join(SYSTEM_DIR, 'profiles');

export const SOUL_FILE = path.join(SYSTEM_DIR, 'SOUL.md');
export const AGENTS_FILE = path.join(SYSTEM_DIR, 'AGENTS.md');
export const MEMORY_FILE = path.join(SYSTEM_DIR, 'MEMORY.md');
export const HEARTBEAT_FILE = path.join(SYSTEM_DIR, 'HEARTBEAT.md');
export const CRON_FILE = path.join(SYSTEM_DIR, 'CRON.md');
export const TASKS_FILE = path.join(TASKS_DIR, 'TASKS.md');
export const DAILY_TEMPLATE = path.join(TEMPLATES_DIR, '_Daily-Template.md');
export const PEOPLE_TEMPLATE = path.join(TEMPLATES_DIR, '_People-Template.md');

// ── Assistant identity ───────────────────────────────────────────────

export const ASSISTANT_NAME = getEnv('ASSISTANT_NAME', 'Clementine');
export const ASSISTANT_NICKNAME = getEnv('ASSISTANT_NICKNAME', 'Clemmy');
export const OWNER_NAME = getEnv('OWNER_NAME');

// ── Secrets (with macOS Keychain fallback) ───────────────────────────

function getSecret(envKey: string, keychainService?: string): string {
  const value = env[envKey] ?? '';
  if (value) return value;

  const service = keychainService ?? ASSISTANT_NAME.toLowerCase();
  try {
    const result = execSync(
      `security find-generic-password -s "${service}" -a "${envKey}" -w`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim();
  } catch {
    return '';
  }
}

// ── Models ───────────────────────────────────────────────────────────

export const MODELS: Models = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export const DEFAULT_MODEL_TIER = (getEnv('DEFAULT_MODEL_TIER', 'sonnet')) as keyof Models;
export const MODEL = MODELS[DEFAULT_MODEL_TIER] ?? MODELS.sonnet;

// ── Discord ──────────────────────────────────────────────────────────

export const DISCORD_TOKEN = getSecret('DISCORD_TOKEN');
export const DISCORD_OWNER_ID = getEnv('DISCORD_OWNER_ID', '0');

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

// ── Voice ────────────────────────────────────────────────────────────

export const GROQ_API_KEY = getSecret('GROQ_API_KEY');
export const ELEVENLABS_API_KEY = getSecret('ELEVENLABS_API_KEY');
export const ELEVENLABS_VOICE_ID = getEnv('ELEVENLABS_VOICE_ID');

// ── Video ────────────────────────────────────────────────────────────

export const GOOGLE_API_KEY = getSecret('GOOGLE_API_KEY');

// ── Security ─────────────────────────────────────────────────────────

export const ALLOW_ALL_USERS = getEnv('ALLOW_ALL_USERS', 'false').toLowerCase() === 'true';

// ── Heartbeat ────────────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MINUTES = 30;
export const HEARTBEAT_ACTIVE_START = 8;
export const HEARTBEAT_ACTIVE_END = 22;
export const HEARTBEAT_MAX_TURNS = 5;

// ── Channel availability flags ───────────────────────────────────────

export const CHANNEL_DISCORD = Boolean(DISCORD_TOKEN);
export const CHANNEL_SLACK = Boolean(SLACK_BOT_TOKEN && SLACK_APP_TOKEN);
export const CHANNEL_TELEGRAM = Boolean(TELEGRAM_BOT_TOKEN);
export const CHANNEL_WHATSAPP = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && WHATSAPP_OWNER_PHONE);
export const CHANNEL_WEBHOOK = WEBHOOK_ENABLED && Boolean(WEBHOOK_SECRET);

// ── Memory / Search ──────────────────────────────────────────────────

export const MEMORY_DB_PATH = path.join(VAULT_DIR, '.memory.db');
export const SEARCH_CONTEXT_LIMIT = 3;
export const SEARCH_RECENCY_LIMIT = 5;
export const SYSTEM_PROMPT_MAX_CONTEXT_CHARS = 12000;

// ── Session Persistence ──────────────────────────────────────────────

export const SESSION_EXCHANGE_HISTORY_SIZE = 5;
export const SESSION_EXCHANGE_MAX_CHARS = 1000;

// ── Search Ranking ───────────────────────────────────────────────────

export const TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
export const EPISODIC_DECAY_HALF_LIFE_DAYS = 7;

// ── API ──────────────────────────────────────────────────────────────

export const ANTHROPIC_API_KEY = getSecret('ANTHROPIC_API_KEY');
