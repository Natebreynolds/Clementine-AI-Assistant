import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration } from '../src/vault-migrations/0004-backfill-schema-versions.js';

describe('migration 0004 — backfill schemaVersion', () => {
  let vaultDir: string;
  let baseDir: string;
  let pkgDir: string;

  beforeEach(() => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'clementine-mig0004-'));
    vaultDir = path.join(tmpRoot, 'vault');
    baseDir = tmpRoot;
    pkgDir = '/dev/null/pkg'; // not used in this migration
    mkdirSync(path.join(vaultDir, '00-System', 'agents', 'ross-the-sdr'), { recursive: true });
    mkdirSync(path.join(vaultDir, '00-System', 'agents', 'sasha-the-cmo'), { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('skips when no target files exist', () => {
    const result = migration.apply({ vaultDir, baseDir, pkgDir });
    expect((result as { skipped: boolean }).skipped).toBe(true);
  });

  it('adds schemaVersion: 1 to CRON.md frontmatter', async () => {
    const cronPath = path.join(vaultDir, '00-System', 'CRON.md');
    writeFileSync(cronPath, '---\njobs:\n  - name: foo\n    schedule: "* * * * *"\n    prompt: hi\n---\n\n# Cron\n');

    const result = await migration.apply({ vaultDir, baseDir, pkgDir });
    expect((result as { applied: boolean }).applied).toBe(true);

    const updated = matter(readFileSync(cronPath, 'utf-8'));
    expect(updated.data.schemaVersion).toBe(1);
    // jobs array preserved
    expect(Array.isArray(updated.data.jobs)).toBe(true);
    expect(updated.data.jobs[0].name).toBe('foo');
  });

  it('adds schemaVersion to all agent.md files', async () => {
    writeFileSync(path.join(vaultDir, '00-System', 'agents', 'ross-the-sdr', 'agent.md'), '---\nname: Ross\ntier: 1\n---\n\nbody\n');
    writeFileSync(path.join(vaultDir, '00-System', 'agents', 'sasha-the-cmo', 'agent.md'), '---\nname: Sasha\ntier: 2\n---\n\nbody\n');

    const result = await migration.apply({ vaultDir, baseDir, pkgDir });
    expect((result as { applied: boolean }).applied).toBe(true);

    const ross = matter(readFileSync(path.join(vaultDir, '00-System', 'agents', 'ross-the-sdr', 'agent.md'), 'utf-8'));
    const sasha = matter(readFileSync(path.join(vaultDir, '00-System', 'agents', 'sasha-the-cmo', 'agent.md'), 'utf-8'));
    expect(ross.data.schemaVersion).toBe(1);
    expect(sasha.data.schemaVersion).toBe(1);
    expect(ross.data.name).toBe('Ross');
    expect(sasha.data.tier).toBe(2);
  });

  it('is idempotent — second run is a no-op', async () => {
    const cronPath = path.join(vaultDir, '00-System', 'CRON.md');
    writeFileSync(cronPath, '---\njobs: []\n---\n');

    const first = await migration.apply({ vaultDir, baseDir, pkgDir });
    expect((first as { applied: boolean }).applied).toBe(true);

    const second = await migration.apply({ vaultDir, baseDir, pkgDir });
    expect((second as { skipped: boolean }).skipped).toBe(true);
    expect((second as { details: string }).details).toContain('already have schemaVersion');
  });

  it('preserves existing schemaVersion: 1', async () => {
    const cronPath = path.join(vaultDir, '00-System', 'CRON.md');
    writeFileSync(cronPath, '---\nschemaVersion: 1\njobs: []\n---\n');

    const result = await migration.apply({ vaultDir, baseDir, pkgDir });
    expect((result as { skipped: boolean }).skipped).toBe(true);

    // File untouched
    const after = matter(readFileSync(cronPath, 'utf-8'));
    expect(after.data.schemaVersion).toBe(1);
  });

  it('skips invalid frontmatter without crashing the run', async () => {
    const cronPath = path.join(vaultDir, '00-System', 'CRON.md');
    // Malformed YAML in frontmatter — gray-matter will throw
    writeFileSync(cronPath, '---\n: invalid: : yaml\n---\n\nbody\n');

    const result = await migration.apply({ vaultDir, baseDir, pkgDir });
    // No valid file got updated, so result is "skipped" with details mentioning invalid
    expect((result as { skipped: boolean }).skipped).toBe(true);
  });

  it('declares kind: "vault" so the runner uses MigrationContext', () => {
    expect((migration as { kind: string }).kind).toBe('vault');
  });

  it('writes out clean YAML frontmatter without breaking multi-line fields', async () => {
    const cronPath = path.join(vaultDir, '00-System', 'CRON.md');
    writeFileSync(cronPath, '---\njobs:\n  - name: foo\n    schedule: "* * * * *"\n    prompt: |\n      Multi-line\n      prompt body\n---\n\n# Body\n');

    await migration.apply({ vaultDir, baseDir, pkgDir });

    const after = matter(readFileSync(cronPath, 'utf-8'));
    expect(after.data.schemaVersion).toBe(1);
    expect(after.data.jobs[0].prompt).toContain('Multi-line');
    expect(after.data.jobs[0].prompt).toContain('prompt body');
  });

});
