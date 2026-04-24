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
  try { buf = readFileSync(filePath); }
  catch (err) {
    throw new Error(`Failed to read PDF ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let result: { text: string; numpages: number; info?: Record<string, unknown> };
  try {
    result = await pdfParse(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /password/i.test(msg) ? ' (looks password-protected)' : '';
    throw new Error(`Failed to parse PDF ${path.basename(filePath)}${hint}: ${msg}`);
  }

  const hint = path.basename(filePath, path.extname(filePath));
  const pages = splitPages(result.text);
  const hasAnyText = pages.some((p) => p.trim().length > 0);
  if (!hasAnyText) {
    throw new Error(`PDF ${path.basename(filePath)} has no extractable text — likely image-only (OCR is not supported). Re-export with a text layer or transcribe it first.`);
  }

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
