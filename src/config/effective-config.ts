/**
 * Effective-config inspector.
 *
 * Re-reads the same sources config.ts uses (process.env, ~/.clementine/.env,
 * ~/.clementine/clementine.json) and produces a structured report of every
 * known key — value plus provenance.
 *
 * Pure: no module-level side effects. Safe to call from any CLI / dashboard
 * surface without touching the running daemon's config snapshot.
 *
 * Mirrors the precedence: process.env > .env > clementine.json > compiled default.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadClementineJson } from './clementine-json.js';

export type ConfigSource = 'process.env' | '.env' | 'clementine.json' | 'default' | 'system';

export interface ConfigEntry {
  key: string;
  value: string | number | boolean;
  source: ConfigSource;
  /** Optional: which other source(s) had a non-empty value for this key (helps debug overrides). */
  shadowedBy?: ConfigSource[];
  /** Optional: human-readable section/group for the report. */
  group?: string;
}

export interface EffectiveConfig {
  baseDir: string;
  hasEnvFile: boolean;
  hasJsonFile: boolean;
  entries: ConfigEntry[];
}

interface KeySpec {
  key: string;
  group: string;
  /** dotted path into clementine.json (e.g. "models.haiku") */
  jsonPath?: string;
  default?: string | number;
  /** "system" provenance label when the default is computed at runtime, not hardcoded. */
  systemDefault?: () => string | number;
  /** Sensitive keys are masked in human output. */
  sensitive?: boolean;
}

const SPECS: KeySpec[] = [
  // Identity
  { key: 'OWNER_NAME', group: 'identity', jsonPath: 'ownerName', default: '' },
  { key: 'ASSISTANT_NAME', group: 'identity', jsonPath: 'assistantName', default: 'Clementine' },
  { key: 'ASSISTANT_NICKNAME', group: 'identity', default: 'Clemmy' },
  { key: 'TIMEZONE', group: 'identity', jsonPath: 'timezone', systemDefault: () => Intl.DateTimeFormat().resolvedOptions().timeZone },

  // Models
  { key: 'DEFAULT_MODEL_TIER', group: 'models', jsonPath: 'models.default', default: 'sonnet' },
  { key: 'HAIKU_MODEL', group: 'models', jsonPath: 'models.haiku', default: 'claude-haiku-4-5-20251001' },
  { key: 'SONNET_MODEL', group: 'models', jsonPath: 'models.sonnet', default: 'claude-sonnet-4-6' },
  { key: 'OPUS_MODEL', group: 'models', jsonPath: 'models.opus', default: 'claude-opus-4-6' },

  // Budgets
  { key: 'BUDGET_HEARTBEAT_USD', group: 'budgets', jsonPath: 'budgets.heartbeat', default: 0.50 },
  { key: 'BUDGET_CRON_T1_USD', group: 'budgets', jsonPath: 'budgets.cronT1', default: 2.00 },
  { key: 'BUDGET_CRON_T2_USD', group: 'budgets', jsonPath: 'budgets.cronT2', default: 5.00 },
  { key: 'BUDGET_CHAT_USD', group: 'budgets', jsonPath: 'budgets.chat', default: 5.00 },

  // Heartbeat
  { key: 'HEARTBEAT_INTERVAL_MINUTES', group: 'heartbeat', jsonPath: 'heartbeat.intervalMinutes', default: 30 },
  { key: 'HEARTBEAT_ACTIVE_START', group: 'heartbeat', jsonPath: 'heartbeat.activeStart', default: 8 },
  { key: 'HEARTBEAT_ACTIVE_END', group: 'heartbeat', jsonPath: 'heartbeat.activeEnd', default: 22 },

  // Unleashed
  { key: 'UNLEASHED_PHASE_TURNS', group: 'unleashed', jsonPath: 'unleashed.phaseTurns', default: 75 },
  { key: 'UNLEASHED_DEFAULT_MAX_HOURS', group: 'unleashed', jsonPath: 'unleashed.defaultMaxHours', default: 6 },
  { key: 'UNLEASHED_MAX_PHASES', group: 'unleashed', jsonPath: 'unleashed.maxPhases', default: 50 },

  // Advisor
  { key: 'CLEMENTINE_ADVISOR_RULES_LOADER', group: 'advisor', default: 'off' },
  { key: 'CLEMENTINE_ALLOW_SOURCE_EDITS', group: 'advisor', default: 'false' },

  // Webhook
  { key: 'WEBHOOK_ENABLED', group: 'channels', default: 'false' },
  { key: 'WEBHOOK_PORT', group: 'channels', default: 8420 },
  { key: 'WEBHOOK_BIND', group: 'channels', default: '127.0.0.1' },

  // Security
  { key: 'ALLOW_ALL_USERS', group: 'security', default: 'false' },

  // Discord / Slack / Telegram (presence-only — values themselves come from secrets)
  { key: 'DISCORD_OWNER_ID', group: 'channels', default: '0' },
  { key: 'SLACK_OWNER_USER_ID', group: 'channels', default: '' },
  { key: 'TELEGRAM_OWNER_ID', group: 'channels', default: '0' },
  { key: 'WHATSAPP_OWNER_PHONE', group: 'channels', default: '' },

  // Salesforce
  { key: 'SF_INSTANCE_URL', group: 'channels', default: '' },
  { key: 'SF_API_VERSION', group: 'channels', default: 'v62.0' },
];

