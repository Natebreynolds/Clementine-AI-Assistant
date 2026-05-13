import { describe, it, expect } from 'vitest';
import { applyMustache, computeSkillAllowlist, buildSkillPrompt } from '../src/agent/run-skill.js';
import type { Skill } from '../src/types.js';

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    frontmatter: {
      name: 'test-skill',
      description: 'A skill for tests.',
      ...overrides.frontmatter,
    },
    body: overrides.body ?? '# Procedure\n\nDo the thing.',
    filePath: '/tmp/skills/test-skill/SKILL.md',
    scope: 'global',
    layout: 'folder',
    schemaVersion: 'clementine',
    bundledFiles: [],
    usedByTriggers: [],
    validation: [],
    ...overrides,
  };
}

describe('applyMustache', () => {
  it('substitutes simple {{var}} placeholders', () => {
    const out = applyMustache('Hello {{name}}, you have {{count}} messages.', {
      name: 'Owner',
      count: 3,
    });
    expect(out).toBe('Hello Owner, you have 3 messages.');
  });

  it('handles whitespace inside the braces', () => {
    expect(applyMustache('{{ foo }} and {{  bar  }}', { foo: 'a', bar: 'b' }))
      .toBe('a and b');
  });

  it('leaves unknown vars untouched (not silently dropped)', () => {
    expect(applyMustache('Hi {{name}}, your {{missing}} is ready', { name: 'N' }))
      .toBe('Hi N, your {{missing}} is ready');
  });

  it('returns body unchanged when inputs is undefined or empty', () => {
    expect(applyMustache('Hi {{name}}', undefined)).toBe('Hi {{name}}');
    expect(applyMustache('Hi {{name}}', {})).toBe('Hi {{name}}');
  });

  it('coerces numbers and booleans to strings', () => {
    expect(applyMustache('{{n}} {{flag}}', { n: 42, flag: true }))
      .toBe('42 true');
  });

  it('does not match malformed placeholders', () => {
    // single brace, leading digit, dot — none are valid identifiers
    expect(applyMustache('{name} {{1bad}} {{a.b}}', { name: 'x', '1bad': 'y' }))
      .toBe('{name} {{1bad}} {{a.b}}');
  });

  it('substitutes the same key multiple times', () => {
    expect(applyMustache('{{x}}-{{x}}-{{x}}', { x: 'a' })).toBe('a-a-a');
  });
});

describe('computeSkillAllowlist', () => {
  it('returns the baseline + declared tools.allow when present', () => {
    const skill = fakeSkill({
      frontmatter: {
        name: 'test',
        clementine: { tools: { allow: ['Bash', 'WebFetch'] } },
      },
    });
    const tools = computeSkillAllowlist(skill);
    // declared
    expect(tools).toContain('Bash');
    expect(tools).toContain('WebFetch');
    // baseline
    expect(tools).toContain('Agent');
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
  });

  it('returns just the baseline when no tools.allow declared', () => {
    const skill = fakeSkill();
    const tools = computeSkillAllowlist(skill);
    expect(tools.sort()).toEqual(['Agent', 'Glob', 'Grep', 'Read']);
  });

  it('auto-includes mcp__server__tool refs found in the body', () => {
    const skill = fakeSkill({
      body: 'Call mcp__Slack__send_message and also mcp__Gmail__list_inbox to get data.',
    });
    const tools = computeSkillAllowlist(skill);
    expect(tools).toContain('mcp__Slack__send_message');
    expect(tools).toContain('mcp__Gmail__list_inbox');
  });

  it('honors deny: deny wins over allow', () => {
    const skill = fakeSkill({
      frontmatter: {
        name: 'test',
        clementine: {
          tools: {
            allow: ['Bash', 'WebFetch', 'WebSearch'],
            deny: ['WebSearch'],
          },
        },
      },
    });
    const tools = computeSkillAllowlist(skill);
    expect(tools).toContain('Bash');
    expect(tools).toContain('WebFetch');
    expect(tools).not.toContain('WebSearch');
  });

  it('dedupes when declared and body-extracted overlap', () => {
    const skill = fakeSkill({
      body: 'Use mcp__Slack__send_message here.',
      frontmatter: {
        name: 'test',
        clementine: { tools: { allow: ['mcp__Slack__send_message'] } },
      },
    });
    const tools = computeSkillAllowlist(skill);
    const occurrences = tools.filter(t => t === 'mcp__Slack__send_message').length;
    expect(occurrences).toBe(1);
  });

  it('returns a stable result on repeated calls (regex state reset)', () => {
    const skill = fakeSkill({ body: 'Use mcp__X__y here.' });
    const a = computeSkillAllowlist(skill).sort();
    const b = computeSkillAllowlist(skill).sort();
    expect(a).toEqual(b);
  });
});

describe('buildSkillPrompt', () => {
  it('returns just the substituted body when no context provided', () => {
    const skill = fakeSkill({ body: 'Send to {{recipient}}' });
    const prompt = buildSkillPrompt(skill, { recipient: 'alice@x' }, undefined);
    expect(prompt).toBe('Send to alice@x');
  });

  it('appends caller context after the body when provided', () => {
    const skill = fakeSkill({ body: 'Procedure here.' });
    const prompt = buildSkillPrompt(skill, undefined, 'User asked: schedule it now');
    expect(prompt).toContain('Procedure here.');
    expect(prompt).toContain('## Caller context');
    expect(prompt).toContain('User asked: schedule it now');
  });

  it('skips the context block when context is empty/whitespace', () => {
    const skill = fakeSkill({ body: 'X' });
    expect(buildSkillPrompt(skill, undefined, '   ')).toBe('X');
    expect(buildSkillPrompt(skill, undefined, '')).toBe('X');
  });

  it('substitutes inputs even when context is also present', () => {
    const skill = fakeSkill({ body: 'Hello {{name}}!' });
    const prompt = buildSkillPrompt(skill, { name: 'World' }, 'context here');
    expect(prompt).toContain('Hello World!');
    expect(prompt).toContain('context here');
  });
});
