/**
 * Phase 9b — credential redaction tests.
 *
 * Two layers under test:
 *   1. Pattern-based — provider token shapes
 *   2. Known-value — exact match against process.env-loaded secrets
 *
 * All test fixtures use placeholder strings that don't match real provider
 * patterns where possible. Where a fake-but-pattern-matching value is needed
 * to exercise the regex (e.g. sk_live_), the fixture lives in this test
 * file only and never persists.
 */

import { describe, expect, it } from 'vitest';
import { buildKnownValueSet, redactSecrets } from '../src/security/redact.js';

describe('redactSecrets — pattern layer', () => {
  it('redacts Stripe live keys', () => {
    // pragma: allowlist secret
    const r = redactSecrets('contact stripe key sk_live_abcdef0123456789xyzZZ for billing');
    expect(r.text).toContain('[REDACTED:stripe]');
    expect(r.text).not.toContain('sk_live_abcdef');
    expect(r.stats.labelsHit).toContain('stripe');
  });

  it('redacts Anthropic keys', () => {
    // pragma: allowlist secret
    const r = redactSecrets('use sk-ant-api03-deadbeefcafebabe123456 to call');
    expect(r.text).toContain('[REDACTED:anthropic]');
    expect(r.text).not.toContain('sk-ant-api03');
  });

  it('redacts GitHub personal tokens', () => {
    // pragma: allowlist secret
    const r = redactSecrets('export TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(r.text).toContain('[REDACTED:github]');
  });

  it('redacts Slack tokens', () => {
    // pragma: allowlist secret
    const r = redactSecrets('bot token: xoxb-1234567890-abcdefg-AbCdEfGhIjK');
    expect(r.text).toContain('[REDACTED:slack]');
  });

  it('redacts AWS access key IDs', () => {
    // pragma: allowlist secret
    const r = redactSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(r.text).toContain('[REDACTED:aws-access]');
  });

  it('redacts JWTs', () => {
    // pragma: allowlist secret
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = redactSecrets(`token=${jwt}`);
    expect(r.text).toContain('[REDACTED:jwt]');
    expect(r.text).not.toContain('eyJhbGc');
  });

  it('redacts PEM-encoded private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAvfH3blob\n-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(`here:\n${pem}\nthat was a key`);
    expect(r.text).toContain('[REDACTED:private-key]');
    expect(r.text).not.toContain('MIIEow');
  });

  it('does not touch plain prose', () => {
    const r = redactSecrets('this is normal text with no secrets in it whatsoever');
    expect(r.text).toBe('this is normal text with no secrets in it whatsoever');
    expect(r.stats.redactionCount).toBe(0);
  });

  it('counts each match individually', () => {
    // pragma: allowlist secret
    const r = redactSecrets('a sk_live_aaaaaaaaaaaaaaaaaaaa b sk_live_bbbbbbbbbbbbbbbbbbbb');
    expect(r.stats.redactionCount).toBe(2);
  });
});

describe('redactSecrets — known-value layer', () => {
  it('redacts exact values present in the known-value set', () => {
    // pragma: allowlist secret
    const known = new Set(['supersecretvalue1234567890ABCDEF']);
    // pragma: allowlist secret
    const r = redactSecrets('the token is supersecretvalue1234567890ABCDEF use carefully', known);
    expect(r.text).toContain('[REDACTED:env]');
    expect(r.text).not.toContain('supersecretvalue');
    expect(r.stats.labelsHit).toContain('env');
  });

  it('handles multiple occurrences of the same value', () => {
    const known = new Set(['mySecretToken1234567890']);
    const r = redactSecrets('use mySecretToken1234567890 then mySecretToken1234567890 again', known);
    expect(r.stats.redactionCount).toBe(2);
  });

  it('replaces longer matches first to avoid double-redaction', () => {
    const known = new Set(['shortvalue1234567', 'shortvalue1234567890extra']);
    const r = redactSecrets('here is shortvalue1234567890extra and then shortvalue1234567', known);
    // Both should be replaced exactly once, not nested.
    expect(r.stats.redactionCount).toBe(2);
    expect(r.text).not.toContain('shortvalue1234');
  });

  it('skips short values to avoid false positives', () => {
    const known = new Set(['short']);
    const r = redactSecrets('the short word is fine', known);
    expect(r.text).toBe('the short word is fine');
  });
});

describe('buildKnownValueSet', () => {
  it('returns sensitive-shaped env keys whose values look like credentials', () => {
    const env = {
      DISCORD_TOKEN: 'mock-discord-token-1234567890',           // sensitive + long
      OWNER_NAME: 'Nate',                                        // not sensitive
      STRIPE_API_KEY: 'sk_test_thisisalongsecretvaluethatisfake', // sensitive + long
      WEBHOOK_PORT: '8420',                                      // not sensitive
      ANTHROPIC_API_KEY: 'short',                                // sensitive but too short
    };
    const set = buildKnownValueSet(env as unknown as NodeJS.ProcessEnv);
    expect(set.has('mock-discord-token-1234567890')).toBe(true);
    expect(set.has('sk_test_thisisalongsecretvaluethatisfake')).toBe(true);
    expect(set.has('Nate')).toBe(false);
    expect(set.has('8420')).toBe(false);
    expect(set.has('short')).toBe(false);
  });

  it('excludes keychain stub references', () => {
    const env = { DISCORD_TOKEN: 'keychain:clementine-agent-DISCORD_TOKEN' };
    const set = buildKnownValueSet(env as unknown as NodeJS.ProcessEnv);
    expect(set.has('keychain:clementine-agent-DISCORD_TOKEN')).toBe(false);
  });
});

describe('redactSecrets — combined layers', () => {
  it('handles pattern + known-value in the same string', () => {
    const known = new Set(['internal-api-secret-1234567890']);
    // pragma: allowlist secret
    const text = 'public sk-ant-api03-aaaaaaaaaaaaaaaaaa and private internal-api-secret-1234567890';
    const r = redactSecrets(text, known);
    expect(r.text).toContain('[REDACTED:anthropic]');
    expect(r.text).toContain('[REDACTED:env]');
    expect(r.stats.redactionCount).toBe(2);
  });

  it('empty input returns empty stats', () => {
    const r = redactSecrets('');
    expect(r.stats.redactionCount).toBe(0);
  });
});
