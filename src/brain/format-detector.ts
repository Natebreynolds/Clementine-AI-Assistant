/**
 * Clementine — Brain format detector.
 *
 * Classifies a file (or walks a folder and classifies each) into one of
 * the v1 ingest formats so the pipeline can dispatch to the right adapter.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DetectedFormat, DetectedManifest } from '../types.js';

const BY_EXTENSION: Record<string, DetectedFormat> = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'markdown',
  '.pdf': 'pdf',
  '.eml': 'email',
  '.mbox': 'email',
  '.msg': 'email',
  '.docx': 'docx',
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.DS_Store']);

/** Classify a single file by extension + content sniffing. */
export function detectFormat(filePath: string): DetectedFormat {
  const ext = path.extname(filePath).toLowerCase();
  const byExt = BY_EXTENSION[ext];

  // JSON vs JSONL disambiguation: extension is ambiguous in practice
  if (byExt === 'json' || (!byExt && ext === '')) {
    const sniff = peekForJsonShape(filePath);
    if (sniff) return sniff;
  }

  if (byExt) return byExt;

  // Content-based fallbacks for extensionless / unknown
  const magic = readMagic(filePath);
  if (magic.startsWith('%PDF-')) return 'pdf';
  if (magic.startsWith('PK\x03\x04')) return 'docx';   // ZIP-based Office
  if (/^(From |Received:|Return-Path:|Delivered-To:)/m.test(magic)) return 'email';

  return 'unknown';
}

/**
 * Walk a file or folder and return a manifest describing what's inside.
 * Files in unsupported formats land under 'unknown' but still show up in
 * the manifest so the dashboard can display them to the user.
 */
export function detectManifest(rootPath: string): DetectedManifest {
  const files: DetectedManifest['files'] = [];
  walk(rootPath, (abs) => {
    const fmt = detectFormat(abs);
    let size = 0;
    try { size = statSync(abs).size; } catch { /* unreadable */ }
    files.push({ path: abs, format: fmt, sizeBytes: size });
  });

  const formats: DetectedManifest['formats'] = {};
  let totalBytes = 0;
  for (const f of files) {
    formats[f.format] = (formats[f.format] ?? 0) + 1;
    totalBytes += f.sizeBytes;
  }

  return { files, totalFiles: files.length, formats, totalBytes };
}

// ── Internals ────────────────────────────────────────────────────────

function peekForJsonShape(filePath: string): DetectedFormat | null {
  let head: string;
  try {
    head = readMagic(filePath, 4096);
  } catch {
    return null;
  }

  const trimmed = head.trim();
  if (!trimmed) return null;

  // JSONL: multiple non-empty lines, each parseable as JSON
  const lines = trimmed.split('\n').filter((l) => l.trim());
  if (lines.length >= 2) {
    let jsonlLikely = 0;
    for (const line of lines.slice(0, 5)) {
      const t = line.trim();
      if (!t.startsWith('{') && !t.startsWith('[')) break;
      try {
        JSON.parse(t);
        jsonlLikely += 1;
      } catch { /* not this line */ }
    }
    if (jsonlLikely >= 2) return 'jsonl';
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return null;
}

function readMagic(filePath: string, bytes = 256): string {
  try {
    const buf = readFileSync(filePath);
    return buf.slice(0, bytes).toString('utf-8');
  } catch {
    return '';
  }
}

function walk(root: string, visit: (filePath: string) => void): void {
  let stat;
  try { stat = statSync(root); } catch { return; }

  if (stat.isFile()) {
    visit(root);
    return;
  }
  if (!stat.isDirectory()) return;

  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }

  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith('.')) continue;
    const abs = path.join(root, name);
    let s;
    try { s = statSync(abs); } catch { continue; }
    if (s.isDirectory()) walk(abs, visit);
    else if (s.isFile()) visit(abs);
  }
}
