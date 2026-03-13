/**
 * Clementine TypeScript — File-watcher cache for system prompt files.
 *
 * Pre-reads vault files and invalidates on fs change, avoiding 50-200ms
 * of readFileSync + gray-matter parsing on every message.
 */

import { readFileSync, existsSync, watch, type FSWatcher } from 'node:fs';
import matter from 'gray-matter';

interface CacheEntry {
  content: string;
  data: Record<string, unknown>;
}

export class PromptCache {
  private cache = new Map<string, CacheEntry | null>();
  private watchers = new Map<string, FSWatcher>();

  /** Get parsed file content. Loads and caches on first access. */
  get(filePath: string): CacheEntry | null {
    if (this.cache.has(filePath)) return this.cache.get(filePath)!;
    return this.load(filePath);
  }

  /** Start watching a file. Re-reads on change. */
  watch(filePath: string): void {
    if (this.watchers.has(filePath)) return;
    this.load(filePath);
    if (!existsSync(filePath)) return;
    try {
      const w = watch(filePath, () => { this.cache.delete(filePath); });
      w.unref(); // Don't keep daemon alive
      this.watchers.set(filePath, w);
    } catch {
      // Watch failed (e.g. file deleted between check and watch) — cache still works
    }
  }

  private load(filePath: string): CacheEntry | null {
    if (!existsSync(filePath)) {
      this.cache.set(filePath, null);
      return null;
    }
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = matter(raw);
      const entry: CacheEntry = { content: parsed.content, data: parsed.data as Record<string, unknown> };
      this.cache.set(filePath, entry);
      return entry;
    } catch {
      this.cache.set(filePath, null);
      return null;
    }
  }

  /** Switch watched daily note path (call when date changes). */
  swapWatch(oldPath: string, newPath: string): void {
    const w = this.watchers.get(oldPath);
    if (w) {
      w.close();
      this.watchers.delete(oldPath);
    }
    this.cache.delete(oldPath);
    this.watch(newPath);
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.cache.clear();
  }
}
