/**
 * Cron-clean migrator — tests against fixtures derived from the user's
 * actual CRON.md content (audited 2026-05-08). Every fixture matches a
 * real prompt that was running in production at the time of writing, so
 * the regex-based preamble strip can't drift from real-world data without
 * breaking these tests.
 */

import { describe, it, expect } from 'vitest';
import {
  migrateCronJob,
  migrateAllEligibleJobs,
  stripToolRestrictionsPreamble,
  findMatchingSkill,
  generateDescription,
} from '../src/agent/cron-migrator.js';
import type { CronJobDefinition, Skill } from '../src/types.js';

// ── Fixture builders ──────────────────────────────────────────────────

function mkJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    name: 'test-job',
    schedule: '0 * * * *',
    prompt: 'Do something useful.',
    enabled: true,
    tier: 1,
    ...overrides,
  };
}

function mkSkill(name: string, fm: Record<string, unknown> = {}): Skill {
  return {
    frontmatter: {
      name,
      description: `Test skill: ${name}`,
      ...(fm as object),
    } as Skill['frontmatter'],
    body: `# ${name}\n\nProcedure body.\n`,
    filePath: `/tmp/skills/${name}/SKILL.md`,
    scope: 'global',
    layout: 'folder',
    schemaVersion: 'clementine',
    bundledFiles: [],
    usedByTriggers: [],
    validation: [],
  };
}

// The morning-briefing prompt verbatim from the user's vault.
const MORNING_BRIEFING_PROMPT = `TOOL RESTRICTIONS — MANDATORY. Violating these is a critical error.
1. FORBIDDEN — ALL mcp__kernel tools: manage_apps, manage_browsers, exec_command, computer_action, execute_playwright_code, manage_browser_pools, manage_proxies, manage_profiles, manage_extensions, search_docs. Never call any kernel tool for any reason.
2. FORBIDDEN — ALL raw filesystem tools: Glob, Read, Write, Edit, Bash. Never call these.
3. ALLOWED tools (the COMPLETE list): task_list, memory_read, memory_search, note_take, outlook_inbox, cron_list, goal_list, self_improve_status, discord_channel_send.
If any ALLOWED tool returns an error, skip that step and continue. Do not try alternative tools.

Give Nate a morning briefing. Check ALL of these:
1. Task list — use task_list to find overdue, due-today, high-priority pending
2. Yesterday's daily note for context — use memory_read
Always send something via discord_channel_send, even if it's "Clean slate today — no tasks, no fires." A brief positive confirmation beats silence.`;

// ── stripToolRestrictionsPreamble ─────────────────────────────────────

