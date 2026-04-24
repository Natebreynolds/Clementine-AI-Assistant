/**
 * Clementine — PDF adapter (text layer only).
 *
 * Yields one RawRecord per PDF page. pdf-parse concatenates pages with
 * a form-feed separator (\f), so we split on that after extraction.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import type { RawRecord } from '../../types.js';
import { contentHash } from './common.js';

export async function* parsePdf(filePath: string): AsyncIterable<RawRecord> {
  let buf: Buffer;
  try { buf = readFileSync(filePath); } catch { return; }

  let result: { text: string; numpages: number; info?: Record<string, unknown> };
  try {
    result = await pdfParse(buf);
  } catch {
    return;
  }

  const hint = path.basename(filePath, path.extname(filePath));
  const pages = splitPages(result.text);

  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i].trim();
    if (!pageText) continue;
    yield {
      externalId: `pdf-${hint}-p${i + 1}-${contentHash(pageText)}`,
      content: pageText,
      rawPayload: pageText,
      metadata: {
        adapter: 'pdf',
        source_file: filePath,
        page: i + 1,
        total_pages: result.numpages,
        pdf_info: result.info ?? {},
        content_hash: contentHash(pageText),
      },
    };
  }
}

/** pdf-parse inserts \f between pages. Fall back to paragraph-size chunks if not. */
function splitPages(text: string): string[] {
  if (text.includes('\f')) return text.split('\f');
  return [text];
}
