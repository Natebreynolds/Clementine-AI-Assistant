/**
 * Clementine — Batch overview generator.
 *
 * After an ingestion run, produce a discoverable entry-point note
 * summarizing what was just added. Uses a recursive map-reduce pass so
 * the summary stays token-safe regardless of run size.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VAULT_DIR } from '../config.js';
import { getStore } from '../tools/shared.js';
import type { Source } from '../types.js';
import { callLLM, parseJsonResponse } from './llm-client.js';

const GROUP_SIZE = 20;   // records per section-summary pass
const MAX_ITEMS_FOR_PROMPT = 40;

interface OverviewInput {
  source: Source;
  runId: number | null;
  recordsIn: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  summaries: Array<{ title: string; summary: string; tags: string[]; externalId: string }>;
}

export interface OverviewResult {
  notePath: string | null;
  text: string;
}

/** Produce an overview note and write it to the vault. */
export async function generateBatchOverview(input: OverviewInput): Promise<OverviewResult> {
  if (input.summaries.length === 0) {
    return { notePath: null, text: '' };
  }

  const sectionSummaries = await summarizeGroups(input.summaries);
  const finalText = await finalizeSummary(input, sectionSummaries);

  const targetFolder = input.source.targetFolder || `04-Ingest/${input.source.slug}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rel = `${targetFolder.replace(/^\/+/, '')}/_overview-${timestamp}.md`;
  const abs = path.join(VAULT_DIR, rel);
  const dir = path.dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fm = [
    '---',
    `title: "Ingestion overview — ${input.source.slug}"`,
    `source: ${input.source.slug}`,
    `kind: overview`,
    `run_id: ${input.runId ?? 'null'}`,
    `records_in: ${input.recordsIn}`,
    `records_written: ${input.recordsWritten}`,
    `records_skipped: ${input.recordsSkipped}`,
    `records_failed: ${input.recordsFailed}`,
    `generated_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');

  const body = `${fm}# Ingestion overview — ${input.source.slug}\n\n${finalText}\n`;
  writeFileSync(abs, body, 'utf-8');

  // Re-index so the overview is searchable immediately
  try {
    const store = await getStore();
    store.updateFile(rel, input.source.agentSlug ?? undefined);
  } catch { /* best-effort */ }

  return { notePath: rel, text: finalText };
}

async function summarizeGroups(
  items: Array<{ title: string; summary: string; tags: string[]; externalId: string }>,
): Promise<string[]> {
  if (items.length <= GROUP_SIZE) {
    return [await summarizeGroup(items)];
  }
  const groups: typeof items[] = [];
  for (let i = 0; i < items.length; i += GROUP_SIZE) {
    groups.push(items.slice(i, i + GROUP_SIZE));
  }
  const out: string[] = [];
  for (const g of groups) {
    out.push(await summarizeGroup(g));
  }
  return out;
}

async function summarizeGroup(
  items: Array<{ title: string; summary: string; tags: string[]; externalId: string }>,
): Promise<string> {
  const bullets = items.map((i) => {
    const tagBit = i.tags.length ? ` [${i.tags.slice(0, 4).join(', ')}]` : '';
    const sum = i.summary ? ` — ${i.summary.slice(0, 180)}` : '';
    return `- ${i.title}${tagBit}${sum}`;
  }).join('\n');

  const prompt = `These are ${items.length} records that were just ingested. Write a short section-summary (2-4 sentences) describing common themes, entities, date ranges, or patterns you see. Don't list individual records — synthesize.\n\n${bullets}`;
  const raw = await callLLM(prompt, {
    system: 'You are a knowledge-base curator producing concise synthesis paragraphs.',
    maxTokens: 400,
  });
  return raw.trim();
}

async function finalizeSummary(input: OverviewInput, sectionSummaries: string[]): Promise<string> {
  const topTags = topK(input.summaries.flatMap((s) => s.tags), 8);
  const sampleTitles = input.summaries.slice(0, MAX_ITEMS_FOR_PROMPT).map((s) => s.title);

  const prompt = `You just ingested ${input.recordsWritten} records into the knowledge base from source "${input.source.slug}" (kind: ${input.source.kind}, adapter: ${input.source.adapter}).

Counts:
- records_in: ${input.recordsIn}
- records_written: ${input.recordsWritten}
- records_skipped: ${input.recordsSkipped}
- records_failed: ${input.recordsFailed}

Top tags: ${topTags.join(', ') || '(none)'}
Sample titles: ${JSON.stringify(sampleTitles.slice(0, 20))}

Section summaries from grouped batches:
${sectionSummaries.map((s, i) => `### Section ${i + 1}\n${s}`).join('\n\n')}

Write a single "Ingestion Overview" note body in markdown with these sections:
## What was added
## Key themes / entities
## Time/number shape
## Next questions to ask

Keep each section to 2-4 sentences. Use [[wikilinks]] for notable entities. No preamble — start with "## What was added".`;

  const raw = await callLLM(prompt, {
    system: 'You are writing a discoverable entry-point note that will be read later when someone asks "what did we just import?"',
    maxTokens: 1000,
  });

  const trimmed = raw.trim();
  // Light defense: if the model returned JSON by accident, try to extract
  if (trimmed.startsWith('{') || trimmed.startsWith('```')) {
    const parsed = parseJsonResponse<{ text?: string }>(trimmed);
    if (parsed?.text) return parsed.text;
  }
  return trimmed;
}

function topK(items: string[], k: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item) continue;
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([k]) => k);
}
