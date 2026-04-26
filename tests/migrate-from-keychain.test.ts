/**
 * planReverseMigration tests — pure read+classify, no keychain shell calls
 * exercised here. Real keychain integration is smoke-tested on a macOS host.
 *
 * Note: planReverseMigration() WILL call keychain.get for any ref it finds
 * to detect unresolvable entries. To keep these tests hermetic, the
 * fixtures use refs to accounts that are guaranteed not to exist; the
 * resolver will return undefined and the entries get classified as
 * 'unresolvable'. That's still useful — it proves the classification path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planReverseMigration } from '../src/config/migrate-from-keychain.js';

describe('planReverseMigration — classification matrix', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clem-rev-migrate-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns empty plan when .env is missing', () => {
    const plan = planReverseMigration(baseDir);
    expect(plan.candidates).toEqual([]);
    expect(plan.toMigrate).toEqual([]);
  });

  it('plaintext non-credentials are classified as not-keychain', () => {
    writeFileSync(path.join(baseDir, '.env'), 'OWNER_NAME=Nate\nWEBHOOK_PORT=8420\n');
    const plan = planReverseMigration(baseDir);
    expect(plan.toMigrate).toEqual([]);
    expect(plan.candidates.every(c => c.status === 'not-keychain')).toBe(true);
  });

  it('keychain ref to credential-shaped key is left alone', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'DISCORD_TOKEN=keychain:clementine-agent-DISCORD_TOKEN\n',
    );
    const plan = planReverseMigration(baseDir);
    expect(plan.toMigrate).toEqual([]);
    expect(plan.candidates[0]!.status).toBe('sensitive-skipped');
  });

  it('keychain ref to non-credential key with missing entry is unresolvable', () => {
    // TASK_BUDGET_* is non-credential; the account doesn't exist in keychain.
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'TASK_BUDGET_FAKE=keychain:clementine-agent-TASK_BUDGET_FAKE_FOR_TEST_' + Date.now() + '\n',
    );
    const plan = planReverseMigration(baseDir);
    const entry = plan.candidates.find(c => c.key === 'TASK_BUDGET_FAKE')!;
    expect(entry.status).toBe('unresolvable');
    expect(plan.unresolvable).toContain('TASK_BUDGET_FAKE');
    expect(plan.toMigrate).toEqual([]);
  });

  it('--key filter scopes to a single key', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      [
        'OWNER_NAME=Nate',
        // pragma: allowlist secret
        'TASK_BUDGET_X=keychain:clementine-agent-TASK_BUDGET_X_NONEXISTENT_' + Date.now(),
        // pragma: allowlist secret
        'TASK_BUDGET_Y=keychain:clementine-agent-TASK_BUDGET_Y_NONEXISTENT_' + Date.now(),
      ].join('\n'),
    );
    const plan = planReverseMigration(baseDir, { only: ['TASK_BUDGET_X'] });
    const xEntry = plan.candidates.find(c => c.key === 'TASK_BUDGET_X')!;
    const yEntry = plan.candidates.find(c => c.key === 'TASK_BUDGET_Y')!;
    expect(xEntry.status).toBe('unresolvable'); // selected and tried to resolve
    expect(yEntry.status).toBe('skipped'); // not selected
  });

  it('passes through comments and blank lines', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      ['# header', '', 'OWNER_NAME=Nate', '# trailing'].join('\n'),
    );
    const plan = planReverseMigration(baseDir);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.key).toBe('OWNER_NAME');
  });
});
