import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadPromptOverrides,
  loadPromptOverridesForJob,
  _resetLoaderState,
} from '../src/agent/prompt-overrides/loader.js';

describe('prompt overrides loader', () => {
  let baseDir: string;

  beforeEach(() => {
    _resetLoaderState();
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-overrides-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function writeOverride(rel: string, content: string): void {
    const p = path.join(baseDir, 'prompt-overrides', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  it('returns empty when no overrides exist', () => {
    const out = loadPromptOverridesForJob('any-job', 'any-agent', { baseDir });
    expect(out).toBe('');
  });

  it('loads a global override and applies to every job', () => {
    writeOverride('_global.md', 'Always do X.');
    const a = loadPromptOverridesForJob('job-1', undefined, { baseDir });
    const b = loadPromptOverridesForJob('job-2', 'agent-z', { baseDir });
    expect(a).toBe('Always do X.');
    expect(b).toBe('Always do X.');
  });

  it('agent-scoped override only applies to that agent', () => {
    writeOverride('agents/ross.md', 'Ross-specific guidance.');
    const matched = loadPromptOverridesForJob('any-job', 'ross', { baseDir });
    const unmatched = loadPromptOverridesForJob('any-job', 'sasha', { baseDir });
    expect(matched).toBe('Ross-specific guidance.');
    expect(unmatched).toBe('');
  });

  it('job-scoped override only applies to that job', () => {
    writeOverride('jobs/market-leader-followup.md', 'Use batches of 50.');
    const matched = loadPromptOverridesForJob('market-leader-followup', undefined, { baseDir });
    const unmatched = loadPromptOverridesForJob('audit-inbox-check', undefined, { baseDir });
    expect(matched).toBe('Use batches of 50.');
    expect(unmatched).toBe('');
  });

  it('concatenates global + agent + job in priority order (lower first)', () => {
    writeOverride('_global.md', 'GLOBAL');
    writeOverride('agents/ross.md', 'AGENT');
    writeOverride('jobs/reply-detection.md', 'JOB');
    const out = loadPromptOverridesForJob('reply-detection', 'ross', { baseDir });
    // Default priorities: global=10 < agent=50 < job=100
    expect(out).toBe('GLOBAL\n\nAGENT\n\nJOB');
  });

  it('respects custom priority from frontmatter', () => {
    writeOverride('_global.md', '---\npriority: 200\n---\nGLOBAL');
    writeOverride('jobs/x.md', 'JOB');
    const out = loadPromptOverridesForJob('x', undefined, { baseDir });
    // Job priority 100 < custom global priority 200, so job comes first
    expect(out).toBe('JOB\n\nGLOBAL');
  });

  it('strips frontmatter from body, keeps only the content', () => {
    writeOverride('jobs/x.md', '---\nschemaVersion: 1\npriority: 50\n---\n\nThe actual prompt addition.');
    const out = loadPromptOverridesForJob('x', undefined, { baseDir });
    expect(out).toBe('The actual prompt addition.');
  });

  it('skips empty-body files', () => {
    writeOverride('jobs/x.md', '---\npriority: 50\n---\n');
    const out = loadPromptOverridesForJob('x', undefined, { baseDir });
    expect(out).toBe('');
  });

  it('loadPromptOverrides reports counts by scope', () => {
    writeOverride('_global.md', 'g');
    writeOverride('agents/a1.md', 'a1');
    writeOverride('agents/a2.md', 'a2');
    writeOverride('jobs/j1.md', 'j1');
    const out = loadPromptOverrides({ baseDir });
    expect(out.length).toBe(4);
    expect(out.filter(o => o.scope === 'global').length).toBe(1);
    expect(out.filter(o => o.scope === 'agent').length).toBe(2);
    expect(out.filter(o => o.scope === 'job').length).toBe(1);
  });

  it('handles invalid frontmatter gracefully — skips file, does not throw', () => {
    writeOverride('jobs/good.md', 'good body');
    writeOverride('jobs/bad.md', '---\n: not a key\n---\nbody');
    // Don't crash the loader.
    expect(() => loadPromptOverrides({ baseDir })).not.toThrow();
  });
});
