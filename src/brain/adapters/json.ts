/**
 * Clementine — JSON / JSONL adapter.
 *
 * Handles both array-wrapped JSON and line-delimited JSONL. Streams one
 * record per object.
 */

import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { RawRecord } from '../../types.js';
import { contentHash, fallbackExternalId, pickIdField } from './common.js';

export async function* parseJson(filePath: string): AsyncIterable<RawRecord> {
  const raw = readFileSync(filePath, 'utf-8').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    // Malformed — nothing to yield
    return;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  yield* emitObjects(filePath, items);
}

export async function* parseJsonl(filePath: string): AsyncIterable<RawRecord> {
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  const hint = path.basename(filePath, path.extname(filePath));
  let index = 0;
  let idField: string | null = null;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const record = obj as Record<string, unknown>;
      if (idField === null) idField = pickIdField(Object.keys(record));
      const rawJson = JSON.stringify(record);
      const idFromField = idField ? String(record[idField] ?? '').trim() : '';
      yield {
        externalId: idFromField ? `${hint}-${idFromField}` : fallbackExternalId(hint, index, rawJson),
        content: objectToReadableText(record),
        rawPayload: rawJson,
        metadata: {
          adapter: 'jsonl',
          source_file: filePath,
          row_index: index,
          structured: record,
          content_hash: contentHash(rawJson),
        },
      };
    }
    index += 1;
  }
}

async function* emitObjects(filePath: string, items: unknown[]): AsyncIterable<RawRecord> {
  const hint = path.basename(filePath, path.extname(filePath));
  let idField: string | null = null;

  for (let i = 0; i < items.length; i++) {
    const obj = items[i];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const record = obj as Record<string, unknown>;
    if (idField === null) idField = pickIdField(Object.keys(record));
    const rawJson = JSON.stringify(record);
    const idFromField = idField ? String(record[idField] ?? '').trim() : '';

    yield {
      externalId: idFromField ? `${hint}-${idFromField}` : fallbackExternalId(hint, i, rawJson),
      content: objectToReadableText(record),
      rawPayload: rawJson,
      metadata: {
        adapter: 'json',
        source_file: filePath,
        row_index: i,
        structured: record,
        content_hash: contentHash(rawJson),
      },
    };
  }
}

function objectToReadableText(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}: ${val}`;
    })
    .join('\n');
}
