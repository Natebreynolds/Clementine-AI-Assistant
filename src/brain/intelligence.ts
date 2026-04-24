/**
 * Clementine — Tiered intelligence for ingestion.
 *
 * Two paths:
 *   • Structured (CSV/JSON/JSONL) — ONE schema-infer LLM call amortized
 *     across all rows, then deterministic templating per row. Cheap + fast.
 *   • Free-form (PDF/email/DOCX/markdown) — per-chunk Haiku distillation.
 *     The chunker splits input to stay under the token budget before every
 *     call, so single-document size does not affect per-call cost.
 */

import { splitAtParagraphs } from '../memory/chunker.js';
import type { IngestedRecord, RawRecord } from '../types.js';
import { callLLM, parseJsonResponse, truncateToTokens } from './llm-client.js';
import { contentHash } from './adapters/common.js';

// ── Schema inference (structured sources) ────────────────────────────

export interface SchemaMapping {
  titleTemplate: string;           // "{{name}} — {{company}}"
  summaryTemplate: string;
  tagTemplates: string[];
  frontmatterKeys: string[];       // which record fields to mirror in FM
  structuredColumns: Array<{ name: string; type: 'TEXT' | 'REAL' | 'INTEGER' }>;
  targetFolder: string;            // e.g. "04-Ingest/stripe-customers"
  entityHints: string[];           // field names that represent entities to link as wikilinks
}

const SCHEMA_INFER_SYSTEM = `You are a data-schema analyst. Given a few sample records from a structured dataset, you design how each record should be summarized and stored in a personal knowledge base.

Output a JSON object with these fields:
- title_template: a Handlebars-like string that produces a short note title from record fields, e.g. "{{name}} ({{company}})"
- summary_template: one or two sentence string summarizing a row
- tag_templates: array of tag strings (may include {{field}} placeholders)
- frontmatter_keys: array of record field names to mirror into note frontmatter
- structured_columns: array of { name, type } where type is "TEXT" | "REAL" | "INTEGER"; pick 3-10 columns that would support useful aggregate queries (amounts, dates, statuses, counts, ids)
- target_folder: short vault folder name like "04-Customers" or "04-Deals"
- entity_hints: array of field names (person/company/product names) that should become [[wikilinks]] in the note body`;

export async function inferSchema(
  samples: RawRecord[],
  sourceSlug: string,
): Promise<SchemaMapping> {
  const sample = samples
    .slice(0, 5)
    .map((r) => r.metadata?.structured ?? r.rawPayload)
    .slice(0, 5);

  const prompt = `Source slug: ${sourceSlug}
Sample records (first ${sample.length}):
${JSON.stringify(sample, null, 2)}

Design the schema mapping for this source.`;

  const raw = await callLLM(prompt, {
    system: SCHEMA_INFER_SYSTEM,
    format: 'json',
    maxTokens: 1024,
  });
  const parsed = parseJsonResponse<any>(raw);

  return {
    titleTemplate: parsed?.title_template ?? '{{__id}}',
    summaryTemplate: parsed?.summary_template ?? '',
    tagTemplates: Array.isArray(parsed?.tag_templates) ? parsed.tag_templates : [],
    frontmatterKeys: Array.isArray(parsed?.frontmatter_keys) ? parsed.frontmatter_keys : [],
    structuredColumns: Array.isArray(parsed?.structured_columns)
      ? parsed.structured_columns
          .filter((c: any) => c && typeof c.name === 'string' && /^[a-z][a-z0-9_]*$/i.test(c.name))
          .map((c: any) => ({
            name: c.name,
            type: c.type === 'REAL' || c.type === 'INTEGER' ? c.type : 'TEXT',
          }))
      : [],
    targetFolder: typeof parsed?.target_folder === 'string' ? parsed.target_folder : `04-Ingest/${sourceSlug}`,
    entityHints: Array.isArray(parsed?.entity_hints) ? parsed.entity_hints : [],
  };
}

/** Render a Handlebars-ish `{{key}}` template against a record. */
export function renderTemplate(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const val = readPath(record, key);
    return val === undefined || val === null ? '' : String(val);
  }).trim();
}

