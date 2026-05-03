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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeEffectiveConfig, type EffectiveConfig } from './effective-config.js';
import { parseEnvText } from './env-parser.js';

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

export interface DoctorFixResult {
  changed: Array<{ key: string; value: string; reason: string }>;
  skipped: Array<{ key: string; reason: string }>;
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
  CLEMENTINE_1M_CONTEXT_MODE: ['auto', 'off', 'on'],
  WEBHOOK_ENABLED: ['true', 'false'],
  ALLOW_ALL_USERS: ['true', 'false'],
  CLEMENTINE_ALLOW_SOURCE_EDITS: ['true', 'false', '1', '0', 'yes', 'no'],
  CLAUDE_CODE_DISABLE_1M_CONTEXT: ['true', 'false', '1', '0', 'yes', 'no'],
};

const SAFE_BACKGROUND_DEFAULTS: Record<string, number> = {
  BUDGET_HEARTBEAT_USD: 0.25,
  BUDGET_CRON_T1_USD: 0.75,
  BUDGET_CRON_T2_USD: 1.50,
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
  checkOperationalOverrides(cfg, baseDir, findings);
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

export function applyDoctorFixes(baseDir: string): DoctorFixResult {
  const cfg = computeEffectiveConfig(baseDir);
  const byKey = new Map(cfg.entries.map(e => [e.key, e]));
  const persistedEnv = readEnvValues(baseDir);
  const changed: DoctorFixResult['changed'] = [];
  const skipped: DoctorFixResult['skipped'] = [];

  const setSafeValue = (key: string, value: string, reason: string): void => {
    const entry = byKey.get(key);
    if (entry?.source === 'process.env' && persistedEnv[key] === undefined) {
      skipped.push({
        key,
        reason: `${key} is coming from process.env, which .env cannot override. Update the launch environment or unset it.`,
      });
      return;
    }
    upsertEnvValue(baseDir, key, value);
    if (entry?.source === 'process.env') {
      process.env[key] = value;
    }
    changed.push({ key, value, reason });
  };

  const oneMMode = byKey.get('CLEMENTINE_1M_CONTEXT_MODE');
  const oneM = byKey.get('CLAUDE_CODE_DISABLE_1M_CONTEXT');
  if ((oneMMode && String(oneMMode.value).toLowerCase() === 'on') || (oneM && isFalseyToggle(oneM.value))) {
    setSafeValue(
      'CLEMENTINE_1M_CONTEXT_MODE',
      'off',
      'Force standard 200K context until the account is confirmed stable.',
    );
    setSafeValue(
      'CLAUDE_CODE_DISABLE_1M_CONTEXT',
      '1',
      'Disable Claude Code 1M context for backward compatibility with older Claude Code versions.',
    );
  }

  for (const [key, recommended] of Object.entries(SAFE_BACKGROUND_DEFAULTS)) {
    const entry = byKey.get(key);
    const value = Number(entry?.value);
    if (entry && entry.source !== 'default' && Number.isFinite(value) && value > recommended) {
      setSafeValue(
        key,
        String(recommended),
        'Lower background budget to the stable default so cron/heartbeat cannot exhaust credits before chat.',
      );
    }
  }

  return { changed, skipped };
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

function checkOperationalOverrides(cfg: EffectiveConfig, baseDir: string, findings: Finding[]): void {
  const byKey = new Map(cfg.entries.map(e => [e.key, e]));
  const persistedEnv = readEnvValues(baseDir);

  const oneMMode = byKey.get('CLEMENTINE_1M_CONTEXT_MODE');
  if (oneMMode && oneMMode.source !== 'default' && String(oneMMode.value).toLowerCase() === 'on') {
    findings.push({
      severity: 'warning',
      key: 'CLEMENTINE_1M_CONTEXT_MODE',
      message: `1M context is forced on from ${oneMMode.source}. Sonnet 1M requires Claude Extra Usage, and Pro subscriptions require Extra Usage for both Sonnet and Opus 1M.`,
      fix: 'clementine budgets 1m auto   # smart mode, or clementine budgets safe for recovery',
    });
  }

  const oneM = byKey.get('CLAUDE_CODE_DISABLE_1M_CONTEXT');
  if (oneM
    && oneM.source !== 'default'
    && isFalseyToggle(oneM.value)
    && (!oneMMode || oneMMode.source === 'default')) {
    const source = oneM.source === 'process.env' && persistedEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT !== undefined
      ? '.env'
      : oneM.source;
    findings.push({
      severity: 'warning',
      key: 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
      message: `Legacy 1M context is explicitly enabled from ${source}. Sonnet 1M requires Extra Usage and can fail calls with "Extra usage is required for 1M context."`,
      fix: 'clementine budgets 1m auto   # smart mode, or clementine budgets safe for recovery',
    });
  }

  for (const [key, recommended] of Object.entries(SAFE_BACKGROUND_DEFAULTS)) {
    const entry = byKey.get(key);
    if (!entry || entry.source === 'default') continue;
    const value = Number(entry.value);
    if (!Number.isFinite(value) || value <= recommended) continue;
    findings.push({
      severity: 'warning',
      key,
      message: `${key} is $${value.toFixed(2)} from ${entry.source}; the safe default is $${recommended.toFixed(2)}. High background budgets can drain Claude credits before the user chats.`,
      fix: `clementine config set ${key} ${recommended}`,
    });
  }
}

function isFalseyToggle(value: unknown): boolean {
  return /^(0|false|no)$/i.test(String(value).trim());
}

function readEnvValues(baseDir: string): Record<string, string> {
  const envPath = path.join(baseDir, '.env');
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvText(readFileSync(envPath, 'utf-8'));
  } catch {
    return {};
  }
}

function upsertEnvValue(baseDir: string, key: string, value: string): void {
  mkdirSync(baseDir, { recursive: true });
  const envPath = path.join(baseDir, '.env');
  const upperKey = key.toUpperCase();
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const re = new RegExp(`^${upperKey}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${upperKey}=${value}`);
  } else {
    content = content.trimEnd() + `\n${upperKey}=${value}\n`;
  }
  writeFileSync(envPath, content, { mode: 0o600 });
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
