/**
 * Hot LRU cache — class behavior + integration with MemoryStore.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HotCache } from '../src/memory/hot-cache.js';
import { MemoryStore } from '../src/memory/store.js';

describe('HotCache — LRU semantics', () => {
  it('evicts the oldest entry when capacity is exceeded', () => {
    const cache = new HotCache<number, string>(3);
    cache.set(1, 'a'); cache.set(2, 'b'); cache.set(3, 'c');
    cache.set(4, 'd'); // evicts 1
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBe('b');
    expect(cache.get(3)).toBe('c');
    expect(cache.get(4)).toBe('d');
    expect(cache.size()).toBe(3);
  });

  it('on get, bumps the entry to most-recent so it survives the next eviction', () => {
    const cache = new HotCache<number, string>(3);
    cache.set(1, 'a'); cache.set(2, 'b'); cache.set(3, 'c');
    cache.get(1); // 1 is now newest
    cache.set(4, 'd'); // evicts 2 (oldest), not 1
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBe('a');
  });

  it('tracks hits, misses, and evictions', () => {
    const cache = new HotCache<number, string>(2);
    cache.set(1, 'a'); cache.set(2, 'b');
    cache.get(1); cache.get(99); cache.get(99);
    cache.set(3, 'c'); // evicts 2
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(2);
    expect(s.evictions).toBe(1);
    expect(s.hitRate).toBeCloseTo(1 / 3, 5);
  });

  it('clear() drops everything, delete() drops one entry', () => {
    const cache = new HotCache<number, string>(5);
    cache.set(1, 'a'); cache.set(2, 'b'); cache.set(3, 'c');
    expect(cache.delete(2)).toBe(true);
    expect(cache.get(2)).toBeUndefined();
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('HotCache — MemoryStore integration', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-hc-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
    writeFileSync(path.join(vaultDir, 'a.md'), '# A\n\nbody a\n');
    store.fullSync();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function firstChunkId(): number {
    const all = store.searchContext('body', { limit: 1, recencyLimit: 0 });
    return all[0].chunkId;
  }

  it('getChunksByIds populates the cache; second call hits the cache', () => {
    const id = firstChunkId();
    // Cold call — cache miss → populates.
    store.getChunksByIds([id]);
    const beforeStats = store.getChunkCacheStats();
    // Warm call — should be a pure hit.
    const second = store.getChunksByIds([id]);
    expect(second.length).toBe(1);
    expect(second[0].id).toBe(id);
    const afterStats = store.getChunkCacheStats();
    expect(afterStats.hits).toBeGreaterThan(beforeStats.hits);
  });

  it('softDeleteChunk invalidates the cache', () => {
    const id = firstChunkId();
    store.getChunksByIds([id]); // populate
    store.softDeleteChunk(id, 'test');
    const stats = store.getChunkCacheStats();
    // Cache should not have stale entry — next lookup is a miss.
    const before = stats.misses;
    store.getChunksByIds([id]);
    expect(store.getChunkCacheStats().misses).toBeGreaterThan(before);
  });

  it('setPinned invalidates the cache so the next read returns fresh data', () => {
    const id = firstChunkId();
    const cold = store.getChunksByIds([id]);
    expect(cold[0].pinned).toBe(false);
    store.setPinned(id, true);
    const warm = store.getChunksByIds([id]);
    expect(warm[0].pinned).toBe(true);
  });
});
