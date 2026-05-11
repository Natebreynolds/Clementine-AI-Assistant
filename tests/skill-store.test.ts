/**
 * Phase A / A.5 — skill-store tests.
 *
 * Covers: discovery for both layouts (folder w/ SKILL.md + flat .md),
 * parse for all three frontmatter shapes (anthropic / clementine / legacy),
 * Anthropic spec validations, bundled file discovery, used-by join,
 * per-project precedence, parse errors, .bak / hidden filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import type { CronJobDefinition } from '../src/types.js';

let tmpHome: string;
let prevHome: string | undefined;

const ANTHROPIC_FRONTMATTER = `---
name: processing-pdfs
description: Extracts text from PDFs and fills forms. Use when working with PDF files.
---
# Processing PDFs

Use pdfplumber to extract text.
`;

const CLEMENTINE_FRONTMATTER = `---
name: audit-inbox-check
description: Watches the inbox for new audits and posts to Discord.
clementine:
  inputs:
    channel_id:
      type: string
      default: "12345"
  tools:
    allow:
      - outlook_search
      - discord_channel_send_buttons
  dataSources:
    - kind: outlook
      purpose: read incoming audit requests
  stateKeys:
    - processed_ids
  success:
    criterion: "All new audits posted."
  limits:
    maxTurns: 8
  version: 2
---
# Audit Inbox Check
Procedure body.
`;

const LEGACY_FRONTMATTER = `---
title: Audit Queue Approval
description: Old skill from before redesign.
triggers:
  - audit approved
  - build brief
source: manual
toolsUsed:
  - workspace_config
useCount: 6
createdAt: '2026-04-20T17:00:00.000Z'
---
# Body
Old procedure.
`;

const BAD_YAML = `---
title: Broken
inputs: { not valid yaml
---
body
`;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'clem-skills-'));
  mkdirSync(path.join(tmpHome, 'vault', '00-System', 'skills'), { recursive: true });
  prevHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome) process.env.CLEMENTINE_HOME = prevHome; else delete process.env.CLEMENTINE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

const skillsDir = (root = tmpHome) => path.join(root, 'vault', '00-System', 'skills');

function writeFlatSkill(filename: string, content: string, dir = skillsDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), content);
}

function writeFolderSkill(folderName: string, skillContent: string, dir = skillsDir(), bundled?: Record<string, string>): void {
  const folder = path.join(dir, folderName);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'SKILL.md'), skillContent);
  for (const [rel, body] of Object.entries(bundled || {})) {
    const abs = path.join(folder, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

// ── Discovery ─────────────────────────────────────────────────────────

describe('listSkills — discovery', () => {
  it('returns empty when no skills directory exists', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    rmSync(path.join(tmpHome, 'vault'), { recursive: true, force: true });
    expect(listSkills()).toEqual([]);
  });

  it('returns empty when directory exists but is empty', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    expect(listSkills()).toEqual([]);
  });

  it('discovers flat skill files', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('processing-pdfs.md', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('legacy-skill.md', LEGACY_FRONTMATTER);
    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.layout)).toEqual(['legacy-skill', 'processing-pdfs'].map(() => 'flat'));
  });

  it('discovers folder-form skills with SKILL.md', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('processing-pdfs', ANTHROPIC_FRONTMATTER);
    writeFolderSkill('audit-inbox-check', CLEMENTINE_FRONTMATTER);
    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills.every((s) => s.layout === 'folder')).toBe(true);
  });

  it('skips folders without SKILL.md (e.g. legacy "auto" dirs)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    mkdirSync(path.join(skillsDir(), 'auto'), { recursive: true });
    writeFlatSkill('real.md', ANTHROPIC_FRONTMATTER);
    expect(listSkills().map((s) => s.frontmatter.name)).toEqual(['real']);
  });

  it('mixes both layouts in the same directory', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('flat-skill.md', ANTHROPIC_FRONTMATTER);
    writeFolderSkill('folder-skill', ANTHROPIC_FRONTMATTER);
    const skills = listSkills();
    expect(skills.map((s) => `${s.frontmatter.name}/${s.layout}`).sort())
      .toEqual(['flat-skill/flat', 'folder-skill/folder']);
  });

  it('skips .bak files and hidden files', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('real.md', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('real.md.bak', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('.hidden.md', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('notes.txt', 'whatever');
    expect(listSkills().map((s) => s.frontmatter.name)).toEqual(['real']);
  });

  it('returns alphabetical order', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('zeta', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('alpha.md', ANTHROPIC_FRONTMATTER);
    writeFolderSkill('mu', ANTHROPIC_FRONTMATTER);
    expect(listSkills().map((s) => s.frontmatter.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('listSkills — global + per-project precedence', () => {
  it('per-project folder shadows global flat', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('audit.md', ANTHROPIC_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'projectA');
    writeFolderSkill('audit', ANTHROPIC_FRONTMATTER.replace('Extracts text from PDFs', 'PROJECT VERSION'),
      path.join(projectDir, '.clementine', 'skills'));
    const skills = listSkills({ projectWorkDir: projectDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].scope).toBe('project');
    expect(skills[0].layout).toBe('folder');
    expect(skills[0].frontmatter.description).toContain('PROJECT');
  });

  it('global + per-project merge when names differ', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('global-only.md', ANTHROPIC_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'projectA');
    writeFlatSkill('project-only.md', ANTHROPIC_FRONTMATTER,
      path.join(projectDir, '.clementine', 'skills'));
    const skills = listSkills({ projectWorkDir: projectDir });
    expect(skills.map((s) => `${s.frontmatter.name}/${s.scope}`).sort())
      .toEqual(['global-only/global', 'project-only/project']);
  });
});

describe('listSkills — agent-scoped precedence', () => {
  it('agent-scoped skills shadow global skills with the same name', async () => {
    const { listSkills, getSkill } = await import('../src/agent/skill-store.js');
    writeFolderSkill('audit', ANTHROPIC_FRONTMATTER.replace('Extracts text from PDFs', 'GLOBAL VERSION'));
    const agentDir = path.join(tmpHome, 'vault', '00-System', 'agents', 'sasha', 'skills');
    writeFolderSkill('audit', ANTHROPIC_FRONTMATTER.replace('Extracts text from PDFs', 'AGENT VERSION'), agentDir);

    const skills = listSkills({ agentSlug: 'sasha' });
    expect(skills).toHaveLength(1);
    expect(skills[0].scope).toBe('agent');
    expect(skills[0].frontmatter.description).toContain('AGENT');
    expect(getSkill('audit', { agentSlug: 'sasha' })?.scope).toBe('agent');
  });

  it('project skills still shadow agent-scoped skills', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    const agentDir = path.join(tmpHome, 'vault', '00-System', 'agents', 'sasha', 'skills');
    writeFolderSkill('audit', ANTHROPIC_FRONTMATTER.replace('Extracts text from PDFs', 'AGENT VERSION'), agentDir);
    const projectDir = path.join(tmpHome, 'projectA');
    writeFolderSkill('audit', ANTHROPIC_FRONTMATTER.replace('Extracts text from PDFs', 'PROJECT VERSION'),
      path.join(projectDir, '.clementine', 'skills'));

    const skill = getSkill('audit', { agentSlug: 'sasha', projectWorkDir: projectDir });
    expect(skill?.scope).toBe('project');
    expect(skill?.frontmatter.description).toContain('PROJECT');
  });
});

// ── Schema version detection ─────────────────────────────────────────

describe('schemaVersion detection', () => {
  it('flags vanilla Anthropic skills (just name + description)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('s.md', ANTHROPIC_FRONTMATTER);
    expect(listSkills()[0].schemaVersion).toBe('anthropic');
  });

  it('flags clementine when the clementine: namespace is present', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('s.md', CLEMENTINE_FRONTMATTER);
    expect(listSkills()[0].schemaVersion).toBe('clementine');
  });

  it('flags legacy when only top-level legacy markers are present', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('s.md', LEGACY_FRONTMATTER);
    expect(listSkills()[0].schemaVersion).toBe('legacy');
  });

  it('legacy beats nothing — title alone marks legacy', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('s.md', '---\ntitle: Old\n---\nbody');
    expect(listSkills()[0].schemaVersion).toBe('legacy');
  });

  it('clementine + legacy markers together → clementine wins', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    // A skill that has both the new namespace AND a legacy `triggers:`
    // field — possible during migration. Treat as clementine since
    // that's the active schema.
    writeFlatSkill('s.md', '---\nname: m\ndescription: x\nclementine:\n  version: 1\ntriggers: [a]\n---\nb');
    expect(listSkills()[0].schemaVersion).toBe('clementine');
  });
});

// ── Frontmatter parsing ──────────────────────────────────────────────

describe('parseSkillFile — frontmatter parsing', () => {
  it('parses Anthropic frontmatter into top-level name + description', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('processing-pdfs.md', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.frontmatter.description).toContain('Extracts text from PDFs');
    expect(skill.frontmatter.clementine).toBeUndefined();
  });

  it('parses clementine namespace into structured extension fields', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('audit.md', CLEMENTINE_FRONTMATTER);
    const skill = listSkills()[0];
    const ext = skill.frontmatter.clementine;
    expect(ext).toBeDefined();
    expect(ext!.inputs?.channel_id?.type).toBe('string');
    expect(ext!.tools?.allow).toContain('outlook_search');
    expect(ext!.dataSources?.[0].kind).toBe('outlook');
    expect(ext!.stateKeys).toContain('processed_ids');
    expect(ext!.success?.criterion).toBe('All new audits posted.');
    expect(ext!.limits?.maxTurns).toBe(8);
    expect(ext!.version).toBe(2);
  });

  it('parses legacy frontmatter and preserves legacy fields top-level', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('legacy.md', LEGACY_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.frontmatter.title).toBe('Audit Queue Approval');
    expect(skill.frontmatter.triggers).toContain('build brief');
    expect(skill.frontmatter.source).toBe('manual');
    expect(skill.frontmatter.toolsUsed).toContain('workspace_config');
    expect(skill.frontmatter.useCount).toBe(6);
    expect(skill.frontmatter.clementine).toBeUndefined();
  });

  it('uses filename as identity (frontmatter `name:` is ignored)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('my-real-name.md', ANTHROPIC_FRONTMATTER); // YAML claims name=processing-pdfs
    const skill = listSkills()[0];
    expect(skill.frontmatter.name).toBe('my-real-name');
  });

  it('captures the body separately from frontmatter', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('s.md', ANTHROPIC_FRONTMATTER);
    expect(listSkills()[0].body).toContain('Use pdfplumber');
    expect(listSkills()[0].body).not.toContain('description:');
  });

  it('tolerates a file with no frontmatter', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('plain.md', '# Just a heading\n\nNo frontmatter.');
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].frontmatter.name).toBe('plain');
  });

  it('captures unparseable files with a synthesized frontmatter', async () => {
    const { parseSkillFile } = await import('../src/agent/skill-store.js');
    writeFlatSkill('broken.md', BAD_YAML);
    const result = parseSkillFile(path.join(skillsDir(), 'broken.md'), 'global');
    expect(result.skill.frontmatter.name).toBe('broken');
    expect(result.skill.filePath).toBe(path.join(skillsDir(), 'broken.md'));
  });
});

// ── Folder-form bundled file discovery ───────────────────────────────

describe('parseSkillFolder — bundled files', () => {
  it('discovers sibling .md files', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER, skillsDir(), {
      'FORMS.md': '# Forms guide',
      'reference.md': '# API ref',
    });
    const skill = listSkills()[0];
    expect(skill.bundledFiles.map((f) => f.relPath).sort()).toEqual(['FORMS.md', 'reference.md']);
    expect(skill.bundledFiles.every((f) => f.kind === 'markdown')).toBe(true);
  });

  it('discovers scripts/ contents and classifies them as scripts', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER, skillsDir(), {
      'scripts/extract.py': 'print("hi")',
      'scripts/validate.py': 'print("v")',
    });
    const skill = listSkills()[0];
    expect(skill.bundledFiles).toHaveLength(2);
    expect(skill.bundledFiles.every((f) => f.kind === 'script')).toBe(true);
  });

  it('excludes SKILL.md from bundledFiles list', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER, skillsDir(), { 'FORMS.md': '# F' });
    const skill = listSkills()[0];
    expect(skill.bundledFiles.map((f) => f.relPath)).not.toContain('SKILL.md');
  });

  it('includes sizeBytes for every bundled file', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('s', ANTHROPIC_FRONTMATTER, skillsDir(), { 'BIG.md': 'x'.repeat(2048) });
    const skill = listSkills()[0];
    expect(skill.bundledFiles[0].sizeBytes).toBeGreaterThan(2000);
  });

  it('top-level files sort before scripts/', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('s', ANTHROPIC_FRONTMATTER, skillsDir(), {
      'scripts/a.py': 'a',
      'reference.md': 'r',
    });
    const skill = listSkills()[0];
    expect(skill.bundledFiles[0].relPath).toBe('reference.md');
    expect(skill.bundledFiles[1].relPath).toBe('scripts/a.py');
  });

  it('flat skills have an empty bundledFiles list', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('flat.md', ANTHROPIC_FRONTMATTER);
    expect(listSkills()[0].bundledFiles).toEqual([]);
  });
});

// ── Anthropic spec validations ───────────────────────────────────────

describe('validateSkill — Anthropic spec', () => {
  it('passes a clean Anthropic-compatible skill with no warnings', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('processing-pdfs', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.validation.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('errors on names with uppercase letters', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('Bad-Name', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.field === 'name' && v.severity === 'error')).toBe(true);
  });

  it('errors on names containing "claude" or "anthropic"', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('claude-helper', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.message.includes('reserved'))).toBe(true);
  });

  it('errors on names exceeding 64 chars', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('a'.repeat(80), ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.message.includes('64 chars'))).toBe(true);
  });

  it('errors when description is missing', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('no-desc', '---\nname: no-desc\n---\nbody');
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.field === 'description' && v.severity === 'error')).toBe(true);
  });

  it('errors when description exceeds 1024 chars', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    const huge = 'x'.repeat(1500);
    writeFolderSkill('long-desc', `---\nname: long-desc\ndescription: ${huge}\n---\nbody`);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.message.includes('1024'))).toBe(true);
  });

  it('errors when description contains XML tags', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('xml-desc', '---\nname: xml-desc\ndescription: "Has <tag> in it"\n---\nbody');
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.message.toLowerCase().includes('xml'))).toBe(true);
  });

  it('warns when body exceeds 500 lines', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    const longBody = '\n'.repeat(600);
    writeFolderSkill('huge', '---\nname: huge\ndescription: huge body\n---\n' + longBody);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.field === 'body' && v.severity === 'warning')).toBe(true);
  });

  it('warns flat-form Anthropic skills toward folder layout', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('processing-pdfs.md', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.field === 'layout' && v.severity === 'warning')).toBe(true);
  });

  it('does not nag legacy flat skills about layout (they pre-date the spec)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('legacy.md', LEGACY_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.validation.some((v) => v.field === 'layout')).toBe(false);
  });
});

// ── Used-by join ─────────────────────────────────────────────────────

describe('usedByTriggers join', () => {
  function job(name: string, skills?: string[]): CronJobDefinition {
    return { name, schedule: '0 9 * * *', prompt: 'p', skills } as CronJobDefinition;
  }

  it('populates usedByTriggers from CronJobDefinition.skills[]', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeFolderSkill('audit-inbox-check', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('orphan.md', ANTHROPIC_FRONTMATTER);
    const jobs = [
      job('cron-1', ['audit-inbox-check']),
      job('cron-2', ['audit-inbox-check', 'orphan']),
    ];
    const skills = listSkills({ jobs });
    const audit = skills.find((s) => s.frontmatter.name === 'audit-inbox-check')!;
    const orphan = skills.find((s) => s.frontmatter.name === 'orphan')!;
    expect(audit.usedByTriggers.sort()).toEqual(['cron-1', 'cron-2']);
    expect(orphan.usedByTriggers).toEqual(['cron-2']);
  });
});

// ── getSkill ─────────────────────────────────────────────────────────

describe('getSkill', () => {
  it('returns null when nothing matches', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    expect(getSkill('nonexistent')).toBeNull();
  });

  it('finds folder-form skill', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER);
    const s = getSkill('pdf');
    expect(s?.layout).toBe('folder');
  });

  it('finds flat-form skill', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    writeFlatSkill('pdf.md', ANTHROPIC_FRONTMATTER);
    const s = getSkill('pdf');
    expect(s?.layout).toBe('flat');
  });

  it('per-project beats global', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    writeFlatSkill('pdf.md', ANTHROPIC_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'p');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER.replace('Extracts text from PDFs', 'PROJECT'),
      path.join(projectDir, '.clementine', 'skills'));
    const s = getSkill('pdf', { projectWorkDir: projectDir });
    expect(s?.scope).toBe('project');
    expect(s?.layout).toBe('folder');
    expect(s?.frontmatter.description).toContain('PROJECT');
  });
});

// ── readBundledFile ──────────────────────────────────────────────────

describe('readBundledFile', () => {
  it('reads a sibling markdown file', async () => {
    const { listSkills, readBundledFile } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER, skillsDir(), { 'FORMS.md': '# Forms\nbody' });
    const skill = listSkills()[0];
    expect(readBundledFile(skill, 'FORMS.md')).toContain('# Forms');
  });

  it('returns null for flat skills', async () => {
    const { listSkills, readBundledFile } = await import('../src/agent/skill-store.js');
    writeFlatSkill('flat.md', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(readBundledFile(skill, 'anything.md')).toBeNull();
  });

  it('rejects directory traversal attempts', async () => {
    const { listSkills, readBundledFile } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER, skillsDir(), { 'FORMS.md': 'body' });
    const skill = listSkills()[0];
    expect(readBundledFile(skill, '../../etc/passwd')).toBeNull();
  });

  it('returns null for missing files', async () => {
    const { listSkills, readBundledFile } = await import('../src/agent/skill-store.js');
    writeFolderSkill('pdf', ANTHROPIC_FRONTMATTER);
    const skill = listSkills()[0];
    expect(readBundledFile(skill, 'nonexistent.md')).toBeNull();
  });
});

// ── Migration: legacy .md → folder/SKILL.md ──────────────────────────

describe('migrateLegacySkill', () => {
  it('returns error when source file does not exist', async () => {
    const { migrateLegacySkill } = await import('../src/agent/skill-store.js');
    const r = migrateLegacySkill('nope');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('rejects empty name', async () => {
    const { migrateLegacySkill } = await import('../src/agent/skill-store.js');
    const r = migrateLegacySkill('');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('name required');
  });

  it('reports alreadyMigrated when folder form exists', async () => {
    const { migrateLegacySkill } = await import('../src/agent/skill-store.js');
    writeFolderSkill('already', ANTHROPIC_FRONTMATTER);
    const r = migrateLegacySkill('already');
    expect(r.ok).toBe(true);
    expect(r.alreadyMigrated).toBe(true);
  });

  it('migrates a legacy file: writes folder/SKILL.md, renames original to .bak', async () => {
    const { migrateLegacySkill, listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('audit-thing.md', LEGACY_FRONTMATTER);
    const r = migrateLegacySkill('audit-thing');
    expect(r.ok).toBe(true);
    expect(r.alreadyMigrated).toBeUndefined();
    expect(r.newSkillPath).toContain('audit-thing/SKILL.md');
    expect(r.backupPath).toContain('audit-thing.md.bak');
    // Loader sees folder form.
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].layout).toBe('folder');
    expect(skills[0].frontmatter.name).toBe('audit-thing');
  });

  it('preserves the body verbatim through migration', async () => {
    const { migrateLegacySkill } = await import('../src/agent/skill-store.js');
    const customBody = '# Custom\n\nThis is a multi-line body with **markdown**.';
    writeFlatSkill('custom.md', '---\ntitle: X\ntoolsUsed: [a]\n---\n' + customBody);
    const r = migrateLegacySkill('custom');
    expect(r.ok).toBe(true);
    const fs = await import('node:fs');
    const written = fs.readFileSync(r.newSkillPath!, 'utf-8');
    expect(written).toContain(customBody);
  });

  it('moves legacy fields under clementine: namespace', async () => {
    const { migrateLegacySkill, getSkill } = await import('../src/agent/skill-store.js');
    writeFlatSkill('legacy.md', LEGACY_FRONTMATTER);
    migrateLegacySkill('legacy');
    const skill = getSkill('legacy');
    expect(skill?.layout).toBe('folder');
    expect(skill?.schemaVersion).toBe('clementine');
    const ext = skill?.frontmatter.clementine;
    expect(ext?.triggers).toContain('build brief');
    expect(ext?.tools?.allow).toContain('workspace_config');
    expect(ext?.useCount).toBe(6);
    expect(ext?.source).toBe('manual');
    // Top-level legacy fields should be gone after migration.
    expect(skill?.frontmatter.triggers).toBeUndefined();
    expect(skill?.frontmatter.toolsUsed).toBeUndefined();
    expect(skill?.frontmatter.useCount).toBeUndefined();
  });

  it('stamps migratedFrom + migratedAt + version=1', async () => {
    const { migrateLegacySkill, getSkill } = await import('../src/agent/skill-store.js');
    writeFlatSkill('m.md', LEGACY_FRONTMATTER);
    migrateLegacySkill('m');
    const skill = getSkill('m');
    const ext = skill?.frontmatter.clementine as Record<string, unknown> | undefined;
    expect(ext?.migratedFrom).toBe('m.md');
    expect(typeof ext?.migratedAt).toBe('string');
    expect(ext?.version).toBe(1);
  });

  it('rejects when target folder already exists (no clobber)', async () => {
    const { migrateLegacySkill } = await import('../src/agent/skill-store.js');
    writeFlatSkill('conflict.md', LEGACY_FRONTMATTER);
    // Create an empty folder at the target name (no SKILL.md inside) —
    // migration must refuse to overwrite.
    mkdirSync(path.join(skillsDir(), 'conflict'), { recursive: true });
    const r = migrateLegacySkill('conflict');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('target folder already exists');
  });
});

describe('migrateAllLegacySkills', () => {
  it('migrates only legacy files, skips Anthropic flat ones', async () => {
    const { migrateAllLegacySkills, listSkills } = await import('../src/agent/skill-store.js');
    writeFlatSkill('anthropic-style.md', ANTHROPIC_FRONTMATTER);
    writeFlatSkill('legacy-1.md', LEGACY_FRONTMATTER);
    writeFlatSkill('legacy-2.md', LEGACY_FRONTMATTER);
    const result = migrateAllLegacySkills();
    expect(result.migrated).toHaveLength(2);
    expect(result.skipped).toHaveLength(1); // anthropic-style stays as-is
    const skills = listSkills();
    // 2 migrated to folder + 1 anthropic-flat = 3 total
    expect(skills).toHaveLength(3);
    const layouts = skills.map((s) => `${s.frontmatter.name}/${s.layout}`).sort();
    expect(layouts).toEqual([
      'anthropic-style/flat',
      'legacy-1/folder',
      'legacy-2/folder',
    ]);
  });

  it('returns empty when no skills exist', async () => {
    const { migrateAllLegacySkills } = await import('../src/agent/skill-store.js');
    const result = migrateAllLegacySkills();
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('writeSkill — folder-form single write path', () => {
  it('writes Clementine extensions under clementine: in folder form', async () => {
    const { writeSkill, getSkill } = await import('../src/agent/skill-store.js');
    const result = writeSkill({
      name: 'asana-sheet-review',
      title: 'Asana Sheet Review',
      description: 'Reviews Asana tasks against a Google Sheet. Use when reconciling task status across systems.',
      body: '# Procedure\n\n1. Read tasks.\n2. Update the sheet.\n',
      source: 'manual',
      tools: ['mcp__asana__list_tasks', 'mcp__google-sheets__update_cells'],
      triggers: ['review asana tasks'],
      dataSources: [{ kind: 'asana', purpose: 'read task status' }],
      success: { criterion: 'The sheet and Asana have been reconciled.' },
    });

    expect(result.filePath).toBe(path.join(skillsDir(), 'asana-sheet-review', 'SKILL.md'));
    const skill = getSkill('asana-sheet-review');
    expect(skill?.layout).toBe('folder');
    expect(skill?.schemaVersion).toBe('clementine');
    expect(skill?.frontmatter.clementine?.tools?.allow).toContain('mcp__asana__list_tasks');
    expect(skill?.frontmatter.clementine?.triggers).toContain('review asana tasks');
    expect(skill?.frontmatter.clementine?.dataSources?.[0].kind).toBe('asana');
    expect(skill?.frontmatter.clementine?.success?.criterion).toContain('reconciled');
  });

  it('preserves lifecycle metadata and increments version on overwrite', async () => {
    const { writeSkill, getSkill } = await import('../src/agent/skill-store.js');
    const first = writeSkill({
      name: 'daily-report',
      description: 'Builds a daily report. Use when the user asks for the daily report.',
      body: '# Procedure\n\nReport.\n',
      source: 'manual',
    });

    const parsed = matter(readFileSync(first.filePath, 'utf-8'));
    parsed.data.clementine.useCount = 7;
    parsed.data.clementine.lastUsed = '2026-05-01T10:00:00.000Z';
    writeFileSync(first.filePath, matter.stringify(parsed.content, parsed.data));
    const createdAt = parsed.data.clementine.createdAt;

    writeSkill({
      name: 'daily-report',
      description: 'Builds a daily report. Use when the user asks for the daily report.',
      body: '# Procedure\n\nUpdated report.\n',
      source: 'manual',
      tools: ['Read'],
      overwrite: true,
    });

    const skill = getSkill('daily-report');
    const ext = skill?.frontmatter.clementine;
    expect(ext?.createdAt).toBe(createdAt);
    expect(ext?.useCount).toBe(7);
    expect(ext?.lastUsed).toBe('2026-05-01T10:00:00.000Z');
    expect(ext?.version).toBe(2);
    expect(ext?.tools?.allow).toEqual(['Read']);
  });

  it('overwriting a legacy flat skill creates folder form and hides the stale flat copy from discovery', async () => {
    const { writeSkill, listSkills, getSkill } = await import('../src/agent/skill-store.js');
    const flatPath = path.join(skillsDir(), 'legacy-flat.md');
    writeFlatSkill('legacy-flat.md', LEGACY_FRONTMATTER);

    writeSkill({
      name: 'legacy-flat',
      description: 'Updated folder-form skill. Use when testing legacy overwrite migration.',
      body: '# Procedure\n\nUpdated.\n',
      source: 'manual',
      overwrite: true,
    });

    const skills = listSkills();
    expect(skills.map(s => s.frontmatter.name)).toEqual(['legacy-flat']);
    expect(skills[0].layout).toBe('folder');
    const ext = getSkill('legacy-flat')?.frontmatter.clementine;
    expect(ext?.useCount).toBe(6);
    expect(ext?.tools?.allow).toContain('workspace_config');
    expect(existsSync(flatPath)).toBe(false);
    expect(existsSync(flatPath + '.bak')).toBe(true);
  });

  it('rejects names containing reserved words even inside longer slugs', async () => {
    const { writeSkill } = await import('../src/agent/skill-store.js');
    expect(() => writeSkill({
      name: 'claudehelper',
      description: 'Invalid skill. Use when testing validation.',
      body: '# Procedure\n\nNo-op.\n',
      source: 'manual',
    })).toThrow(/reserved word/);
  });
});

describe('cleanupLegacySkillBackups (1.18.125 — vault janitor)', () => {
  /** Stamp the mtime of `file` to N days ago. Used to simulate "old enough to sweep". */
  function setMtimeDaysAgo(file: string, days: number): void {
    const mtimeMs = Date.now() - days * 24 * 60 * 60 * 1000;
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  it('removes .md.bak files older than 30 days from the global skills dir', async () => {
    const { cleanupLegacySkillBackups } = await import('../src/agent/skill-store.js');
    const oldBak = path.join(skillsDir(), 'old-skill.md.bak');
    writeFileSync(oldBak, '# old');
    setMtimeDaysAgo(oldBak, 60);
    const r = cleanupLegacySkillBackups();
    expect(r.removed).toContain(oldBak);
    expect(r.inspected).toBe(1);
    expect(existsSync(oldBak)).toBe(false);
  });

  it('keeps .md.bak files younger than 30 days (rollback grace window)', async () => {
    const { cleanupLegacySkillBackups } = await import('../src/agent/skill-store.js');
    const freshBak = path.join(skillsDir(), 'recent-skill.md.bak');
    writeFileSync(freshBak, '# fresh');
    setMtimeDaysAgo(freshBak, 5);
    const r = cleanupLegacySkillBackups();
    expect(r.removed).toEqual([]);
    expect(r.inspected).toBe(1);
    expect(r.keptFresh).toBe(1);
    expect(existsSync(freshBak)).toBe(true);
  });

  it('ignores non-bak files (regular skills are never touched)', async () => {
    const { cleanupLegacySkillBackups } = await import('../src/agent/skill-store.js');
    writeFlatSkill('keeper.md', ANTHROPIC_FRONTMATTER);
    writeFolderSkill('folder-keeper', ANTHROPIC_FRONTMATTER);
    const r = cleanupLegacySkillBackups();
    expect(r.removed).toEqual([]);
    expect(r.inspected).toBe(0);
    expect(existsSync(path.join(skillsDir(), 'keeper.md'))).toBe(true);
    expect(existsSync(path.join(skillsDir(), 'folder-keeper', 'SKILL.md'))).toBe(true);
  });

  it('also sweeps per-agent skill dirs (00-System/agents/<slug>/skills/)', async () => {
    const { cleanupLegacySkillBackups } = await import('../src/agent/skill-store.js');
    const agentDir = path.join(tmpHome, 'vault', '00-System', 'agents', 'sasha', 'skills');
    mkdirSync(agentDir, { recursive: true });
    const oldBak = path.join(agentDir, 'sasha-old.md.bak');
    writeFileSync(oldBak, '# old');
    setMtimeDaysAgo(oldBak, 90);
    const r = cleanupLegacySkillBackups();
    expect(r.removed).toContain(oldBak);
    expect(existsSync(oldBak)).toBe(false);
  });

  it('returns zero counts when the skills dir has no files', async () => {
    const { cleanupLegacySkillBackups } = await import('../src/agent/skill-store.js');
    const r = cleanupLegacySkillBackups();
    expect(r.removed).toEqual([]);
    expect(r.inspected).toBe(0);
    expect(r.keptFresh).toBe(0);
  });

  it('does not touch .md.bak files inside folder-form skill bundles (only top-level slug-named bak files)', async () => {
    const { cleanupLegacySkillBackups } = await import('../src/agent/skill-store.js');
    const folder = path.join(skillsDir(), 'safe-bundle');
    mkdirSync(path.join(folder, 'templates'), { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), ANTHROPIC_FRONTMATTER);
    const nestedBak = path.join(folder, 'templates', 'old-draft.md.bak');
    writeFileSync(nestedBak, '# nested bak should not be swept');
    setMtimeDaysAgo(nestedBak, 90);
    const r = cleanupLegacySkillBackups();
    expect(r.removed).toEqual([]);
    expect(existsSync(nestedBak)).toBe(true);
  });
});
