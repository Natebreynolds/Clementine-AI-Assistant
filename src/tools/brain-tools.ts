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
import { runLocalSeedIngestion } from '../brain/local-seed.js';

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
  inputPath?: string;
  filesScanned?: number;
  pipeline: {
    recordsIn: number;
    recordsWritten: number;
    recordsSkipped: number;
    recordsFailed: number;
    errors: Array<{ externalId?: string; error: string }>;
  };
  message: string;
}

export async function ingestBrainPath(slug: string | undefined, inputPath: string): Promise<BrainIngestFolderResult> {
  const { slug: safeSlug, inputPath: resolvedPath, manifest, result } = await runLocalSeedIngestion({
    slug,
    inputPath,
  });
  let ingestionSummary =
    `Pipeline: ${result.recordsIn} in · ${result.recordsWritten} written · ${result.recordsSkipped} skipped · ${result.recordsFailed} failed`;
  if (result.errors?.length) {
    ingestionSummary += ` (first error: ${result.errors[0].error.slice(0, 100)})`;
  }

  const message =
    `Ingested local path into slug "${safeSlug}": ${manifest.totalFiles} file(s) scanned, ${manifest.totalBytes} bytes. ${ingestionSummary}`;
  logger.info(
    { slug: safeSlug, inputPath: resolvedPath, filesScanned: manifest.totalFiles },
    'brain_ingest_folder local path complete',
  );

  return {
    slug: safeSlug,
    acceptedCount: result.recordsIn,
    skippedEmpty: 0,
    inputPath: resolvedPath,
    filesScanned: manifest.totalFiles,
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

// ── brain_save — one-shot ingestion from chat ─────────────────────────
//
// 1.18.145 — closes the chat-parity gap on the write side. The user
// can now say "save this article" or "ingest this URL" and the agent
// drives the same pipeline the dashboard's Seed tab uses, no manual
// record assembly required.
//
// Accepts either raw text or a URL. URLs are fetched + reasonably
// extracted (HTML→text via regex strip, JSON/markdown passthrough);
// for richer extraction the user should still use the dashboard's
// adapter pipeline (PDF/DOCX/CSV/etc. — they need parsers we don't
// want to import into every chat session).

const URL_LIKE = /^https?:\/\//i;

function looksLikeUrl(s: string): boolean {
  return URL_LIKE.test(s.trim());
}

async function fetchUrlText(url: string, timeoutMs = 20_000): Promise<{ text: string; title?: string; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Clementine/brain_save (compatible; +https://github.com/Natebreynolds/Clementine-AI-Assistant)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    if (/json/i.test(contentType)) {
      return { text: raw, contentType };
    }
    if (/html/i.test(contentType) || /^\s*<!DOCTYPE|^\s*<html/i.test(raw)) {
      // Crude HTML→text. Good enough for "save this article" — anything
      // fancier (Readability, Mercury) is a dashboard concern.
      const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : undefined;
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      return { text, title, contentType };
    }
    // Plaintext, markdown, etc.
    return { text: raw, contentType };
  } finally {
    clearTimeout(timer);
  }
}

export interface BrainSaveInput {
  /** Either a URL (will be fetched) or raw text content. */
  content: string;
  /** Optional human-readable title. Inferred from <title> tag for HTML URLs. */
  title?: string;
  /** Logical bucket the record belongs to. Default: "chat-saves". */
  slug?: string;
  /** Stable id so repeat saves dedupe. Default: hash of content. */
  externalId?: string;
  /** Free-form tags carried in frontmatter for later filtering/recall. */
  tags?: string[];
}

export async function brainSave(input: BrainSaveInput): Promise<BrainIngestFolderResult & { sourceType: 'url' | 'text' }> {
  const slug = sanitizeSlug(input.slug || 'chat-saves');
  const isUrl = looksLikeUrl(input.content);
  let text = input.content;
  let title = input.title;
  let urlContentType: string | undefined;

  if (isUrl) {
    const fetched = await fetchUrlText(input.content);
    text = fetched.text;
    title = title || fetched.title || input.content;
    urlContentType = fetched.contentType;
  }

  if (!text || !text.trim()) {
    throw new Error('brain_save: content is empty after fetch/extract');
  }

  // Stable id: caller-provided OR URL-as-id OR sha-style hash of text
  const externalId = input.externalId
    || (isUrl ? input.content : fallbackExternalId(slug, 0, text));

  const metadata: Record<string, unknown> = {
    savedFromChat: true,
    sourceType: isUrl ? 'url' : 'text',
  };
  if (isUrl) metadata.url = input.content;
  if (urlContentType) metadata.contentType = urlContentType;
  if (input.tags && input.tags.length) metadata.tags = input.tags;

  const result = await ingestBrainRecords(slug, [{
    title: title || 'Untitled',
    externalId,
    content: text,
    metadata,
  }]);

  return { ...result, sourceType: isUrl ? 'url' : 'text' };
}

export function registerBrainTools(server: McpServer): void {
  server.tool(
    'brain_save',
    'Save a single piece of content (text or URL) to the brain right now. Use when the user says things like "remember this", "save this article", "ingest this URL", "add to memory". Routes through the same distillation pipeline the dashboard\'s Seed tab uses (chunking + LLM summary + vault note + memory index + knowledge graph). For batch ingestion or recurring feeds, see brain_ingest_folder + schedule_skill.',
    {
      content: z.string().describe('Either a URL (fetched + text-extracted) or raw text content.'),
      title: z.string().optional().describe('Optional human-readable title. Inferred from <title> tag for HTML URLs.'),
      slug: z.string().optional().describe('Logical bucket (folder) the record lands in under 04-Ingest/<slug>/. Default: "chat-saves".'),
      externalId: z.string().optional().describe('Stable id so repeat saves dedupe (e.g. URL, message id). Default: hash of content.'),
      tags: z.array(z.string()).optional().describe('Free-form tags persisted in frontmatter for later filtering/recall.'),
    },
    async (input) => {
      try {
        const result = await brainSave(input);
        const where = `04-Ingest/${result.slug}/`;
        return textResult(
          `Saved to brain (${result.sourceType}): "${(input.title || input.content).slice(0, 80)}"\n` +
          `Folder: ${where} · Pipeline: ${result.pipeline.recordsIn} in · ${result.pipeline.recordsWritten} written · ${result.pipeline.recordsSkipped} skipped` +
          (result.pipeline.recordsFailed > 0 ? ` · ${result.pipeline.recordsFailed} failed` : ''),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'brain_save: failed');
        return textResult(`brain_save failed: ${msg}`);
      }
    },
  );

  server.tool(
    'brain_ingest_folder',
    'Ingest local data or a batch of records into the brain under a named slug. For local files/folders, pass inputPath and let Clementine parse CSV, JSON, JSONL, Markdown, PDF, email, DOCX, and text server-side. For connector feeds, pass records directly. Routes through the distillation pipeline (chunking, LLM summary, vault note, memory index, knowledge graph). Safe to re-run — stable records update the same distilled note.',
    {
      slug: z.string().optional().describe('Feed/source slug (matches 04-Ingest/<slug> folder). Lowercase, hyphen-separated. Inferred from inputPath when omitted.'),
      inputPath: z.string().optional().describe('Absolute or ~/ local file/folder path to ingest. Use this when the user says to seed the brain from local data. Do not read and paste the files into records yourself.'),
      records: z.array(z.object({
        title: z.string().describe('Human-readable title for this record.'),
        externalId: z.string().describe('Stable provider id so re-runs dedup (e.g. Gmail message id, Drive file id).'),
        content: z.string().describe('The full text content of the record. Will be chunked and distilled.'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Any key/value fields to preserve in frontmatter (url, modifiedAt, author).'),
      })).optional().describe('Connector/feed records to ingest. Use inputPath instead for local files/folders.'),
    },
    async ({ slug, inputPath, records }) => {
      if (inputPath && Array.isArray(records) && records.length > 0) {
        return textResult('brain_ingest_folder: pass either inputPath or records, not both');
      }

      if (inputPath) {
        try {
          const result = await ingestBrainPath(slug, inputPath);
          return textResult(result.message);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, slug, inputPath }, 'brain_ingest_folder: local path ingestion failed');
          return textResult(`brain_ingest_folder: local path ingestion failed: ${msg}`);
        }
      }

      const safeSlug = sanitizeSlug(slug || '');
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
