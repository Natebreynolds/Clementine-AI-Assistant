/**
 * Allowlist intersection helpers — `computeEffectiveAllowedTools` and
 * `applyMcpAllowlist` from `src/agent/run-agent-cron.ts`.
 */

import { describe, expect, it } from 'vitest';
import { computeEffectiveAllowedTools, applyMcpAllowlist } from '../src/agent/run-agent-cron.js';

describe('computeEffectiveAllowedTools', () => {
  it('returns undefined when both job and profile allowlists are absent (legacy behavior preserved)', () => {
    expect(computeEffectiveAllowedTools(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when job allowlist is undefined even if profile has one', () => {
    expect(computeEffectiveAllowedTools(undefined, ['Read', 'Edit'])).toBeUndefined();
  });

  it('returns undefined when job allowlist is an empty array (treats empty as "not set")', () => {
    expect(computeEffectiveAllowedTools([], ['Read', 'Edit'])).toBeUndefined();
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

  it('returns the input map unchanged when allowlist is empty', () => {
    const result = applyMcpAllowlist(servers, []);
    expect(result).toBe(servers);
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
