/**
 * Clementine — REST polling adapter.
 *
 * Fetches an HTTP endpoint (typically an API's list/search route),
 * extracts the records array, and yields one RawRecord per item. Values
 * in the config like `${my_cred_ref}` are substituted at request time
 * from ~/.clementine/credentials.json via `getCredential()`.
 *
 * MVP: single page fetch. Cursor/offset pagination is deferred — most
 * initial seed cases work with a single large response or a pre-set
 * `params.limit` that covers the dataset the user cares about.
 */

import path from 'node:path';
import type { RawRecord } from '../../types.js';
import { contentHash, fallbackExternalId, pickIdField } from './common.js';
import { getCredential } from '../../config.js';

export interface RestConfig {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  params?: Record<string, string>;          // URL query params
  body?: unknown;                           // for POST
  recordsJsonPath?: string;                 // dot-path into response, e.g. "data" or "items.results"
  idField?: string;                         // per-record field to use as external_id
  hint?: string;                            // used when building fallback external_id
}

/**
 * Adapter factory — `cfg` is the source's config_json parsed into RestConfig.
 * Returns an AsyncIterable that yields RawRecords.
 */
export async function* parseRest(cfg: RestConfig): AsyncIterable<RawRecord> {
  const resolvedUrl = appendParams(substituteCreds(cfg.url), cfg.params);
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    resolvedHeaders[k] = substituteCreds(v);
  }
  const init: RequestInit = {
    method: cfg.method ?? 'GET',
    headers: resolvedHeaders,
  };
  if (cfg.method === 'POST' && cfg.body !== undefined) {
    init.body = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
    if (!resolvedHeaders['Content-Type']) {
      resolvedHeaders['Content-Type'] = 'application/json';
    }
  }

  const resp = await fetch(resolvedUrl, init);
  if (!resp.ok) {
    const text = await safeText(resp);
    throw new Error(`REST fetch ${resp.status}: ${text.slice(0, 300)}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  let payload: unknown;
  if (contentType.includes('application/json') || contentType === '') {
    payload = await resp.json();
  } else {
    payload = { _text: await resp.text() };
  }

  const records = extractRecords(payload, cfg.recordsJsonPath);
  const hint = cfg.hint ?? derivedHint(cfg.url);

  let idField = cfg.idField ?? null;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const structured = rec as Record<string, unknown>;
    if (idField === null) idField = pickIdField(Object.keys(structured));
    const rawJson = JSON.stringify(structured);
    const idFromField = idField ? String(structured[idField] ?? '').trim() : '';
    yield {
      externalId: idFromField
        ? `${hint}-${idFromField}`
        : fallbackExternalId(hint, i, rawJson),
      content: objectToReadableText(structured),
      rawPayload: rawJson,
      metadata: {
        adapter: 'rest',
        source_url: resolvedUrl,
        record_index: i,
        structured,
        content_hash: contentHash(rawJson),
      },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function substituteCreds(input: string): string {
  return input.replace(/\$\{([a-z0-9_\-.]+)\}/gi, (_, ref) => {
    const val = getCredential(ref);
    return val ?? '';
  });
}

function appendParams(url: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, substituteCreds(v));
  }
  return u.toString();
}

function extractRecords(payload: unknown, pathStr?: string): unknown[] {
  if (!pathStr) {
    // If the top-level is an array, use it directly; otherwise wrap.
    if (Array.isArray(payload)) return payload;
    return [payload];
  }
  let cur: unknown = payload;
  for (const key of pathStr.split('.').filter(Boolean)) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return [];
    }
  }
  if (Array.isArray(cur)) return cur;
  return [cur];
}

function derivedHint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
  } catch {
    return path.basename(url).replace(/[^a-z0-9_-]+/gi, '-');
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

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return ''; }
}
