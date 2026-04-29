/**
 * Tiny in-process LRU for hot chunk-row reads.
 *
 * Use case: searchContext + recall-trace expansion + dashboard chunk view all
 * funnel through getChunksByIds, which often touches the same hot rows
 * many times within a session. SQLite reads are already fast (microseconds),
 * but the LRU eliminates the per-query overhead and lets us amortize the
 * row-shape unpacking that getChunksByIds does.
 *
 * Bounded: capacity ~1000 by default (~1MB at 1KB/chunk). Map preserves
 * insertion order, so we delete-then-set on access to keep most-recent at
 * the tail and evict from the head.
 *
 * Concurrency: single-process daemon, single thread — no locking needed.
 */

export class HotCache<K, V> {
  private map = new Map<K, V>();
  private capacity: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    // Bump to most-recent.
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Evict oldest (first inserted).
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
        this.evictions++;
      }
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Drop all entries — call when bulk-rebuilding the underlying store. */
  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  stats(): { hits: number; misses: number; evictions: number; size: number; capacity: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.map.size,
      capacity: this.capacity,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}
