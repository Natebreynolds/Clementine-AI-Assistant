/**
 * Phase 7a — generalized migration runner.
 * Confirms both shapes work side by side.
 */
import { describe, expect, it } from 'vitest';
import type {
  AnyMigration,
  Migration,
  MigrationContext,
  VaultMigration,
} from '../src/vault-migrations/types.js';

describe('Migration types', () => {
  it('VaultMigration shape has no kind, takes vaultDir string', () => {
    const m: VaultMigration = {
      id: '0001-test',
      description: 'A test',
      apply: (vaultDir: string) => ({ applied: false, skipped: true, details: vaultDir }),
    };
    expect(m.apply('/tmp/vault')).toEqual({ applied: false, skipped: true, details: '/tmp/vault' });
  });

  it('Migration shape has kind discriminator and takes MigrationContext', () => {
    const m: Migration = {
      kind: 'advisor-rules',
      id: '0004-test',
      description: 'Multi-target test',
      apply: (ctx: MigrationContext) => ({
        applied: true,
        skipped: false,
        details: `vault=${ctx.vaultDir}, base=${ctx.baseDir}`,
      }),
    };
    const ctx: MigrationContext = { vaultDir: '/v', baseDir: '/b', pkgDir: '/p' };
    const r = m.apply(ctx);
    expect((r as { applied: boolean }).applied).toBe(true);
  });

  it('AnyMigration accepts both shapes', () => {
    const v: VaultMigration = { id: 'v', description: 'v', apply: () => ({ applied: false, skipped: true }) };
    const m: Migration = { kind: 'config', id: 'm', description: 'm', apply: () => ({ applied: false, skipped: true }) };
    const arr: AnyMigration[] = [v, m];
    expect(arr).toHaveLength(2);
  });
});

describe('Migration runner discrimination', () => {
  it('detects context-style migrations by kind field', () => {
    const ctxMigration: AnyMigration = {
      kind: 'config',
      id: 'm',
      description: 'm',
      apply: () => ({ applied: false, skipped: true }),
    };
    const vaultMigration: AnyMigration = {
      id: 'v',
      description: 'v',
      apply: () => ({ applied: false, skipped: true }),
    };
    expect('kind' in ctxMigration).toBe(true);
    expect('kind' in vaultMigration).toBe(false);
  });
});
