/**
 * Clementine — CSV adapter.
 *
 * Streams rows from a CSV file (comma- or tab-separated). Each row is a
 * RawRecord with stringified JSON content so the downstream pipeline can
 * template/distill it the same way as any other structured source.
 */

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import type { RawRecord } from '../../types.js';
import { contentHash, fallbackExternalId, pickIdField } from './common.js';

export async function* parseCsv(filePath: string): AsyncIterable<RawRecord> {
  const hint = path.basename(filePath, path.extname(filePath));
  const delimiter = filePath.toLowerCase().endsWith('.tsv') ? '\t' : ',';

  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relax_column_count: true,
    }),
  );

  let index = 0;
  let idField: string | null = null;

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    if (idField === null) {
      idField = pickIdField(Object.keys(row));
    }
    const rawJson = JSON.stringify(row);
    const idFromField = idField ? String(row[idField] ?? '').trim() : '';
    const externalId = idFromField
      ? `${hint}-${idFromField}`
      : fallbackExternalId(hint, index, rawJson);

    yield {
      externalId,
      content: rowToReadableText(row),
      rawPayload: rawJson,
      metadata: {
        adapter: 'csv',
        source_file: filePath,
        row_index: index,
        columns: Object.keys(row),
        structured: row,
        content_hash: contentHash(rawJson),
      },
    };
    index += 1;
  }
}

function rowToReadableText(row: Record<string, string>): string {
  return Object.entries(row)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