function readEnvFile(baseDir: string): Record<string, string> {
  const envPath = path.join(baseDir, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function getJsonValue(json: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split('.');
  let cur: unknown = json;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Compute the effective config: every known key with its resolved value
 * and the source it came from. Optionally include sensitive entries unmasked.
 */
export function computeEffectiveConfig(baseDir: string): EffectiveConfig {
  const envFromFile = readEnvFile(baseDir);
  const json = loadClementineJson(baseDir) as unknown as Record<string, unknown>;
  const entries: ConfigEntry[] = [];

  const envPath = path.join(baseDir, '.env');
  const jsonPath = path.join(baseDir, 'clementine.json');

  for (const spec of SPECS) {
    // Resolution order matches config.ts: process.env > .env > json > default.
    const fromProcessEnv = process.env[spec.key];
    const fromEnvFile = envFromFile[spec.key];
    const fromJson = spec.jsonPath ? getJsonValue(json, spec.jsonPath) : undefined;

    let value: string | number | boolean;
    let source: ConfigSource;

    if (fromProcessEnv && fromProcessEnv.length > 0) {
      value = fromProcessEnv;
      source = 'process.env';
    } else if (fromEnvFile && fromEnvFile.length > 0) {
      value = fromEnvFile;
      source = '.env';
    } else if (fromJson !== undefined && fromJson !== '' && fromJson !== null) {
      value = fromJson as string | number;
      source = 'clementine.json';
    } else if (spec.systemDefault) {
      value = spec.systemDefault();
      source = 'system';
    } else {
      value = spec.default ?? '';
      source = 'default';
    }

    // Track which other sources had values, to surface "this is overriding X."
    const shadowedBy: ConfigSource[] = [];
    if (source !== 'process.env' && fromProcessEnv) shadowedBy.push('process.env');
    if (source !== '.env' && fromEnvFile && fromEnvFile.length > 0) shadowedBy.push('.env');
    if (source !== 'clementine.json' && fromJson !== undefined && fromJson !== '') shadowedBy.push('clementine.json');

    entries.push({
      key: spec.key,
      value,
      source,
      shadowedBy: shadowedBy.length > 0 ? shadowedBy : undefined,
      group: spec.group,
    });
  }

  return {
    baseDir,
    hasEnvFile: existsSync(envPath),
    hasJsonFile: existsSync(jsonPath),
    entries,
  };
}

/** Return the SPECS array — exported so tests can iterate keys without re-importing. */
export function listKnownConfigKeys(): readonly string[] {
  return SPECS.map(s => s.key);
}
