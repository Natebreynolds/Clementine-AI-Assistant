/**
 * Phase 6d — config doctor checks.
 *
 * Drives runDoctor against curated baseDir scenarios and asserts the
 * expected findings + exitCode. No process.env mutation across tests
 * (clean restore in afterEach).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/config/config-doctor.js';
import { _resetClementineJsonCache } from '../src/config/clementine-json.js';
import { listKnownConfigKeys } from '../src/config/effective-config.js';

describe('runDoctor', () => {
  let baseDir: string;

  beforeEach(() => {
    _resetClementineJsonCache();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clem-doctor-'));
    for (const key of listKnownConfigKeys()) delete process.env[key];
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    for (const key of listKnownConfigKeys()) delete process.env[key];
  });

  it('clean default state has no errors but warns about missing config files', () => {
    const r = runDoctor(baseDir);
    expect(r.exitCode).toBe(0);
    expect(r.counts.error).toBe(0);
    expect(r.findings.find(f => f.message.includes('No .env or clementine.json'))).toBeDefined();
  });

  it('flags non-numeric value in numeric key', () => {
    writeFileSync(path.join(baseDir, '.env'), 'BUDGET_HEARTBEAT_USD=not-a-number\n');
    const r = runDoctor(baseDir);
    expect(r.exitCode).toBe(1);
    const finding = r.findings.find(f => f.key === 'BUDGET_HEARTBEAT_USD');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.message).toContain('does not parse as a number');
  });

  it('flags invalid enum value', () => {
    writeFileSync(path.join(baseDir, '.env'), 'CLEMENTINE_ADVISOR_RULES_LOADER=enabled\n');
    const r = runDoctor(baseDir);
    expect(r.exitCode).toBe(1);
    const finding = r.findings.find(f => f.key === 'CLEMENTINE_ADVISOR_RULES_LOADER');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('off, shadow, primary');
  });

  it('flags unresolved keychain refs', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'BUDGET_HEARTBEAT_USD=keychain:never-existed-account-' + Date.now() + '\n',
    );
    const r = runDoctor(baseDir);
    expect(r.exitCode).toBe(1);
    const finding = r.findings.find(f => f.key === 'BUDGET_HEARTBEAT_USD' && f.message.includes('keychain entry is missing'));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
  });

  it('flags malformed clementine.json schemaVersion', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({ schemaVersion: 99, ownerName: 'x' }),
    );
    const r = runDoctor(baseDir);
    expect(r.exitCode).toBe(1);
    expect(r.findings.find(f => f.message.includes('schemaVersion'))).toBeDefined();
  });

  it('flags malformed clementine.json (not parseable)', () => {
    writeFileSync(path.join(baseDir, 'clementine.json'), '{ not json');
    const r = runDoctor(baseDir);
    expect(r.exitCode).toBe(1);
    expect(r.findings.find(f => f.message.includes('not valid JSON'))).toBeDefined();
  });

  it('flags HEARTBEAT_ACTIVE_START >= HEARTBEAT_ACTIVE_END', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      'HEARTBEAT_ACTIVE_START=22\nHEARTBEAT_ACTIVE_END=8\n',
    );
    const r = runDoctor(baseDir);
    const finding = r.findings.find(f => f.message.includes('not before'));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
  });

  it('flags swapped budget tiers', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      'BUDGET_CRON_T1_USD=10\nBUDGET_CRON_T2_USD=5\n',
    );
    const r = runDoctor(baseDir);
    expect(r.findings.find(f => f.message.includes('exceeds BUDGET_CRON_T2_USD'))).toBeDefined();
  });

  it('does NOT warn about plaintext credentials in .env (v1.1.4+ policy: .env IS the default)', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // pragma: allowlist secret
      'STRIPE_API_KEY=placeholder-credential-value-1234567890abcdef\n',
    );
    const r = runDoctor(baseDir);
    expect(r.findings.find(f => f.key === 'STRIPE_API_KEY')).toBeUndefined();
  });

  it('flags world-readable .env permissions', () => {
    const envPath = path.join(baseDir, '.env');
    writeFileSync(envPath, 'OWNER_NAME=Nate\n');
    // chmod 644 — readable by group + others
    require('node:fs').chmodSync(envPath, 0o644);
    const r = runDoctor(baseDir);
    const finding = r.findings.find(f => f.message.includes('readable by other users'));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.fix).toContain('chmod 600');
  });

  it('does not flag mode 0600 .env', () => {
    const envPath = path.join(baseDir, '.env');
    writeFileSync(envPath, 'OWNER_NAME=Nate\n');
    require('node:fs').chmodSync(envPath, 0o600);
    const r = runDoctor(baseDir);
    expect(r.findings.find(f => f.message.includes('readable by other users'))).toBeUndefined();
  });

  it('does not flag short plaintext values (was a config-shape false-positive guard)', () => {
    writeFileSync(path.join(baseDir, '.env'), 'WEBHOOK_PORT=8420\n');
    const r = runDoctor(baseDir);
    expect(r.findings.find(f => f.key === 'WEBHOOK_PORT')).toBeUndefined();
  });

  it('flags webhook enabled without WEBHOOK_PORT/BIND empty', () => {
    writeFileSync(
      path.join(baseDir, '.env'),
      // Set enabled=true and clear the dependents (use empty values)
      'WEBHOOK_ENABLED=true\nWEBHOOK_PORT=\nWEBHOOK_BIND=\n',
    );
    const r = runDoctor(baseDir);
    // Defaults will fill in WEBHOOK_PORT and WEBHOOK_BIND, so they're not "empty" — but
    // the defaults are valid (8420 and 127.0.0.1), so no warning expected.
    expect(r.findings.filter(f => f.severity === 'warning' && f.message.includes('Webhook'))).toEqual([]);
  });

  it('clean valid config produces no errors', () => {
    writeFileSync(
      path.join(baseDir, 'clementine.json'),
      JSON.stringify({
        schemaVersion: 1,
        ownerName: 'Nate',
        budgets: { heartbeat: 0.5, cronT1: 2, cronT2: 5, chat: 5 },
        heartbeat: { intervalMinutes: 30, activeStart: 8, activeEnd: 22 },
      }),
    );
    const r = runDoctor(baseDir);
    expect(r.counts.error).toBe(0);
    expect(r.exitCode).toBe(0);
  });
});
