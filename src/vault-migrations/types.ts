/**
 * Vault migration system — types and interfaces.
 *
 * Vault migrations ship structural changes to user vault files (SOUL.md,
 * AGENTS.md, etc.) alongside code updates. Each migration is idempotent
 * and runs once during `clementine update`.
 */

export interface VaultMigration {
  /** Unique ID matching the filename (e.g., "0001-add-execution-framework"). */
  id: string;
  /** Human-readable description for update logs. */
  description: string;
  /** Apply the migration. Must be idempotent — safe to re-run. */
  apply: (vaultDir: string) => MigrationResult;
}

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
