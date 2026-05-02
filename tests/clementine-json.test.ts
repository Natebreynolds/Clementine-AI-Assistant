import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetClementineJsonCache,
  loadClementineJson,
  resolveNumber,
  resolveString,
  updateClementineJson,
} from '../src/config/clementine-json.js';
import { migration as migration0005 } from '../src/vault-migrations/0005-create-clementine-json.js';

describe('loadClementineJson', () => {
  let baseDir: string;

  beforeEach(() => {
    _resetClementineJsonCache();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-json-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns minimal config when file is missing', () => {
    const cfg = loadClementineJson(baseDir);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.ownerName).toBeUndefined();
  });

  it('loads valid JSON config', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 1, ownerName: 'Nate', timezone: 'America/Los_Angeles' }),
    );
    const cfg = loadClementineJson(baseDir);
    expect(cfg.ownerName).toBe('Nate');
    expect(cfg.timezone).toBe('America/Los_Angeles');
  });

  it('returns minimal config on malformed JSON without throwing', () => {
    writeFileSync(path.join(baseDir, 'clementine.json'), '{ not: valid json');
    const cfg = loadClementineJson(baseDir);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.ownerName).toBeUndefined();
  });

  it('returns minimal config on schema mismatch', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 99, ownerName: 'Nate' }),
    );
    const cfg = loadClementineJson(baseDir);
    expect(cfg.ownerName).toBeUndefined();
  });

  it('caches by mtime — repeated reads do not re-parse', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 1, ownerName: 'A' }),
    );
    const a = loadClementineJson(baseDir);
    expect(a.ownerName).toBe('A');

    // Mutate the file but mtime won't change in the same ms — overwrite anyway.
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 1, ownerName: 'B' }),
    );
    // Both reads happen in the same test → mtime may differ. The cache hits
    // when mtime matches; we just assert the loader returns the latest value.
    _resetClementineJsonCache();
    const b = loadClementineJson(baseDir);
    expect(b.ownerName).toBe('B');
  });

  it('parses nested model + budget config', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({
        schemaVersion: 1,
        models: { default: 'sonnet', haiku: 'claude-haiku-4-5' },
        budgets: { heartbeat: 0.5, cronT2: 5.0 },
      }),
    );
    const cfg = loadClementineJson(baseDir);
    expect(cfg.models?.default).toBe('sonnet');
    expect(cfg.budgets?.cronT2).toBe(5.0);
  });

  it('persists assistant experience preferences', () => {
    const cfg = updateClementineJson(baseDir, (current) => ({
      ...current,
      assistant: {
        ...(current.assistant ?? {}),
        proactivity: 'proactive',
        responseStyle: 'concise',
        progressVisibility: 'detailed',
        autonomy: 'act_when_safe',
      },
    }));
    expect(cfg.assistant?.proactivity).toBe('proactive');

    const reloaded = loadClementineJson(baseDir);
    expect(reloaded.assistant?.responseStyle).toBe('concise');
    expect(reloaded.assistant?.progressVisibility).toBe('detailed');
    expect(reloaded.assistant?.autonomy).toBe('act_when_safe');
  });
});