describe('stripToolRestrictionsPreamble', () => {
  it('returns null when there is no preamble', () => {
    expect(stripToolRestrictionsPreamble('Just a normal prompt.')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(stripToolRestrictionsPreamble('')).toBeNull();
  });

  it('strips the canonical preamble and parses the ALLOWED list', () => {
    const result = stripToolRestrictionsPreamble(MORNING_BRIEFING_PROMPT);
    expect(result).not.toBeNull();
    expect(result!.allowedTools).toEqual([
      'task_list',
      'memory_read',
      'memory_search',
      'note_take',
      'outlook_inbox',
      'cron_list',
      'goal_list',
      'self_improve_status',
      'discord_channel_send',
    ]);
    // The preamble + the "If any ALLOWED tool..." line are stripped;
    // the actual procedural body remains.
    expect(result!.cleanedPrompt).toMatch(/^Give Nate a morning briefing/);
    expect(result!.cleanedPrompt).not.toContain('TOOL RESTRICTIONS');
    expect(result!.cleanedPrompt).not.toContain('FORBIDDEN');
  });

  it('handles preamble with em-dash (—) AND hyphen (-) variants', () => {
    const withHyphen = MORNING_BRIEFING_PROMPT.replace('TOOL RESTRICTIONS — MANDATORY', 'TOOL RESTRICTIONS - MANDATORY');
    const result = stripToolRestrictionsPreamble(withHyphen);
    expect(result).not.toBeNull();
    expect(result!.allowedTools.length).toBeGreaterThan(0);
  });

  it('does not match a prompt that just mentions tool restrictions in passing', () => {
    const innocent = 'When a user asks about tool restrictions, explain Predictable mode.';
    expect(stripToolRestrictionsPreamble(innocent)).toBeNull();
  });
});

// ── findMatchingSkill ─────────────────────────────────────────────────

describe('findMatchingSkill', () => {
  it('matches by exact name', () => {
    const job = mkJob({ name: 'morning-briefing' });
    const skills = [
      mkSkill('weekly-review'),
      mkSkill('morning-briefing'),
      mkSkill('content-intel-brief'),
    ];
    const m = findMatchingSkill(job, skills);
    expect(m?.frontmatter.name).toBe('morning-briefing');
  });

  it('matches via skill triggers when names are different', () => {
    const job = mkJob({ name: 'audit-inbox-check' });
    const skills = [
      mkSkill('checking-audit-inbox', {
        clementine: {
          triggers: ['audit inbox check', 'inbox audit', 'check audit inbox'],
        },
      }),
    ];
    const m = findMatchingSkill(job, skills);
    expect(m?.frontmatter.name).toBe('checking-audit-inbox');
  });

  it('matches via word-token overlap with skill name (≥2 shared content words)', () => {
    const job = mkJob({ name: 'audit-inbox-check' });
    const skills = [
      mkSkill('checking-audit-inbox'),  // shares "audit" + "inbox"
      mkSkill('something-else'),
    ];
    const m = findMatchingSkill(job, skills);
    expect(m?.frontmatter.name).toBe('checking-audit-inbox');
  });

  it('returns null when no skill matches confidently', () => {
    const job = mkJob({ name: 'totally-novel-job' });
    const skills = [mkSkill('weekly-review'), mkSkill('morning-briefing')];
    expect(findMatchingSkill(job, skills)).toBeNull();
  });

  it('does not over-match — single shared word is not enough', () => {
    const job = mkJob({ name: 'build-something-special' });
    const skills = [mkSkill('build-tool')];  // shares only "build"
    expect(findMatchingSkill(job, skills)).toBeNull();
  });
});

// ── generateDescription ───────────────────────────────────────────────

describe('generateDescription', () => {
  it('prefers the matched skill description when available', () => {
    const skill = mkSkill('morning-briefing', {
      description: 'Comprehensive morning status check covering tasks, email, calendar.',
    });
    expect(generateDescription('any cleaned prompt', skill)).toBe(
      'Comprehensive morning status check covering tasks, email, calendar.',
    );
  });

  it('falls back to first sentence of cleaned prompt', () => {
    const desc = generateDescription('Send a daily summary email. Include the calendar.', null);
    expect(desc).toBe('Send a daily summary email.');
  });

  it('handles a prompt with no punctuation by capping at 200 chars', () => {
    const longRun = 'Do this and that and all the things and many more steps that go on and on and on without ever ending its just a list';
    const desc = generateDescription(longRun, null);
    expect(desc.length).toBeLessThanOrEqual(200);
    expect(longRun.startsWith(desc.slice(0, -3) /* allow trailing ellipsis */) || longRun.startsWith(desc)).toBe(true);
  });

  it('returns empty string for empty input with no skill', () => {
    expect(generateDescription('', null)).toBe('');
  });
});

// ── migrateCronJob — the integration ──────────────────────────────────

describe('migrateCronJob — full migration flow', () => {
  it('migrates the morning-briefing fixture end-to-end', () => {
    const job = mkJob({
      name: 'morning-briefing',
      schedule: '0 8 * * *',
      prompt: MORNING_BRIEFING_PROMPT,
    });
    const skills = [
      mkSkill('morning-briefing', {
        title: 'Morning Briefing',
        description: 'Comprehensive morning status check covering tasks, email, calendar, goals, crons, audit queue, and self-improvement.',
      }),
    ];
    const result = migrateCronJob(job, skills);

    expect(result.eligible).toBe(true);
    expect(result.matchedSkill).toBe('morning-briefing');
    // predictable flipped on
    expect(result.migrated.predictable).toBe(true);
    // skills pinned
    expect(result.migrated.skills).toEqual(['morning-briefing']);
    // prompt reduced to thin invocation
    expect(result.migrated.prompt).toMatch(/^Run the Morning Briefing skill/);
    expect(result.migrated.prompt).not.toContain('TOOL RESTRICTIONS');
    // description populated from skill
    expect(result.migrated.description).toContain('Comprehensive morning status check');
    // allowed_tools extracted from the preamble
    expect(result.migrated.allowedTools).toContain('task_list');
    expect(result.migrated.allowedTools).toContain('discord_channel_send');
    // change log mentions every operation
    const allChanges = result.changes.join(' ');
    expect(allChanges).toContain('Strict mode');
    expect(allChanges).toContain('TOOL RESTRICTIONS preamble');
    expect(allChanges).toContain('morning-briefing');
  });

  it('migrates a job WITHOUT preamble — just adds predictable + description', () => {
    const job = mkJob({
      name: 'weekly-review',
      schedule: '0 18 * * 5',
      prompt: 'Create a weekly review note. Read daily notes from the past 7 days.',
    });
    const result = migrateCronJob(job, []);

    expect(result.eligible).toBe(true);
    expect(result.migrated.predictable).toBe(true);
    expect(result.migrated.description).toBe('Create a weekly review note.');
    // No skill pin (no skills in catalog)
    expect(result.migrated.skills).toBeUndefined();
    // Prompt unchanged (no preamble to strip)
    expect(result.migrated.prompt).toBe(job.prompt);
  });

  it('returns eligible=false when the job is already clean', () => {
    const job = mkJob({
      name: 'already-clean',
      predictable: true,
      description: 'A clean task that needs nothing.',
      skills: ['some-skill'],
      prompt: 'Run the some-skill skill.',
    });
    const result = migrateCronJob(job, [mkSkill('some-skill')]);

    expect(result.eligible).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.notEligibleReason).toBeTruthy();
  });

  it('is idempotent — re-running migration on a migrated job yields no changes', () => {
    const job = mkJob({
      name: 'morning-briefing',
      prompt: MORNING_BRIEFING_PROMPT,
    });
    const skills = [
      mkSkill('morning-briefing', {
        title: 'Morning Briefing',
        description: 'Test description.',
      }),
    ];
    const first = migrateCronJob(job, skills);
    expect(first.eligible).toBe(true);

    const second = migrateCronJob(first.migrated, skills);
    expect(second.eligible).toBe(false);
    expect(second.changes).toEqual([]);
  });

  it('preserves user-added text after the preamble when pinning a skill', () => {
    const job = mkJob({
      name: 'morning-briefing',
      prompt: MORNING_BRIEFING_PROMPT.replace(
        'A brief positive confirmation beats silence.',
        'A brief positive confirmation beats silence.\n\nALSO: today specifically, lead with the Revill audit reminder.',
      ),
    });
    const skills = [mkSkill('morning-briefing', { title: 'Morning Briefing' })];
    const result = migrateCronJob(job, skills);

    // The skill invocation appears, AND the user-added "ALSO" line is preserved.
    expect(result.migrated.prompt).toMatch(/^Run the Morning Briefing skill/);
    expect(result.migrated.prompt).toContain('Revill audit reminder');
  });

  it('does not overwrite an existing description', () => {
    const job = mkJob({
      name: 'has-description',
      description: 'Existing description set by hand.',
      prompt: 'Send a thing.',
    });
    const result = migrateCronJob(job, []);
    expect(result.migrated.description).toBe('Existing description set by hand.');
  });

  it('does not overwrite existing pinned skills', () => {
    const job = mkJob({
      name: 'morning-briefing',
      skills: ['custom-skill'],
      prompt: MORNING_BRIEFING_PROMPT,
    });
    const skills = [mkSkill('morning-briefing'), mkSkill('custom-skill')];
    const result = migrateCronJob(job, skills);
    expect(result.migrated.skills).toEqual(['custom-skill']);
  });

  it('merges new tools into existing allowed_tools without dropping any', () => {
    const job = mkJob({
      name: 'a-job',
      prompt: MORNING_BRIEFING_PROMPT,
      allowedTools: ['existing_tool'],
    });
    const result = migrateCronJob(job, []);
    expect(result.migrated.allowedTools).toContain('existing_tool');
    expect(result.migrated.allowedTools).toContain('task_list');
  });
});

// ── migrateAllEligibleJobs — bulk preview ─────────────────────────────

describe('migrateAllEligibleJobs', () => {
  it('partitions a mixed list into eligible vs skipped', () => {
    const jobs: CronJobDefinition[] = [
      mkJob({ name: 'morning-briefing', prompt: MORNING_BRIEFING_PROMPT }),
      mkJob({ name: 'weekly-review', prompt: 'Create a weekly review note.' }),
      mkJob({
        name: 'already-clean',
        predictable: true,
        description: 'Clean.',
        skills: ['s'],
        prompt: 'Run skill s.',
      }),
    ];
    const skills = [
      mkSkill('morning-briefing', { title: 'Morning Briefing' }),
      mkSkill('s'),
    ];
    const out = migrateAllEligibleJobs(jobs, skills);
    expect(out.eligible.map(e => e.job.name)).toEqual(['morning-briefing', 'weekly-review']);
    expect(out.skipped.map(s => s.job.name)).toEqual(['already-clean']);
    expect(out.skipped[0].reason).toBeTruthy();
  });

  it('handles an empty input', () => {
    const out = migrateAllEligibleJobs([], []);
    expect(out.eligible).toEqual([]);
    expect(out.skipped).toEqual([]);
  });
});
