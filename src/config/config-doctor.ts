/**
 * Config doctor — proactive validation of ~/.clementine/.
 *
 * Runs a series of checks against the effective config (env + clementine.json
 * + defaults) and surfaces issues that would otherwise silently degrade the
 * daemon. Each check produces a Finding {severity, key, message, fix}.
 *
 * Severity:
 *   error    — daemon is misconfigured in a way that affects behavior
 *   warning  — works, but bad practice or fragile
 *   info     — note worth surfacing, not actionable
 *
 * Pure: no module-level side effects, no shell calls beyond what
 * computeEffectiveConfig already does (lazy keychain resolution).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeEffectiveConfig, type EffectiveConfig } from './effective-config.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  key?: string;
  message: string;
  /** Suggested next-step command or action. */
  fix?: string;
}

export interface DoctorReport {
  baseDir: string;
  hasEnvFile: boolean;
  hasJsonFile: boolean;
  findings: Finding[];
  /** Counts by severity, for quick rendering. */
  counts: Record<Severity, number>;
  /** Suggested process exit code: 1 if any errors, 0 otherwise. */
  exitCode: 0 | 1;
}

// ── Type expectations ───────────────────────────────────────────────
//
// Keys that must parse as a finite number when set. The inspector already
// handles default fallback for missing values, so we only fail on present-
// but-wrong values.

const NUMERIC_KEYS = new Set([
  'BUDGET_HEARTBEAT_USD',
  'BUDGET_CRON_T1_USD',
  'BUDGET_CRON_T2_USD',
  'BUDGET_CHAT_USD',
  'HEARTBEAT_INTERVAL_MINUTES',
  'HEARTBEAT_ACTIVE_START',
  'HEARTBEAT_ACTIVE_END',
  'UNLEASHED_PHASE_TURNS',
  'UNLEASHED_DEFAULT_MAX_HOURS',
  'UNLEASHED_MAX_PHASES',
  'WEBHOOK_PORT',
]);

const ENUM_KEYS: Record<string, readonly string[]> = {
  CLEMENTINE_ADVISOR_RULES_LOADER: ['off', 'shadow', 'primary'],
  DEFAULT_MODEL_TIER: ['haiku', 'sonnet', 'opus'],
  WEBHOOK_ENABLED: ['true', 'false'],
  ALLOW_ALL_USERS: ['true', 'false'],
  CLEMENTINE_ALLOW_SOURCE_EDITS: ['true', 'false', '1', '0', 'yes', 'no'],
};

// Channel pairings: when channel.enableKey is truthy, the companion keys
// are required; doctor flags any companion that's empty.
interface ChannelRequirement {
  channel: string;
  /** A key that, if non-empty/true, indicates the channel is in use. */
  enableKey?: string;
  enableValuePredicate?: (value: string) => boolean;
  /** Keys that must also be set when the channel is in use. */
  requires: string[];
}

const CHANNEL_REQUIREMENTS: ChannelRequirement[] = [
  {
    channel: 'Discord',
    // Discord is implicit: presence of DISCORD_OWNER_ID != "0" implies usage.
    enableKey: 'DISCORD_OWNER_ID',
    enableValuePredicate: (v) => v !== '0' && v !== '',
    requires: ['DISCORD_OWNER_ID'],
  },
  {
    channel: 'Webhook',
    enableKey: 'WEBHOOK_ENABLED',
    enableValuePredicate: (v) => v.toLowerCase() === 'true',
    requires: ['WEBHOOK_PORT', 'WEBHOOK_BIND'],
  },
];

// ── Doctor ──────────────────────────────────────────────────────────

