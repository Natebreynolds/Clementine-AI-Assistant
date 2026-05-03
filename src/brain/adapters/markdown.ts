/**
 * Clementine — Markdown adapter.
 *
 * Yields one RawRecord per markdown file. The downstream pipeline
 * re-chunks the content via splitAtParagraphs() before distillation, so
 * we don't need to split sections here.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { RawRecord } from '../../types.js';
import { contentHash } from './common.js';

export async function* parseMarkdown(filePath: string): AsyncIterable<RawRecord> {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return; }

  let parsed: matter.GrayMatterFile<string>;
  try { parsed = matter(raw); } catch {
    parsed = { data: {}, content: raw } as matter.GrayMatterFile<string>;
  }

  const hint = path.basename(filePath, path.extname(filePath));
  const body = parsed.content.trim();
  if (!body) return;

  let mtime = '';
  try { mtime = statSync(filePath).mtime.toISOString(); } catch { /* ignore */ }

  const frontmatterExternalId =
    typeof parsed.data?.externalId === 'string' && parsed.data.externalId.trim()
      ? parsed.data.externalId.trim()
      : typeof parsed.data?.external_id === 'string' && parsed.data.external_id.trim()
        ? parsed.data.external_id.trim()
        : null;

  yield {
    externalId: frontmatterExternalId ?? `md-${hint}-${contentHash(body)}`,
    content: body,
    rawPayload: raw,
    metadata: {
      adapter: 'markdown',
      source_file: filePath,
      frontmatter: parsed.data ?? {},
      mtime,
      content_hash: contentHash(body),
    },
  };
}
