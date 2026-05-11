/**
 * Shared local seed ingestion helpers.
 *
 * Dashboard Seed, CLI/chat MCP tools, and future local-data entry points should
 * all resolve paths and register seed sources the same way.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetectedManifest, Source } from '../types.js';
import { detectManifest } from './format-detector.js';
import { runIngestion, type IngestResult, type ProgressCallback } from './ingestion-pipeline.js';
import { getSource, upsertSource } from './source-registry.js';

function sanitizeSlug(slug: string): string {
  return String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function deriveLocalSeedSlug(inputPath: string): string {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
  return sanitizeSlug(base) || 'local-seed';
}

export function resolveLocalSeedPath(inputPath: string): string {
  const raw = String(inputPath ?? '').trim();
  if (!raw) throw new Error('inputPath is required');
  const resolved = path.resolve(expandHome(raw));
  if (!existsSync(resolved)) throw new Error(`inputPath does not exist: ${resolved}`);
  const real = realpathSync(resolved);
  const blockedRoots = ['/etc', '/System', '/private/etc', '/dev', '/bin', '/sbin', '/usr/bin', '/usr/sbin'];
  if (real === '/' || blockedRoots.some(root => real === root || real.startsWith(root + path.sep))) {
    throw new Error(`refusing to ingest protected system path: ${real}`);
  }
  const stat = statSync(real);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`inputPath must be a file or directory: ${real}`);
  }
  return real;
}

export function buildLocalSeedSource(slug: string, inputPath: string): Source {
  const now = new Date().toISOString();
  return {
    slug,
    kind: 'seed',
    adapter: 'csv',
    configJson: JSON.stringify({ inputPath, mode: 'local-path' }),
    credentialRef: null,
    scheduleCron: null,
    targetFolder: `04-Ingest/${slug}`,
    agentSlug: null,
    intelligence: 'auto',
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function registerLocalSeedSource(slug: string, inputPath: string): Promise<Source> {
  await upsertSource({
    slug,
    kind: 'seed',
    adapter: 'csv',
    configJson: JSON.stringify({ inputPath, mode: 'local-path' }),
    targetFolder: `04-Ingest/${slug}`,
    intelligence: 'auto',
    enabled: true,
  });
  const source = await getSource(slug);
  if (!source) throw new Error('failed to register source');
  return source;
}

export interface LocalSeedIngestionOptions {
  slug?: string;
  inputPath: string;
  dryRun?: boolean;
  limit?: number;
  onManifest?: (info: { slug: string; inputPath: string; manifest: DetectedManifest }) => void;
  onProgress?: ProgressCallback;
}

export interface LocalSeedIngestionResult {
  slug: string;
  inputPath: string;
  manifest: DetectedManifest;
  result: IngestResult;
}

export async function runLocalSeedIngestion(opts: LocalSeedIngestionOptions): Promise<LocalSeedIngestionResult> {
  const inputPath = resolveLocalSeedPath(opts.inputPath);
  const slug = sanitizeSlug(opts.slug || deriveLocalSeedSlug(inputPath));
  if (!slug) throw new Error('slug is required');
  const manifest = detectManifest(inputPath);
  if (manifest.totalFiles === 0) {
    throw new Error('no supported local files found to ingest');
  }
  opts.onManifest?.({ slug, inputPath, manifest });

  const source = opts.dryRun
    ? buildLocalSeedSource(slug, inputPath)
    : await registerLocalSeedSource(slug, inputPath);

  const result = await runIngestion({
    source,
    inputPath,
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  return { slug, inputPath, manifest, result };
}
