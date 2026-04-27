/**
 * Phase 12 — file-permission hardening.
 *
 * Hermetic tests over a tmp directory tree. Verifies idempotency,
 * dry-run mode, and that we don't follow symlinks.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hardenPermissions } from '../src/config/harden-permissions.js';

describe('hardenPermissions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-harden-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function mode(p: string): number {
    return statSync(p).mode & 0o777;
  }

  it('tightens 0644 files to 0600', () => {
    const f = path.join(dir, 'state.json');
    writeFileSync(f, '{}');
    chmodSync(f, 0o644);

    const r = hardenPermissions(dir);
    expect(r.failed).toBe(0);
    expect(r.tightened).toBeGreaterThanOrEqual(1);
    expect(mode(f)).toBe(0o600);
  });

  it('tightens 0755 directories to 0700', () => {
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    chmodSync(sub, 0o755);

    const r = hardenPermissions(dir);
    expect(r.failed).toBe(0);
    expect(mode(sub)).toBe(0o700);
  });

  it('is idempotent — re-running on hardened tree is all already-correct', () => {
    writeFileSync(path.join(dir, 'a.json'), '{}');
    chmodSync(path.join(dir, 'a.json'), 0o644);

    hardenPermissions(dir);
    const second = hardenPermissions(dir);
    expect(second.tightened).toBe(0);
    expect(second.alreadyCorrect).toBeGreaterThan(0);
  });

  it('dry-run reports planned changes without writing', () => {
    const f = path.join(dir, 'preview.json');
    writeFileSync(f, '{}');
    chmodSync(f, 0o644);

    const r = hardenPermissions(dir, { dryRun: true });
    expect(r.tightened).toBe(1);
    // File mode must NOT have changed
    expect(mode(f)).toBe(0o644);
  });

  it('walks subdirectories', () => {
    const a = path.join(dir, 'a');
    const aFile = path.join(a, 'file.json');
    mkdirSync(a);
    writeFileSync(aFile, '{}');
    chmodSync(aFile, 0o644);
    chmodSync(a, 0o755);

    const r = hardenPermissions(dir);
    expect(mode(a)).toBe(0o700);
    expect(mode(aFile)).toBe(0o600);
  });

  it('does not follow symlinks', () => {
    const realFile = path.join(dir, '..', 'outside-' + Date.now() + '.txt');
    writeFileSync(realFile, 'sensitive');
    chmodSync(realFile, 0o644);
    try {
      const link = path.join(dir, 'link.txt');
      symlinkSync(realFile, link);

      hardenPermissions(dir);
      // The symlink target outside our tree must still be 0644
      expect(mode(realFile)).toBe(0o644);
    } finally {
      rmSync(realFile, { force: true });
    }
  });

  it('reports per-entry detail', () => {
    writeFileSync(path.join(dir, 'a.json'), '{}');
    chmodSync(path.join(dir, 'a.json'), 0o644);

    const r = hardenPermissions(dir);
    const entry = r.entries.find(e => e.path.endsWith('a.json'));
    expect(entry).toBeDefined();
    expect(entry!.beforeMode).toBe('644');
    expect(entry!.afterMode).toBe('600');
    expect(entry!.status).toBe('tightened');
  });

  it('handles non-existent baseDir gracefully', () => {
    const r = hardenPermissions(path.join(dir, 'does-not-exist'));
    expect(r.failed).toBe(1);
    expect(r.scanned).toBe(0);
  });

  it('correctly classifies files vs directories in the entry kind field', () => {
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'a.json'), '{}');

    const r = hardenPermissions(dir);
    const dirEntry = r.entries.find(e => e.path === sub);
    const fileEntry = r.entries.find(e => e.path.endsWith('a.json'));
    expect(dirEntry?.kind).toBe('directory');
    expect(fileEntry?.kind).toBe('file');
  });
});
