/**
 * PRD §6 Phase 4d / 1.18.102 — path-b-installer tests.
 *
 * Covers: template shape, install (fresh / update), refusal-to-overwrite
 * user content, status reporting, uninstall semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSettingsTemplate,
  installPathBHooks,
  getHooksStatus,
  uninstallPathBHooks,
} from '../src/agent/path-b-installer.js';

let tmpProj: string;

beforeEach(() => { tmpProj = mkdtempSync(path.join(tmpdir(), 'clem-pathb-')); });
afterEach(() => { rmSync(tmpProj, { recursive: true, force: true }); });

describe('buildSettingsTemplate', () => {
  it('reads the token from disk at fire time via $(cat ...) instead of baking it', () => {
    // 1.18.151 — no more baked literal. The curl substitutes $(cat <path>)
    // so dashboard token rotation propagates without re-installing hooks.
    const tpl = buildSettingsTemplate({ port: 3030, tokenFilePath: '/tmp/test-tok' }) as Record<string, unknown>;
    const hooks = (tpl.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>);
    const cmd = hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain('X-Dashboard-Token: $(cat /tmp/test-tok 2>/dev/null)');
    expect(cmd).toContain('http://127.0.0.1:3030/api/hooks/event');
    expect(cmd).not.toContain('X-Dashboard-Token: /tmp/test-tok'); // not baked
  });

  it('defaults the token file path to ~/.clementine/.dashboard-token', () => {
    const tpl = buildSettingsTemplate({ port: 3030 }) as Record<string, unknown>;
    const hooks = (tpl.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>);
    const cmd = hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain('.clementine/.dashboard-token');
    expect(cmd).toContain('$(cat ');
  });

  it('respects a custom port', () => {
    const tpl = buildSettingsTemplate({ port: 9999 }) as Record<string, unknown>;
    const hooks = (tpl.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>);
    expect(hooks.PreToolUse[0].hooks[0].command).toContain(':9999/api/hooks/event');
  });

  it('defaults port to 3030', () => {
    const tpl = buildSettingsTemplate() as Record<string, unknown>;
    const hooks = (tpl.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>);
    expect(hooks.PreToolUse[0].hooks[0].command).toContain(':3030/');
  });

  it('includes all expected hook event keys (PreCompact + PostCompact added 1.18.151)', () => {
    const tpl = buildSettingsTemplate() as Record<string, unknown>;
    const hooks = tpl.hooks as Record<string, unknown>;
    const expected = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Notification', 'UserPromptSubmit', 'SessionStart', 'PreCompact', 'PostCompact'];
    for (const k of expected) expect(hooks[k]).toBeDefined();
  });

  it('stamps a _clementine sentinel for re-install detection', () => {
    const tpl = buildSettingsTemplate() as Record<string, unknown>;
    const sentinel = tpl._clementine as { managedBy?: string; installerVersion?: string } | undefined;
    expect(sentinel).toBeDefined();
    expect(sentinel!.managedBy).toContain('clementine');
    expect(sentinel!.installerVersion).toBe('1.18.151');
  });
});

describe('installPathBHooks', () => {
  it('fresh install writes the file and reports wasExisting=false', () => {
    const result = installPathBHooks(tmpProj);
    expect(result.ok).toBe(true);
    expect(result.wasExisting).toBe(false);
    expect(result.wasUpdate).toBe(false);
    expect(result.filePath).toBe(path.join(tmpProj, '.claude', 'settings.local.json'));
    expect(existsSync(result.filePath)).toBe(true);
  });

  it('reinstall over our own file reports wasUpdate=true', () => {
    installPathBHooks(tmpProj, { port: 3030 });
    const result = installPathBHooks(tmpProj, { port: 3031 });
    expect(result.ok).toBe(true);
    expect(result.wasExisting).toBe(true);
    expect(result.wasUpdate).toBe(true);
    // New port should be reflected in the file.
    const content = JSON.parse(readFileSync(result.filePath, 'utf-8'));
    const cmd = content.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain(':3031/');
  });

  it('refuses to overwrite a user-created settings.local.json', () => {
    const dir = path.join(tmpProj, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['*'] } }));
    const result = installPathBHooks(tmpProj);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not created by clementine');
    // User file must remain untouched.
    const content = JSON.parse(readFileSync(path.join(dir, 'settings.local.json'), 'utf-8'));
    expect(content.permissions).toBeDefined();
  });

  it('refuses to overwrite an unparseable settings.local.json', () => {
    const dir = path.join(tmpProj, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.local.json'), 'not json');
    const result = installPathBHooks(tmpProj);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not parse');
  });

  it('errors when workDir is empty', () => {
    const result = installPathBHooks('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('workDir');
  });
});

describe('getHooksStatus', () => {
  it('reports installed=false when no file exists', () => {
    const s = getHooksStatus(tmpProj);
    expect(s.installed).toBe(false);
    expect(s.managedByUs).toBe(false);
  });

  it('reports managedByUs=true after a fresh install', () => {
    installPathBHooks(tmpProj);
    const s = getHooksStatus(tmpProj);
    expect(s.installed).toBe(true);
    expect(s.managedByUs).toBe(true);
    expect(s.installedAt).toBeDefined();
  });

  it('reports conflictsWithUser when a non-clementine file exists', () => {
    const dir = path.join(tmpProj, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['*'] } }));
    const s = getHooksStatus(tmpProj);
    expect(s.installed).toBe(true);
    expect(s.managedByUs).toBe(false);
    expect(s.conflictsWithUser).toBe(true);
  });
});

describe('uninstallPathBHooks', () => {
  it('removes our own file', () => {
    installPathBHooks(tmpProj);
    const filePath = path.join(tmpProj, '.claude', 'settings.local.json');
    expect(existsSync(filePath)).toBe(true);
    const result = uninstallPathBHooks(tmpProj);
    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('refuses to remove a user-created file', () => {
    const dir = path.join(tmpProj, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['*'] } }));
    const result = uninstallPathBHooks(tmpProj);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not managed by clementine');
    expect(existsSync(path.join(dir, 'settings.local.json'))).toBe(true);
  });

  it('returns ok when no file exists (idempotent)', () => {
    const result = uninstallPathBHooks(tmpProj);
    expect(result.ok).toBe(true);
  });
});
