/**
 * Phase 6c — effective-config inspector.
 *
 * Tests the resolution + provenance reporting against a controlled
 * baseDir (no module-level side effects on the real ~/.clementine).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeEffectiveConfig, listKnownConfigKeys } from '../src/config/effective-config.js';
import { _resetClementineJsonCache } from '../src/config/clementine-json.js';

describe('computeEffectiveConfig', () => {
  let baseDir: string;

  beforeEach(() => {
    _resetClementineJsonCache();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clem-effective-'));
    // Make sure no stray process.env from other tests leaks in.
    for (const key of listKnownConfigKeys()) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    for (const key of listKnownConfigKeys()) {
      delete process.env[key];
    }
  });

  it('reports defaults when no .env or clementine.json exists', () => {
    const cfg = computeEffectiveConfig(baseDir);
    expect(cfg.hasEnvFile).toBe(false);
    expect(cfg.hasJsonFile).toBe(false);

    const ownerName = cfg.entries.find(e => e.key === 'OWNER_NAME');
    expect(ownerName).toBeDefined();
    expect(ownerName!.source).toBe('default');

    const tz = cfg.entries.find(e => e.key === 'TIMEZONE');
    expect(tz!.source).toBe('system'); // Intl.DateTimeFormat fallback
  });

  it('reports clementine.json source when only JSON has the value', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({
        schemaVersion: 1,
        ownerName: 'Nate',
        budgets: { heartbeat: 0.99 },
      }),
    );
    const cfg = computeEffectiveConfig(baseDir);
    expect(cfg.hasJsonFile).toBe(true);

    const ownerName = cfg.entries.find(e => e.key === 'OWNER_NAME')!;
    expect(ownerName.value).toBe('Nate');
    expect(ownerName.source).toBe('clementine.json');

    const budget = cfg.entries.find(e => e.key === 'BUDGET_HEARTBEAT_USD')!;
    expect(budget.value).toBe(0.99);
    expect(budget.source).toBe('clementine.json');
  });

  it('.env wins over clementine.json and reports the shadow', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 1, ownerName: 'JsonNate', budgets: { heartbeat: 0.10 } }),
    );
    writeFileSync(
      path.join(baseDir, '.env'),
      'OWNER_NAME=EnvNate\nBUDGET_HEARTBEAT_USD=0.99\n',
    );
    const cfg = computeEffectiveConfig(baseDir);

    const ownerName = cfg.entries.find(e => e.key === 'OWNER_NAME')!;
    expect(ownerName.value).toBe('EnvNate');
    expect(ownerName.source).toBe('.env');
    expect(ownerName.shadowedBy).toEqual(['clementine.json']);

    const budget = cfg.entries.find(e => e.key === 'BUDGET_HEARTBEAT_USD')!;
    expect(budget.source).toBe('.env');
    expect(budget.shadowedBy).toEqual(['clementine.json']);
  });

  it('process.env wins over .env and clementine.json', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 1, ownerName: 'JsonNate' }),
    );
    writeFileSync(path.join(baseDir, '.env'), 'OWNER_NAME=EnvNate\n');
    process.env.OWNER_NAME = 'ProcessNate';

    const cfg = computeEffectiveConfig(baseDir);
    const ownerName = cfg.entries.find(e => e.key === 'OWNER_NAME')!;
    expect(ownerName.value).toBe('ProcessNate');
    expect(ownerName.source).toBe('process.env');
    expect(ownerName.shadowedBy).toEqual(['.env', 'clementine.json']);
  });

  it('groups entries by section', () => {
    const cfg = computeEffectiveConfig(baseDir);
    const groups = new Set(cfg.entries.map(e => e.group));
    expect(groups).toContain('identity');
    expect(groups).toContain('models');
    expect(groups).toContain('budgets');
    expect(groups).toContain('heartbeat');
    expect(groups).toContain('unleashed');
    expect(groups).toContain('advisor');
  });

  it('all known keys appear in the report', () => {
    const cfg = computeEffectiveConfig(baseDir);
    const reportedKeys = new Set(cfg.entries.map(e => e.key));
    for (const key of listKnownConfigKeys()) {
      expect(reportedKeys.has(key)).toBe(true);
    }
  });

  it('handles malformed clementine.json gracefully (loader fallback)', () => {
    writeFileSync(path.join(baseDir, 'clementine.json'), '{not valid json');
    const cfg = computeEffectiveConfig(baseDir);
    // No throw — falls through to defaults
    const ownerName = cfg.entries.find(e => e.key === 'OWNER_NAME')!;
    expect(ownerName.source).toBe('default');
  });

  it('AUTO_DELEGATE_ENABLED defaults to false and is registered in the config registry', () => {
    const cfg = computeEffectiveConfig(baseDir);
    const flag = cfg.entries.find(e => e.key === 'AUTO_DELEGATE_ENABLED');
    expect(flag).toBeDefined();
    expect(flag!.value).toBe(false);
    expect(flag!.source).toBe('default');
    expect(flag!.group).toBe('team');
  });

  it('AUTO_DELEGATE_ENABLED reports .env override and provenance', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      'AUTO_DELEGATE_ENABLED=true\n',
    );
    const cfg = computeEffectiveConfig(baseDir);
    const flag = cfg.entries.find(e => e.key === 'AUTO_DELEGATE_ENABLED')!;
    expect(flag.value).toBe('true');
    expect(flag.source).toBe('.env');
  });

  it('marks unresolvable keychain refs and surfaces fallback', () => {
    // Stub a non-existent account — `security` will exit non-zero, resolver
    // returns undefined, inspector should fall through to default and flag
    // unresolvedRef.
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'BUDGET_HEARTBEAT_USD=keychain:nonexistent-account-' + Date.now() + '\n',
    );
    const cfg = computeEffectiveConfig(baseDir);
    const budget = cfg.entries.find(e => e.key === 'BUDGET_HEARTBEAT_USD')!;
    expect(budget.source).toBe('default');
    expect(budget.value).toBe(0.25);
    expect(budget.unresolvedRef).toMatch(/^keychain:nonexistent-account-/);
  });
});
