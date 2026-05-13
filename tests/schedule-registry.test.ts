/**
 * Schedule registry — read/write/list/upsert/remove/enable.
 *
 * The architectural shift in 1.18.129: schedules live in a separate
 * registry instead of CRON.md so skills can stay 100% Anthropic-pure.
 * These tests cover the file-IO + merge behavior; the cron-scheduler
 * integration (parseCronJobs reading the registry alongside CRON.md)
 * is covered by the cron-job-parsing test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'clem-sched-'));
  prevHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome) process.env.CLEMENTINE_HOME = prevHome; else delete process.env.CLEMENTINE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

const fileAt = () => path.join(tmpHome, 'schedules.json');

describe('listSchedules', () => {
  it('returns an empty array when the file does not exist', async () => {
    const { listSchedules } = await import('../src/agent/schedule-registry.js');
    expect(listSchedules()).toEqual([]);
  });

  it('flattens the on-disk shape into ScheduleEntry[] with skillName', async () => {
    writeFileSync(fileAt(), JSON.stringify({
      'morning-briefing': { schedule: '0 7 * * 1-5', enabled: true, agentSlug: null },
      'weekly-review': { schedule: '0 17 * * 5', enabled: false, agentSlug: 'marketing-agent' },
    }));
    const { listSchedules } = await import('../src/agent/schedule-registry.js');
    const result = listSchedules();
    expect(result).toHaveLength(2);
    const morning = result.find(e => e.skillName === 'morning-briefing');
    expect(morning?.schedule).toBe('0 7 * * 1-5');
    expect(morning?.enabled).toBe(true);
    const weekly = result.find(e => e.skillName === 'weekly-review');
    expect(weekly?.enabled).toBe(false);
    expect(weekly?.agentSlug).toBe('marketing-agent');
  });

  it('survives a malformed JSON file (returns empty array)', async () => {
    writeFileSync(fileAt(), 'not valid json {{');
    const { listSchedules } = await import('../src/agent/schedule-registry.js');
    expect(listSchedules()).toEqual([]);
  });

  it('skips entries whose value is not an object', async () => {
    writeFileSync(fileAt(), JSON.stringify({
      'good-skill': { schedule: '0 9 * * *', enabled: true },
      'bad-skill-1': 'not an object',
      'bad-skill-2': null,
      'bad-skill-3': ['array', 'value'],
    }));
    const { listSchedules } = await import('../src/agent/schedule-registry.js');
    const r = listSchedules();
    expect(r).toHaveLength(1);
    expect(r[0].skillName).toBe('good-skill');
  });

  it('defaults missing optional fields to sensible values', async () => {
    // Simulate a hand-edited file with only schedule — everything else
    // should default cleanly without throwing.
    writeFileSync(fileAt(), JSON.stringify({
      'minimal-skill': { schedule: '0 9 * * *' },
    }));
    const { listSchedules } = await import('../src/agent/schedule-registry.js');
    const [entry] = listSchedules();
    expect(entry.enabled).toBe(true);    // default true
    expect(entry.agentSlug).toBeNull();
    expect(entry.addedAt).toBeUndefined();
  });

  it('treats enabled !== false as enabled (so missing key = enabled)', async () => {
    writeFileSync(fileAt(), JSON.stringify({
      'no-enabled-key': { schedule: '0 9 * * *' },
      'explicit-true': { schedule: '0 10 * * *', enabled: true },
      'explicit-false': { schedule: '0 11 * * *', enabled: false },
    }));
    const { listSchedules } = await import('../src/agent/schedule-registry.js');
    const r = listSchedules();
    const byName = Object.fromEntries(r.map(e => [e.skillName, e]));
    expect(byName['no-enabled-key'].enabled).toBe(true);
    expect(byName['explicit-true'].enabled).toBe(true);
    expect(byName['explicit-false'].enabled).toBe(false);
  });
});

describe('getSchedule', () => {
  it('returns null when the skill is not scheduled', async () => {
    const { getSchedule } = await import('../src/agent/schedule-registry.js');
    expect(getSchedule('does-not-exist')).toBeNull();
  });

  it('returns the entry with skillName populated', async () => {
    writeFileSync(fileAt(), JSON.stringify({
      'cold-outreach': { schedule: '0 8 * * 1-5', enabled: true, agentSlug: 'sales-agent' },
    }));
    const { getSchedule } = await import('../src/agent/schedule-registry.js');
    const r = getSchedule('cold-outreach');
    expect(r).not.toBeNull();
    expect(r!.skillName).toBe('cold-outreach');
    expect(r!.schedule).toBe('0 8 * * 1-5');
    expect(r!.agentSlug).toBe('sales-agent');
  });
});

describe('setSchedule', () => {
  it('creates the file and writes the entry on first call', async () => {
    const { setSchedule } = await import('../src/agent/schedule-registry.js');
    const r = setSchedule('morning-briefing', { schedule: '0 7 * * 1-5' });
    expect(r.skillName).toBe('morning-briefing');
    expect(r.schedule).toBe('0 7 * * 1-5');
    expect(r.enabled).toBe(true); // default
    expect(r.agentSlug).toBeNull();
    expect(r.addedAt).toBeTruthy();
    expect(r.lastModifiedAt).toBeTruthy();
    expect(existsSync(fileAt())).toBe(true);
  });

  it('preserves addedAt across edits but updates lastModifiedAt', async () => {
    const { setSchedule } = await import('../src/agent/schedule-registry.js');
    const first = setSchedule('foo', { schedule: '0 9 * * *' });
    // Wait one millisecond to guarantee distinct ISO timestamps.
    await new Promise(r => setTimeout(r, 5));
    const second = setSchedule('foo', { schedule: '0 10 * * *' });
    expect(second.addedAt).toBe(first.addedAt);
    expect(second.lastModifiedAt).not.toBe(first.lastModifiedAt);
    expect(second.schedule).toBe('0 10 * * *');
  });

  it('honors enabled=false explicitly', async () => {
    const { setSchedule } = await import('../src/agent/schedule-registry.js');
    const r = setSchedule('paused-skill', { schedule: '0 9 * * *', enabled: false });
    expect(r.enabled).toBe(false);
  });

  it('persists agentSlug for hired-agent skills', async () => {
    const { setSchedule, getSchedule } = await import('../src/agent/schedule-registry.js');
    setSchedule('skill-of-morgan', { schedule: '0 14 * * *', agentSlug: 'marketing-agent' });
    const r = getSchedule('skill-of-morgan');
    expect(r?.agentSlug).toBe('marketing-agent');
  });

  it('persists multiple entries on disk in sorted-key order', async () => {
    const { setSchedule } = await import('../src/agent/schedule-registry.js');
    setSchedule('zebra', { schedule: '0 9 * * *' });
    setSchedule('alpha', { schedule: '0 10 * * *' });
    setSchedule('mango', { schedule: '0 11 * * *' });
    const onDisk = JSON.parse(readFileSync(fileAt(), 'utf-8'));
    // Object key iteration in JSON is preserved insertion order; we
    // sort on write so the file is git-friendly.
    expect(Object.keys(onDisk)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('throws when skillName is empty', async () => {
    const { setSchedule } = await import('../src/agent/schedule-registry.js');
    expect(() => setSchedule('', { schedule: '0 9 * * *' })).toThrow(/skillName required/);
  });
});

describe('removeSchedule', () => {
  it('removes the entry from the file', async () => {
    const { setSchedule, removeSchedule, getSchedule } = await import('../src/agent/schedule-registry.js');
    setSchedule('to-remove', { schedule: '0 9 * * *' });
    setSchedule('to-keep', { schedule: '0 10 * * *' });
    removeSchedule('to-remove');
    expect(getSchedule('to-remove')).toBeNull();
    expect(getSchedule('to-keep')).not.toBeNull();
  });

  it('is a silent no-op when the entry does not exist', async () => {
    const { removeSchedule } = await import('../src/agent/schedule-registry.js');
    expect(() => removeSchedule('never-was-scheduled')).not.toThrow();
  });
});

describe('enableSchedule', () => {
  it('flips the enabled flag without touching schedule or agentSlug', async () => {
    const { setSchedule, enableSchedule, getSchedule } = await import('../src/agent/schedule-registry.js');
    setSchedule('toggle-me', { schedule: '0 9 * * *', agentSlug: 'sales-agent', enabled: true });
    const r = enableSchedule('toggle-me', false);
    expect(r?.enabled).toBe(false);
    const fresh = getSchedule('toggle-me');
    expect(fresh?.schedule).toBe('0 9 * * *');
    expect(fresh?.agentSlug).toBe('sales-agent');
    expect(fresh?.enabled).toBe(false);
  });

  it('returns null when the skill is not scheduled', async () => {
    const { enableSchedule } = await import('../src/agent/schedule-registry.js');
    expect(enableSchedule('not-scheduled', true)).toBeNull();
  });

  it('updates lastModifiedAt on toggle', async () => {
    const { setSchedule, enableSchedule } = await import('../src/agent/schedule-registry.js');
    const initial = setSchedule('time-stamped', { schedule: '0 9 * * *' });
    await new Promise(r => setTimeout(r, 5));
    const toggled = enableSchedule('time-stamped', false);
    expect(toggled?.lastModifiedAt).not.toBe(initial.lastModifiedAt);
    expect(toggled?.addedAt).toBe(initial.addedAt);
  });
});
