/**
 * Clementine TypeScript — Secret reference resolver.
 *
 * When code reads process.env.FOO, it should get the resolved SECRET VALUE
 * regardless of whether that secret is stored plaintext in .env or as a
 * keychain ref stub (`keychain:clementine-agent-FOO`). This module bridges
 * the gap: called once at daemon boot, it walks process.env, detects ref
 * stubs, resolves them via the appropriate backend, and replaces the stub
 * with the real value in-place.
 *
 * After hydrate(), downstream code can treat process.env as usual — it has
 * no knowledge of keychain/1Password/etc. This mirrors OpenClaw's SecretRef
 * pattern but narrower: one backend (macOS Keychain), one convention.
 */

import pino from 'pino';
import * as keychain from './keychain.js';

const logger = pino({ name: 'clementine.secrets' });

/**
 * Check every env var for a ref stub and resolve in place. Returns a summary
 * of what was resolved / failed so startup can log visibility.
 */
export function hydrateSecretsFromEnv(): { resolved: string[]; failed: string[] } {
  const resolved: string[] = [];
  const failed: string[] = [];

  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!rawValue) continue;
    if (!keychain.isRef(rawValue)) continue;

    const resolvedValue = keychain.get(key);
    if (resolvedValue !== undefined) {
      process.env[key] = resolvedValue;
      resolved.push(key);
    } else {
      failed.push(key);
      // Leave the ref stub in place so downstream errors are obvious rather
      // than silently returning the literal "keychain:..." as if it were a
      // real API key.
    }
  }

  if (resolved.length > 0 || failed.length > 0) {
    logger.info({ resolved: resolved.length, failed }, 'Secrets hydrated');
  }
  return { resolved, failed };
}

/**
 * Lazy single-key lookup — reads process.env[key], resolves the ref if
 * needed, returns the resolved value. Useful when code calls us at runtime
 * rather than relying on startup hydration.
 */
export function resolveEnvValue(key: string): string | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  if (!keychain.isRef(raw)) return raw;
  return keychain.get(key);
}

/**
 * Classify a given value by its storage backend (for status reporting).
 * Returns e.g. "keychain" or "env" or undefined (not set).
 */
export function secretBackend(envVar: string): 'keychain' | 'env' | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  return keychain.isRef(raw) ? 'keychain' : 'env';
}
