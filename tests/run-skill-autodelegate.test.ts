/**
 * Tests for the autonomous auto-delegation wrapper in run-skill.ts
 * (1.18.173).
 *
 * Covers shouldAutoDelegate detection, worker-agent construction, and
 * orchestrator-prompt shape. The actual SDK call is mocked at the
 * runAgent boundary so we can assert what gets passed without spinning
 * up a real query.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Skill } from '../src/types.js';

// Mock runAgent so we can inspect what runSkill passes to the SDK boundary.
const runAgentMock = vi.fn(async (_prompt: string, _opts: unknown) => ({
  text: 'mock response',
  totalCostUsd: 0.01,
  numTurns: 1,
  sessionId: 'sess',
  subtype: 'success',
  runId: 'run-test',
  permissionMode: 'dontAsk' as const,
  allowedToolsApplied: [],
  builtinToolsApplied: [],
  mcpServersApplied: [],
}));

vi.mock('../src/agent/run-agent.js', () => ({
  runAgent: (prompt: string, opts: unknown) => runAgentMock(prompt, opts),
}));

// Mock the skill loader so we can inject test skills without touching disk.
const getSkillMock = vi.fn();
vi.mock('../src/agent/skill-store.js', () => ({
  getSkill: (name: string, opts: unknown) => getSkillMock(name, opts),
}));

// Mock the MCP builder — we don't need real MCP servers for these tests.
vi.mock('../src/agent/run-agent-mcp.js', () => ({
  buildExtraMcpForRunAgent: async () => ({
    servers: {},
    composioConnected: [],
    externalConnected: [],
    droppedClaudeAi: [],
    droppedComposio: [],
  }),
}));

import { runSkill } from '../src/agent/run-skill.js';

function fakeSkill(over: Partial<Skill> = {}): Skill {
  return {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill.',
      ...over.frontmatter,
    },
    body: 'Step 1: do X.\nStep 2: do Y.',
    filePath: '/tmp/test-skill/SKILL.md',
    scope: 'global',
    layout: 'folder',
    schemaVersion: 'clementine',
    bundledFiles: [],
    usedByTriggers: [],
    validation: [],
    ...over,
  };
}

beforeEach(() => {
  runAgentMock.mockClear();
  getSkillMock.mockReset();
});

describe('runSkill autonomous auto-delegation (1.18.173)', () => {
  it('uses the auto-delegating wrapper for scheduled-skill source', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'imessage-triage',
        description: 'Triage iMessages',
        clementine: {
          tools: { allow: ['imessage_read', 'discord_send_dm'] },
        },
      },
    }));

    const result = await runSkill('imessage-triage', { source: 'scheduled-skill' });
    expect(result.ok).toBe(true);
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    const [prompt, opts] = runAgentMock.mock.calls[0];
    // Parent prompt should mention dispatching to skill-worker
    expect(prompt as string).toContain('skill-worker');
    expect(prompt as string).toContain('Dispatch');
    expect(prompt as string).toContain('imessage-triage');
    // Parent allowedTools should be only ['Agent']
    expect((opts as { allowedTools?: string[] }).allowedTools).toEqual(['Agent']);
    expect((opts as { permissionTools?: string[] }).permissionTools).toEqual(expect.arrayContaining([
      'Agent',
      'imessage_read',
      'discord_send_dm',
    ]));
    // forceSubagent should be set
    expect((opts as { forceSubagent?: string }).forceSubagent).toBe('skill-worker');
    // agents map should contain skill-worker
    const agents = (opts as { agents?: Record<string, { prompt?: string; tools?: string[] }> }).agents ?? {};
    expect(agents['skill-worker']).toBeDefined();
    expect(agents['skill-worker'].tools).toContain('imessage_read');
    expect(agents['skill-worker'].tools).toContain('discord_send_dm');
    // Worker's system prompt embeds the skill body
    expect(agents['skill-worker'].prompt).toContain('Step 1: do X.');
  });

  it('renders inputs and caller context into the worker prompt', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'rendered-skill',
        description: 'Uses runtime values.',
        clementine: { tools: { allow: ['Read'] } },
      },
      body: 'Review {{account_name}} and report back.',
    }));

    await runSkill('rendered-skill', {
      source: 'scheduled-skill',
      inputs: { account_name: 'Acme Legal' },
      context: 'Triggered by weekly schedule.',
    });

    const [, opts] = runAgentMock.mock.calls[0];
    const agents = (opts as { agents?: Record<string, { prompt?: string }> }).agents ?? {};
    expect(agents['skill-worker'].prompt).toContain('Review Acme Legal and report back.');
    expect(agents['skill-worker'].prompt).toContain('## Caller context');
    expect(agents['skill-worker'].prompt).toContain('Triggered by weekly schedule.');
  });

  it('uses the inline path for chat source (no auto-delegation)', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'my-skill',
        description: 'A skill.',
        clementine: {
          tools: { allow: ['Bash'] },
        },
      },
    }));

    await runSkill('my-skill', { source: 'skill' });
    const [prompt, opts] = runAgentMock.mock.calls[0];
    // Inline branch: prompt is the skill body, NOT an orchestrator
    expect(prompt as string).toContain('Step 1: do X.');
    expect(prompt as string).not.toContain('skill-worker');
    // No forceSubagent
    expect((opts as { forceSubagent?: string }).forceSubagent).toBeUndefined();
    // allowedTools is the skill's allowlist (not just ['Agent'])
    const allowed = (opts as { allowedTools?: string[] }).allowedTools;
    expect(allowed).toContain('Bash');
  });

  it('honors clementine.execution.inline opt-out', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'opt-out-skill',
        description: 'Always inline.',
        clementine: {
          tools: { allow: ['Read'] },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          execution: { inline: true } as any,
        },
      },
    }));

    await runSkill('opt-out-skill', { source: 'scheduled-skill' });
    const [prompt, opts] = runAgentMock.mock.calls[0];
    // Should be inline despite scheduled-skill source
    expect(prompt as string).not.toContain('skill-worker');
    expect((opts as { forceSubagent?: string }).forceSubagent).toBeUndefined();
  });

  it('defaults to plain Sonnet (200K, no [1m]) for autonomous runs', async () => {
    // 1.18.182: autonomous default flipped from Sonnet [1m] to plain
    // Sonnet so cron/scheduled-skill/heartbeat/team-task runs stay on
    // the standard Sonnet meter covered by Max plans. Sonnet [1m] is
    // the "Extra Usage path" on Anthropic's billing — defaulting to it
    // silently routed autonomous work onto a separate metered bill.
    // Worker-subagent isolation (1.18.173) keeps 200K comfortable for
    // heavy skills. Skills that need 1M opt in via frontmatter
    // clementine.limits.model: claude-sonnet-4-6[1m] or
    // claude-opus-4-7[1m] (the latter is covered by Max).
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'big-skill',
        description: 'Reads a lot.',
        clementine: {
          tools: { allow: ['Read'] },
        },
      },
    }));

    await runSkill('big-skill', { source: 'cron' });
    const [, opts] = runAgentMock.mock.calls[0];
    const model = (opts as { model?: string }).model ?? '';
    expect(model.toLowerCase()).toContain('sonnet');
    expect(model).not.toContain('[1m]');
  });

  it('honors skill-declared limits.model when it opts into [1m]', async () => {
    // Escape hatch: a skill that genuinely needs the 1M window can
    // request it via clementine.limits.model. Verifies the opt-in path
    // still works after the 1.18.182 default flip.
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'huge-skill',
        description: 'Truly needs 1M context.',
        clementine: {
          tools: { allow: ['Read'] },
          limits: { model: 'claude-opus-4-7[1m]' },
        },
      },
    }));

    await runSkill('huge-skill', { source: 'cron' });
    const [, opts] = runAgentMock.mock.calls[0];
    expect((opts as { model?: string }).model).toBe('claude-opus-4-7[1m]');
  });

  it('honors explicit caller model override', async () => {
    getSkillMock.mockReturnValue(fakeSkill());
    await runSkill('test-skill', {
      source: 'scheduled-skill',
      model: 'claude-opus-4-7',
    });
    const [, opts] = runAgentMock.mock.calls[0];
    expect((opts as { model?: string }).model).toBe('claude-opus-4-7');
  });

  it('caps parent maxTurns at 5 (parent should dispatch + relay)', async () => {
    getSkillMock.mockReturnValue(fakeSkill());
    await runSkill('test-skill', { source: 'scheduled-skill' });
    const [, opts] = runAgentMock.mock.calls[0];
    expect((opts as { maxTurns?: number }).maxTurns).toBe(5);
  });

  it('passes the skill author maxTurns to the worker, not the parent', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'limited-skill',
        description: 'Capped.',
        clementine: {
          tools: { allow: ['Read'] },
          limits: { maxTurns: 12 },
        },
      },
    }));

    await runSkill('limited-skill', { source: 'scheduled-skill' });
    const [, opts] = runAgentMock.mock.calls[0];
    // Parent should be capped at 5 regardless
    expect((opts as { maxTurns?: number }).maxTurns).toBe(5);
    // Worker should get the skill's maxTurns
    const agents = (opts as { agents?: Record<string, { maxTurns?: number }> }).agents ?? {};
    expect(agents['skill-worker'].maxTurns).toBe(12);
  });

  it('falls back to worker maxTurns=30 when skill declares none', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'no-cap-skill',
        description: 'No limits.',
        clementine: { tools: { allow: ['Read'] } },
      },
    }));
    await runSkill('no-cap-skill', { source: 'scheduled-skill' });
    const [, opts] = runAgentMock.mock.calls[0];
    const agents = (opts as { agents?: Record<string, { maxTurns?: number }> }).agents ?? {};
    expect(agents['skill-worker'].maxTurns).toBe(30);
  });

  it('lets caller maxBudgetUsd=0 override a skill-local budget cap', async () => {
    getSkillMock.mockReturnValue(fakeSkill({
      frontmatter: {
        name: 'uncapped-skill',
        description: 'Has a local cap.',
        clementine: {
          tools: { allow: ['Read'] },
          limits: { maxBudgetUsd: 0.05 },
        },
      },
    }));

    await runSkill('uncapped-skill', { source: 'scheduled-skill', maxBudgetUsd: 0 });
    const [, opts] = runAgentMock.mock.calls[0];
    expect((opts as { maxBudgetUsd?: number }).maxBudgetUsd).toBe(0);
  });

  it('returns ok=false when skill not found', async () => {
    getSkillMock.mockReturnValue(null);
    const r = await runSkill('nonexistent', { source: 'scheduled-skill' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
