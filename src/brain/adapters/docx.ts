/**
 * Clementine — DOCX adapter.
 *
 * Yields a single RawRecord per document (converted to plain text via
 * mammoth). The downstream pipeline re-chunks long bodies before
 * distillation, so we don't need to split here.
 */

import path from 'node:path';
import mammoth from 'mammoth';
import type { RawRecord } from '../../types.js';
import { contentHash } from './common.js';

export async function* parseDocx(filePath: string): AsyncIterable<RawRecord> {
  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch {
    return;
  }

  const body = (result.value ?? '').trim();
  if (!body) return;

  const hint = path.basename(filePath, path.extname(filePath));

  yield {
    externalId: `docx-${hint}-${contentHash(body)}`,
    content: body,
    rawPayload: body,
    metadata: {
      adapter: 'docx',
      source_file: filePath,
      content_hash: contentHash(body),
      warnings: (result.messages ?? []).map((m) => m.message),
    },
  };
}
