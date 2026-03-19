/**
 * Clementine TypeScript — Worktree Preflight Validator.
 *
 * Validates proposed source changes in an isolated git worktree before
 * they touch the live repo. Uses worktree isolation for safe validation.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { PKG_DIR, STAGING_DIR } from '../config.js';

const logger = pino({ name: 'clementine.source-preflight' });

export interface PreflightResult {
  success: boolean;
  errors?: string[];   // tsc error lines
}

/**
 * Validate proposed source changes in an isolated git worktree.
 *
 * 1. Create a detached worktree from HEAD
 * 2. Symlink node_modules from the real tree
 * 3. Write the changed .ts files into the worktree
 * 4. Run `npx tsc --noEmit` to type-check
 * 5. Return success/failure with compiler errors
 * 6. Always clean up the worktree
 */
export async function preflightSourceChange(
  pkgDir: string,
  changes: Array<{ relativePath: string; content: string }>,
): Promise<PreflightResult> {
  const timestamp = Date.now();
  const worktreePath = path.join(STAGING_DIR, `preflight-${timestamp}`);

  // Ensure staging directory exists
  if (!existsSync(STAGING_DIR)) {
    mkdirSync(STAGING_DIR, { recursive: true });
  }

  try {
    // 1. Create detached worktree from HEAD
    logger.info({ worktreePath }, 'Creating preflight worktree');
    execSync(`git worktree add --detach "${worktreePath}" HEAD`, {
      cwd: pkgDir,
      stdio: 'pipe',
    });

    // 2. Symlink node_modules from the real tree
    const realModules = path.join(pkgDir, 'node_modules');
    const worktreeModules = path.join(worktreePath, 'node_modules');
    if (existsSync(realModules)) {
      try {
        symlinkSync(realModules, worktreeModules, 'junction');
      } catch {
        // Fallback: copy if symlink fails (e.g., cross-device)
        logger.warn('Symlink failed — copying node_modules');
        execSync(`cp -r "${realModules}" "${worktreeModules}"`, { stdio: 'pipe' });
      }
    }

    // 3. Write changed .ts files into the worktree
    for (const change of changes) {
      const targetFile = path.join(worktreePath, change.relativePath);
      const targetDir = path.dirname(targetFile);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      writeFileSync(targetFile, change.content);
    }

    // 4. Run tsc --noEmit to type-check
    try {
      execSync('npx tsc --noEmit', {
        cwd: worktreePath,
        stdio: 'pipe',
        timeout: 60_000,
      });
      logger.info('Preflight compilation succeeded');
      return { success: true };
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? '';
      const stdout = err.stdout?.toString() ?? '';
      const output = (stderr + '\n' + stdout).trim();
      const errors = output.split('\n').filter(Boolean);
      logger.warn({ errorCount: errors.length }, 'Preflight compilation failed');
      return { success: false, errors };
    }
  } catch (err) {
    logger.error({ err }, 'Preflight worktree setup failed');
    return {
      success: false,
      errors: [`Worktree setup failed: ${String(err)}`],
    };
  } finally {
    // 6. Always clean up the worktree
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: pkgDir,
        stdio: 'pipe',
      });
      logger.info('Preflight worktree cleaned up');
    } catch {
      // Best effort — worktree prune will catch it later
      logger.warn({ worktreePath }, 'Failed to remove preflight worktree — will be pruned later');
    }
  }
}
