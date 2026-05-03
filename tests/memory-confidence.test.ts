/**
 * Memory confidence scoring — tentative facts should remain searchable but
 * rank below equally relevant, higher-confidence facts across retrieval paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-confidence-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function setConfidence(sourceFile: string, confidence: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE chunks SET confidence = ?, updated_at = ? WHERE source_file = ?')
      .run(confidence, '2026-01-01 00:00:00', sourceFile);
  } finally {
    db.close();
  }
}

describe('confidence-aware retrieval', () => {
  it('penalizes low-confidence FTS matches without hiding them', () => {
    writeFileSync(path.join(testDir, 'high.md'), '# High\n\napollo constraint memory tight\n');
    writeFileSync(path.join(testDir, 'low.md'), '# Low\n\napollo constraint memory tight\n');
    store.fullSync();
    setConfidence('high.md', 1.0);
    setConfidence('low.md', 0.0);

    const results = store.searchContext('apollo constraint', { limit: 5, recencyLimit: 0 });
    const high = results.find(r => r.sourceFile === 'high.md');
    const low = results.find(r => r.sourceFile === 'low.md');

    expect(high).toBeTruthy();
    expect(low).toBeTruthy();
    expect(high!.score).toBeGreaterThan(low!.score);
    expect(results.findIndex(r => r.sourceFile === 'high.md')).toBeLessThan(
      results.findIndex(r => r.sourceFile === 'low.md'),
    );
  });

  it('penalizes low-confidence recency matches', () => {
    writeFileSync(path.join(testDir, 'recent-high.md'), '# High\n\nrecent confidence fact\n');
    writeFileSync(path.join(testDir, 'recent-low.md'), '# Low\n\nrecent confidence fact\n');
    store.fullSync();
    setConfidence('recent-high.md', 1.0);
    setConfidence('recent-low.md', 0.0);

    const results = store.getRecentChunks(5);
    const high = results.find(r => r.sourceFile === 'recent-high.md');
    const low = results.find(r => r.sourceFile === 'recent-low.md');

    expect(high).toBeTruthy();
    expect(low).toBeTruthy();
    expect(high!.score).toBeGreaterThan(low!.score);
  });
});
