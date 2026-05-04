/**
 * Clementine TypeScript — Daemon-Driven Auto-Update.
 *
 * Checks for and applies upstream changes without requiring `clementine update`.
 * Source modifications from self-improve are tracked in ~/.clementine/ (not git),
 * so git pull is always clean. After pulling, source mods are reconciled.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';
import { reconcileSourceMods } from './source-mods.js';
import type { RestartSentinel } from '../types.js';

const logger = pino({ name: 'clementine.auto-update' });

const SENTINEL_PATH = path.join(BASE_DIR, '.restart-sentinel.json');

function readDataEnv(): Record<string, string> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return {};
  try {
    return Object.fromEntries(
      readFileSync(envPath, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const idx = line.indexOf('=');
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

function flagEnabled(name: string, envFile: Record<string, string>): boolean {
  const raw = process.env[name] ?? envFile[name];
  return /^(1|true|yes|on)$/i.test(String(raw ?? ''));
}

function shouldPrefetchEmbeddings(): boolean {
  const envFile = readDataEnv();
  return flagEnabled('CLEMENTINE_INSTALL_EMBEDDINGS', envFile)
    || flagEnabled('CLEMENTINE_PREFETCH_EMBEDDINGS', envFile);
}

export interface UpdateCheckResult {
  available: boolean;
  commitsBehind: number;
  summary?: string;       // one-line description of what's new
}

export interface UpdateApplyResult {
  success: boolean;
  error?: string;
  reconcileResult?: import('./source-mods.js').ReconcileResult;
}

/**
 * Check if upstream has new commits. Safe to call from cron — no side effects.
 */
export async function checkForUpdates(pkgDir: string): Promise<UpdateCheckResult> {
  try {
    execSync('git fetch origin main --quiet', {
      cwd: pkgDir,
      stdio: 'pipe',
      timeout: 30_000,
    });

    const countStr = execSync('git rev-list HEAD..origin/main --count', {
      cwd: pkgDir,
      encoding: 'utf-8',
    }).trim();
    const commitsBehind = parseInt(countStr, 10) || 0;

    if (commitsBehind === 0) {
      return { available: false, commitsBehind: 0 };
    }

    const summary = execSync('git log HEAD..origin/main --oneline', {
      cwd: pkgDir,
      encoding: 'utf-8',
    }).trim();

    return { available: true, commitsBehind, summary };
  } catch (err) {
    logger.warn({ err }, 'Update check failed (network issue?)');
    return { available: false, commitsBehind: 0 };
  }
}

/**
 * Apply upstream updates:
 *   1. Reset any uncommitted src/ changes (mods are tracked in ~/.clementine/)
 *   2. Pull latest from origin/main
 *   3. Install deps + build
 *   4. Reconcile source modifications
 *   5. Rebuild if mods were re-applied
 *   6. Write sentinel + restart
 */
