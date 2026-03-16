/**
 * Clementine TypeScript — Safe Restart Orchestrator.
 *
 * Central coordinator for source self-editing. Replaces bare SIGUSR1-based
 * source editing with a validated pipeline:
 *   preflight → apply → commit → build → sentinel → restart
 *
 * All self-edits live on a local `self/edits` branch that never gets pushed.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR, PKG_DIR } from '../config.js';
import { preflightSourceChange } from './source-preflight.js';
import type { RestartSentinel } from '../types.js';

const logger = pino({ name: 'clementine.safe-restart' });

const SENTINEL_PATH = path.join(BASE_DIR, '.restart-sentinel.json');

/** Files that cannot be self-edited (security-critical). */
const BLOCKLIST = new Set([
  'src/config.ts',
  'src/gateway/security-scanner.ts',
  'src/security/scanner.ts',
]);

export interface SafeEditResult {
  success: boolean;
  error?: string;
  preflightErrors?: string[];
}

/**
 * Safely edit Clementine's own source code:
 *   1. Preflight — validate in a staging worktree
 *   2. Apply — write validated .ts files to the real src/
 *   3. Commit — on `self/edits` branch
 *   4. Build — run `npm run build`; revert if it fails
 *   5. Write sentinel — context for the new process
 *   6. Signal restart — SIGUSR1
 */
export async function safeSourceEdit(
  pkgDir: string,
  changes: Array<{ relativePath: string; content: string }>,
  opts?: { experimentId?: string; reason?: string; sessionKey?: string },
): Promise<SafeEditResult> {
  const reason = opts?.reason ?? 'source self-edit';

  // Validate against blocklist
  for (const change of changes) {
    if (BLOCKLIST.has(change.relativePath)) {
      return {
        success: false,
        error: `Blocked: ${change.relativePath} is on the security blocklist and cannot be self-edited.`,
      };
    }
  }

  // 1. Preflight
  logger.info({ fileCount: changes.length, reason }, 'Starting safe source edit');
  const preflight = await preflightSourceChange(pkgDir, changes);

  if (!preflight.success) {
    logger.warn({ errors: preflight.errors }, 'Preflight failed — aborting source edit');
    return {
      success: false,
      error: 'Compilation failed in staging worktree.',
      preflightErrors: preflight.errors,
    };
  }

  // Ensure we're on the self/edits branch
  try {
    ensureSelfEditsBranch(pkgDir);
  } catch (err) {
    return { success: false, error: `Branch setup failed: ${String(err)}` };
  }

  // 2. Apply — write validated files to the real tree
  const changedFiles: string[] = [];
  for (const change of changes) {
    const targetFile = path.join(pkgDir, change.relativePath);
    const targetDir = path.dirname(targetFile);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    writeFileSync(targetFile, change.content);
    changedFiles.push(change.relativePath);
  }

  // 3. Commit on self/edits
  try {
    execSync(`git add ${changedFiles.map(f => `"${f}"`).join(' ')}`, {
      cwd: pkgDir,
      stdio: 'pipe',
    });
    execSync(`git commit -m "self-edit: ${reason}"`, {
      cwd: pkgDir,
      stdio: 'pipe',
    });
    logger.info({ changedFiles, reason }, 'Committed source edit on self/edits');
  } catch (err) {
    logger.error({ err }, 'Git commit failed');
    return { success: false, error: `Git commit failed: ${String(err)}` };
  }

  // 4. Build
  try {
    execSync('npm run build', {
      cwd: pkgDir,
      stdio: 'pipe',
      timeout: 120_000,
    });
    logger.info('Build succeeded after source edit');
  } catch (err) {
    // Build failed (shouldn't happen since preflight passed) — revert
    logger.error({ err }, 'Build failed after source edit — reverting');
    try {
      execSync('git revert --no-edit HEAD', { cwd: pkgDir, stdio: 'pipe' });
      execSync('npm run build', { cwd: pkgDir, stdio: 'pipe', timeout: 120_000 });
    } catch (revertErr) {
      logger.error({ revertErr }, 'Revert + rebuild also failed');
    }
    return { success: false, error: `Build failed after applying changes: ${String(err)}` };
  }

  // 5. Write sentinel
  const sentinel: RestartSentinel = {
    previousPid: process.pid,
    restartedAt: new Date().toISOString(),
    reason: 'source-edit',
    sourceChangeId: opts?.experimentId,
    sessionKey: opts?.sessionKey,
    changedFiles,
  };
  writeFileSync(SENTINEL_PATH, JSON.stringify(sentinel, null, 2));
  logger.info({ sentinel }, 'Restart sentinel written');

  // 6. Signal restart
  process.kill(process.pid, 'SIGUSR1');

  return { success: true };
}

/**
 * Ensure the `self/edits` branch exists and we're on it.
 * If we're on main, create self/edits from HEAD.
 * If self/edits already exists and we're not on it, switch to it.
 */
function ensureSelfEditsBranch(pkgDir: string): void {
  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: pkgDir,
    encoding: 'utf-8',
  }).trim();

  if (currentBranch === 'self/edits') return;

  // Check if self/edits exists
  try {
    execSync('git rev-parse --verify self/edits', { cwd: pkgDir, stdio: 'pipe' });
    // Branch exists — switch to it
    execSync('git checkout self/edits', { cwd: pkgDir, stdio: 'pipe' });
    logger.info('Switched to existing self/edits branch');
  } catch {
    // Branch doesn't exist — create it from current HEAD
    execSync('git checkout -b self/edits', { cwd: pkgDir, stdio: 'pipe' });
    logger.info('Created self/edits branch from HEAD');
  }
}

/**
 * Get the path to the restart sentinel file.
 */
export function getSentinelPath(): string {
  return SENTINEL_PATH;
}
