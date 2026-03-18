/**
 * Clementine TypeScript — Safe Restart Orchestrator.
 *
 * Central coordinator for source self-editing. Replaces bare SIGUSR1-based
 * source editing with a validated pipeline:
 *   preflight → apply → record → build → sentinel → restart
 *
 * Source modifications are recorded in ~/.clementine/self-improve/source-mods/
 * (not in git). This keeps the repo clean so `git pull` always works, and
 * modifications are re-applied intelligently after updates.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';
import { preflightSourceChange } from './source-preflight.js';
import { recordSourceMod } from './source-mods.js';
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
  sourceModId?: string;
}

/**
 * Safely edit Clementine's own source code:
 *   1. Preflight — validate in a staging worktree
 *   2. Snapshot — capture "before" content for rollback
 *   3. Apply — write validated .ts files to the real src/
 *   4. Record — save modification to ~/.clementine/ registry
 *   5. Build — run tsc; revert if it fails
 *   6. Write sentinel — context for the new process
 *   7. Signal restart — SIGUSR1
 */
export async function safeSourceEdit(
  pkgDir: string,
  changes: Array<{ relativePath: string; content: string }>,
  opts?: { experimentId?: string; reason?: string; sessionKey?: string; description?: string },
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

  // 2. Snapshot "before" content for each file
  const filesWithSnapshots = changes.map(change => {
    const targetFile = path.join(pkgDir, change.relativePath);
    const beforeContent = existsSync(targetFile) ? readFileSync(targetFile, 'utf-8') : '';
    return {
      relativePath: change.relativePath,
      beforeContent,
      afterContent: change.content,
    };
  });

  // 3. Apply — write validated files to the real tree
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

  // 4. Record source modification in the registry
  const modId = opts?.experimentId ?? randomBytes(4).toString('hex');
  try {
    recordSourceMod(modId, filesWithSnapshots, {
      reason,
      description: opts?.description ?? reason,
      experimentId: opts?.experimentId,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to record source mod (non-fatal)');
  }

  // 5. Build — use `tsc` directly instead of `npm run build` because
  //    the build script does `rm -rf dist` which would nuke the currently
  //    running process's loaded modules. tsc alone overwrites only changed .js files.
  try {
    execSync('npx tsc', {
      cwd: pkgDir,
      stdio: 'pipe',
      timeout: 120_000,
    });
    logger.info('Build succeeded after source edit');
  } catch (err) {
    // Build failed (shouldn't happen since preflight passed) — revert
    logger.error({ err }, 'Build failed after source edit — reverting');
    try {
      // Restore "before" content
      for (const file of filesWithSnapshots) {
        writeFileSync(path.join(pkgDir, file.relativePath), file.beforeContent);
      }
      execSync('npx tsc', { cwd: pkgDir, stdio: 'pipe', timeout: 120_000 });
    } catch (revertErr) {
      logger.error({ revertErr }, 'Revert + rebuild also failed');
    }
    return { success: false, error: `Build failed after applying changes: ${String(err)}` };
  }

  // 6. Write sentinel
  const sentinel: RestartSentinel = {
    previousPid: process.pid,
    restartedAt: new Date().toISOString(),
    reason: 'source-edit',
    sourceChangeId: modId,
    sessionKey: opts?.sessionKey,
    changedFiles,
  };
  writeFileSync(SENTINEL_PATH, JSON.stringify(sentinel, null, 2));
  logger.info({ sentinel }, 'Restart sentinel written');

  // 7. Signal restart
  process.kill(process.pid, 'SIGUSR1');

  return { success: true, sourceModId: modId };
}

/**
 * Get the path to the restart sentinel file.
 */
export function getSentinelPath(): string {
  return SENTINEL_PATH;
}