export async function applyUpdate(pkgDir: string): Promise<UpdateApplyResult> {
  try {
    // 1. Ensure we're on main and clean
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: pkgDir,
        encoding: 'utf-8',
      }).trim();
      if (currentBranch !== 'main') {
        execSync('git checkout main', { cwd: pkgDir, stdio: 'pipe' });
      }
    } catch { /* best effort */ }

    // Reset any local src/ changes (source mods are tracked in registry, not git)
    try {
      execSync('git checkout -- src/', { cwd: pkgDir, stdio: 'pipe' });
    } catch { /* no changes to reset */ }

    // 2. Pull from origin
    try {
      execSync('git pull --ff-only origin main', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      logger.info('Pulled latest from origin/main');
    } catch (err) {
      logger.error({ err }, 'git pull --ff-only failed');
      return { success: false, error: `git pull failed: ${String(err)}` };
    }

    // 3. Install dependencies (in case they changed)
    // Include devDependencies — typescript is needed for the build step
    try {
      execSync('npm install', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      logger.warn({ err }, 'npm install failed during update');
      // Non-fatal — build may still work
    }

    // 3b. Rebuild native modules (better-sqlite3) for current Node version
    // The postinstall hook silently swallows errors, so do this explicitly.
    try {
      execSync('npm rebuild better-sqlite3', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      logger.info('Native module rebuild succeeded');
    } catch (err) {
      logger.warn({ err }, 'npm rebuild better-sqlite3 failed — memory may not work after restart');
    }

    // 4. Build — use local tsc binary directly (npx can fail if typescript isn't cached)
    try {
      execSync('./node_modules/.bin/tsc', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
      logger.info('Build succeeded after update');
    } catch (err) {
      logger.error({ err }, 'Build failed after update');
      return { success: false, error: `Build failed after update: ${String(err)}` };
    }

    // 4b. Optional embedding model prefetch. npm postinstall may run before
    // the freshly pulled TypeScript has been built; this second pass uses the
    // just-built CLI so repo updates and npm-style updates behave the same.
    if (shouldPrefetchEmbeddings()) {
      try {
        execFileSync(process.execPath, [path.join(pkgDir, 'dist', 'cli', 'index.js'), 'memory', 'model', 'install'], {
          cwd: pkgDir,
          stdio: 'pipe',
          env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
          timeout: 10 * 60_000,
        });
        logger.info('Local embedding model prefetch succeeded after update');
      } catch (err) {
        logger.warn({ err }, 'Local embedding model prefetch failed after update');
      }
    }

    // 5. Reconcile source modifications
    const reconcileResult = reconcileSourceMods(pkgDir);
    logger.info({
      reapplied: reconcileResult.reapplied.length,
      superseded: reconcileResult.superseded.length,
      needsReconciliation: reconcileResult.needsReconciliation.length,
      failed: reconcileResult.failed.length,
    }, 'Source mod reconciliation complete');

    // 6. Rebuild if any mods were re-applied
    if (reconcileResult.reapplied.length > 0) {
      try {
        execSync('./node_modules/.bin/tsc', { cwd: pkgDir, stdio: 'pipe', timeout: 120_000 });
        logger.info('Rebuild succeeded after re-applying source mods');
      } catch (err) {
        logger.warn({ err }, 'Rebuild failed after re-applying source mods');
      }
    }

    // 6b. Run vault migrations
    try {
      const { runVaultMigrations } = await import('../vault-migrations/runner.js');
      const migResult = await runVaultMigrations(path.join(BASE_DIR, 'vault'));
      logger.info({
        applied: migResult.applied.length,
        skipped: migResult.skipped.length,
        failed: migResult.failed.length,
      }, 'Vault migrations complete');
    } catch (err) {
      logger.warn({ err }, 'Vault migration failed (non-fatal)');
    }

    // 7. Get version info and write sentinel + restart
    let commitHash = '';
    let commitDate = '';
    try {
      commitHash = execSync('git rev-parse --short HEAD', { cwd: pkgDir, encoding: 'utf-8' }).trim();
      commitDate = execSync('git log -1 --format=%ci HEAD', { cwd: pkgDir, encoding: 'utf-8' }).trim().slice(0, 10);
      // Count would have been calculated pre-pull; approximate from reconcile context
    } catch { /* best effort */ }

    const sentinel: RestartSentinel = {
      previousPid: process.pid,
      restartedAt: new Date().toISOString(),
      reason: 'update',
      updateDetails: {
        commitHash,
        commitDate,
        modsReapplied: reconcileResult.reapplied.length,
        modsSuperseded: reconcileResult.superseded.length,
        modsNeedReconciliation: reconcileResult.needsReconciliation.length,
        modsFailed: reconcileResult.failed.length,
      },
    };
    writeFileSync(SENTINEL_PATH, JSON.stringify(sentinel, null, 2));

    process.kill(process.pid, 'SIGUSR1');

    return { success: true, reconcileResult };
  } catch (err) {
    logger.error({ err }, 'Update apply failed');
    return { success: false, error: String(err) };
  }
}
