/**
 * Skill pin resolution — buildSkillContext.
 */

import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT_DIR = mkdtempSync(path.join(tmpdir(), 'clem-skill-pin-root-'));
(globalThis as any).__CLEM_TEST_VAULT_DIR = path.join(ROOT_DIR, 'vault');
(globalThis as any).__CLEM_TEST_AGENTS_DIR = path.join(ROOT_DIR, 'vault', '00-System', 'agents');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    get VAULT_DIR() { return (globalThis as any).__CLEM_TEST_VAULT_DIR as string; },
    get AGENTS_DIR() { return (globalThis as any).__CLEM_TEST_AGENTS_DIR as string; },
  };
});

const { buildSkillContext } = await import('../src/agent/run-agent-cron.js');

// `skill-extractor.ts` captures `VAULT_DIR` into a module-level constant at
// import time (`const GLOBAL_SKILLS_DIR = path.join(VAULT_DIR, ...)`), so we
// pin a single skills root for the whole suite and clean it between tests
// rather than rotating temp dirs per test.
const GLOBAL_SKILLS_DIR = path.join(ROOT_DIR, 'vault', '00-System', 'skills');
function agentSkillsDir(slug: string): string {
  return path.join(ROOT_DIR, 'vault', '00-System', 'agents', slug, 'skills');
}

function writeGlobalSkill(name: string, frontmatter: Record<string, unknown>, body = 'Steps go here.'): void {
  mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(path.join(GLOBAL_SKILLS_DIR, `${name}.md`), `---\n${fm}\n---\n${body}\n`);
}

function writeAgentSkill(slug: string, name: string, frontmatter: Record<string, unknown>, body = 'Agent steps.'): void {
  const dir = agentSkillsDir(slug);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(path.join(dir, `${name}.md`), `---\n${fm}\n---\n${body}\n`);
}

beforeEach(() => {
  if (existsSync(GLOBAL_SKILLS_DIR)) rmSync(GLOBAL_SKILLS_DIR, { recursive: true, force: true });
  const agentsRoot = path.join(ROOT_DIR, 'vault', '00-System', 'agents');
  if (existsSync(agentsRoot)) rmSync(agentsRoot, { recursive: true, force: true });
});

beforeAll(() => { /* no-op */ });
afterAll(() => {
  if (existsSync(ROOT_DIR)) rmSync(ROOT_DIR, { recursive: true, force: true });
});

describe('buildSkillContext — pinned + auto-match composition', () => {
  it('returns empty when no pins and nothing matches', async () => {
    const result = await buildSkillContext('lonely-job', 'do nothing in particular', undefined, undefined, null);
    expect(result.text).toBe('');
    expect(result.applied).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('loads pinned skills by exact slug, marks them as source=pinned', async () => {
    writeGlobalSkill('research-protocol', {
      title: 'Research protocol',
      description: 'How to do research',
      triggers: ['research'],
    });
    writeGlobalSkill('summarize-news', {
      title: 'Summarize news',
      description: 'How to summarize',
      triggers: ['summarize'],
    });
    const result = await buildSkillContext(
      'morning-research', 'do the research today', undefined,
      ['research-protocol', 'summarize-news'], null,
    );
    expect(result.applied).toHaveLength(2);
    expect(result.applied.map(a => a.name)).toEqual(['research-protocol', 'summarize-news']);
    expect(result.applied.every(a => a.source === 'pinned')).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.text).toContain('Research protocol');
    expect(result.text).toContain('Summarize news');
    expect(result.text).toContain('_(pinned)_');
  });

  it('auto-match fills remaining slots when pins < cap, and pins render first', async () => {
    writeGlobalSkill('pinned-one', {
      title: 'Pinned one', description: 'first', triggers: ['unrelated'],
    });
    writeGlobalSkill('matched-by-trigger', {
      title: 'Matched by trigger', description: 'second',
      triggers: ['research', 'morning'],
    });
    const result = await buildSkillContext(
      'morning-research-job', 'morning research run', undefined,
      ['pinned-one'], null,
    );
    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    expect(result.applied[0]).toMatchObject({ name: 'pinned-one', source: 'pinned' });
    const matchedIdx = result.applied.findIndex(a => a.name === 'matched-by-trigger');
    if (matchedIdx >= 0) {
      expect(matchedIdx).toBeGreaterThan(0);
      expect(result.applied[matchedIdx].source).toBe('auto');
    }
  });

  it('does not duplicate when a pinned skill also matches the auto-match query', async () => {
    writeGlobalSkill('shared-skill', {
      title: 'Shared skill', description: 'matches both ways',
      triggers: ['morning', 'research'],
    });
    const result = await buildSkillContext(
      'morning-research', 'morning research run', undefined,
      ['shared-skill'], null,
    );
    const occurrences = result.applied.filter(a => a.name === 'shared-skill').length;
    expect(occurrences).toBe(1);
    expect(result.applied[0]).toMatchObject({ name: 'shared-skill', source: 'pinned' });
  });

  it('pinned slug that does not exist on disk is reported in missing[] and not fatal', async () => {
    writeGlobalSkill('exists', { title: 'Exists', description: 'ok', triggers: ['x'] });
    const result = await buildSkillContext(
      'job', 'prompt', undefined,
      ['exists', 'does-not-exist', 'also-missing'], null,
    );
    expect(result.applied.map(a => a.name)).toEqual(['exists']);
    expect(result.missing).toEqual(['does-not-exist', 'also-missing']);
    expect(result.text).toContain('Exists');
  });

  it('respects the suppressed-names set from the memoryStore (treats as missing)', async () => {
    writeGlobalSkill('shouty-skill', {
      title: 'Shouty', description: 'noisy', triggers: ['x'],
    });
    const fakeMemoryStore = {
      getSkillsToSuppress: () => new Set(['shouty-skill']),
    };
    const result = await buildSkillContext(
      'job', 'prompt', undefined, ['shouty-skill'],
      fakeMemoryStore as unknown as Parameters<typeof buildSkillContext>[4],
    );
    expect(result.applied).toEqual([]);
    expect(result.missing).toEqual(['shouty-skill']);
  });

  it('caps total injected skills at MAX_INJECTED_SKILLS (4) when many pins requested', async () => {
    for (let i = 1; i <= 7; i++) {
      writeGlobalSkill(`pin-${i}`, {
        title: `Pin ${i}`, description: `skill ${i}`, triggers: [`pin${i}`],
      });
    }
    const result = await buildSkillContext(
      'job', 'prompt', undefined,
      ['pin-1', 'pin-2', 'pin-3', 'pin-4', 'pin-5', 'pin-6', 'pin-7'], null,
    );
    expect(result.applied).toHaveLength(4);
    expect(result.applied.map(a => a.name)).toEqual(['pin-1', 'pin-2', 'pin-3', 'pin-4']);
  });

  it('agent-scoped skills resolve when an agentSlug is passed', async () => {
    writeAgentSkill('ross-the-sdr', 'agent-only-skill', {
      title: 'Agent only', description: 'lives under the agent', triggers: ['x'],
    });
    const result = await buildSkillContext(
      'ross-the-sdr:job', 'prompt', 'ross-the-sdr',
      ['agent-only-skill'], null,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ name: 'agent-only-skill', source: 'pinned' });
    expect(result.missing).toEqual([]);
  });
});
