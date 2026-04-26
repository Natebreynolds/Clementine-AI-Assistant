/**
 * Clementine TypeScript — macOS Keychain backend for secret storage.
 *
 * When available, lets `env_set` store API keys in the user's login keychain
 * instead of plaintext in ~/.clementine/.env. The .env file then holds only
 * a reference stub: `STRIPE_API_KEY=keychain:clementine-STRIPE_API_KEY`.
 *
 * Graceful fallback: on non-macOS systems or when `security` is unavailable,
 * isAvailable() returns false and callers fall back to raw .env storage.
 *
 * Secrets are stored under service "clementine-agent" with the env var
 * name as the account label, so the user can inspect / revoke them via
 * Keychain Access.app if needed.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import pino from 'pino';

const logger = pino({ name: 'clementine.keychain' });

const SERVICE_NAME = 'clementine-agent';
const REF_PREFIX = 'keychain:'; // pragma: allowlist secret

/** Is macOS keychain usable in this environment? */
export function isAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/security', ['-h'], {
      stdio: 'pipe',
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Construct the stub value written to .env when a secret is keychain-backed.
 * Reading this back through resolver.ts triggers a keychain lookup.
 */
export function makeRef(envVar: string): string {
  return `${REF_PREFIX}${SERVICE_NAME}-${envVar}`;
}

export function isRef(value: string): boolean {
  return value.startsWith(REF_PREFIX);
}

/** Parse a ref stub back into its account name, or null if not a ref. */
export function parseRef(value: string): { account: string } | null {
  if (!isRef(value)) return null;
  return { account: value.slice(REF_PREFIX.length) };
}

/** Write a secret. Returns the ref stub suitable for .env. */
export function set(envVar: string, value: string): string {
  if (!isAvailable()) {
    throw new Error('Keychain unavailable on this platform');
  }
  const account = `${SERVICE_NAME}-${envVar}`;
  // -U updates existing entry in place; -s = service; -a = account; -w = password.
  // -T /usr/bin/security pre-approves the `security` CLI itself — that's what
  // every Clementine read goes through, so reads via clementine/the daemon
  // don't produce a per-process keychain dialog. Without this flag, every
  // node process that reads the entry would block on a UI prompt that may
  // never appear (hidden behind windows, dismissed silently, etc.) — which
  // is the bug that motivated this change.
  const result = spawnSync('/usr/bin/security', [
    'add-generic-password',
    '-U',
    '-s', SERVICE_NAME,
    '-a', account,
    '-w', value,
    '-T', '/usr/bin/security',
    '-l', `Clementine: ${envVar}`,
  ], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`security add-generic-password failed (code ${result.status}): ${result.stderr.toString().slice(0, 200)}`);
  }
  return makeRef(envVar);
}

/** Read a secret back. Returns undefined if missing or unreadable. */
export function get(envVar: string): string | undefined {
  if (!isAvailable()) return undefined;
  const account = `${SERVICE_NAME}-${envVar}`;
  const result = spawnSync('/usr/bin/security', [
    'find-generic-password',
    '-s', SERVICE_NAME,
    '-a', account,
    '-w',
  ], { stdio: 'pipe' });
  if (result.status !== 0) {
    // Exit code 44 = item not found — expected, don't log
    if (result.status !== 44) {
      logger.debug({ code: result.status, envVar }, 'keychain read non-zero');
    }
    return undefined;
  }
  const value = result.stdout.toString();
  // security prints a trailing newline we need to strip
  return value.replace(/\r?\n$/, '');
}

/** Delete a secret. No-op if it doesn't exist. */
export function remove(envVar: string): boolean {
  if (!isAvailable()) return false;
  const account = `${SERVICE_NAME}-${envVar}`;
  const result = spawnSync('/usr/bin/security', [
    'delete-generic-password',
    '-s', SERVICE_NAME,
    '-a', account,
  ], { stdio: 'pipe' });
  return result.status === 0;
}

/** List env var names that have keychain entries (best-effort). */
export function list(): string[] {
  if (!isAvailable()) return [];
  const result = spawnSync('/usr/bin/security', [
    'dump-keychain',
  ], { stdio: 'pipe', timeout: 5000 });
  if (result.status !== 0) return [];
  const out = result.stdout.toString();
  const matches = out.matchAll(new RegExp(`"acct"<blob>="${SERVICE_NAME}-([^"]+)"`, 'g'));
  return [...new Set([...matches].map(m => m[1]))];
}