export function runDoctor(baseDir: string): DoctorReport {
  const cfg = computeEffectiveConfig(baseDir);
  const findings: Finding[] = [];

  checkBootstrap(cfg, findings);
  checkUnresolvedKeychainRefs(cfg, findings);
  checkNumericTypes(cfg, findings);
  checkEnumTypes(cfg, findings);
  checkChannelRequirements(cfg, findings);
  checkPlaintextSecretsInEnv(cfg, baseDir, findings);
  checkRangeSanity(cfg, findings);
  checkSchemaVersion(baseDir, findings);

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    baseDir: cfg.baseDir,
    hasEnvFile: cfg.hasEnvFile,
    hasJsonFile: cfg.hasJsonFile,
    findings,
    counts,
    exitCode: counts.error > 0 ? 1 : 0,
  };
}

function checkBootstrap(cfg: EffectiveConfig, findings: Finding[]): void {
  if (!cfg.hasEnvFile && !cfg.hasJsonFile) {
    findings.push({
      severity: 'warning',
      message: 'No .env or clementine.json found — running entirely on compiled defaults',
      fix: 'clementine config setup',
    });
  }
}

function checkUnresolvedKeychainRefs(cfg: EffectiveConfig, findings: Finding[]): void {
  for (const entry of cfg.entries) {
    if (entry.unresolvedRef) {
      findings.push({
        severity: 'error',
        key: entry.key,
        message: `${entry.key} is set to ${entry.unresolvedRef} but the keychain entry is missing or unreadable. Daemon is silently using the default (${entry.value}).`,
        fix: `clementine config set ${entry.key} <real value>   # writes plaintext to .env, removing the stale ref`,
      });
    }
  }
}

function checkNumericTypes(cfg: EffectiveConfig, findings: Finding[]): void {
  for (const entry of cfg.entries) {
    if (!NUMERIC_KEYS.has(entry.key)) continue;
    if (entry.source === 'default' || entry.source === 'system') continue;
    const n = Number(entry.value);
    if (!Number.isFinite(n)) {
      findings.push({
        severity: 'error',
        key: entry.key,
        message: `${entry.key} is "${entry.value}" (from ${entry.source}) — does not parse as a number. Numeric coercion silently produces NaN, which means downstream comparisons always fail.`,
        fix: `clementine config set ${entry.key} <numeric value>`,
      });
    }
  }
}

function checkEnumTypes(cfg: EffectiveConfig, findings: Finding[]): void {
  for (const entry of cfg.entries) {
    const allowed = ENUM_KEYS[entry.key];
    if (!allowed) continue;
    if (entry.source === 'default') continue;
    if (!allowed.includes(String(entry.value).toLowerCase())) {
      findings.push({
        severity: 'error',
        key: entry.key,
        message: `${entry.key} is "${entry.value}" (from ${entry.source}) — must be one of: ${allowed.join(', ')}. Daemon silently treats this as the first valid option.`,
        fix: `clementine config set ${entry.key} <one of: ${allowed.join('|')}>`,
      });
    }
  }
}

function checkChannelRequirements(cfg: EffectiveConfig, findings: Finding[]): void {
  const byKey = new Map(cfg.entries.map(e => [e.key, e]));
  for (const req of CHANNEL_REQUIREMENTS) {
    const enableEntry = req.enableKey ? byKey.get(req.enableKey) : undefined;
    if (!enableEntry) continue;
    const enableValue = String(enableEntry.value);
    const enabled = req.enableValuePredicate
      ? req.enableValuePredicate(enableValue)
      : Boolean(enableValue);
    if (!enabled) continue;

    for (const reqKey of req.requires) {
      const entry = byKey.get(reqKey);
      if (!entry) continue;
      const v = String(entry.value).trim();
      if (!v || v === '0') {
        findings.push({
          severity: 'warning',
          key: reqKey,
          message: `${req.channel} channel is enabled but ${reqKey} is empty. Owner-only commands and notifications may misbehave.`,
          fix: `clementine config set ${reqKey} <value>`,
        });
      }
    }
  }
}

