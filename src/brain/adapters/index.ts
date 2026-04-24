/**
 * Clementine — Adapter dispatch.
 *
 * Maps a DetectedFormat to the adapter function that yields RawRecords.
 */

import type { DetectedFormat, RawRecord } from '../../types.js';
import { parseCsv } from './csv.js';
import { parseJson, parseJsonl } from './json.js';
import { parseMarkdown } from './markdown.js';
import { parsePdf } from './pdf.js';
import { parseEmail } from './email.js';
import { parseDocx } from './docx.js';

export type AdapterFn = (filePath: string) => AsyncIterable<RawRecord>;

export function adapterFor(format: DetectedFormat): AdapterFn | null {
  switch (format) {
    case 'csv':      return parseCsv;
    case 'json':     return parseJson;
    case 'jsonl':    return parseJsonl;
    case 'markdown': return parseMarkdown;
    case 'pdf':      return parsePdf;
    case 'email':    return parseEmail;
    case 'docx':     return parseDocx;
    default:         return null;
  }
}
