/**
 * Clementine TypeScript — Brain MCP tools.
 *
 * Tools the agent uses to feed the brain's ingestion pipeline from cron jobs.
 * Primarily used by Connector Feeds (src/brain/connector-recipes.ts) — each
 * feed's cron prompt ends with a brain_ingest_folder call that writes fetched
 * records to 04-Ingest/<slug>/ and runs distillation.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VAULT_DIR, logger, textResult } from './shared.js';

/** Slugify a record title for the filename — URL-safe, short, collision-resistant with externalId. */
function filenameFor(title: string, externalId: string): string {
  const base = String(title || externalId || 'record')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'record';
  const idPart = String(externalId || '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, 16) || 'x';
  return `${base}-${idPart}.md`;
}

function formatFrontmatter(record: IngestRecordInput, slug: string): string {
  const frontmatter: Record<string, unknown> = {
    source: slug,
    externalId: record.externalId,
    title: record.title,
    fetchedAt: new Date().toISOString(),
  };
  if (record.metadata && typeof record.metadata === 'object') {
    for (const [k, v] of Object.entries(record.metadata)) {
      if (v != null) frontmatter[k] = v;
    }
  }
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (typeof v === 'string') {
      // Quote strings containing colons or special chars
      if (/[:#\[\]\n]/.test(v)) lines.push(`${k}: ${JSON.stringify(v)}`);
      else lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

interface IngestRecordInput {
  title: string;
  externalId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export function registerBrainTools(server: McpServer): void {
  server.tool(
    'brain_ingest_folder',
    'Ingest a batch of records into the brain under a named slug. Writes each record as a markdown file in 04-Ingest/<slug>/ with frontmatter, then runs the distillation pipeline (chunking, LLM summarization, vault note write, knowledge graph write). Use at the end of Connector Feed cron jobs. Safe to re-run — existing files with matching content hashes are deduped by the pipeline.',
    {
      slug: z.string().describe('Feed slug (matches 04-Ingest/<slug> folder). Lowercase, hyphen-separated.'),
      records: z.array(z.object({
        title: z.string().describe('Human-readable title for this record.'),
        externalId: z.string().describe('Stable provider id so re-runs dedup (e.g. Gmail message id, Drive file id).'),
        content: z.string().describe('The full text content of the record. Will be chunked and distilled.'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Any key/value fields to preserve in frontmatter (url, modifiedAt, author).'),
      })).describe('The records to ingest.'),
    },
    async ({ slug, records }) => {
      const safeSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
      if (!safeSlug) return textResult('brain_ingest_folder: slug is required');
      if (!Array.isArray(records) || records.length === 0) {
        return textResult(`brain_ingest_folder: no records to ingest for slug "${safeSlug}".`);
      }

      const targetFolder = path.join(VAULT_DIR, '04-Ingest', safeSlug);
      mkdirSync(targetFolder, { recursive: true });

      // Write each record to a markdown file
      let writtenCount = 0;
      let skippedExisting = 0;
      for (const r of records) {
        if (!r.content || !r.content.trim()) continue;
        const fname = filenameFor(r.title, r.externalId);
        const fullPath = path.join(targetFolder, fname);
        const body = formatFrontmatter(r, safeSlug) + r.content;
        // Idempotency: if a file with the same externalId already exists, overwrite
        // (the distillation pipeline does its own content-hash dedup).
        const preExisting = existsSync(fullPath);
        try {
          writeFileSync(fullPath, body, 'utf-8');
          if (preExisting) skippedExisting += 1;
          else writtenCount += 1;
        } catch (err) {
          logger.warn({ err, fullPath }, 'brain_ingest_folder: write failed for one record');
        }
      }

      // Run the distillation pipeline. Use a synthetic seed source so the
      // ingestion framework can classify + distill + write back into the
      // vault & graph with its existing dedup.
      let ingestionSummary = '';
      try {
        const { upsertSource, getSource } = await import('../brain/source-registry.js');
        const { runIngestion } = await import('../brain/ingestion-pipeline.js');

        await upsertSource({
          slug: safeSlug,
          kind: 'seed',
          adapter: 'markdown',
          configJson: JSON.stringify({ inputPath: targetFolder, managed: 'connector-feed' }),
          targetFolder: `04-Ingest/${safeSlug}`,
          intelligence: 'auto',
          enabled: true,
        });
        const source = await getSource(safeSlug);
        if (!source) throw new Error('failed to register source');

        const result = await runIngestion({ source, inputPath: targetFolder });
        ingestionSummary =
          `Pipeline: ${result.recordsIn} in · ${result.recordsWritten} written · ${result.recordsSkipped} skipped · ${result.recordsFailed} failed`;
        if (result.errors?.length) {
          ingestionSummary += ` (first error: ${result.errors[0].error.slice(0, 100)})`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, slug: safeSlug }, 'brain_ingest_folder: ingestion pipeline failed');
        return textResult(`brain_ingest_folder: wrote ${writtenCount} file(s) but ingestion failed: ${msg}`);
      }

      logger.info(
        { slug: safeSlug, writtenCount, skippedExisting, recordCount: records.length },
        'brain_ingest_folder complete',
      );
      return textResult(
        `Ingested into slug "${safeSlug}": ${writtenCount} new file(s), ${skippedExisting} updated in place. ${ingestionSummary}`,
      );
    },
  );
}
