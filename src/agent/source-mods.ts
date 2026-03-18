/**
 * Clementine TypeScript — Source Modification Registry.
 *
 * Tracks self-improve source edits in ~/.clementine/ (not in git).
 * When `clementine update` pulls new code, the reconciliation step
 * re-applies active modifications that are still needed.
 *
 * This decouples user-local improvements from the upstream repo,
 * so `git pull` is always clean and user customizations survive.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { SOURCE_MODS_DIR, PKG_DIR } from '../config.js';

const logger = pino({ name: 'clementine.source-mods' });

// ── Types ────────────────────────────────────────────────────────────

export interface SourceModRecord {
  id: string;
  files: string[];               // relative paths, e.g. "src/agent/self-improve.ts"
  reason: string;                // why the change was made
  description: string;           // semantic description of what changed
  experimentId?: string;         // self-improve experiment ID
  appliedAt: string;             // ISO timestamp
  status: 'active' | 'superseded' | 'needs-reconciliation' | 'failed';
}

// ── Registry Operations ──────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(SOURCE_MODS_DIR)) {
    mkdirSync(SOURCE_MODS_DIR, { recursive: true });
  }
}

/** Record a new source modification with before/after file snapshots. */
export function recordSourceMod(
  id: string,
  files: Array<{ relativePath: string; beforeContent: string; afterContent: string }>,
  opts: { reason: string; description: string; experimentId?: string },
): void {
  ensureDir();

  const record: SourceModRecord = {
    id,
    files: files.map(f => f.relativePath),
    reason: opts.reason,
    description: opts.description,
    experimentId: opts.experimentId,
    appliedAt: new Date().toISOString(),
    status: 'active',
  };

  // Write metadata
  writeFileSync(
    path.join(SOURCE_MODS_DIR, `${id}.json`),
    JSON.stringify(record, null, 2),
  );

  // Write before/after snapshots
  for (const file of files) {
    const beforeDir = path.join(SOURCE_MODS_DIR, `${id}.before`);
    const afterDir = path.join(SOURCE_MODS_DIR, `${id}.after`);
    mkdirSync(path.join(beforeDir, path.dirname(file.relativePath)), { recursive: true });
    mkdirSync(path.join(afterDir, path.dirname(file.relativePath)), { recursive: true });
    writeFileSync(path.join(beforeDir, file.relativePath), file.beforeContent);
    writeFileSync(path.join(afterDir, file.relativePath), file.afterContent);
  }

  logger.info({ id, files: record.files, reason: opts.reason }, 'Source modification recorded');
}

/** Load all source mod records. */
export function loadSourceMods(): SourceModRecord[] {
  ensureDir();
  return readdirSync(SOURCE_MODS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(readFileSync(path.join(SOURCE_MODS_DIR, f), 'utf-8')) as SourceModRecord;
      } catch { return null; }
    })
    .filter(Boolean) as SourceModRecord[];
}

/** Load only active mods. */
export function loadActiveSourceMods(): SourceModRecord[] {
  return loadSourceMods().filter(m => m.status === 'active');
}

