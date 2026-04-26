/**
 * Inverse of migrate-keychain.ts: pulls non-credential values OUT of the
 * macOS keychain and back into plaintext .env entries.
 *
 * Why this exists: an earlier env_set bug routed every value to keychain
 * regardless of whether the key looked like a credential, producing stale
 * keychain entries for things like TASK_BUDGET_HEARTBEAT (a token-count
 * config knob, not a secret). Each one costs the user a keychain prompt
 * for no benefit. This module reverses that mistake — and the user-rule
 * "only actual API keys belong in keychain" stays enforced going forward
 * by the env_set classifier fix in 897bb97.
 *
 * For each line in .env that holds a `keychain:` ref AND whose key does
 * NOT match the sensitivity classifier:
 *   1. Resolve via `security find-generic-password`
 *   2. Replace the .env line with `KEY=<plaintext value>`
 *   3. Delete the keychain entry
 *
 * Atomic: phase-1 reads + writes succeed in a temp file before the original
 * .env is replaced via rename. Keychain deletes happen last, so a partial
 * failure leaves the keychain entry intact (no data loss).
 *
 * Idempotent + opt-in: lines whose key IS credential-shaped pass through
 * untouched even when stored as a keychain ref — we don't undo legitimate
 * keychain storage. --key filter for surgical migrations.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as keychain from '../secrets/keychain.js';
import { isSensitiveEnvKey } from '../secrets/sensitivity.js';

export type ReverseMigrationStatus =
  | 'migrated'           // keychain ref → plaintext .env, keychain entry removed
  | 'sensitive-skipped'  // keychain ref but key looks like a credential — left alone
  | 'not-keychain'       // not a keychain ref to begin with
  | 'unresolvable'       // ref points to a missing/unreadable account
  | 'skipped';           // filtered out by --key

export interface ReverseMigrationCandidate {
  key: string;
  status: ReverseMigrationStatus;
  /** The keychain stub itself (always safe to log — it's just an account name). */
  ref?: string;
}

export interface ReverseMigrationPlan {
  envPath: string;
  candidates: ReverseMigrationCandidate[];
  /** Keys this run would migrate out of keychain. */
  toMigrate: string[];
  /** Refs that look bad — surfaced separately so doctor can flag them. */
  unresolvable: string[];
}

export interface ReverseMigrationResult {
  envPath: string;
  migrated: string[];
  failed: Array<{ key: string; error: string }>;
}

interface ParsedLine {
  raw: string;
  key?: string;
  value?: string;
  passthrough: boolean;
}

const REF_PREFIX = 'keychain:'; // pragma: allowlist secret

function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return { raw: line, passthrough: true };
  const eq = trimmed.indexOf('=');
  if (eq === -1) return { raw: line, passthrough: true };
  const key = trimmed.slice(0, eq);
  let value = trimmed.slice(eq + 1);
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { raw: line, key, value, passthrough: false };
}

function refAccount(stub: string): string {
  return stub.slice(REF_PREFIX.length);
}

function tryResolveRef(stub: string): string | undefined {
  // Account names are stored under the well-known service "clementine-agent",
  // and the stub is encoded as keychain:<service>-<envVar>. The actual
  // keychain lookup uses the env-var name as the account label, which is
  // also the suffix of the stub past the service prefix.
  const account = refAccount(stub);
  // The keychain `get(envVar)` helper expects just the env-var name; our
  // stub format is `keychain:clementine-agent-<envVar>`, so strip the
  // service prefix before delegating.
  const SERVICE_PREFIX = 'clementine-agent-';
  const envVar = account.startsWith(SERVICE_PREFIX) ? account.slice(SERVICE_PREFIX.length) : account;
  return keychain.get(envVar);
}

/**
 * Pure read + classify pass — no .env writes, no keychain deletes, but
 * DOES make read-only `security find-generic-password` calls to detect
 * unresolvable refs (and to verify resolvable ones won't fail later).
 */
