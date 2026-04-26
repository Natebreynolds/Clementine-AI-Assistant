/**
 * Outbound credential redaction.
 *
 * Last-line defense against prompt-injection exfil: any outbound text
 * (Discord, Slack, email, dashboard chat) gets scanned for credential
 * shapes BEFORE delivery. Matches are replaced with [REDACTED:reason]
 * so the recipient sees that something was stripped without seeing the
 * value itself.
 *
 * Two layers:
 *   1. Pattern-based — well-known token formats from common providers
 *      (Stripe, Anthropic, OpenAI, GitHub, Slack, AWS, Discord). These
 *      catch credentials whose values we don't know in advance — including
 *      ones the agent might have just learned about from external sources.
 *   2. Known-value — exact-match against the live values of credential-
 *      shaped keys in process.env / .env. Caught even if the format
 *      doesn't match a known pattern (e.g. internal API keys, custom
 *      webhook secrets).
 *
 * Designed to be cheap (single pass over each pattern + known-value set)
 * so we can run on every outbound message without measurable latency.
 *
 * Designed to err on the side of REDACTING. False positives (a chunk of
 * text that happens to look like a Stripe key) just produce a [REDACTED]
 * marker; the recipient knows to ask. False negatives (a real credential
 * leaked) are the bug we're trying to prevent.
 */

import { isSensitiveEnvKey } from '../secrets/sensitivity.js';

interface PatternRule {
  /** Short label used in the [REDACTED:label] replacement. */
  label: string;
  re: RegExp;
}

// pragma: allowlist secret (this module exists to recognize secret patterns)
const PATTERNS: PatternRule[] = [
  { label: 'stripe', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: 'anthropic', re: /\bsk-ant-(?:api|admin)\w*-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'openai-project', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai', re: /\bsk-[A-Za-z0-9]{40,}\b/g },
  { label: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { label: 'slack', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'aws-access', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'discord', re: /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,38}\b/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
];

export interface RedactionStats {
  redactionCount: number;
  /** Labels that fired, deduped. Useful for audit logging. */
  labelsHit: string[];
}

export interface RedactionResult {
  text: string;
  stats: RedactionStats;
}

/**
 * Pull credential values from process.env for any key that looks sensitive
 * (matches isSensitiveEnvKey). Used to build the known-value redaction set
 * lazily — re-read on each call so a freshly-set credential is covered
 * within one tick.
 */
export function buildKnownValueSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (value.length < 12) continue;          // short values likely false positives
    if (value.startsWith('keychain:')) continue; // reference, not the secret itself
    if (!isSensitiveEnvKey(key)) continue;
    out.add(value);
  }
  return out;
}

/**
 * Run all redaction layers against a string. Returns the redacted text
 * plus stats about what fired.
 *
 * `knownValues` defaults to a fresh process.env scan but tests pass an
 * explicit set for hermetic coverage.
 */
export function redactSecrets(
  text: string,
  knownValues: Set<string> = buildKnownValueSet(),
): RedactionResult {
  if (!text) return { text, stats: { redactionCount: 0, labelsHit: [] } };

  let working = text;
  const labelsHit = new Set<string>();
  let count = 0;

  // Pattern pass first — catches well-known formats whose values we may
  // not know in advance.
  for (const { label, re } of PATTERNS) {
    working = working.replace(re, () => {
      labelsHit.add(label);
      count++;
      return `[REDACTED:${label}]`;
    });
  }

  // Known-value pass — exact-match every credential currently loaded into
  // process.env. Sort by length descending so longer values get replaced
  // first (a longer secret might contain a shorter one as substring).
  const sortedValues = [...knownValues].sort((a, b) => b.length - a.length);
  for (const v of sortedValues) {
    if (!v || v.length < 12) continue;
    let idx = working.indexOf(v);
    while (idx !== -1) {
      working = working.slice(0, idx) + '[REDACTED:env]' + working.slice(idx + v.length);
      labelsHit.add('env');
      count++;
      idx = working.indexOf(v, idx + '[REDACTED:env]'.length);
    }
  }

  return {
    text: working,
    stats: { redactionCount: count, labelsHit: [...labelsHit] },
  };
}
