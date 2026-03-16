/**
 * Clementine TypeScript — Daemon-Driven Auto-Update.
 *
 * Checks for and applies upstream changes without requiring `clementine update`.
 * Self-edits live on `self/edits` branch; upstream updates go to `main`.
 * After pulling main, self-edits are rebased on top.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';
import type { RestartSentinel } from '../types.js';

const logger = pino({ name: 'clementine.auto-update' });

const SENTINEL_PATH = path.join(BASE_DIR, '.restart-sentinel.json');

export interface UpdateCheckResult {
  available: boolean;
  commitsBehind: number;
  summary?: string;       // one-line description of what's new
}

export interface UpdateApplyResult {
  success: boolean;
  error?: string;
  selfEditsConflict?: boolean;  // true if self-edits couldn't be rebased
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
 * Apply upstream updates. Handles branch awareness:
 * - If on `self/edits`: checkout main → pull → rebase self-edits → build
 * - If on `main`: pull → build
 *
 * Writes a restart sentinel and sends SIGUSR1 on success.
 */
export async function applyUpdate(pkgDir: string): Promise<UpdateApplyResult> {
  let wasOnSelfEdits = false;
  let didStash = false;

  try {
    // 1. Detect current branch
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: pkgDir,
      encoding: 'utf-8',
    }).trim();
    wasOnSelfEdits = currentBranch === 'self/edits';

    // 2. Stash any uncommitted work
    try {
      const stashOut = execSync('git stash', {
        cwd: pkgDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      didStash = !stashOut.includes('No local changes');
    } catch { /* nothing to stash */ }

    // 3. If on self/edits, switch to main
    if (wasOnSelfEdits) {
      execSync('git checkout main', { cwd: pkgDir, stdio: 'pipe' });
    }

    // 4. Pull from origin
    try {
      execSync('git pull --ff-only origin main', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      logger.info('Pulled latest from origin/main');
    } catch (err) {
      logger.error({ err }, 'git pull --ff-only failed');
      // Restore previous state
      if (wasOnSelfEdits) {
        try { execSync('git checkout self/edits', { cwd: pkgDir, stdio: 'pipe' }); } catch { /* best effort */ }
      }
      if (didStash) {
        try { execSync('git stash pop', { cwd: pkgDir, stdio: 'pipe' }); } catch { /* best effort */ }
      }
      return { success: false, error: `git pull failed: ${String(err)}` };
    }

    // 5. Install dependencies (in case they changed)
    try {
      execSync('npm install --omit=dev', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      logger.warn({ err }, 'npm install failed during update');
      // Non-fatal — build may still work
    }

    // 6. Rebase self-edits if they existed
    let selfEditsConflict = false;
    if (wasOnSelfEdits) {
      try {
        execSync('git rebase main self/edits', {
          cwd: pkgDir,
          stdio: 'pipe',
        });
        execSync('git checkout self/edits', { cwd: pkgDir, stdio: 'pipe' });
        logger.info('Rebased self/edits onto updated main');
      } catch {
        // Rebase conflict — abort and stay on main
        try { execSync('git rebase --abort', { cwd: pkgDir, stdio: 'pipe' }); } catch { /* best effort */ }
        selfEditsConflict = true;
        logger.warn('Rebase of self/edits failed — staying on main. Self-edits preserved on branch.');
      }
    }

    // 7. Build
    try {
      execSync('npm run build', {
        cwd: pkgDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
      logger.info('Build succeeded after update');
    } catch (err) {
      logger.error({ err }, 'Build failed after update');
      if (didStash) {
        try { execSync('git stash pop', { cwd: pkgDir, stdio: 'pipe' }); } catch { /* best effort */ }
      }
      return { success: false, error: `Build failed after update: ${String(err)}` };
    }

    // 8. Restore stashed work
    if (didStash) {
      try { execSync('git stash pop', { cwd: pkgDir, stdio: 'pipe' }); } catch { /* best effort */ }
    }

    // 9. Write sentinel
    const sentinel: RestartSentinel = {
      previousPid: process.pid,
      restartedAt: new Date().toISOString(),
      reason: 'update',
    };
    writeFileSync(SENTINEL_PATH, JSON.stringify(sentinel, null, 2));

    // 10. Signal restart
    process.kill(process.pid, 'SIGUSR1');

    return { success: true, selfEditsConflict };
  } catch (err) {
    logger.error({ err }, 'Update apply failed');
    // Try to restore state
    if (didStash) {
      try { execSync('git stash pop', { cwd: pkgDir, stdio: 'pipe' }); } catch { /* best effort */ }
    }
    return { success: false, error: String(err) };
  }
}
