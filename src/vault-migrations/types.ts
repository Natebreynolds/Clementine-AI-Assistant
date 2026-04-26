/**
 * Migration system — types and interfaces.
 *
 * Migrations ship structural changes to user data files (SOUL.md, AGENTS.md,
 * advisor rules, prompt overrides, clementine.json, etc.) alongside code
 * updates. Each migration is idempotent and runs once during `clementine update`.
 *
 * Two shapes coexist for back-compat:
 *   - VaultMigration: takes vaultDir only (the original shape, used by 0001-0003)
 *   - Migration: takes a MigrationContext { vaultDir, baseDir, pkgDir } so a
 *     migration can touch advisor-rules/, prompt-overrides/, clementine.json,
 *     etc. — anything under ~/.clementine/, not just the vault.
 *
 * Discriminator: `kind` field. Vault-style migrations omit it.
 */

export interface MigrationContext {
  /** ~/.clementine/vault */
  vaultDir: string;
  /** ~/.clementine/  (data home — config, state, cache, advisor-rules, etc.) */
  baseDir: string;
  /** Package install root (where dist/ lives). For migrations that ship templates. */
  pkgDir: string;
}

/** Original vault-only migration shape. Existing 0001-0003 use this. */
export interface VaultMigration {
  /** Unique ID matching the filename (e.g., "0001-add-execution-framework"). */
  id: string;
  /** Human-readable description for update logs. */
  description: string;
  /** Apply the migration. Must be idempotent — safe to re-run. */
  apply: (vaultDir: string) => MigrationResult;
}

/** Multi-target migration shape. Use for any data outside vault/. */
export interface Migration {
  /** Discriminator. Vault-only migrations omit this and use VaultMigration. */
  kind: 'vault' | 'config' | 'advisor-rules' | 'prompt-overrides' | 'multi';
  id: string;
  description: string;
  apply: (ctx: MigrationContext) => MigrationResult | Promise<MigrationResult>;
}

export type AnyMigration = VaultMigration | Migration;

export interface MigrationResult {
  /** True if changes were written to disk. */
  applied: boolean;
  /** True if the migration detected its changes were already present. */
  skipped: boolean;
  /** What was done or why it was skipped. */
  details?: string;
}

export interface MigrationStateEntry {
  id: string;
  appliedAt: string;
  result: 'applied' | 'skipped';
}

export interface MigrationState {
  applied: MigrationStateEntry[];
}

export interface VaultMigrationSummary {
  applied: string[];
  skipped: string[];
  alreadyRun: string[];
  failed: string[];
  errors: Array<{ id: string; error: string }>;
}

/** Alias — same shape, generalized name now that migrations aren't vault-only. */
export type MigrationSummary = VaultMigrationSummary;
