/**
 * Clementine — Ingestion pipeline.
 *
 * Shared flow for every ingestion entry point (CLI seed, scheduled poll,
 * webhook push). Feeds the existing memory + graph system — it does not
 * replace it.
 *
 *   adapter → (pre-chunk) → intelligence → dedupe → artifact(raw)
 *     → vault note → store.updateFile (chunks, FTS, wikilinks)
 *     → tag provenance → ingested_rows (structured overlay)
 *     → graph extractor → ingestion_runs audit
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VAULT_DIR } from '../config.js';
import { getStore } from '../tools/shared.js';
import type {
  IngestedRecord,
  IngestionProgress,
  RawRecord,
  Source,
} from '../types.js';
import { detectFormat, detectManifest } from './format-detector.js';
import { adapterFor } from './adapters/index.js';
import {
  applyTemplate,
  chunkContent,
  classifyRecord,
  combineDistillations,
  distillChunk,
  inferSchema,
  sanitizeFolder,
  type SchemaMapping,
} from './intelligence.js';
import { writeGraphForRecord } from './graph-extractor.js';
import { generateBatchOverview } from './batch-summary.js';

export type ProgressCallback = (progress: IngestionProgress) => void;

export interface IngestOptions {
  source: Source;
  /** For seed mode: local file/folder path. For poll/webhook: unused. */
  inputPath?: string;
  /** For poll/webhook: pre-yielded raw records to ingest. */
  records?: AsyncIterable<RawRecord>;
  /** Dry-run: distill but do not write to vault/graph. Returns planned records. */
  dryRun?: boolean;
  /** Cap the run at N records (useful for dashboard preview). */
  limit?: number;
  /** Progress callback for SSE / dashboard streaming. */
  onProgress?: ProgressCallback;
}

export interface IngestResult {
  runId: number | null;
  recordsIn: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  errors: Array<{ externalId?: string; error: string }>;
  plannedRecords?: IngestedRecord[];  // dry-run only
  overviewNotePath?: string | null;
}

/**
 * Drive one ingestion run. Entry points all call here.
 */
