/**
 * Clementine TypeScript — Brain MCP tools.
 *
 * Tools the agent uses to feed the brain's ingestion pipeline from cron jobs.
 * Primarily used by Connector Feeds (src/brain/connector-recipes.ts) — each
 * feed's cron prompt ends with a brain_ingest_folder call that sends fetched
 * records into the distillation pipeline. The pipeline writes distilled notes
 * to 04-Ingest/<slug>/ and indexes them for recall.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RawRecord } from '../types.js';
import { fallbackExternalId } from '../brain/adapters/common.js';
import { logger, textResult } from './shared.js';

function formatFrontmatter(record: IngestRecordInput, slug: string, fetchedAt: string): string {
  const frontmatter: Record<string, unknown> = {
    source: slug,
    externalId: record.externalId,
    title: record.title,
    fetchedAt,
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

function sanitizeSlug(slug: string): string {
  return String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

export interface IngestRecordInput {
  title: string;
  externalId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface BrainIngestFolderResult {
  slug: string;
  acceptedCount: number;
  skippedEmpty: number;
  pipeline: {
    recordsIn: number;
    recordsWritten: number;
    recordsSkipped: number;
    recordsFailed: number;
    errors: Array<{ externalId?: string; error: string }>;
  };
  message: string;
}

function toRawRecords(records: IngestRecordInput[], slug: string): { rawRecords: RawRecord[]; skippedEmpty: number } {
  const fetchedAt = new Date().toISOString();
  const rawRecords: RawRecord[] = [];
  let skippedEmpty = 0;

  for (const [index, record] of records.entries()) {
    const content = String(record.content ?? '').trim();
    if (!content) {
      skippedEmpty += 1;
      continue;
    }

    const title = String(record.title || record.externalId || `Record ${index + 1}`).trim();
    const externalId = String(record.externalId || '').trim()
      || fallbackExternalId(`${slug}-record`, index + 1, content);
    const normalized: IngestRecordInput = {
      title,
      externalId,
      content,
      metadata: record.metadata,
    };

    rawRecords.push({
      externalId,
      content,
      rawPayload: formatFrontmatter(normalized, slug, fetchedAt) + content,
      metadata: {
        ...(record.metadata ?? {}),
        adapter: 'connector-feed',
        source: slug,
        externalId,
        title,
        fetchedAt,
      },
    });
  }

  return { rawRecords, skippedEmpty };
}

async function* iterateRecords(records: RawRecord[]): AsyncIterable<RawRecord> {
  for (const record of records) yield record;
}

export async function ingestBrainRecords(slug: string, records: IngestRecordInput[]): Promise<BrainIngestFolderResult> {
  const safeSlug = sanitizeSlug(slug);
  if (!safeSlug) throw new Error('slug is required');
  if (!Array.isArray(records) || records.length === 0) throw new Error(`no records to ingest for slug "${safeSlug}"`);

  const { rawRecords, skippedEmpty } = toRawRecords(records, safeSlug);
  if (rawRecords.length === 0) throw new Error(`no non-empty records to ingest for slug "${safeSlug}"`);

  const { upsertSource, getSource } = await import('../brain/source-registry.js');
  const { runIngestion } = await import('../brain/ingestion-pipeline.js');

  await upsertSource({
    slug: safeSlug,
    kind: 'seed',
    adapter: 'markdown',
    configJson: JSON.stringify({ managed: 'connector-feed', mode: 'direct-records' }),
    targetFolder: `04-Ingest/${safeSlug}`,
    intelligence: 'auto',
    enabled: true,
  });
  const source = await getSource(safeSlug);
  if (!source) throw new Error('failed to register source');

  const result = await runIngestion({ source, records: iterateRecords(rawRecords) });
  let ingestionSummary =
    `Pipeline: ${result.recordsIn} in · ${result.recordsWritten} written · ${result.recordsSkipped} skipped · ${result.recordsFailed} failed`;
  if (result.errors?.length) {
    ingestionSummary += ` (first error: ${result.errors[0].error.slice(0, 100)})`;
  }

  const message =
    `Ingested into slug "${safeSlug}": ${rawRecords.length} accepted record(s), ${skippedEmpty} empty skipped. ${ingestionSummary}`;
  logger.info(
    { slug: safeSlug, acceptedCount: rawRecords.length, skippedEmpty, recordCount: records.length },
    'brain_ingest_folder complete',
  );

  return {
    slug: safeSlug,
    acceptedCount: rawRecords.length,
    skippedEmpty,
    pipeline: {
      recordsIn: result.recordsIn,
      recordsWritten: result.recordsWritten,
      recordsSkipped: result.recordsSkipped,
      recordsFailed: result.recordsFailed,
      errors: result.errors,
    },
    message,
  };
}

export function registerBrainTools(server: McpServer): void {
  server.tool(
    'brain_ingest_folder',
    'Ingest a batch of records into the brain under a named slug. Sends records directly into the distillation pipeline (chunking, LLM summarization, vault note write, memory indexing, knowledge graph write). Use at the end of Connector Feed cron jobs. Safe to re-run — records with the same externalId update the same distilled note.',
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

      try {
        const result = await ingestBrainRecords(safeSlug, records);
        return textResult(result.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, slug: safeSlug }, 'brain_ingest_folder: ingestion pipeline failed');
        return textResult(`brain_ingest_folder: ingestion failed for slug "${safeSlug}": ${msg}`);
      }
    },
  );
}
