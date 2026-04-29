/**
 * Procedural memory tier — the "how to do X" memory class.
 *
 * Verifies:
 *  - chunker recognizes 00-System/procedures/ files as category=procedure
 *  - chunker honors explicit frontmatter category=procedure outside that dir
 *  - findRelevantProcedures matches by trigger substring
 *  - results are sorted by match-count then trigger specificity
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { chunkFile } from '../src/memory/chunker.js';

describe('Procedural memory tier', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-proc-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeProc(slug: string, fm: Record<string, unknown>, body: string): string {
    const procDir = path.join(vaultDir, '00-System', 'procedures');
    mkdirSync(procDir, { recursive: true });
    const fmYaml = Object.entries(fm)
      .map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join('\n')}` : `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    const filePath = path.join(procDir, `${slug}.md`);
    writeFileSync(filePath, `---\n${fmYaml}\n---\n\n${body}\n`);
    return filePath;
  }

  it('chunker assigns category=procedure to files in 00-System/procedures/', () => {
    const filePath = writeProc('ship-release', { triggers: ['ship release'] }, '# Ship\n\nstep 1\n');
    const chunks = chunkFile(filePath, vaultDir);
    expect(chunks.length).toBeGreaterThan(0);
    const bodyChunk = chunks.find((c) => c.chunkType !== 'frontmatter');
    expect(bodyChunk?.category).toBe('procedure');
  });

  it('chunker honors explicit frontmatter category=procedure outside the dir', () => {
    const filePath = path.join(vaultDir, 'misc.md');
    writeFileSync(filePath, `---\ncategory: procedure\ntriggers:\n  - "deploy"\n---\n\n# Deploy\n\nbody\n`);
    const chunks = chunkFile(filePath, vaultDir);
    const bodyChunk = chunks.find((c) => c.chunkType !== 'frontmatter');
    expect(bodyChunk?.category).toBe('procedure');
  });

  it('findRelevantProcedures returns chunks whose triggers match the query', () => {
    writeProc('ship-release', { triggers: ['ship release', 'publish to npm'] }, '# Ship\n\nbump version\n');
    writeProc('inbox-handling', { triggers: ['handle inbound', 'reply to inbox'] }, '# Inbox\n\ntriage\n');
    writeProc('no-triggers', {}, '# Lonely\n\nbody\n');
    store.fullSync();

    const a = store.findRelevantProcedures('how do i ship release this branch?');
    expect(a.length).toBe(1);
    expect(a[0].sourceFile).toContain('ship-release.md');
    expect(a[0].matched).toContain('ship release');

    const b = store.findRelevantProcedures('please reply to inbox today');
    expect(b.length).toBe(1);
    expect(b[0].sourceFile).toContain('inbox-handling.md');

    const c = store.findRelevantProcedures('something unrelated');
    expect(c.length).toBe(0);
  });

  it('ranks by match-count, then by longest matched trigger', () => {
    writeProc('two-matches', { triggers: ['ship', 'deploy'] }, '# Two\n\nbody\n');
    writeProc('one-long-match', { triggers: ['ship a release'] }, '# One\n\nbody\n');
    writeProc('one-short-match', { triggers: ['ship'] }, '# Short\n\nbody\n');
    store.fullSync();

    const r = store.findRelevantProcedures('please ship a release and deploy now');
    // 'two-matches' hits both 'ship' and 'deploy' → 2 matches → wins.
    expect(r[0].sourceFile).toContain('two-matches.md');
    // Among single-match procedures, 'ship a release' (longer) outranks 'ship'.
    const remaining = r.slice(1).map((m) => m.sourceFile);
    expect(remaining[0]).toContain('one-long-match.md');
    expect(remaining[1]).toContain('one-short-match.md');
  });

  it('skips soft-deleted procedure chunks', () => {
    writeProc('soon-deleted', { triggers: ['archive me'] }, '# X\n\nbody\n');
    store.fullSync();
    const before = store.findRelevantProcedures('please archive me');
    expect(before.length).toBe(1);
    store.softDeleteChunk(before[0].id, 'test');
    const after = store.findRelevantProcedures('please archive me');
    expect(after.length).toBe(0);
  });
});
