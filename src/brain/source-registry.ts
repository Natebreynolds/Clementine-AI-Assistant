/**
 * Clementine — Source registry.
 *
 * Thin wrapper around store CRUD + the canonical `runSource(slug)` entry
 * point used by the scheduler, the dashboard "Run Now" button, and the
 * webhook receiver. Bulk seeding has its own entry (runIngestion with
 * inputPath) because it ingests a local file/folder not tied to a saved
 * source — but a seed can be re-run later via a registered source.
 */

import { getStore } from '../tools/shared.js';
import type { RawRecord, Source } from '../types.js';
import { runIngestion, type IngestOptions, type IngestResult, type ProgressCallback } from './ingestion-pipeline.js';

/** Register or update a source. */
export async function upsertSource(source: Partial<Source> & { slug: string; kind: Source['kind']; adapter: Source['adapter'] }): Promise<void> {
  const store = await getStore();
  store.upsertSource({
    slug: source.slug,
    kind: source.kind,
    adapter: source.adapter,
    configJson: source.configJson ?? '{}',
    credentialRef: source.credentialRef ?? null,
    scheduleCron: source.scheduleCron ?? null,
    targetFolder: source.targetFolder ?? null,
    agentSlug: source.agentSlug ?? null,
    intelligence: source.intelligence ?? 'auto',
    enabled: source.enabled !== false,
  });
}

export async function getSource(slug: string): Promise<Source | null> {
  const store = await getStore();
  const row = store.getSource(slug);
  if (!row) return null;
  return {
    slug: row.slug,
    kind: row.kind as Source['kind'],
    adapter: row.adapter as Source['adapter'],
    configJson: row.configJson,
    credentialRef: row.credentialRef,
    scheduleCron: row.scheduleCron,
    targetFolder: row.targetFolder,
    agentSlug: row.agentSlug,
    intelligence: (row.intelligence as Source['intelligence']) ?? 'auto',
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus as Source['lastStatus'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSources(filter: { enabled?: boolean; kind?: Source['kind'] } = {}): Promise<Source[]> {
  const store = await getStore();
  const rows = (store.listSources(filter) as Array<{
    slug: string; kind: string; adapter: string; configJson: string;
    credentialRef: string | null; scheduleCron: string | null;
    targetFolder: string | null; agentSlug: string | null;
    intelligence: string; enabled: boolean;
    lastRunAt: string | null; lastStatus: string | null;
    createdAt: string; updatedAt: string;
  } | null>).filter((r): r is Exclude<typeof r, null> => r !== null);

  return rows.map((row) => ({
    slug: row.slug,
    kind: row.kind as Source['kind'],
    adapter: row.adapter as Source['adapter'],
    configJson: row.configJson,
    credentialRef: row.credentialRef,
    scheduleCron: row.scheduleCron,
    targetFolder: row.targetFolder,
    agentSlug: row.agentSlug,
    intelligence: (row.intelligence as Source['intelligence']) ?? 'auto',
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus as Source['lastStatus'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function deleteSource(slug: string): Promise<void> {
  const store = await getStore();
  store.deleteSource(slug);
}

/**
 * Run a registered source. Seed sources require an `inputPath`; poll/
 * webhook sources accept a pre-built `records` iterator from their caller
 * (the scheduler's REST adapter or the webhook handler).
 */
export async function runSource(
  slug: string,
  opts: { inputPath?: string; records?: AsyncIterable<RawRecord>; dryRun?: boolean; limit?: number; onProgress?: ProgressCallback } = {},
): Promise<IngestResult> {
  const source = await getSource(slug);
  if (!source) {
    throw new Error(`Source not found: ${slug}`);
  }
  if (!source.enabled && !opts.dryRun) {
    throw new Error(`Source disabled: ${slug}`);
  }

  const ingestOpts: IngestOptions = {
    source,
    inputPath: opts.inputPath,
    records: opts.records,
    dryRun: opts.dryRun,
    limit: opts.limit,
    onProgress: opts.onProgress,
  };
  return runIngestion(ingestOpts);
}
