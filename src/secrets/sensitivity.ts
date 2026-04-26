/**
 * Classify whether an environment variable name looks like a secret.
 *
 * Used by:
 *   - env_set's `auto` storage mode to decide keychain-vs-plaintext routing
 *     (sensitive keys → keychain on macOS; everything else → plain .env)
 *   - cmdConfigList to mask values in console output
 *
 * Heuristic: pattern-match common conventions. Errs on the side of "treat
 * as sensitive" — false positives just mean a config knob ends up in the
 * keychain unnecessarily; false negatives leak credentials to plaintext.
 */

const SENSITIVE_SUBSTRINGS = [
  'TOKEN',
  'SECRET',
  'API_KEY',
  'AUTH',
  'PASSWORD',
  'PRIVATE_KEY',
  'CLIENT_SECRET',
  'WEBHOOK_SECRET',
  'CREDENTIALS',
] as const;

const SENSITIVE_SUFFIXES = [
  '_SID',
] as const;

/**
 * True iff the key name matches a known credential convention.
 * Case-insensitive comparison.
 */
export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  for (const sub of SENSITIVE_SUBSTRINGS) {
    if (upper.includes(sub)) return true;
  }
  for (const suf of SENSITIVE_SUFFIXES) {
    if (upper.endsWith(suf)) return true;
  }
  return false;
}
