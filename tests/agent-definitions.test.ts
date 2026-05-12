import { describe, expect, it } from 'vitest';
import { buildAgentMap, hasAgent } from '../src/agent/agent-definitions.js';
import type { AgentManager } from '../src/agent/agent-manager.js';
import type { AgentProfile } from '../src/types.js';

function makeProfile(slug: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    slug,
    name: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    tier: 1,
    description: `${slug} agent`,
    systemPromptBody: `You are ${slug}.`,
    ...overrides,
  } as AgentProfile;
}

function fakeManager(profiles: AgentProfile[]): AgentManager {
  return {
    listAll: () => profiles,
    get: (slug: string) => profiles.find(p => p.slug === slug) ?? null,
  } as unknown as AgentManager;
}

describe('buildAgentMap — system subagents', () => {
  it('always includes planner / researcher / discovery / cron-fixer', () => {
    const map = buildAgentMap();
    expect(hasAgent(map, 'planner')).toBe(true);
    expect(hasAgent(map, 'researcher')).toBe(true);
    expect(hasAgent(map, 'discovery')).toBe(true); // 1.18.197
    expect(hasAgent(map, 'cron-fixer')).toBe(true);
  });

  it('discovery subagent (1.18.197) is haiku, bounded tools, read-only', () => {
    const { discovery } = buildAgentMap();
    expect(discovery.model).toBe('haiku');
    expect(discovery.effort).toBe('low');
    // Must have Bash for `head`, `find`, `ls`, `wc` — the bounded primitives.
    expect(discovery.tools).toContain('Bash');
    // Must have Read + Glob for targeted lookups.
    expect(discovery.tools).toContain('Read');
    expect(discovery.tools).toContain('Glob');
    // Must NOT include mutating tools — discovery is strictly read-only.
    expect(discovery.tools).not.toContain('Edit');
    expect(discovery.tools).not.toContain('Write');
    // Description must mention local file-system discovery so the SDK
    // auto-routes "find that project" / "where is X" / "scan the Y folder"
    // to it instead of the parent running recursive Glob/Read inline.
    const desc = discovery.description ?? '';
    expect(desc).toMatch(/file-system|find|locate|discover/i);
  });

  it('planner uses opus and has no tools', () => {
    const { planner } = buildAgentMap();
    expect(planner.model).toBe('opus');
    expect(planner.tools).toEqual([]);
    expect(planner.maxTurns).toBe(1);
  });

  it('researcher uses haiku for cheap fan-out', () => {
    const { researcher } = buildAgentMap();
    expect(researcher.model).toBe('haiku');
    expect(researcher.effort).toBe('low');
  });

  it('researcher does NOT have a tools allowlist — inherits parent surface (1.18.198)', () => {
    // Before 1.18.198 researcher had a hardcoded allowlist that excluded
    // every MCP server. When Ross dispatched "Parallel SEO enrichment for
    // 13 domains" the subagent couldn't call mcp__dataforseo__* and fell
    // back to "I cannot do this" — Ross then ran 25 sequential MCP calls
    // in his own turn instead. The fix: omit `tools` so the subagent
    // inherits parent's full tool surface. Safety lives in the prompt.
    const { researcher } = buildAgentMap();
    expect(researcher.tools).toBeUndefined();
  });

  it('researcher prompt enforces read-only behavior as a behavior class, not allowlist', () => {
    const { researcher } = buildAgentMap();
    const prompt = researcher.prompt ?? '';
    // Must call out read-only.
    expect(prompt.toLowerCase()).toContain('read-only');
    // Must name the mutation-keyword regex so the model can self-police
    // against ANY MCP server (not just ones we know about).
    expect(prompt).toMatch(/send_|create_|update_|delete_/);
    // Must tell researcher it inherits from parent.
    expect(prompt.toLowerCase()).toMatch(/inherit|every tool the parent/);
  });

  it('cron-fixer has the canonical broken-job tools, not a generic surface', () => {
    const { 'cron-fixer': fixer } = buildAgentMap();
    expect(fixer.tools).toContain('mcp__clementine-tools__list_broken_jobs');
    expect(fixer.tools).toContain('mcp__clementine-tools__apply_broken_job_fix');
    expect(fixer.model).toBe('sonnet');
  });

  it('every system subagent has a description that includes "Use" or "Used"', () => {
    const map = buildAgentMap();
    for (const [name, def] of Object.entries(map)) {
      expect(def.description, `subagent ${name} description`).toMatch(/\bUse(?:d|s|\s)/);
    }
  });
});

describe('buildAgentMap — hired-agent profiles', () => {
  it('adds hired agents from profileManager (excluding clementine)', () => {
    const profiles = [
      makeProfile('clementine'),
      makeProfile('ross-the-sdr', { description: 'SDR specialist', model: 'sonnet' }),
      makeProfile('sasha-the-cmo', { description: 'CMO specialist' }),
    ];
    const map = buildAgentMap({ profileManager: fakeManager(profiles) });
    expect(hasAgent(map, 'ross-the-sdr')).toBe(true);
    expect(hasAgent(map, 'sasha-the-cmo')).toBe(true);
    expect(hasAgent(map, 'clementine')).toBe(false);
  });

  it('hired-agent definitions inherit description from profile', () => {
    const profiles = [makeProfile('ross-the-sdr', { description: 'Outbound SDR for cold outreach' })];
    const map = buildAgentMap({ profileManager: fakeManager(profiles) });
    expect(map['ross-the-sdr'].description).toContain('Outbound SDR');
  });

  it('hired agent gets sonnet by default', () => {
    const profiles = [makeProfile('nora', { description: 'Senior SDR' })];
    const map = buildAgentMap({ profileManager: fakeManager(profiles) });
    expect(map['nora'].model).toBe('sonnet');
  });

  it('hired agent honors profile.model override', () => {
    const profiles = [makeProfile('budget-bot', { description: 'Cheap helper', model: 'haiku' })];
    const map = buildAgentMap({ profileManager: fakeManager(profiles) });
    expect(map['budget-bot'].model).toBe('haiku');
  });

  it('hired agent restricts tools when profile.team.allowedTools is set', () => {
    const profiles = [makeProfile('locked-down', {
      description: 'Restricted',
      team: { channelName: 'x', channels: [], canMessage: [], allowedTools: ['Read', 'Grep'] },
    })];
    const map = buildAgentMap({ profileManager: fakeManager(profiles) });
    // `Agent` is always included so the subagent can further delegate;
    // the profile's allowlist narrows the rest.
    expect(map['locked-down'].tools).toEqual(['Agent', 'Read', 'Grep']);
  });

  it('skips the active agent (no recursion into self as subagent)', () => {
    const profiles = [
      makeProfile('clementine'),
      makeProfile('ross-the-sdr', { description: 'SDR' }),
      makeProfile('sasha-the-cmo', { description: 'CMO' }),
    ];
    const map = buildAgentMap({
      profileManager: fakeManager(profiles),
      activeAgentSlug: 'ross-the-sdr',
    });
    expect(hasAgent(map, 'ross-the-sdr')).toBe(false);
    expect(hasAgent(map, 'sasha-the-cmo')).toBe(true);
  });

  it('returns only system subagents when no profileManager', () => {
    const map = buildAgentMap();
    const slugs = Object.keys(map);
    // 1.18.197 — discovery joined the system roster.
    expect(slugs).toEqual(expect.arrayContaining(['planner', 'researcher', 'discovery', 'cron-fixer']));
    // No hired agents in the map.
    expect(slugs.length).toBe(4);
  });
});
