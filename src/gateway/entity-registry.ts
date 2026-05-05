/**
 * Entity registry — detects when a user turn mentions a topic / entity
 * Clementine already has context on, so recall can fire without waiting
 * for vague-repair phrases like "what did we decide?".
 *
 * The registry is a flattened, mention-frequency-ranked snapshot of:
 *   - chunks.topic (curated knowledge)
 *   - episodes.topics + episodes.entities (consolidated session memory)
 *
 * Cached per store dbPath with a 5-minute TTL — the registry only changes
 * when episodes consolidate or new chunks land, both of which are minutes-
 * scale events. Invalidating less often keeps the chat path fast.
 */
import type { MemoryStore } from '../memory/store.js';

export interface RegistryEntity {
  name: string;       // canonical, lowercased
  display: string;    // original case
  kind: 'topic' | 'entity';
  count: number;
}

export interface EntityMatch {
  name: string;
  display: string;
  kind: 'topic' | 'entity';
}

interface CachedRegistry {
  entries: RegistryEntity[];
  loadedAt: number;
}

const REGISTRY_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedRegistry>();

/** Words that trigger pointless matches when allowed (too generic). Augments
 *  the per-entity length filter — "we" or "do" would never make it past the
 *  3-char floor anyway, but common-but-bare nouns sometimes do, and they
 *  cause false positives across unrelated turns. */
const ENTITY_STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'has', 'had', 'have', 'this',
  'that', 'with', 'from', 'they', 'them', 'their', 'these', 'those',
  'about', 'into', 'over', 'just', 'than', 'then', 'when', 'what', 'where',
  'while', 'will', 'would', 'could', 'should',
]);

/** Read the registry from cache, refreshing if stale or missing. Tests can
 *  call invalidateEntityRegistry() between cases to bypass the cache. */
export function getEntityRegistry(store: MemoryStore, opts: { now?: number; key?: string } = {}): RegistryEntity[] {
  const key = opts.key ?? (store as unknown as { dbPath?: string }).dbPath ?? 'default';
  const now = opts.now ?? Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.loadedAt < REGISTRY_TTL_MS) {
    return cached.entries;
  }
  let entries: RegistryEntity[] = [];
  try {
    if (typeof (store as { getEntityRegistrySnapshot?: unknown }).getEntityRegistrySnapshot === 'function') {
      entries = (store as {
        getEntityRegistrySnapshot: (o: { minCount?: number; maxItems?: number }) => RegistryEntity[];
      }).getEntityRegistrySnapshot({ minCount: 1, maxItems: 500 });
    }
  } catch { /* registry probe is best-effort */ }
  cache.set(key, { entries, loadedAt: now });
  return entries;
}

/** Drop cached registry entries — used by tests and by code paths that
 *  know they just mutated the registry source (e.g. after a fresh episode
 *  consolidation pass). */
export function invalidateEntityRegistry(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find registry entities mentioned in the input text, with word-boundary
 * matching so "auth" doesn't match "author". Multi-word entities are
 * matched as contiguous word sequences. Longer matches are preferred
 * (more specific), with mention-count as the tiebreaker.
 *
 * Returns at most `maxMatches` (default 5) entities, deduplicated.
 */
export function findEntitiesInText(
  text: string,
  registry: RegistryEntity[],
  opts: { maxMatches?: number } = {},
): EntityMatch[] {
  const max = Math.max(1, opts.maxMatches ?? 5);
  if (!text || registry.length === 0) return [];
  const haystack = ` ${normalizeForMatch(text)} `;
  if (haystack.trim().length < 3) return [];

  const candidates: Array<{ entry: RegistryEntity; specificity: number }> = [];
  for (const entry of registry) {
    if (entry.name.length < 3) continue;
    if (entry.name.split(' ').length === 1 && ENTITY_STOPWORDS.has(entry.name)) continue;
    const needle = ` ${entry.name} `;
    if (haystack.includes(needle)) {
      candidates.push({ entry, specificity: entry.name.length });
    }
  }
  // Specificity desc, then count desc — multi-word matches win, frequency
  // breaks ties between equally-specific candidates.
  candidates.sort((a, b) => b.specificity - a.specificity || b.entry.count - a.entry.count);

  // Dedup: skip a candidate if a longer already-accepted match fully
  // contains its name (e.g. don't surface "dashboard" if "dashboard
  // refactor" already matched).
  const accepted: EntityMatch[] = [];
  const acceptedNames: string[] = [];
  for (const { entry } of candidates) {
    if (acceptedNames.some(n => n.includes(entry.name))) continue;
    accepted.push({ name: entry.name, display: entry.display, kind: entry.kind });
    acceptedNames.push(entry.name);
    if (accepted.length >= max) break;
  }
  return accepted;
}
