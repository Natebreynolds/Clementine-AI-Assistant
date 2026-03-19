/**
 * Vault migration runner — discovers, executes, and tracks migrations.
 *
 * Migrations are TypeScript files in this directory named NNNN-description.ts.
 * Each exports a `migration` object conforming to VaultMigration.
 * State is tracked in ~/.clementine/.vault-migrations.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { VAULT_MIGRATIONS_STATE } from '../config.js';
import type { MigrationState, VaultMigration, VaultMigrationSummary } from './types.js';

const logger = pino({ name: 'clementine.vault-migrations' });

/** Load the migration state file. Returns empty state if missing or corrupt. */
function loadState(): MigrationState {
  try {
    if (existsSync(VAULT_MIGRATIONS_STATE)) {
      return JSON.parse(readFileSync(VAULT_MIGRATIONS_STATE, 'utf-8'));
    }
  } catch {
    logger.warn('Vault migration state file corrupt — resetting');
  }
  return { applied: [] };
}

/** Save the migration state file. */
function saveState(state: MigrationState): void {
  const dir = path.dirname(VAULT_MIGRATIONS_STATE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(VAULT_MIGRATIONS_STATE, JSON.stringify(state, null, 2));
}

/** Back up a file before modifying it. */
function backupFile(filePath: string, backupDir: string): void {
  if (!existsSync(filePath)) return;
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const safeName = filePath.replace(/[/\\]/g, '-').replace(/^-+/, '');
  copyFileSync(filePath, path.join(backupDir, safeName));
}

/**
 * Discover all migration modules in the compiled dist/vault-migrations/ directory.
 * Returns them sorted by filename (numeric prefix ensures correct order).
 */
async function discoverMigrations(): Promise<VaultMigration[]> {
  const migrations: VaultMigration[] = [];

  // Look for compiled migration files next to this runner
  const migrationsDir = path.dirname(new URL(import.meta.url).pathname);
  const skipFiles = new Set(['runner.js', 'types.js', 'helpers.js', 'runner.d.ts', 'types.d.ts', 'helpers.d.ts']);

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js') && !skipFiles.has(f))
      .sort();
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const mod = await import(path.join(migrationsDir, file));
      if (mod.migration && typeof mod.migration.apply === 'function') {
        migrations.push(mod.migration);
      }
    } catch (err) {
      logger.warn({ file, err }, 'Failed to load vault migration');
    }
  }

  return migrations;
}

/**
 * Run all pending vault migrations against the user's vault.
 * Idempotent — safe to call multiple times.
 */
export async function runVaultMigrations(
  vaultDir: string,
  backupDir?: string,
): Promise<VaultMigrationSummary> {
  const summary: VaultMigrationSummary = {
    applied: [],
    skipped: [],
    alreadyRun: [],
    failed: [],
    errors: [],
  };

  const state = loadState();
  const appliedIds = new Set(state.applied.map(e => e.id));
  const migrations = await discoverMigrations();

  if (migrations.length === 0) return summary;

  for (const migration of migrations) {
    // Skip if already recorded as applied
    if (appliedIds.has(migration.id)) {
      summary.alreadyRun.push(migration.id);
      continue;
    }

    try {
      // Back up target files before migration
      if (backupDir) {
        // Best-effort backup of the vault's 00-System dir (most common target)
        const systemDir = path.join(vaultDir, '00-System');
        if (existsSync(systemDir)) {
          const systemFiles = readdirSync(systemDir).filter(f => f.endsWith('.md'));
          for (const f of systemFiles) {
            backupFile(path.join(systemDir, f), backupDir);
          }
        }
      }

      const result = migration.apply(vaultDir);

      if (result.applied) {
        summary.applied.push(migration.id);
        state.applied.push({
          id: migration.id,
          appliedAt: new Date().toISOString(),
          result: 'applied',
        });
        logger.info({ id: migration.id, details: result.details }, 'Vault migration applied');
      } else if (result.skipped) {
        summary.skipped.push(migration.id);
        // Record as applied so we don't re-check every update
        state.applied.push({
          id: migration.id,
          appliedAt: new Date().toISOString(),
          result: 'skipped',
        });
        logger.info({ id: migration.id, details: result.details }, 'Vault migration skipped (already present)');
      }
    } catch (err) {
      const errMsg = String(err).slice(0, 200);
      summary.failed.push(migration.id);
      summary.errors.push({ id: migration.id, error: errMsg });
      // Do NOT record as applied — will retry on next update
      logger.warn({ id: migration.id, err }, 'Vault migration failed');
    }
  }

  saveState(state);
  return summary;
}
