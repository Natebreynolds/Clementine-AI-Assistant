/**
 * Phase A — skill-store tests.
 *
 * Covers: discovery (global + per-project + override), parse (v1 + legacy
 * frontmatter), schemaVersion detection, used-by join, parse errors,
 * filename canonicalization, .bak filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CronJobDefinition } from '../src/types.js';

let tmpHome: string;
let prevHome: string | undefined;

const V1_FRONTMATTER = `---
name: audit-inbox-check
description: Watch inbox for audits.
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
    purpose: read emails
stateKeys:
  - processed_ids
success:
  criterion: "All new audits posted."
limits:
  maxTurns: 8
version: 2
---
# Body
Procedure goes here.
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
  // Mirror the real layout: ~/.clementine/vault/00-System/skills/
  mkdirSync(path.join(tmpHome, 'vault', '00-System', 'skills'), { recursive: true });
  prevHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome) process.env.CLEMENTINE_HOME = prevHome; else delete process.env.CLEMENTINE_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeSkill(filename: string, content: string, dir = path.join(tmpHome, 'vault', '00-System', 'skills')): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), content);
}

describe('listSkills — discovery + filtering', () => {
  it('returns empty when no skills directory exists', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    rmSync(path.join(tmpHome, 'vault'), { recursive: true, force: true });
    expect(listSkills()).toEqual([]);
  });

  it('returns empty when directory exists but is empty', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    expect(listSkills()).toEqual([]);
  });

  it('discovers .md files in the global skills dir', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('audit-inbox-check.md', V1_FRONTMATTER);
    writeSkill('legacy-skill.md', LEGACY_FRONTMATTER);
    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.frontmatter.name).sort()).toEqual(['audit-inbox-check', 'legacy-skill']);
    // V1 file's `name: audit-inbox-check` happens to match its filename,
    // but identity is the filename — proven by other tests that put
    // frontmatter-name="audit-inbox-check" into a file named "real.md".
  });

  it('skips .bak files', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('real.md', V1_FRONTMATTER);
    writeSkill('real.md.bak', V1_FRONTMATTER);
    expect(listSkills().map((s) => s.frontmatter.name)).toEqual(['real']);
  });

  it('skips hidden files', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('real.md', V1_FRONTMATTER);
    writeSkill('.hidden.md', V1_FRONTMATTER);
    expect(listSkills().map((s) => s.frontmatter.name)).toEqual(['real']);
  });

  it('skips non-md files', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('real.md', V1_FRONTMATTER);
    writeSkill('notes.txt', 'whatever');
    expect(listSkills().map((s) => s.frontmatter.name)).toEqual(['real']);
  });
});

describe('listSkills — global + per-project precedence', () => {
  it('per-project skill overrides global with same name', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('audit.md', V1_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'projectA');
    writeSkill('audit.md', V1_FRONTMATTER.replace('Watch inbox for audits.', 'PROJECT VERSION'),
      path.join(projectDir, '.clementine', 'skills'));
    const skills = listSkills({ projectWorkDir: projectDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].scope).toBe('project');
    expect(skills[0].frontmatter.description).toBe('PROJECT VERSION');
  });

  it('per-project + global merge when names differ', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('global-only.md', V1_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'projectA');
    writeSkill('project-only.md', V1_FRONTMATTER,
      path.join(projectDir, '.clementine', 'skills'));
    const skills = listSkills({ projectWorkDir: projectDir });
    expect(skills.map((s) => `${s.frontmatter.name}/${s.scope}`).sort())
      .toEqual(['global-only/global', 'project-only/project']);
  });

  it('returns empty per-project when work_dir has no .clementine/skills/', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('global-only.md', V1_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'projectA');
    mkdirSync(projectDir, { recursive: true });
    const skills = listSkills({ projectWorkDir: projectDir });
    expect(skills.map((s) => s.scope)).toEqual(['global']);
  });

  it('alphabetical order by name', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('zeta.md', V1_FRONTMATTER);
    writeSkill('alpha.md', V1_FRONTMATTER);
    writeSkill('mu.md', V1_FRONTMATTER);
    const names = listSkills().map((s) => s.frontmatter.name);
    expect(names).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('parseSkillFile — frontmatter parsing', () => {
  it('parses v1 frontmatter into structured fields', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('audit-inbox-check.md', V1_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.frontmatter.description).toBe('Watch inbox for audits.');
    expect(skill.frontmatter.inputs?.channel_id?.type).toBe('string');
    expect(skill.frontmatter.tools?.allow).toContain('outlook_search');
    expect(skill.frontmatter.dataSources?.[0].kind).toBe('outlook');
    expect(skill.frontmatter.stateKeys).toContain('processed_ids');
    expect(skill.frontmatter.success?.criterion).toBe('All new audits posted.');
    expect(skill.frontmatter.limits?.maxTurns).toBe(8);
    expect(skill.frontmatter.version).toBe(2);
  });

  it('parses legacy frontmatter and preserves legacy fields', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('audit-queue-approval.md', LEGACY_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.frontmatter.title).toBe('Audit Queue Approval');
    expect(skill.frontmatter.triggers).toContain('build brief');
    expect(skill.frontmatter.source).toBe('manual');
    expect(skill.frontmatter.toolsUsed).toContain('workspace_config');
    expect(skill.frontmatter.useCount).toBe(6);
    // Legacy files have no v1-only fields.
    expect(skill.frontmatter.inputs).toBeUndefined();
    expect(skill.frontmatter.tools).toBeUndefined();
    expect(skill.frontmatter.stateKeys).toBeUndefined();
  });

  it('uses filename as name when frontmatter omits it', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('my-skill-from-file.md', LEGACY_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.frontmatter.name).toBe('my-skill-from-file');
  });

  it('captures the body separately from the frontmatter', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('s.md', V1_FRONTMATTER);
    const skill = listSkills()[0];
    expect(skill.body).toContain('Procedure goes here');
    expect(skill.body).not.toContain('description:');
  });

  it('tolerates a file with no frontmatter (treats body as everything)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('plain.md', '# Just a heading\n\nNo frontmatter here.');
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].frontmatter.name).toBe('plain');
    expect(skills[0].body).toContain('Just a heading');
  });

  it('captures an unparseable file with a synthesized frontmatter', async () => {
    const { parseSkillFile } = await import('../src/agent/skill-store.js');
    writeSkill('broken.md', BAD_YAML);
    const filePath = path.join(tmpHome, 'vault', '00-System', 'skills', 'broken.md');
    const direct = parseSkillFile(filePath, 'global');
    // Either parseError is set OR the file parsed but with degraded
    // frontmatter — both are acceptable; the important thing is the
    // loader doesn't crash.
    expect(direct.skill.frontmatter.name).toBe('broken');
    // Most YAML parsers either error here OR silently treat the malformed
    // line as a string property. Don't assert which — just confirm we
    // got a Skill back instead of crashing.
    expect(direct.skill.filePath).toBe(filePath);
  });
});

describe('schemaVersion detection', () => {
  it('flags v1 files when inputs is present', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('v1.md', V1_FRONTMATTER);
    expect(listSkills()[0].schemaVersion).toBe('v1');
  });

  it('flags legacy files (only legacy fields present)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('legacy.md', LEGACY_FRONTMATTER);
    expect(listSkills()[0].schemaVersion).toBe('legacy');
  });

  it('flags v1 when only tools.allow is present', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('s.md', '---\ntools:\n  allow: [Read]\n---\nbody');
    expect(listSkills()[0].schemaVersion).toBe('v1');
  });

  it('flags legacy when only toolsUsed (informational legacy field)', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('s.md', '---\ntoolsUsed: [Read]\n---\nbody');
    expect(listSkills()[0].schemaVersion).toBe('legacy');
  });
});

describe('usedByTriggers join', () => {
  function job(name: string, skills?: string[]): CronJobDefinition {
    return { name, schedule: '0 9 * * *', prompt: 'p', skills } as CronJobDefinition;
  }

  it('populates usedByTriggers from CronJobDefinition.skills[]', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('audit-inbox-check.md', V1_FRONTMATTER);
    writeSkill('orphan.md', V1_FRONTMATTER.replace('audit-inbox-check', 'orphan'));
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

  it('returns empty usedByTriggers when no jobs reference the skill', async () => {
    const { listSkills } = await import('../src/agent/skill-store.js');
    writeSkill('lonely.md', V1_FRONTMATTER);
    expect(listSkills({ jobs: [] })[0].usedByTriggers).toEqual([]);
  });
});

describe('getSkill', () => {
  it('returns null when skill does not exist', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    expect(getSkill('nonexistent')).toBeNull();
  });

  it('returns global skill by name', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    writeSkill('audit.md', V1_FRONTMATTER);
    const s = getSkill('audit');
    expect(s).not.toBeNull();
    expect(s!.scope).toBe('global');
  });

  it('per-project takes precedence over global', async () => {
    const { getSkill } = await import('../src/agent/skill-store.js');
    writeSkill('audit.md', V1_FRONTMATTER);
    const projectDir = path.join(tmpHome, 'projectA');
    writeSkill('audit.md', V1_FRONTMATTER.replace('Watch', 'PROJECT'),
      path.join(projectDir, '.clementine', 'skills'));
    const s = getSkill('audit', { projectWorkDir: projectDir });
    expect(s!.scope).toBe('project');
    expect(s!.frontmatter.description).toContain('PROJECT');
  });
});
