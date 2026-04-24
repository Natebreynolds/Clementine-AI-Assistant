/**
 * Clementine — Adapter common helpers.
 */

import { createHash } from 'node:crypto';

/** Truncated SHA-256 content hash, hex, first 16 chars. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Build a stable externalId fallback from (source-hint, index, content). */
export function fallbackExternalId(hint: string, index: number, content: string): string {
  return `${hint}-${index}-${contentHash(content)}`;
}

/** Detect whether a value looks like a stable identifier column. */
export function looksLikeIdKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === 'id' ||
    lower.endsWith('_id') ||
    lower.endsWith('id') && lower.length <= 6 ||
    lower === 'uuid' || lower === 'guid' || lower === 'uid' ||
    lower === 'email' || lower === 'message_id' || lower === 'sfid'
  );
}

/** Pick a likely id column from a record's keys (for structured adapters). */
export function pickIdField(keys: string[]): string | null {
  for (const k of keys) if (looksLikeIdKey(k)) return k;
  return null;
}