function readPath(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Apply a schema mapping to a single structured record (no LLM call).
 *
 * `targetFolderOverride` (when set) wins over the mapping's folder — that
 * lets the registered source's `target_folder` stay authoritative so a
 * user who seeds slug "customers" always finds records under their own
 * folder instead of whichever semantic bucket the LLM inferred.
 */
export function applyTemplate(
  record: RawRecord,
  mapping: SchemaMapping,
  sourceSlug: string,
  targetFolderOverride?: string | null,
): Omit<IngestedRecord, 'artifactId'> {
  const structured = (record.metadata?.structured as Record<string, unknown>) ?? {};
  const title = renderTemplate(mapping.titleTemplate, structured) || record.externalId || 'Untitled';
  const summary = renderTemplate(mapping.summaryTemplate, structured);
  const tags = mapping.tagTemplates.map((t) => renderTemplate(t, structured)).filter(Boolean);

  const frontmatter: Record<string, unknown> = {
    source: sourceSlug,
    external_id: record.externalId,
    ingested_at: new Date().toISOString(),
  };
  for (const key of mapping.frontmatterKeys) {
    if (key in structured) frontmatter[key] = structured[key];
  }
  if (tags.length) frontmatter.tags = tags;

  // Body: summary paragraph, readable field list, optional wikilinks for entity hints
  const wikilinks = mapping.entityHints
    .map((field) => structured[field])
    .filter((v) => v !== undefined && v !== null && String(v).trim())
    .map((v) => `[[${String(v).trim()}]]`);

  const body = [
    summary || title,
    wikilinks.length ? `\nLinks: ${wikilinks.join(' ')}` : '',
    '',
    '## Fields',
    ...Object.entries(structured)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`),
  ].filter(Boolean).join('\n');

  const structuredRow: Record<string, unknown> = {};
  for (const col of mapping.structuredColumns) {
    if (col.name in structured) structuredRow[col.name] = structured[col.name];
  }

  const externalId = record.externalId ?? contentHash(record.rawPayload);
  const safeSlug = externalId.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80);
  const safeFolder = sanitizeFolder(targetFolderOverride || mapping.targetFolder, sourceSlug);
  const targetRelPath = `${safeFolder}/${safeSlug}.md`;

  return {
    sourceSlug,
    externalId,
    title,
    summary,
    body,
    frontmatter,
    tags,
    targetRelPath,
    rawPayload: record.rawPayload,
    structuredRow: Object.keys(structuredRow).length ? structuredRow : undefined,
  };
}

// ── Free-form distillation (per-chunk LLM) ───────────────────────────

const DISTILL_SYSTEM = `You are a knowledge-base curator. Given a chunk of free-form text (from a PDF page, email, Word doc, or markdown note) plus any provided metadata, return a JSON object:
- title: short title for this chunk (≤ 80 chars)
- summary: 1-3 sentence distillation capturing the key facts/decisions
- tags: array of 2-6 short topical tags (lowercase, kebab-case)
- entities: array of { label, id } where label is the type ("Person", "Company", "Place", "Project", "Amount", "Date") and id is the canonical name — these will become [[wikilinks]]
- relationships: array of { from, rel, to, context? } describing typed facts like {"from":"Acme Corp","rel":"PAID","to":"$50k","context":"2026-03-15"}
Keep it concise. Omit tags/entities/relationships if nothing meaningful is present — prefer empty arrays over hallucination.`;

export interface DistilledChunk {
  title: string;
  summary: string;
  tags: string[];
  entities: Array<{ label: string; id: string }>;
  relationships: Array<{ from: string; rel: string; to: string; context?: string }>;
}

/** Pre-chunk a free-form document to keep every LLM call under budget. */
export function chunkContent(text: string, maxChars = 3000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  return splitAtParagraphs(trimmed, maxChars);
}

/** Run one Haiku distillation call on a chunk. Input is truncated to 4k tokens. */
export async function distillChunk(
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<DistilledChunk> {
  const { text, truncated } = truncateToTokens(content, 4000);

  const prompt = `Metadata: ${JSON.stringify(metadata)}
${truncated ? '(Note: content was truncated to fit token budget)\n' : ''}
Content:
${text}`;

  const raw = await callLLM(prompt, {
    system: DISTILL_SYSTEM,
    format: 'json',
    maxTokens: 800,
  });
  const parsed = parseJsonResponse<any>(raw);

  return {
    title: (parsed?.title ?? '').toString().slice(0, 200) || synthTitle(content),
    summary: (parsed?.summary ?? '').toString(),
    tags: Array.isArray(parsed?.tags) ? parsed.tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
    entities: Array.isArray(parsed?.entities)
      ? parsed.entities
          .filter((e: any) => e && typeof e.label === 'string' && typeof e.id === 'string')
          .map((e: any) => ({ label: e.label, id: e.id }))
      : [],
    relationships: Array.isArray(parsed?.relationships)
      ? parsed.relationships
          .filter((r: any) => r && typeof r.from === 'string' && typeof r.rel === 'string' && typeof r.to === 'string')
          .map((r: any) => ({ from: r.from, rel: r.rel, to: r.to, context: r.context }))
      : [],
  };
}

/** Fallback title: first line ≤ 80 chars. */
function synthTitle(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Untitled';
  return firstLine.slice(0, 80);
}

/** Combine many chunk distillations into a single IngestedRecord for one free-form document. */
export function combineDistillations(
  record: RawRecord,
  distilled: DistilledChunk[],
  sourceSlug: string,
  targetFolder: string,
): Omit<IngestedRecord, 'artifactId'> {
  const title = distilled[0]?.title || synthTitle(record.content);
  const summaries = distilled.map((d) => d.summary).filter(Boolean);
  const tags = Array.from(new Set(distilled.flatMap((d) => d.tags))).slice(0, 12);
  const entities = dedupeEntities(distilled.flatMap((d) => d.entities));
  const relationships = distilled.flatMap((d) => d.relationships);

  const wikilinkLine = entities.length
    ? `\nLinks: ${entities.slice(0, 20).map((e) => `[[${e.id}]]`).join(' ')}`
    : '';

  const body = [
    ...summaries,
    wikilinkLine,
    '',
    '## Source',
    record.content.length > 6000
      ? record.content.slice(0, 6000) + '\n\n…[full payload preserved as artifact]'
      : record.content,
  ].filter(Boolean).join('\n\n');

  const frontmatter: Record<string, unknown> = {
    source: sourceSlug,
    external_id: record.externalId,
    ingested_at: new Date().toISOString(),
  };
  if (tags.length) frontmatter.tags = tags;
  if (record.metadata) {
    for (const k of ['subject', 'from', 'to', 'date', 'page', 'source_file']) {
      if (record.metadata[k] !== undefined) frontmatter[k] = record.metadata[k];
    }
  }

  const safeSlug = (record.externalId ?? contentHash(record.content))
    .replace(/[^a-z0-9_-]+/gi, '-')
    .slice(0, 80);
  const safeFolder = sanitizeFolder(targetFolder, sourceSlug);
  const targetRelPath = `${safeFolder}/${safeSlug}.md`;

  return {
    sourceSlug,
    externalId: record.externalId ?? contentHash(record.content),
    title,
    summary: summaries.join(' ').slice(0, 400),
    body,
    frontmatter,
    tags,
    targetRelPath,
    rawPayload: record.rawPayload,
    graphEntities: entities,
    graphRelationships: relationships.map((r) => ({
      from: r.from, rel: r.rel, to: r.to, context: r.context,
    })),
  };
}

function dedupeEntities(entities: Array<{ label: string; id: string }>): Array<{ label: string; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; id: string }> = [];
  for (const e of entities) {
    const key = `${e.label}::${e.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// ── Vault path safety ────────────────────────────────────────────────

/**
 * Clamp an LLM-generated or user-supplied target folder to a safe,
 * vault-relative path. Strips leading slashes, collapses `..`, rejects
 * absolute-ish inputs, and falls back to `04-Ingest/<sourceSlug>` when
 * the cleaned value is empty or suspicious.
 */
export function sanitizeFolder(folder: string | undefined | null, sourceSlug: string): string {
  const fallback = `04-Ingest/${sourceSlug.replace(/[^a-z0-9_-]+/gi, '-') || 'seed'}`;
  if (!folder) return fallback;
  const parts = folder
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) return fallback;
  const cleaned = parts.map((p) => p.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80)).join('/');
  return cleaned || fallback;
}

// ── Path classifier ──────────────────────────────────────────────────

export type IntelligencePath = 'structured' | 'free-form';

/** Decide which intelligence path to use for a given record, honoring source override. */
export function classifyRecord(
  record: RawRecord,
  sourceIntelligence: 'auto' | 'template-only' | 'llm-per-record',
): IntelligencePath {
  if (sourceIntelligence === 'template-only') return 'structured';
  if (sourceIntelligence === 'llm-per-record') return 'free-form';
  const adapter = (record.metadata?.adapter as string) ?? '';
  if (adapter === 'csv' || adapter === 'json' || adapter === 'jsonl') return 'structured';
  return 'free-form';
}
