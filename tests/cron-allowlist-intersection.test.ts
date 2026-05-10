/**
 * Allowlist intersection helpers — `computeEffectiveAllowedTools` and
 * `applyMcpAllowlist` from `src/agent/run-agent-cron.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  computeEffectiveAllowedTools,
  applyMcpAllowlist,
  widenAllowlistWithSkillTools,
  widenMcpAllowlistWithSkillRefs,
  extractMcpServersFromSkillBodies,
} from '../src/agent/run-agent-cron.js';

describe('computeEffectiveAllowedTools', () => {
  it('returns undefined when both job and profile allowlists are absent (legacy behavior preserved)', () => {
    expect(computeEffectiveAllowedTools(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when job allowlist is undefined even if profile has one', () => {
    expect(computeEffectiveAllowedTools(undefined, ['Read', 'Edit'])).toBeUndefined();
  });

  it('returns ["Agent"] when job allowlist is explicitly empty (1.18.148: empty = "deny all but the SDK Agent spawn tool")', () => {
    // Before 1.18.148, empty array collapsed to undefined ("no restriction"),
    // which let meta-jobs (insight-check, grade:*, etc.) inherit the full
    // tool set + Composio toolkit schemas → "Prompt is too long" failures.
    // Now empty array means exactly what it says.
    expect(computeEffectiveAllowedTools([], ['Read', 'Edit'])).toEqual(['Agent']);
  });

  it('job-only: returns the job list with Agent force-included at front', () => {
    const result = computeEffectiveAllowedTools(['Read', 'Write'], undefined);
    expect(result).toBeDefined();
    expect(result).toContain('Agent');
    expect(result).toContain('Read');
    expect(result).toContain('Write');
    expect(result![0]).toBe('Agent');
  });

  it('job-only: keeps Agent at its existing position when already in job list (no duplicate)', () => {
    const result = computeEffectiveAllowedTools(['Read', 'Agent', 'Write'], undefined);
    expect(result!.filter(t => t === 'Agent')).toHaveLength(1);
    expect(new Set(result)).toEqual(new Set(['Read', 'Agent', 'Write']));
  });

  it('both: returns intersection plus Agent', () => {
    const result = computeEffectiveAllowedTools(
      ['Read', 'Write', 'Bash', 'WebFetch'],
      ['Read', 'Edit', 'WebFetch'],
    );
    expect(result).toBeDefined();
    expect(new Set(result)).toEqual(new Set(['Agent', 'Read', 'WebFetch']));
  });

  it('both with empty intersection: returns just [Agent] so subagent delegation still works', () => {
    const result = computeEffectiveAllowedTools(
      ['Bash', 'WebFetch'],
      ['Read', 'Edit'],
    );
    expect(result).toEqual(['Agent']);
  });

  it('both with profile already containing Agent: no duplicate Agent in result', () => {
    const result = computeEffectiveAllowedTools(
      ['Read', 'Agent'],
      ['Agent', 'Read', 'Edit'],
    );
    expect(result!.filter(t => t === 'Agent')).toHaveLength(1);
    expect(new Set(result)).toEqual(new Set(['Agent', 'Read']));
  });

  it('does not mutate the inputs', () => {
    const job = ['Read', 'Write'];
    const profile = ['Read', 'Edit'];
    const jobBefore = [...job];
    const profileBefore = [...profile];
    computeEffectiveAllowedTools(job, profile);
    expect(job).toEqual(jobBefore);
    expect(profile).toEqual(profileBefore);
  });
});

describe('applyMcpAllowlist', () => {
  const servers = {
    slack: { type: 'http' },
    salesforce: { type: 'stdio' },
    firecrawl: { type: 'http' },
    linear: { type: 'http' },
  };

  it('returns the input map unchanged when allowlist is undefined', () => {
    const result = applyMcpAllowlist(servers, undefined);
    expect(result).toBe(servers);
  });

  it('returns an empty map when allowlist is explicitly empty (1.18.148: empty = "deny all")', () => {
    // Before 1.18.148, empty array collapsed to "no restriction" and the
    // full server map flowed through — meaning meta-jobs got every
    // Composio toolkit's tool schemas wired in, blowing past the prompt
    // limit. Now empty array means exactly "no MCP servers."
    const result = applyMcpAllowlist(servers, []);
    expect(result).toEqual({});
  });

  it('keeps only servers whose names are in the allowlist', () => {
    const result = applyMcpAllowlist(servers, ['slack', 'firecrawl']);
    expect(Object.keys(result).sort()).toEqual(['firecrawl', 'slack']);
    expect(result.slack).toBe(servers.slack);
    expect(result.firecrawl).toBe(servers.firecrawl);
  });

  it('returns an empty map when no allowlist entries match', () => {
    const result = applyMcpAllowlist(servers, ['nope', 'never-existed']);
    expect(Object.keys(result)).toEqual([]);
  });

  it('does not mutate the input map', () => {
    const before = { ...servers };
    applyMcpAllowlist(servers, ['slack']);
    expect(servers).toEqual(before);
  });
});

describe('widenAllowlistWithSkillTools (1.18.125 — pinned-skill scope widening)', () => {
  it('returns undefined when the cron has no allowlist (skill tools should not narrow an unrestricted cron)', () => {
    expect(widenAllowlistWithSkillTools(undefined, ['Read', 'Bash'])).toBeUndefined();
    // 1.18.148 — empty + skill tools widens to skill tools (skill pin is a
    // positive signal that overrides "deny all"). Empty + no skill pin
    // stays empty (predictable mode contract).
    expect(widenAllowlistWithSkillTools([], ['Read', 'Bash'])).toEqual(['Read', 'Bash']);
    expect(widenAllowlistWithSkillTools([], undefined)).toEqual([]);
    expect(widenAllowlistWithSkillTools([], [])).toEqual([]);
  });

  it('returns the cron allowlist unchanged when no pinned-skill tools were declared', () => {
    expect(widenAllowlistWithSkillTools(['Read', 'Edit'], undefined)).toEqual(['Read', 'Edit']);
    expect(widenAllowlistWithSkillTools(['Read', 'Edit'], [])).toEqual(['Read', 'Edit']);
  });

  it('unions cron allowlist with skill tools (widens, never narrows)', () => {
    const result = widenAllowlistWithSkillTools(['Read'], ['Read', 'Bash']);
    expect(new Set(result)).toEqual(new Set(['Read', 'Bash']));
  });

  it('dedupes when cron and skill request the same tool', () => {
    const result = widenAllowlistWithSkillTools(['Read', 'Bash'], ['Bash', 'Edit']);
    expect(result).toHaveLength(3);
    expect(new Set(result)).toEqual(new Set(['Read', 'Bash', 'Edit']));
  });

  it('does not mutate inputs', () => {
    const cron = ['Read'];
    const skills = ['Bash'];
    const cronBefore = [...cron];
    const skillsBefore = [...skills];
    widenAllowlistWithSkillTools(cron, skills);
    expect(cron).toEqual(cronBefore);
    expect(skills).toEqual(skillsBefore);
  });

  it('downstream computeEffectiveAllowedTools sees the widened list', () => {
    // End-to-end: cron allows [Read], skill needs Bash, profile permits both.
    // Pre-1.18.125 the SDK only saw Read; now it sees Read + Bash.
    const widened = widenAllowlistWithSkillTools(['Read'], ['Bash']);
    const eff = computeEffectiveAllowedTools(widened, ['Read', 'Bash', 'Edit']);
    expect(eff).toBeDefined();
    expect(new Set(eff)).toEqual(new Set(['Agent', 'Read', 'Bash']));
  });
});

describe('extractMcpServersFromSkillBodies (1.18.125)', () => {
  it('returns an empty array when no skill bodies reference MCP tools', () => {
    expect(extractMcpServersFromSkillBodies([])).toEqual([]);
    expect(extractMcpServersFromSkillBodies(['Just a plain Markdown body, no MCP refs.'])).toEqual([]);
  });

  it('extracts a single server name from a body that calls one MCP tool', () => {
    const body = 'Send via mcp__gmail__send_message with the right subject.';
    expect(extractMcpServersFromSkillBodies([body])).toEqual(['gmail']);
  });

  it('captures server names with single underscores (claude_ai_Microsoft_365)', () => {
    const body = '1. Pull email via mcp__claude_ai_Microsoft_365__outlook_email_search.';
    expect(extractMcpServersFromSkillBodies([body])).toEqual(['claude_ai_Microsoft_365']);
  });

  it('captures dashed and CamelCase server names (clementine-tools, ElevenLabs, Bright_Data)', () => {
    const body = 'mcp__clementine-tools__list_skills, mcp__ElevenLabs__text_to_speech, mcp__Bright_Data__discover.';
    expect(new Set(extractMcpServersFromSkillBodies([body]))).toEqual(
      new Set(['clementine-tools', 'ElevenLabs', 'Bright_Data']),
    );
  });

  it('dedupes the same server referenced multiple times across bodies', () => {
    const a = 'Step 1: mcp__gmail__send_message.';
    const b = 'Step 2: also use mcp__gmail__list_messages and mcp__slack__post_message.';
    expect(new Set(extractMcpServersFromSkillBodies([a, b]))).toEqual(new Set(['gmail', 'slack']));
  });

  it('ignores empty / nullish bodies without throwing', () => {
    const result = extractMcpServersFromSkillBodies(['', 'mcp__gmail__send', '' as string]);
    expect(result).toEqual(['gmail']);
  });
});

describe('widenMcpAllowlistWithSkillRefs (1.18.125)', () => {
  it('returns undefined when the cron has no MCP allowlist (unrestricted)', () => {
    expect(widenMcpAllowlistWithSkillRefs(undefined, ['gmail'])).toBeUndefined();
    // 1.18.148 — empty + skill refs widens to skill refs. Empty + no
    // skill refs stays empty (predictable mode contract).
    expect(widenMcpAllowlistWithSkillRefs([], ['gmail'])).toEqual(['gmail']);
    expect(widenMcpAllowlistWithSkillRefs([], [])).toEqual([]);
  });

  it('returns the cron MCP allowlist unchanged when no skill refs were found', () => {
    expect(widenMcpAllowlistWithSkillRefs(['slack'], [])).toEqual(['slack']);
  });

  it('unions cron MCP allowlist with skill-referenced servers', () => {
    const result = widenMcpAllowlistWithSkillRefs(['slack'], ['gmail', 'slack']);
    expect(new Set(result)).toEqual(new Set(['slack', 'gmail']));
  });

  it('does not mutate inputs', () => {
    const cron = ['slack'];
    const refs = ['gmail'];
    widenMcpAllowlistWithSkillRefs(cron, refs);
    expect(cron).toEqual(['slack']);
    expect(refs).toEqual(['gmail']);
  });
});
