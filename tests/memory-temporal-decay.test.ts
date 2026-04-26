/**
 * Phase 9d — confirm temporal decay is applied to FTS scoring.
 *
 * Strategy: insert two chunks via fullSync (real ingestion path), then
 * UPDATE the updated_at column directly to backdate one of them. Run
 * searchContext and assert the recent chunk ranks ahead of the old one
 * when relevance is comparable.
 *
 * Note: insertChunk isn't a public API; we use the real chunking pipeline.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import Database from 'better-sqlite3';

describe('Phase 9d — temporal decay applied to FTS scoring', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-mem-decay-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function backdate(sourceFileLike: string, isoTimestamp: string): void {
    const db = new Database(dbPath);
    db.prepare('UPDATE chunks SET updated_at = ? WHERE source_file LIKE ?').run(isoTimestamp, `%${sourceFileLike}%`);
    db.close();
  }

  it('newer chunk with same FTS relevance ranks above older chunk', () => {
    // Two markdown files with identical relevant text → same BM25 score.
    writeFileSync(
      path.join(vaultDir, 'old-note.md'),
      '# History\n\nmarketleaderfollowup is a daily SDR job for outbound emails.\n',
    );
    writeFileSync(
      path.join(vaultDir, 'new-note.md'),
      '# History\n\nmarketleaderfollowup is a daily SDR job for outbound emails.\n',
    );
    store.fullSync();
    // Backdate old-note to two years ago, leave new-note at sync time (now).
    const twoYearsAgoIso = new Date(Date.now() - 730 * 86_400_000).toISOString();
    backdate('old-note.md', twoYearsAgoIso);

    const results = store.searchContext('marketleaderfollowup', { limit: 5, recencyLimit: 0 });
    const newIdx = results.findIndex(r => r.sourceFile.includes('new-note.md'));
    const oldIdx = results.findIndex(r => r.sourceFile.includes('old-note.md'));
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('very old chunks are still returned (not filtered out)', () => {
    // The decay multiplier floor (0.4) ensures ancient chunks lose at most
    // 60% of score. They get demoted but stay in results — historical
    // context is preserved even when a newer chunk wins ranking. This
    // test asserts the chunk is still RETURNED, not that it wins.
    writeFileSync(
      path.join(vaultDir, 'ancient.md'),
      '# Background\n\nkelvinprotocol architectural overview.\n',
    );
    writeFileSync(
      path.join(vaultDir, 'recent.md'),
      '# Note\n\nkelvinprotocol was mentioned today.\n',
    );
    store.fullSync();
    backdate('ancient.md', new Date(Date.now() - 1825 * 86_400_000).toISOString()); // 5 years

    const results = store.searchContext('kelvinprotocol', { limit: 5, recencyLimit: 0 });
    const ancientFound = results.some(r => r.sourceFile.includes('ancient.md'));
    expect(ancientFound).toBe(true);
  });
});