function checkPlaintextSecretsInEnv(_cfg: EffectiveConfig, baseDir: string, findings: Finding[]): void {
  // Sanity check on .env file permissions.
  //
  // History: this function previously WARNED whenever credential-shaped keys
  // (DISCORD_TOKEN, *_API_KEY, etc.) sat as plaintext in .env, recommending
  // migration to the macOS Keychain. After the 2026-04-26 rabbit hole
  // (commits 88cfd99 .. c5a2eb5) we reversed that recommendation: plaintext
  // .env at mode 0600 is the supported default, and keychain is opt-in only.
  // The old warning is now misleading guidance, so it's removed.
  //
  // What we DO check: file mode. If .env is world-readable or group-readable
  // we flag that as a real risk regardless of what's inside.
  const envPath = path.join(baseDir, '.env');
  if (!existsSync(envPath)) return;
  try {
    const st = require('node:fs').statSync(envPath) as { mode: number };
    const worldOrGroupReadable = (st.mode & 0o077) !== 0;
    if (worldOrGroupReadable) {
      findings.push({
        severity: 'error',
        message: `.env file is readable by other users (mode ${(st.mode & 0o777).toString(8)}). Restrict to owner-only.`,
        fix: `chmod 600 ${envPath}`,
      });
    }
  } catch { /* stat failed — non-fatal, doctor continues */ }
}

function checkRangeSanity(cfg: EffectiveConfig, findings: Finding[]): void {
  const byKey = new Map(cfg.entries.map(e => [e.key, e]));

  const start = byKey.get('HEARTBEAT_ACTIVE_START');
  const end = byKey.get('HEARTBEAT_ACTIVE_END');
  if (start && end) {
    const s = Number(start.value);
    const e = Number(end.value);
    if (Number.isFinite(s) && Number.isFinite(e)) {
      if (s < 0 || s > 23) {
        findings.push({ severity: 'error', key: 'HEARTBEAT_ACTIVE_START', message: `must be 0-23, got ${s}` });
      }
      if (e < 0 || e > 23) {
        findings.push({ severity: 'error', key: 'HEARTBEAT_ACTIVE_END', message: `must be 0-23, got ${e}` });
      }
      if (Number.isFinite(s) && Number.isFinite(e) && s >= e) {
        findings.push({
          severity: 'warning',
          message: `HEARTBEAT_ACTIVE_START (${s}) is not before HEARTBEAT_ACTIVE_END (${e}). Heartbeat will only run during a zero-length window.`,
          fix: `clementine config set HEARTBEAT_ACTIVE_END <hour later than ${s}>`,
        });
      }
    }
  }

  // Budget sanity: cronT1 should be <= cronT2 (T1 is cheap tier).
  const t1 = byKey.get('BUDGET_CRON_T1_USD');
  const t2 = byKey.get('BUDGET_CRON_T2_USD');
  if (t1 && t2) {
    const v1 = Number(t1.value);
    const v2 = Number(t2.value);
    if (Number.isFinite(v1) && Number.isFinite(v2) && v1 > v2) {
      findings.push({
        severity: 'warning',
        message: `BUDGET_CRON_T1_USD ($${v1}) exceeds BUDGET_CRON_T2_USD ($${v2}). Tier 1 is the cheap tier — these are likely swapped.`,
      });
    }
  }
}

function checkSchemaVersion(baseDir: string, findings: Finding[]): void {
  const jsonPath = path.join(baseDir, 'clementine.json');
  if (!existsSync(jsonPath)) return;
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { schemaVersion?: unknown };
    if (raw.schemaVersion !== 1) {
      findings.push({
        severity: 'error',
        message: `clementine.json schemaVersion is ${String(raw.schemaVersion)}; expected 1. Loader is treating the whole file as empty.`,
        fix: 'Set "schemaVersion": 1 in clementine.json',
      });
    }
  } catch {
    findings.push({
      severity: 'error',
      message: 'clementine.json exists but is not valid JSON. Loader is treating the whole file as empty.',
      fix: 'Repair the JSON syntax or delete the file (next start regenerates it from .env)',
    });
  }
}

/** Keys-list helper for tests. */
export function listNumericKeys(): readonly string[] {
  return Array.from(NUMERIC_KEYS);
}
export function listEnumKeys(): readonly string[] {
  return Object.keys(ENUM_KEYS);
}