export async function runIngestion(opts: IngestOptions): Promise<IngestResult> {
  const { source } = opts;
  const store = await getStore();
  const runId = opts.dryRun ? null : store.createIngestionRun(source.slug);
  const errors: Array<{ externalId?: string; error: string }> = [];
  const plannedRecords: IngestedRecord[] = [];
  const writtenSummaries: Array<{ title: string; summary: string; tags: string[]; externalId: string }> = [];

  let recordsIn = 0;
  let recordsWritten = 0;
  let recordsSkipped = 0;
  let recordsFailed = 0;

  const report = (stage: IngestionProgress['stage'], message?: string) => {
    opts.onProgress?.({
      runId: runId ?? -1,
      sourceSlug: source.slug,
      stage,
      recordsIn,
      recordsWritten,
      recordsSkipped,
      recordsFailed,
      message,
    });
  };

  // Shared per-record bookkeeping factory (declared before use to keep hoisting
  // behavior explicit — previously relied on function-declaration hoisting).
  const counters = (): Counters => ({
    onWrite: (sum) => {
      recordsWritten += 1;
      if (sum) writtenSummaries.push(sum);
    },
    onSkip: () => { recordsSkipped += 1; },
    onFail: (err) => { recordsFailed += 1; errors.push(err); },
  });

  try {
    report('detecting');

    // Collect raw records from either input path or pre-yielded iterator
    const recordIterators: Array<AsyncIterable<RawRecord>> = [];
    if (opts.records) recordIterators.push(opts.records);
    if (opts.inputPath) {
      for await (const it of iterateFromPath(opts.inputPath)) {
        recordIterators.push(it);
      }
    }

    report('parsing');

    // Buffer first 5 records for schema inference on structured sources
    const SAMPLE_SIZE = 5;
    const intelligenceMode = (source.intelligence ?? 'auto') as 'auto' | 'template-only' | 'llm-per-record';
    let schemaMapping: SchemaMapping | null = null;
    const samples: RawRecord[] = [];
    const pendingStructured: RawRecord[] = [];

    for (const iter of recordIterators) {
      for await (const record of iter) {
        recordsIn += 1;
        if (opts.limit && recordsIn > opts.limit) break;

        const flowPath = classifyRecord(record, intelligenceMode);
        if (flowPath === 'structured') {
          if (!schemaMapping && samples.length < SAMPLE_SIZE) {
            samples.push(record);
            pendingStructured.push(record);
            continue;
          }
          if (!schemaMapping && samples.length >= SAMPLE_SIZE) {
            schemaMapping = await inferSchema(samples, source.slug);
            await applyStructuredColumns(schemaMapping);
            for (const s of pendingStructured) {
              await processStructured(s, schemaMapping, source, opts, store, report, plannedRecords, errors, writtenSummaries, counters());
            }
            pendingStructured.length = 0;
          }
          if (schemaMapping) {
            await processStructured(record, schemaMapping, source, opts, store, report, plannedRecords, errors, writtenSummaries, counters());
          }
        } else {
          await processFreeForm(record, source, opts, store, report, plannedRecords, errors, writtenSummaries, counters());
        }
      }
    }

    // Flush structured records that never reached the schema-infer threshold
    if (!schemaMapping && samples.length > 0) {
      schemaMapping = await inferSchema(samples, source.slug);
      await applyStructuredColumns(schemaMapping);
      for (const s of samples) {
        await processStructured(s, schemaMapping, source, opts, store, report, plannedRecords, errors, writtenSummaries, counters());
      }
    }

    // Batch overview (skip on dry-run or when nothing was written)
    let overviewNotePath: string | null = null;
    if (!opts.dryRun && recordsWritten > 0) {
      try {
        report('summarizing');
        const overview = await generateBatchOverview({
          source,
          runId,
          recordsIn,
          recordsWritten,
          recordsSkipped,
          recordsFailed,
          summaries: writtenSummaries,
        });
        overviewNotePath = overview.notePath;
      } catch (err) {
        // Non-fatal: a run can succeed without an overview. Prefix so
        // callers can tell these apart from per-record ingestion errors.
        errors.push({
          externalId: '__overview__',
          error: `overview_failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Finalize
    const status: 'ok' | 'partial' | 'error' =
      recordsFailed > 0 && recordsWritten === 0 ? 'error' :
      recordsFailed > 0 ? 'partial' : 'ok';

    if (runId !== null) {
      store.updateIngestionRun(runId, {
        recordsIn, recordsWritten, recordsSkipped, recordsFailed,
        errorsJson: errors.length ? JSON.stringify(errors.slice(0, 50)) : null,
        overviewNotePath,
        status,
        finished: true,
      });
      store.markSourceRun(source.slug, status);
    }

    report('done');

    return {
      runId,
      recordsIn,
      recordsWritten,
      recordsSkipped,
      recordsFailed,
      errors,
      plannedRecords: opts.dryRun ? plannedRecords : undefined,
      overviewNotePath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ error: msg });
    if (runId !== null) {
      store.updateIngestionRun(runId, {
        recordsIn, recordsWritten, recordsSkipped, recordsFailed: recordsFailed + 1,
        errorsJson: JSON.stringify(errors),
        status: 'error',
        finished: true,
      });
      store.markSourceRun(source.slug, 'error');
    }
    report('error', msg);
    return {
      runId,
      recordsIn,
      recordsWritten,
      recordsSkipped,
      recordsFailed: recordsFailed + 1,
      errors,
      plannedRecords: opts.dryRun ? plannedRecords : undefined,
    };
  }
}

// ── Per-record helpers ──────────────────────────────────────────────

interface Counters {
  onWrite: (summary?: { title: string; summary: string; tags: string[]; externalId: string }) => void;
  onSkip: () => void;
  onFail: (err: { externalId?: string; error: string }) => void;
}

async function processStructured(
  record: RawRecord,
  mapping: SchemaMapping,
  source: Source,
  opts: IngestOptions,
  store: any,
  _report: (stage: IngestionProgress['stage'], msg?: string) => void,
  planned: IngestedRecord[],
  _errors: Array<{ externalId?: string; error: string }>,
  _writtenSummaries: Array<{ title: string; summary: string; tags: string[]; externalId: string }>,
  counters: Counters,
): Promise<void> {
  try {
    // Pass source.targetFolder as the authoritative override so records
    // always land in the folder the user registered (not whatever bucket
    // the schema-infer LLM picked).
    const partial = applyTemplate(record, mapping, source.slug, source.targetFolder ?? null);
    const ingested: IngestedRecord = { ...partial };
    const summaryBundle = { title: ingested.title, summary: ingested.summary, tags: ingested.tags, externalId: ingested.externalId };
    if (opts.dryRun) {
      planned.push(ingested);
      counters.onWrite(summaryBundle);
      return;
    }
    await writeRecord(ingested, source, store);
    counters.onWrite(summaryBundle);
  } catch (err) {
    counters.onFail({ externalId: record.externalId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function processFreeForm(
  record: RawRecord,
  source: Source,
  opts: IngestOptions,
  store: any,
  report: (stage: IngestionProgress['stage'], msg?: string) => void,
  planned: IngestedRecord[],
  _errors: Array<{ externalId?: string; error: string }>,
  _writtenSummaries: Array<{ title: string; summary: string; tags: string[]; externalId: string }>,
  counters: Counters,
): Promise<void> {
  try {
    report('distilling');
    const chunks = chunkContent(record.content, 3000);
    const distillations = [];
    for (const chunk of chunks) {
      distillations.push(await distillChunk(chunk, record.metadata ?? {}));
    }
    const targetFolder = sanitizeFolder(source.targetFolder || `04-Ingest/${source.slug}`, source.slug);
    const partial = combineDistillations(record, distillations, source.slug, targetFolder);
    const ingested: IngestedRecord = { ...partial };
    const summaryBundle = { title: ingested.title, summary: ingested.summary, tags: ingested.tags, externalId: ingested.externalId };
    if (opts.dryRun) {
      planned.push(ingested);
      counters.onWrite(summaryBundle);
      return;
    }
    await writeRecord(ingested, source, store);
    counters.onWrite(summaryBundle);
  } catch (err) {
    counters.onFail({ externalId: record.externalId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Persist one fully-distilled record: artifact → vault note → chunks/FTS →
 * provenance tags → ingested_rows overlay → graph.
 */
async function writeRecord(record: IngestedRecord, source: Source, store: any): Promise<void> {
  const nowIso = new Date().toISOString();
  const sourceType: string = source.kind; // 'seed' | 'poll' | 'webhook'

  // Project tagging: sources linked to a project propagate that link
  // into every ingested record's frontmatter + tags, so agents bound to
  // a project can filter their memory_search results by project tag.
  if (source.project) {
    const projSlug = projectSlugFromPath(source.project);
    record.frontmatter = { ...record.frontmatter, project: source.project, project_slug: projSlug };
    if (!record.tags.some((t) => t === `project:${projSlug}`)) {
      record.tags = [...record.tags, `project:${projSlug}`];
    }
  }

  // 1) Raw payload → artifact store
  const artifactId = store.storeArtifact({
    toolName: `ingest:${source.slug}`,
    summary: record.title || record.externalId,
    content: record.rawPayload,
    tags: [source.slug, sourceType, ...record.tags].join(','),
    sessionKey: null,
    agentSlug: source.agentSlug ?? null,
  });
  record.artifactId = artifactId;

  // 2) Vault note: write markdown file with frontmatter + body
  const abs = path.join(VAULT_DIR, record.targetRelPath);
  const dir = path.dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fm = { title: record.title, ...record.frontmatter };
  const frontmatterBlock = Object.entries(fm)
    .map(([k, v]) => `${k}: ${serializeYaml(v)}`)
    .join('\n');
  const fileContent = `---\n${frontmatterBlock}\n---\n\n# ${record.title}\n\n${record.body}\n`;
  writeFileSync(abs, fileContent, 'utf-8');

  // 3) Re-index via existing vault pipeline (chunks, FTS, wikilinks)
  store.updateFile(record.targetRelPath, source.agentSlug ?? undefined);

  // 4) Tag provenance on the chunks we just wrote
  store.tagChunksForSource(record.targetRelPath, {
    sourceSlug: record.sourceSlug,
    externalId: record.externalId,
    sourceType,
    lastSyncedAt: nowIso,
  });

  // 5) Structured overlay for SQL aggregates
  if (record.structuredRow) {
    const chunkRef = store.findChunkByExternalId(record.sourceSlug, record.externalId);
    store.insertIngestedRow({
      sourceSlug: record.sourceSlug,
      externalId: record.externalId,
      chunkId: chunkRef?.id ?? null,
      artifactId,
      rowJson: JSON.stringify(record.structuredRow),
      structuredColumns: Object.fromEntries(
        Object.entries(record.structuredRow).map(([k, v]) => [k, coerceCol(v)]),
      ),
    });
  }

  // 6) Graph (best-effort, no-op if graph unavailable)
  await writeGraphForRecord(record);
}

async function applyStructuredColumns(mapping: SchemaMapping): Promise<void> {
  const store = await getStore();
  for (const col of mapping.structuredColumns) {
    store.ensureIngestedRowColumn(col.name, col.type);
  }
}

async function* iterateFromPath(inputPath: string): AsyncIterable<AsyncIterable<RawRecord>> {
  const manifest = detectManifest(inputPath);
  for (const entry of manifest.files) {
    const adapter = adapterFor(entry.format);
    if (!adapter) continue;
    yield adapter(entry.path);
  }
}

function serializeYaml(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) return `[${val.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (typeof val === 'object') return JSON.stringify(val);
  const str = String(val);
  if (/[\n:#&*{}[\],|>!%@`]/.test(str) || /^\s|\s$/.test(str)) return JSON.stringify(str);
  return str;
}

/** Derive a short tag-friendly slug from a project path. */
function projectSlugFromPath(projectPath: string): string {
  const base = projectPath.split('/').filter(Boolean).pop() ?? projectPath;
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function coerceCol(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return String(v);
}

// ── Format detection entry points (exported for dashboard/CLI previews) ──

export { detectFormat, detectManifest };
