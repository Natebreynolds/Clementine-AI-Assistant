/**
 * Migrate plaintext credential values from .env into the macOS keychain.
 *
 * For each line in .env whose key looks like a credential (per the
 * sensitivity classifier) and whose value is plaintext (not a `keychain:`
 * stub), writes the value into the keychain under the well-known
 * `clementine-agent` service and replaces the .env line with a stub ref.
 *
 * Atomic: all keychain writes complete first, then a single temp-file +
 * rename rewrites .env. If any keychain write fails, the .env is untouched.
 *
 * Idempotent: lines already holding a keychain ref are skipped. Lines
 * that don't match the sensitivity classifier are passed through verbatim.
 *
 * Pure: never reads .env from process.env, never mutates ambient state.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as keychain from '../secrets/keychain.js';
import { isSensitiveEnvKey } from '../secrets/sensitivity.js';

export type MigrationStatus = 'migrated' | 'already-keychain' | 'not-sensitive' | 'too-short' | 'skipped';

export interface MigrationCandidate {
  key: string;
  status: MigrationStatus;
  /** Length of the original value (never the value itself — avoid leaking via logs). */
  valueLength: number;
}

export interface MigrationPlan {
  envPath: string;
  candidates: MigrationCandidate[];
  /** Keys this run would actually migrate (status === 'migrated' after apply). */
  toMigrate: string[];
}

export interface MigrationResult {
  envPath: string;
  migrated: string[];
  failed: Array<{ key: string; error: string }>;
  unchanged: number;
}

interface ParsedLine {
  raw: string;        // original line, unmodified
  key?: string;
  value?: string;
  /** True if line is blank or comment-only (not a key=value pair). */
  passthrough: boolean;
}

const REF_PREFIX = 'keychain:'; // pragma: allowlist secret
const MIN_VALUE_LENGTH = 16;

function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return { raw: line, passthrough: true };
  }
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

function classify(parsed: ParsedLine, opts: { only?: Set<string> }): MigrationStatus {
  if (parsed.passthrough || !parsed.key || parsed.value === undefined) return 'skipped';
  if (opts.only && !opts.only.has(parsed.key)) return 'skipped';
  if (parsed.value.startsWith(REF_PREFIX)) return 'already-keychain';
  if (!isSensitiveEnvKey(parsed.key)) return 'not-sensitive';
  if (parsed.value.length < MIN_VALUE_LENGTH) return 'too-short';
  return 'migrated';
}

/**
 * Compute what would happen — pure read, no .env write, no keychain write.
 * Use --dry-run paths or pre-flight UX in front of apply().
 */
export function planMigration(
  baseDir: string,
  opts: { only?: string[] } = {},
): MigrationPlan {
  const envPath = path.join(baseDir, '.env');
  if (!existsSync(envPath)) {
    return { envPath, candidates: [], toMigrate: [] };
  }
  const raw = readFileSync(envPath, 'utf-8');
  const onlySet = opts.only ? new Set(opts.only) : undefined;

  const candidates: MigrationCandidate[] = [];
  const toMigrate: string[] = [];
  for (const line of raw.split('\n')) {
    const parsed = parseLine(line);
    if (parsed.passthrough || !parsed.key) continue;
    const status = classify(parsed, { only: onlySet });
    candidates.push({
      key: parsed.key,
      status,
      valueLength: parsed.value?.length ?? 0,
    });
    if (status === 'migrated') toMigrate.push(parsed.key);
  }
  return { envPath, candidates, toMigrate };
}

/**
 * Execute the migration. Two-phase to avoid leaving .env in an inconsistent
 * state: (1) write every value to keychain, (2) atomically rewrite .env
 * replacing each migrated value with its stub ref. Any keychain write
 * failure aborts before the .env rewrite.
 */
export function applyMigration(
  baseDir: string,
  opts: { only?: string[] } = {},
): MigrationResult {
  const envPath = path.join(baseDir, '.env');
  const result: MigrationResult = { envPath, migrated: [], failed: [], unchanged: 0 };
  if (!existsSync(envPath)) return result;

  if (!keychain.isAvailable()) {
    throw new Error('macOS keychain is not available on this system');
  }

  const raw = readFileSync(envPath, 'utf-8');
  const onlySet = opts.only ? new Set(opts.only) : undefined;
  const lines = raw.split('\n');
  const parsedLines = lines.map(parseLine);

  // Phase 1: write each migration target into the keychain. Build a map
  // key → newStubValue. Bail on first keychain write failure (no .env touch).
  const newValues = new Map<string, string>();
  for (const parsed of parsedLines) {
    if (parsed.passthrough || !parsed.key) continue;
    const status = classify(parsed, { only: onlySet });
    if (status !== 'migrated') {
      if (status !== 'skipped' && status !== 'already-keychain') result.unchanged++;
      continue;
    }
    try {
      const stub = keychain.set(parsed.key, parsed.value!);
      newValues.set(parsed.key, stub);
    } catch (err) {
      result.failed.push({ key: parsed.key, error: String(err).slice(0, 200) });
    }
  }

  if (result.failed.length > 0) {
    // Don't touch .env if any keychain write failed — keeps the original
    // plaintext intact rather than half-migrating.
    return result;
  }

  if (newValues.size === 0) return result;

  // Phase 2: rewrite .env in place, line-by-line, swapping values for stubs.
  const newLines = parsedLines.map((parsed) => {
    if (parsed.passthrough || !parsed.key) return parsed.raw;
    const newStub = newValues.get(parsed.key);
    if (!newStub) return parsed.raw;
    // Match the original line's leading whitespace and trailing comment-noise
    // by reconstructing key=stub from scratch — keys are uppercase identifiers,
    // so no whitespace ambiguity.
    return `${parsed.key}=${newStub}`;
  });

  const tmp = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, newLines.join('\n'));
  renameSync(tmp, envPath);

  for (const key of newValues.keys()) result.migrated.push(key);
  return result;
}