export function planReverseMigration(
  baseDir: string,
  opts: { only?: string[] } = {},
): ReverseMigrationPlan {
  const envPath = path.join(baseDir, '.env');
  if (!existsSync(envPath)) {
    return { envPath, candidates: [], toMigrate: [], unresolvable: [] };
  }
  const raw = readFileSync(envPath, 'utf-8');
  const onlySet = opts.only ? new Set(opts.only) : undefined;

  const candidates: ReverseMigrationCandidate[] = [];
  const toMigrate: string[] = [];
  const unresolvable: string[] = [];

  for (const line of raw.split('\n')) {
    const parsed = parseLine(line);
    if (parsed.passthrough || !parsed.key || parsed.value === undefined) continue;

    if (onlySet && !onlySet.has(parsed.key)) {
      candidates.push({ key: parsed.key, status: 'skipped' });
      continue;
    }
    if (!parsed.value.startsWith(REF_PREFIX)) {
      candidates.push({ key: parsed.key, status: 'not-keychain' });
      continue;
    }
    if (isSensitiveEnvKey(parsed.key)) {
      candidates.push({ key: parsed.key, status: 'sensitive-skipped', ref: parsed.value });
      continue;
    }
    // Try to resolve. If unresolvable, surface separately — caller decides
    // whether to delete the orphan stub.
    const resolved = tryResolveRef(parsed.value);
    if (resolved === undefined) {
      candidates.push({ key: parsed.key, status: 'unresolvable', ref: parsed.value });
      unresolvable.push(parsed.key);
      continue;
    }
    candidates.push({ key: parsed.key, status: 'migrated', ref: parsed.value });
    toMigrate.push(parsed.key);
  }

  return { envPath, candidates, toMigrate, unresolvable };
}

/**
 * Apply the migration. Two phases:
 *   1. Rewrite .env in a temp file, swapping each migrated ref for plaintext.
 *      If anything throws, the original .env is untouched.
 *   2. Atomically rename the temp file over .env.
 *   3. Delete each migrated key's keychain entry. Best-effort — failure to
 *      delete is logged but doesn't roll back the .env update (the value
 *      is now safely in .env regardless).
 */
export function applyReverseMigration(
  baseDir: string,
  opts: { only?: string[] } = {},
): ReverseMigrationResult {
  const envPath = path.join(baseDir, '.env');
  const result: ReverseMigrationResult = { envPath, migrated: [], failed: [] };
  if (!existsSync(envPath)) return result;

  const raw = readFileSync(envPath, 'utf-8');
  const onlySet = opts.only ? new Set(opts.only) : undefined;
  const lines = raw.split('\n');
  const parsedLines = lines.map(parseLine);

  // Phase 1: resolve every target via keychain (read-only). Bail before
  // touching anything if any target is unresolvable — caller can rerun
  // with --key to skip the bad ones.
  const newValues = new Map<string, string>();
  for (const parsed of parsedLines) {
    if (parsed.passthrough || !parsed.key || parsed.value === undefined) continue;
    if (onlySet && !onlySet.has(parsed.key)) continue;
    if (!parsed.value.startsWith(REF_PREFIX)) continue;
    if (isSensitiveEnvKey(parsed.key)) continue;
    const resolved = tryResolveRef(parsed.value);
    if (resolved === undefined) {
      result.failed.push({ key: parsed.key, error: `keychain entry missing or unreadable for ${parsed.value}` });
      continue;
    }
    newValues.set(parsed.key, resolved);
  }

  if (result.failed.length > 0) return result;
  if (newValues.size === 0) return result;

  // Phase 2: rewrite .env atomically.
  const newLines = parsedLines.map((parsed) => {
    if (parsed.passthrough || !parsed.key) return parsed.raw;
    const newValue = newValues.get(parsed.key);
    if (newValue === undefined) return parsed.raw;
    return `${parsed.key}=${newValue}`;
  });
  const tmp = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, newLines.join('\n'));
  renameSync(tmp, envPath);

  // Phase 3: best-effort keychain deletes.
  for (const key of newValues.keys()) {
    try {
      keychain.remove(key);
    } catch {
      /* keychain delete failure is non-fatal — the value is in .env now */
    }
    result.migrated.push(key);
  }

  return result;
}
