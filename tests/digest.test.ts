import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDigestPrefs } from '../src/cli/routes/digest.js';

const TEST_DIR = path.join(os.tmpdir(), 'clem-test-digest-' + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Digest Preferences', () => {
  it('returns defaults when file does not exist', () => {
    const prefs = getDigestPrefs(path.join(TEST_DIR, 'nonexistent.json'));
    expect(prefs.enabled).toBe(false);
    expect(prefs.schedule).toBe('0 8 * * 1-5');
    expect((prefs.channels as Record<string, boolean>).email).toBe(true);
    expect((prefs.channels as Record<string, boolean>).discord).toBe(true);
    expect((prefs.channels as Record<string, boolean>).voice).toBe(false);
    expect((prefs.sections as Record<string, boolean>).goals).toBe(true);
    expect((prefs.quietHours as Record<string, number>).start).toBe(22);
  });

  it('reads saved preferences and merges with defaults', () => {
    const prefsFile = path.join(TEST_DIR, 'prefs.json');
    writeFileSync(prefsFile, JSON.stringify({
      enabled: true,
      schedule: '0 7 * * *',
      emailRecipient: 'nate@example.com',
    }));

    const prefs = getDigestPrefs(prefsFile);
    expect(prefs.enabled).toBe(true);
    expect(prefs.schedule).toBe('0 7 * * *');
    expect(prefs.emailRecipient).toBe('nate@example.com');
    // Defaults still present for unset fields
    expect((prefs.channels as Record<string, boolean>).email).toBe(true);
    expect((prefs.sections as Record<string, boolean>).goals).toBe(true);
  });

  it('handles malformed JSON by returning defaults', () => {
    const prefsFile = path.join(TEST_DIR, 'bad.json');
    writeFileSync(prefsFile, 'not valid json{{{');

    const prefs = getDigestPrefs(prefsFile);
    expect(prefs.enabled).toBe(false);
    expect(prefs.schedule).toBe('0 8 * * 1-5');
  });

  it('writes and reads back preferences', () => {
    const prefsFile = path.join(TEST_DIR, 'roundtrip.json');

    const updated = {
      enabled: true,
      schedule: '0 9 * * 1-5',
      channels: { email: true, discord: false, slack: true, voice: true },
      emailRecipient: 'test@company.com',
      sections: { goals: true, crons: false, activity: true, metrics: false, approvals: true },
      quietHours: { start: 23, end: 7 },
    };
    writeFileSync(prefsFile, JSON.stringify(updated, null, 2));

    const loaded = getDigestPrefs(prefsFile);
    expect(loaded.enabled).toBe(true);
    expect(loaded.schedule).toBe('0 9 * * 1-5');
    expect((loaded.channels as Record<string, boolean>).slack).toBe(true);
    expect((loaded.channels as Record<string, boolean>).discord).toBe(false);
    expect((loaded.sections as Record<string, boolean>).crons).toBe(false);
    expect((loaded.quietHours as Record<string, number>).start).toBe(23);
    expect(loaded.emailRecipient).toBe('test@company.com');
  });
});
