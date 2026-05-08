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

/** Write a folder-form skill (Anthropic spec: <name>/SKILL.md). The
 *  frontmatter is YAML that gray-matter will parse. */
function writeFolderSkill(name: string, frontmatter: Record<string, unknown>, body = 'Folder skill body.'): string {
  const folder = path.join(GLOBAL_SKILLS_DIR, name);
  mkdirSync(folder, { recursive: true });
  // Build YAML carefully — JSON.stringify works for primitives but objects
  // need to be flattened into nested mapping form for gray-matter to read.
  function toYaml(value: unknown, indent = 0): string {
    const pad = '  '.repeat(indent);
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return value.map(v => `\n${pad}- ${toYaml(v, indent + 1).trimStart()}`).join('');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      const rendered = toYaml(v, indent + 1);
      const isMulti = typeof v === 'object' && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0);
      return `\n${pad}${k}:${isMulti ? rendered : ' ' + rendered}`;
    }).join('');
  }
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    const rendered = toYaml(v, 1);
    const isMulti = typeof v === 'object' && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0);
    return `${k}:${isMulti ? rendered : ' ' + rendered}`;
  }).join('\n');
  writeFileSync(path.join(folder, 'SKILL.md'), `---\n${fm}\n---\n${body}\n`);
  return folder;
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

describe('buildSkillContext — folder-form skills (Anthropic spec)', () => {
  // The C-0 regression: after migrating `<name>.md` → `<name>/SKILL.md`,
  // pinning by `<name>` silently failed because the loader computed the
  // slug as `<name>-SKILL`. Every test here would have failed pre-fix.

  it('resolves a pinned folder-form skill by its folder name', async () => {
    writeFolderSkill('morning-briefing', {
      name: 'morning-briefing',
      description: 'How to send the morning brief',
    }, 'STEP 1: Check inbox.\nSTEP 2: Summarize.');
    const result = await buildSkillContext(
      'morning-cron', 'do the morning brief', undefined,
      ['morning-briefing'], null,
    );
    expect(result.missing).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ name: 'morning-briefing', source: 'pinned' });
    expect(result.text).toContain('STEP 1: Check inbox.');
    expect(result.text).toContain('STEP 2: Summarize.');
  });

  it('returns the FULL body of a folder-form skill (no 1500-char cap)', async () => {
    // Body deliberately > 1500 chars so the legacy slice would truncate.
    const longBody = 'Procedure step. '.repeat(200);  // ~3,200 chars
    expect(longBody.length).toBeGreaterThan(2000);
    writeFolderSkill('long-procedure', {
      name: 'long-procedure',
      description: 'Long procedure',
    }, longBody);
    const result = await buildSkillContext(
      'job', 'prompt', undefined, ['long-procedure'], null,
    );
    expect(result.applied).toHaveLength(1);
    // Loader returns the full body. The 1500-char truncation that capped
    // legacy skills is gone — the cron prompt now sees the whole procedure.
    expect(result.text.length).toBeGreaterThan(longBody.length - 200);
    expect(result.text).toContain(longBody.slice(-200));
  });

  it('inlines bundled .md files (templates/, reference docs) into the skill block', async () => {
    const folder = writeFolderSkill('cold-outreach', {
      name: 'cold-outreach',
      description: 'Send cold outreach emails',
    }, 'See templates/intro.md for the opener.');
    // Sibling reference doc
    writeFileSync(path.join(folder, 'tone.md'), '# Tone Guide\nWarm, concise, human.\n');
    // Templates sub-dir
    mkdirSync(path.join(folder, 'templates'), { recursive: true });
    writeFileSync(path.join(folder, 'templates', 'intro.md'), '# Intro\nHi {{name}}, ...');
    writeFileSync(path.join(folder, 'templates', 'follow-up.md'), '# Follow-up\nJust circling back.');

    const result = await buildSkillContext(
      'cold-outreach-cron', 'send the morning batch', undefined,
      ['cold-outreach'], null,
    );
    expect(result.applied).toHaveLength(1);
    // SKILL.md body lands in the block.
    expect(result.text).toContain('See templates/intro.md');
    // Sibling reference is inlined.
    expect(result.text).toContain('# Tone Guide');
    expect(result.text).toContain('Warm, concise, human.');
    // Templates sub-dir contents are inlined with directory label.
    expect(result.text).toContain('templates/intro.md');
    expect(result.text).toContain('Hi {{name}}');
    expect(result.text).toContain('templates/follow-up.md');
  });

  it('exposes clementine.tools.allow as toolsUsed in the skill block', async () => {
    writeFolderSkill('typed-skill', {
      name: 'typed-skill',
      description: 'Skill with allowlist',
      clementine: {
        tools: {
          allow: ['Read', 'Bash', 'mcp__plugin_proposal-builder_dataforseo__serp_organic_live_advanced'],
        },
      },
    }, 'Steps.');
    const result = await buildSkillContext(
      'job', 'prompt', undefined, ['typed-skill'], null,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.text).toContain('**Tools:**');
    expect(result.text).toContain('Read');
    expect(result.text).toContain('Bash');
    expect(result.text).toContain('serp_organic_live_advanced');
  });

  it('flat and folder forms coexist — both resolve correctly', async () => {
    writeGlobalSkill('legacy-flat', {
      title: 'Legacy flat', description: 'old style', triggers: ['x'],
    });
    writeFolderSkill('modern-folder', {
      name: 'modern-folder', description: 'new style',
    });
    const result = await buildSkillContext(
      'job', 'prompt', undefined,
      ['legacy-flat', 'modern-folder'], null,
    );
    expect(result.missing).toEqual([]);
    expect(result.applied.map(a => a.name)).toEqual(['legacy-flat', 'modern-folder']);
  });
});
