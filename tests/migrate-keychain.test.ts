/**
 * migrate-keychain — planMigration tests (pure, no keychain shell calls).
 *
 * applyMigration is exercised end-to-end on a real macOS host via
 * smoke-testing in CI/dev, but these tests cover the classification
 * matrix that decides what's a candidate.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planMigration } from '../src/config/migrate-keychain.js';

describe('planMigration', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clem-migrate-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns empty plan when .env is missing', () => {
    const plan = planMigration(baseDir);
    expect(plan.candidates).toEqual([]);
    expect(plan.toMigrate).toEqual([]);
  });

  it('classifies plaintext credentials as migration candidates', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      [
        // pragma: allowlist secret
        'DISCORD_TOKEN=this-is-a-fake-bot-token-1234567890abcdef',
        // pragma: allowlist secret
        'STRIPE_API_KEY=placeholder-credential-value-1234567890abcdef',
      ].join('\n'),
    );
    const plan = planMigration(baseDir);
    expect(plan.toMigrate.sort()).toEqual(['DISCORD_TOKEN', 'STRIPE_API_KEY']);
    const tokenEntry = plan.candidates.find(c => c.key === 'DISCORD_TOKEN')!;
    expect(tokenEntry.status).toBe('migrated');
  });

  it('skips already-keychain refs', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'DISCORD_TOKEN=keychain:clementine-agent-DISCORD_TOKEN\n',
    );
    const plan = planMigration(baseDir);
    expect(plan.toMigrate).toEqual([]);
    expect(plan.candidates[0]!.status).toBe('already-keychain');
  });

  it('skips non-credential keys', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      'OWNER_NAME=Nate\nBUDGET_HEARTBEAT_USD=0.50\n',
    );
    const plan = planMigration(baseDir);
    expect(plan.toMigrate).toEqual([]);
    expect(plan.candidates.every(c => c.status === 'not-sensitive')).toBe(true);
  });

  it('skips short values that are likely not credentials', () => {
    writeFileSync(path.join(baseDir, '.env'), 'API_KEY=short\n');
    const plan = planMigration(baseDir);
    expect(plan.toMigrate).toEqual([]);
    expect(plan.candidates[0]!.status).toBe('too-short');
  });

  it('honors --key filter', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      [
        // pragma: allowlist secret
        'DISCORD_TOKEN=this-is-a-fake-bot-token-1234567890abcdef',
        // pragma: allowlist secret
        'STRIPE_API_KEY=placeholder-credential-value-1234567890abcdef',
      ].join('\n'),
    );
    const plan = planMigration(baseDir, { only: ['DISCORD_TOKEN'] });
    expect(plan.toMigrate).toEqual(['DISCORD_TOKEN']);
    // STRIPE_API_KEY is in candidates but skipped (not in --key filter)
    const stripe = plan.candidates.find(c => c.key === 'STRIPE_API_KEY')!;
    expect(stripe.status).toBe('skipped');
  });

  it('passes through comments and blank lines', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      [
        '# This is a comment',
        '',
        // pragma: allowlist secret
        'DISCORD_TOKEN=this-is-a-fake-bot-token-1234567890abcdef',
        '',
        '# trailing comment',
      ].join('\n'),
    );
    const plan = planMigration(baseDir);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.key).toBe('DISCORD_TOKEN');
  });

  it('strips surrounding quotes from value before length check', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      `DISCORD_TOKEN="this-is-a-fake-bot-token-1234567890abcdef"\n`,
    );
    const plan = planMigration(baseDir);
    expect(plan.toMigrate).toEqual(['DISCORD_TOKEN']);
  });

  it('reports value length but never the value itself', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'DISCORD_TOKEN=secret-value-1234567890abcdef\n',
    );
    const plan = planMigration(baseDir);
    const entry = plan.candidates[0]!;
    expect(entry.valueLength).toBeGreaterThan(0);
    // The plan object should never carry the raw secret value anywhere
    const json = JSON.stringify(plan);
    expect(json).not.toContain('secret-value');
  });

  it('does not modify .env (planning only)', () => {
    const original = 'OWNER_NAME=Nate\n# pragma: allowlist secret\nDISCORD_TOKEN=this-is-a-fake-bot-token-1234567890abcdef\n';
    const envPath = path.join(baseDir, '.env');
    writeFileSync(envPath, original);
    planMigration(baseDir);
    expect(readFileSync(envPath, 'utf-8')).toBe(original);
  });
});
