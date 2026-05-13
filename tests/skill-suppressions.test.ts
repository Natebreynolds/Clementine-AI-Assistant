/**
 * Manual skill suppression file — read, merge, and toggle (1.18.127).
 *
 * The runtime side (run-agent-cron.ts) is covered by the existing
 * skill-pin-resolution test suite via the `suppressedNames` Set parameter;
 * here we cover only the file-IO + merging contract of skill-suppressions.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'clem-suppress-'));
  prevHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome) process.env.CLEMENTINE_HOME = prevHome; else delete process.env.CLEMENTINE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

const fileAt = () => path.join(tmpHome, 'skill-suppressions.json');

describe('getManualSuppressions', () => {
  it('returns an empty Set when the file does not exist', async () => {
    const { getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    const r = getManualSuppressions(undefined);
    expect(r.size).toBe(0);
  });

  it('returns global suppressions when no agent slug is passed', async () => {
    writeFileSync(fileAt(), JSON.stringify({ global: ['stale-one', 'broken-two'] }));
    const { getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    const r = getManualSuppressions();
    expect(r).toEqual(new Set(['stale-one', 'broken-two']));
  });

  it('merges global + per-agent suppressions when an agent slug is passed', async () => {
    writeFileSync(fileAt(), JSON.stringify({
      global: ['shared-bad'],
      'sales-agent': ['alex-only-bad'],
      'marketing-agent': ['morgan-only-bad'],
    }));
    const { getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    const r = getManualSuppressions('sales-agent');
    expect(r).toEqual(new Set(['shared-bad', 'alex-only-bad']));
    // morgan's per-agent list must NOT leak into alex's set
    expect(r.has('morgan-only-bad')).toBe(false);
  });

  it('returns globals only when the per-agent key is missing', async () => {
    writeFileSync(fileAt(), JSON.stringify({ global: ['g1'] }));
    const { getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    expect(getManualSuppressions('never-configured-agent')).toEqual(new Set(['g1']));
  });

  it('survives a malformed JSON file (returns empty Set)', async () => {
    writeFileSync(fileAt(), 'not valid json {{');
    const { getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    expect(getManualSuppressions().size).toBe(0);
  });

  it('survives a non-array global value (returns empty Set)', async () => {
    writeFileSync(fileAt(), JSON.stringify({ global: 'not-an-array' }));
    const { getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    expect(getManualSuppressions().size).toBe(0);
  });
});

describe('setSuppression', () => {
  it('creates the file and writes the global list when toggled on', async () => {
    const { setSuppression } = await import('../src/agent/skill-suppressions.js');
    const r = setSuppression('a-bad-skill', 'global', true);
    expect(r.scope).toBe('global');
    expect(r.list).toEqual(['a-bad-skill']);
    expect(existsSync(fileAt())).toBe(true);
    const onDisk = JSON.parse(readFileSync(fileAt(), 'utf-8'));
    expect(onDisk.global).toEqual(['a-bad-skill']);
  });

  it('removes a skill from the list when toggled off', async () => {
    const { setSuppression } = await import('../src/agent/skill-suppressions.js');
    setSuppression('a', 'global', true);
    setSuppression('b', 'global', true);
    const r = setSuppression('a', 'global', false);
    expect(r.list).toEqual(['b']);
  });

  it('writes per-agent suppressions to the named slug key', async () => {
    const { setSuppression, getManualSuppressions } = await import('../src/agent/skill-suppressions.js');
    setSuppression('alex-only', 'sales-agent', true);
    expect(getManualSuppressions('sales-agent')).toEqual(new Set(['alex-only']));
    expect(getManualSuppressions()).toEqual(new Set()); // global stays empty
  });

  it('toggling off a skill that was never on is a no-op', async () => {
    const { setSuppression } = await import('../src/agent/skill-suppressions.js');
    const r = setSuppression('never-was-suppressed', 'global', false);
    expect(r.list).toEqual([]);
  });

  it('persists a sorted list (deterministic on disk)', async () => {
    const { setSuppression } = await import('../src/agent/skill-suppressions.js');
    setSuppression('zebra', 'global', true);
    setSuppression('alpha', 'global', true);
    setSuppression('mango', 'global', true);
    const onDisk = JSON.parse(readFileSync(fileAt(), 'utf-8'));
    expect(onDisk.global).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('global toggling does not affect per-agent lists and vice versa', async () => {
    const { setSuppression, listAllSuppressions } = await import('../src/agent/skill-suppressions.js');
    setSuppression('shared-name', 'global', true);
    setSuppression('shared-name', 'sales-agent', true);
    const all = listAllSuppressions();
    expect(all.global).toEqual(['shared-name']);
    expect(all['sales-agent']).toEqual(['shared-name']);
    setSuppression('shared-name', 'global', false);
    const after = listAllSuppressions();
    expect(after.global).toEqual([]);
    expect(after['sales-agent']).toEqual(['shared-name']);
  });
});

describe('listAllSuppressions', () => {
  it('returns the full file shape including all per-agent keys', async () => {
    writeFileSync(fileAt(), JSON.stringify({
      global: ['g1'],
      'sales-agent': ['r1', 'r2'],
      'marketing-agent': ['s1'],
    }));
    const { listAllSuppressions } = await import('../src/agent/skill-suppressions.js');
    const all = listAllSuppressions();
    expect(all.global).toEqual(['g1']);
    expect(all['sales-agent']).toEqual(['r1', 'r2']);
    expect(all['marketing-agent']).toEqual(['s1']);
  });
});
