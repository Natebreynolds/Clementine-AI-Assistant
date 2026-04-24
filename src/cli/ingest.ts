/**
 * Clementine CLI — `ingest` subcommand.
 *
 * Secondary entry point to the brain. Dashboard is primary; this is for
 * power users, cron scripts, and automation.
 *
 *   clementine ingest seed <path> --slug <name>  (bulk one-shot import)
 *   clementine ingest run <slug>                 (re-run a registered source)
 *   clementine ingest list                       (list all sources)
 *   clementine ingest status <slug>              (recent runs for a source)
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { runIngestion } from '../brain/ingestion-pipeline.js';
import { detectManifest } from '../brain/format-detector.js';
import { runSource, getSource, listSources, upsertSource } from '../brain/source-registry.js';
import { getStore } from '../tools/shared.js';

export async function cmdIngestSeed(inputPath: string, opts: { slug?: string; intelligence?: 'auto' | 'template-only' | 'llm-per-record' }): Promise<void> {
  const abs = path.resolve(inputPath);
  if (!existsSync(abs)) {
    console.error(`Path not found: ${abs}`);
    process.exit(1);
  }

  const slug = opts.slug ?? deriveSlug(abs);
  const manifest = detectManifest(abs);
  const supported = Object.entries(manifest.formats).filter(([f]) => f !== 'unknown');
  const total = supported.reduce((acc, [, n]) => acc + (n ?? 0), 0);

  console.log(`\nSeeding source "${slug}" from ${abs}`);
  console.log(`Detected: ${manifest.totalFiles} file(s), ${formatBytes(manifest.totalBytes)}`);
  for (const [fmt, count] of Object.entries(manifest.formats)) {
    console.log(`  • ${fmt}: ${count}`);
  }
  if (total === 0) {
    console.error('\nNo supported files found. Aborting.');
    process.exit(1);
  }

  // Register (or refresh) the source so re-runs work later
  await upsertSource({
    slug,
    kind: 'seed',
    adapter: 'csv', // representative — the pipeline dispatches per-file via detectManifest
    configJson: JSON.stringify({ inputPath: abs }),
    targetFolder: `04-Ingest/${slug}`,
    intelligence: opts.intelligence ?? 'auto',
    enabled: true,
  });
  const source = await getSource(slug);
  if (!source) {
    console.error(`Failed to register source ${slug}`);
    process.exit(1);
  }

  console.log('\nRunning ingestion…');
  const result = await runIngestion({
    source,
    inputPath: abs,
    onProgress: (p) => {
      process.stdout.write(`\r  stage=${p.stage} in=${p.recordsIn} written=${p.recordsWritten} skipped=${p.recordsSkipped} failed=${p.recordsFailed}   `);
    },
  });
  process.stdout.write('\n');

  console.log(`\nDone.`);
  console.log(`  Records in:      ${result.recordsIn}`);
  console.log(`  Records written: ${result.recordsWritten}`);
  console.log(`  Records skipped: ${result.recordsSkipped}`);
  console.log(`  Records failed:  ${result.recordsFailed}`);
  if (result.overviewNotePath) {
    console.log(`  Overview note:   ${result.overviewNotePath}`);
  }
  if (result.errors.length) {
    console.log(`\nErrors (first 5):`);
    for (const e of result.errors.slice(0, 5)) {
      console.log(`  • ${e.externalId ?? ''}: ${e.error}`);
    }
  }
}

export async function cmdIngestRun(slug: string): Promise<void> {
  const source = await getSource(slug);
  if (!source) {
    console.error(`Source not found: ${slug}`);
    process.exit(1);
  }

  let inputPath: string | undefined;
  try {
    const cfg = JSON.parse(source.configJson ?? '{}');
    if (cfg.inputPath) inputPath = cfg.inputPath;
  } catch { /* ignore */ }

  console.log(`Re-running source "${slug}" (kind=${source.kind})…`);
  const result = await runSource(slug, {
    inputPath,
    onProgress: (p) => {
      process.stdout.write(`\r  stage=${p.stage} in=${p.recordsIn} written=${p.recordsWritten} skipped=${p.recordsSkipped} failed=${p.recordsFailed}   `);
    },
  });
  process.stdout.write('\n');
  console.log(`  written=${result.recordsWritten} skipped=${result.recordsSkipped} failed=${result.recordsFailed}`);
  if (result.overviewNotePath) {
    console.log(`  overview: ${result.overviewNotePath}`);
  }
}

export async function cmdIngestList(): Promise<void> {
  const sources = await listSources();
  if (sources.length === 0) {
    console.log('No sources registered yet.');
    console.log('Add one with: clementine ingest seed <path> --slug <name>');
    return;
  }
  console.log(`\n${sources.length} source(s):\n`);
  for (const s of sources) {
    const status = s.enabled ? 'enabled' : 'disabled';
    const last = s.lastRunAt ? `last=${s.lastRunAt} (${s.lastStatus ?? '?'})` : 'never run';
    console.log(`  • ${s.slug}  [${s.kind}/${s.adapter}]  ${status}  ${last}`);
  }
}

export async function cmdIngestStatus(slug: string): Promise<void> {
  const source = await getSource(slug);
  if (!source) {
    console.error(`Source not found: ${slug}`);
    process.exit(1);
  }
  const store = await getStore();
  const runs = store.listIngestionRuns(slug, 10);
  console.log(`\nSource: ${slug}  (${source.kind}/${source.adapter})`);
  console.log(`Enabled: ${source.enabled}`);
  console.log(`Target:  ${source.targetFolder ?? '(default)'}`);
  if (runs.length === 0) {
    console.log('\nNo runs yet.');
    return;
  }
  console.log(`\nRecent runs (${runs.length}):\n`);
  for (const r of runs) {
    console.log(`  #${r.id}  ${r.startedAt}  ${r.status.padEnd(8)}  in=${r.recordsIn} written=${r.recordsWritten} skipped=${r.recordsSkipped} failed=${r.recordsFailed}`);
    if (r.overviewNotePath) console.log(`         overview: ${r.overviewNotePath}`);
  }
}

function deriveSlug(abs: string): string {
  const base = path.basename(abs, path.extname(abs));
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'seed';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