/** Update a mod's status. */
export function updateModStatus(id: string, status: SourceModRecord['status']): void {
  const filePath = path.join(SOURCE_MODS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return;
  const record = JSON.parse(readFileSync(filePath, 'utf-8')) as SourceModRecord;
  record.status = status;
  writeFileSync(filePath, JSON.stringify(record, null, 2));
}

/** Remove a mod and its snapshots entirely. */
export function removeSourceMod(id: string): void {
  const jsonPath = path.join(SOURCE_MODS_DIR, `${id}.json`);
  const beforeDir = path.join(SOURCE_MODS_DIR, `${id}.before`);
  const afterDir = path.join(SOURCE_MODS_DIR, `${id}.after`);
  try { if (existsSync(jsonPath)) rmSync(jsonPath); } catch { /* best effort */ }
  try { if (existsSync(beforeDir)) rmSync(beforeDir, { recursive: true }); } catch { /* best effort */ }
  try { if (existsSync(afterDir)) rmSync(afterDir, { recursive: true }); } catch { /* best effort */ }
}

/** Read the stored "after" content for a mod's file. */
export function readModAfterContent(id: string, relativePath: string): string | null {
  const filePath = path.join(SOURCE_MODS_DIR, `${id}.after`, relativePath);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/** Read the stored "before" content for a mod's file (for rollback). */
export function readModBeforeContent(id: string, relativePath: string): string | null {
  const filePath = path.join(SOURCE_MODS_DIR, `${id}.before`, relativePath);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

// ── Rollback ─────────────────────────────────────────────────────────

/** Rollback a source mod by restoring the "before" snapshots. */
export function rollbackSourceMod(id: string, pkgDir: string): boolean {
  const record = loadSourceMods().find(m => m.id === id);
  if (!record) return false;

  for (const relativePath of record.files) {
    const before = readModBeforeContent(id, relativePath);
    if (before !== null) {
      writeFileSync(path.join(pkgDir, relativePath), before);
    }
  }
  updateModStatus(id, 'failed');
  logger.info({ id }, 'Source modification rolled back');
  return true;
}

// ── Reconciliation (post-update) ─────────────────────────────────────

function fileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface ReconcileResult {
  reapplied: string[];           // mod IDs re-applied successfully
  superseded: string[];          // mod IDs already in upstream
  needsReconciliation: string[]; // mod IDs that need LLM help
  failed: string[];              // mod IDs that failed typecheck after re-apply
}

/**
 * Reconcile active source mods after an upstream update.
 *
 * For each active mod:
 * 1. If the current file already matches our "after" content → superseded
 * 2. If the current file matches our "before" content → re-apply directly
 * 3. If the current file is different from both → needs LLM reconciliation
 *
 * After re-applying, runs a typecheck. Failures get reverted.
 */
export function reconcileSourceMods(pkgDir: string): ReconcileResult {
  const result: ReconcileResult = {
    reapplied: [],
    superseded: [],
    needsReconciliation: [],
    failed: [],
  };

  const activeMods = loadActiveSourceMods();
  if (activeMods.length === 0) return result;

  logger.info({ count: activeMods.length }, 'Reconciling source modifications after update');

  for (const mod of activeMods) {
    let modResult: 'reapply' | 'superseded' | 'needs-reconciliation' = 'needs-reconciliation';

    // Check each file in the mod
    const fileChecks: Array<{ relativePath: string; action: 'reapply' | 'superseded' | 'needs-reconciliation' }> = [];

    for (const relativePath of mod.files) {
      const currentPath = path.join(pkgDir, relativePath);
      const currentContent = existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : '';
      const afterContent = readModAfterContent(mod.id, relativePath);
      const beforeContent = readModBeforeContent(mod.id, relativePath);

      const currentHash = fileHash(currentContent);
      const afterHash = afterContent ? fileHash(afterContent) : '';
      const beforeHash = beforeContent ? fileHash(beforeContent) : '';

      if (currentHash === afterHash) {
        // Current file already has our changes (upstream included them)
        fileChecks.push({ relativePath, action: 'superseded' });
      } else if (currentHash === beforeHash) {
        // File is back to pre-mod state — upstream didn't change it, safe to re-apply
        fileChecks.push({ relativePath, action: 'reapply' });
      } else {
        // File changed upstream AND our mod is gone — needs intelligent merge
        fileChecks.push({ relativePath, action: 'needs-reconciliation' });
      }
    }

    // Determine overall mod action
    const hasNeedsRecon = fileChecks.some(f => f.action === 'needs-reconciliation');
    const allSuperseded = fileChecks.every(f => f.action === 'superseded');

    if (allSuperseded) {
      modResult = 'superseded';
    } else if (hasNeedsRecon) {
      modResult = 'needs-reconciliation';
    } else {
      modResult = 'reapply';
    }

    if (modResult === 'superseded') {
      updateModStatus(mod.id, 'superseded');
      result.superseded.push(mod.id);
      logger.info({ id: mod.id, reason: mod.reason }, 'Source mod superseded by upstream');
    } else if (modResult === 'reapply') {
      // Re-apply all files
      for (const relativePath of mod.files) {
        const afterContent = readModAfterContent(mod.id, relativePath);
        if (afterContent) {
          writeFileSync(path.join(pkgDir, relativePath), afterContent);
        }
      }
      result.reapplied.push(mod.id);
      logger.info({ id: mod.id, reason: mod.reason }, 'Source mod re-applied after update');
    } else {
      updateModStatus(mod.id, 'needs-reconciliation');
      result.needsReconciliation.push(mod.id);
      logger.info({ id: mod.id, reason: mod.reason }, 'Source mod needs LLM reconciliation');
    }
  }

  // If we re-applied anything, typecheck
  if (result.reapplied.length > 0) {
    try {
      const { execSync } = require('node:child_process');
      execSync('npx tsc --noEmit', { cwd: pkgDir, stdio: 'pipe', timeout: 120_000 });
      logger.info({ count: result.reapplied.length }, 'Typecheck passed after re-applying source mods');
    } catch {
      // Typecheck failed — revert all re-applied mods
      logger.warn('Typecheck failed after re-applying source mods — reverting');
      for (const modId of result.reapplied) {
        rollbackSourceMod(modId, pkgDir);
      }
      result.failed.push(...result.reapplied);
      result.reapplied = [];
    }
  }

  return result;
}
