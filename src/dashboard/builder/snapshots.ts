/**
 * Builder snapshot history — file-based undo for workflow saves.
 *
 * Every successful save writes a copy of the source file to:
 *   ~/.clementine/snapshots/builder/<origin>/<key>/<timestamp>.md
 *
 * Bounded: keep at most MAX_PER_WORKFLOW snapshots per workflow id.
 * Older snapshots are pruned on each save.
 *
 * No git dependency, no user-facing CLI — agent invokes via MCP tools
 * (workflow_history / workflow_restore).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseBuilderId } from './serializer.js';

function snapRoot(): string {
  return path.join(
    process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine'),
    'snapshots',
    'builder',
  );
}

const MAX_PER_WORKFLOW = 20;

let _snapshotCounter = 0;

function nextSnapshotFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const seq = (++_snapshotCounter).toString(36).padStart(3, '0');
  return `${ts}-${seq}.md`;
}

export interface SnapshotEntry {
  id: string;             // builder id
  filename: string;       // <ts>.md
  ts: string;             // ISO timestamp
  size: number;           // bytes
  preview: string;        // first ~120 chars of frontmatter for quick scan
}

function snapshotDirFor(id: string): string | null {
  const parsed = parseBuilderId(id);
  if (!parsed) return null;
  return path.join(snapRoot(), parsed.origin, sanitizeKey(parsed.key));
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120);
}

/**
 * Write a snapshot of the current state of a workflow's source file.
 * Best-effort — failures are logged but never block the underlying save.
 */
export function snapshotWorkflow(id: string, sourceFile: string): SnapshotEntry | null {
  if (!sourceFile || !existsSync(sourceFile)) return null;
  const dir = snapshotDirFor(id);
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const filename = nextSnapshotFilename();
    const dst = path.join(dir, filename);
    copyFileSync(sourceFile, dst);
    pruneOldSnapshots(dir);
    return entryFromFile(id, dir, filename);
  } catch {
    return null;
  }
}

/** List snapshots for a builder id, newest first. */
export function listSnapshots(id: string): SnapshotEntry[] {
  const dir = snapshotDirFor(id);
  if (!dir || !existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    return files
      .map(f => entryFromFile(id, dir, f))
      .filter((e): e is SnapshotEntry => e != null)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  } catch {
    return [];
  }
}

/** Restore a snapshot by filename. Writes the snapshot's contents back into sourceFile. */
export function restoreSnapshot(id: string, snapshotFilename: string, sourceFile: string): { ok: boolean; error?: string } {
  const dir = snapshotDirFor(id);
  if (!dir) return { ok: false, error: 'unknown id' };
  const safe = path.basename(snapshotFilename);
  const src = path.join(dir, safe);
  if (!existsSync(src)) return { ok: false, error: 'snapshot not found' };
  if (!sourceFile) return { ok: false, error: 'missing sourceFile' };
  try {
    // Snapshot the *current* contents first so the restore itself is reversible.
    snapshotWorkflow(id, sourceFile);
    const content = readFileSync(src, 'utf-8');
    writeFileSync(sourceFile, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function pruneOldSnapshots(dir: string): void {
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.md')); }
  catch { return; }
  if (files.length <= MAX_PER_WORKFLOW) return;
  const sorted = files.sort();   // ISO timestamps sort naturally
  const overflow = sorted.length - MAX_PER_WORKFLOW;
  for (let i = 0; i < overflow; i++) {
    try { unlinkSync(path.join(dir, sorted[i])); } catch { /* */ }
  }
}

function entryFromFile(id: string, dir: string, filename: string): SnapshotEntry | null {
  try {
    const full = path.join(dir, filename);
    const stat = statSync(full);
    const ts = filename.replace(/\.md$/, '').replace(/-/g, ':').replace(/^(\d{4}):(\d{2}):(\d{2})T/, '$1-$2-$3T').replace(/T(\d{2}):(\d{2}):(\d{2}):(\d{3})Z?$/, 'T$1:$2:$3.$4Z');
    let preview = '';
    try {
      const head = readFileSync(full, 'utf-8').slice(0, 240);
      preview = head.replace(/\n/g, ' ').slice(0, 120);
    } catch { /* */ }
    return {
      id,
      filename,
      ts,
      size: stat.size,
      preview,
    };
  } catch {
    return null;
  }
}
