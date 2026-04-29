/**
 * Wikilink graph expansion — searchContext should surface 1-hop neighbors
 * of the top hits so chunks that share an entity but miss lexical match
 * still make it into the candidate pool.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';

describe('Wikilink graph expansion', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-graph-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('expandViaWikilinks pulls neighbors via [[wikilink]] edges in either direction', () => {
    // hub has the FTS-matching content. spoke links TO hub but doesn't share
    // the FTS terms. orphan is unrelated.
    writeFileSync(path.join(vaultDir, 'hub.md'), '# Hub\n\nuniqueterm shows up here.\n');
    writeFileSync(path.join(vaultDir, 'spoke.md'), '# Spoke\n\nSee [[hub]] for context. Unrelated body.\n');
    writeFileSync(path.join(vaultDir, 'orphan.md'), '# Orphan\n\nLone island.\n');
    store.fullSync();

    const ftsOnly = store.searchFts('uniqueterm', 5);
    expect(ftsOnly.some((r) => r.sourceFile.includes('hub.md'))).toBe(true);
    expect(ftsOnly.some((r) => r.sourceFile.includes('spoke.md'))).toBe(false);

    const expanded = store.expandViaWikilinks(ftsOnly, { maxNeighbors: 5 });
    const expandedFiles = expanded.map((r) => r.sourceFile);
    expect(expandedFiles.some((f) => f.includes('spoke.md'))).toBe(true);
    expect(expandedFiles.every((f) => !f.includes('orphan.md'))).toBe(true);
    // Graph results carry matchType='graph' for downstream debugging.
    expect(expanded.every((r) => r.matchType === 'graph')).toBe(true);
  });

  it('searchContext folds graph neighbors into the final result set', () => {
    writeFileSync(path.join(vaultDir, 'hub.md'), '# Hub\n\nuniqueterm appears here.\n');
    writeFileSync(path.join(vaultDir, 'spoke.md'), '# Spoke\n\nReferences [[hub]]. Different vocabulary entirely.\n');
    store.fullSync();

    const results = store.searchContext('uniqueterm', { limit: 5, recencyLimit: 0 });
    const files = results.map((r) => r.sourceFile);
    // Hub matches via FTS; spoke arrives via the wikilink graph expansion.
    expect(files.some((f) => f.includes('hub.md'))).toBe(true);
    expect(files.some((f) => f.includes('spoke.md'))).toBe(true);
  });

  it('returns empty when there are no seeds', () => {
    expect(store.expandViaWikilinks([])).toEqual([]);
  });

  it('respects limitPerFile so a heavy linker does not flood the pool', () => {
    writeFileSync(path.join(vaultDir, 'hub.md'), '# Hub\n\nuniqueterm here.\n');
    writeFileSync(
      path.join(vaultDir, 'big-spoke.md'),
      '# Big\n\n## A\n\nlinks [[hub]]\n\n## B\n\nstill [[hub]]\n\n## C\n\nyet [[hub]]\n',
    );
    store.fullSync();
    const fts = store.searchFts('uniqueterm', 5);
    const expanded = store.expandViaWikilinks(fts, { limitPerFile: 1, maxNeighbors: 10 });
    const fromBigSpoke = expanded.filter((r) => r.sourceFile.includes('big-spoke.md'));
    expect(fromBigSpoke.length).toBeLessThanOrEqual(1);
  });
});