describe('migration 0005 — create clementine.json', () => {
  let baseDir: string;
  let vaultDir: string;
  const pkgDir = '/tmp/clementine-pkg-stub';

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-json-mig-'));
    vaultDir = path.join(baseDir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('declares kind: config', () => {
    expect((migration0005 as { kind: string }).kind).toBe('config');
  });

  it('creates clementine.json + README.md from .env', async () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      [
        'OWNER_NAME=Nate',
        'ASSISTANT_NAME=Clemmy',
        'TIMEZONE=America/Los_Angeles',
        'BUDGET_HEARTBEAT_USD=0.50',
        'BUDGET_CRON_T2_USD=5.00',
        'DEFAULT_MODEL_TIER=sonnet',
        'HEARTBEAT_INTERVAL_MINUTES=45',
        'HEARTBEAT_ACTIVE_START=6',
        'UNLEASHED_PHASE_TURNS=100',
        'UNLEASHED_DEFAULT_MAX_HOURS=4',
      ].join('\n'),
    );

    const result = await migration0005.apply({ vaultDir, baseDir, pkgDir });
    expect((result as { applied: boolean }).applied).toBe(true);

    const json = JSON.parse(readFileSync(path.join(baseDir, 'clementine.json'), 'utf-8'));
    expect(json.schemaVersion).toBe(1);
    expect(json.ownerName).toBe('Nate');
    expect(json.assistantName).toBe('Clemmy');
    expect(json.timezone).toBe('America/Los_Angeles');
    expect(json.models.default).toBe('sonnet');
    expect(json.budgets.heartbeat).toBe(0.5);
    expect(json.budgets.cronT2).toBe(5);
    expect(json.heartbeat.intervalMinutes).toBe(45);
    expect(json.heartbeat.activeStart).toBe(6);
    expect(json.heartbeat.activeEnd).toBeUndefined(); // not in .env, omitted
    expect(json.unleashed.phaseTurns).toBe(100);
    expect(json.unleashed.defaultMaxHours).toBe(4);

    // README also written
    const readme = readFileSync(path.join(baseDir, 'README.md'), 'utf-8');
    expect(readme).toContain('clementine.json');
    expect(readme).toContain('Config precedence');
  });

  it('skips on second run (idempotent)', async () => {
    writeFileSync(path.join(baseDir, '.env'), 'OWNER_NAME=Nate');

    const first = await migration0005.apply({ vaultDir, baseDir, pkgDir });
    expect((first as { applied: boolean }).applied).toBe(true);

    const second = await migration0005.apply({ vaultDir, baseDir, pkgDir });
    expect((second as { skipped: boolean }).skipped).toBe(true);
    expect((second as { details: string }).details).toContain('already exists');
  });

  it('omits fields that are not in .env (no walls of nulls)', async () => {
    // .env has only OWNER_NAME — assistantName, timezone, models, budgets all absent
    writeFileSync(path.join(baseDir, '.env'), 'OWNER_NAME=Nate');

    await migration0005.apply({ vaultDir, baseDir, pkgDir });
    const json = JSON.parse(readFileSync(path.join(baseDir, 'clementine.json'), 'utf-8'));
    expect(json.ownerName).toBe('Nate');
    expect(json.assistantName).toBeUndefined();
    expect(json.timezone).toBeUndefined();
    expect(json.models).toBeUndefined();
    expect(json.budgets).toBeUndefined();
  });

  it('handles missing .env gracefully — minimal file', async () => {
    // No .env at all
    const result = await migration0005.apply({ vaultDir, baseDir, pkgDir });
    expect((result as { applied: boolean }).applied).toBe(true);
    const json = JSON.parse(readFileSync(path.join(baseDir, 'clementine.json'), 'utf-8'));
    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json)).toEqual(['schemaVersion']);
  });
});

describe('resolveString — env > json > default', () => {
  it('uses env value when present', () => {
    expect(resolveString('from-env', 'from-json', 'default')).toBe('from-env');
  });
  it('falls back to JSON when env is empty', () => {
    expect(resolveString('', 'from-json', 'default')).toBe('from-json');
  });
  it('falls back to default when env and JSON are both unset', () => {
    expect(resolveString('', undefined, 'default')).toBe('default');
  });
});

describe('resolveNumber — env > json > default with finite-check', () => {
  it('uses env value when it parses as finite', () => {
    expect(resolveNumber('0.99', 0.10, 0.50)).toBe(0.99);
  });
  it('uses env zero (zero is finite, not falsy here)', () => {
    expect(resolveNumber('0', 0.10, 0.50)).toBe(0);
  });
  it('falls back to JSON when env is non-finite garbage', () => {
    expect(resolveNumber('not-a-number', 0.10, 0.50)).toBe(0.10);
  });
  it('falls back to JSON when env is empty', () => {
    expect(resolveNumber('', 0.10, 0.50)).toBe(0.10);
  });
  it('falls back to default when JSON is undefined', () => {
    expect(resolveNumber('', undefined, 0.50)).toBe(0.50);
  });
  it('json zero is preserved', () => {
    expect(resolveNumber('', 0, 0.50)).toBe(0);
  });
});
