import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CLEMENTINE_HOME = `/private/tmp/clementine-run-agent-cron-bg-${process.pid}`;
});

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  buildExtraMcpForRunAgent: vi.fn(),
}));

vi.mock('../src/agent/run-agent.js', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('../src/agent/run-agent-mcp.js', () => ({
  buildExtraMcpForRunAgent: mocks.buildExtraMcpForRunAgent,
}));

import { runAgentCron } from '../src/agent/run-agent-cron.js';

describe('runAgentCron background task worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildExtraMcpForRunAgent.mockResolvedValue({
      servers: { dataforseo: { type: 'stdio', command: 'dataforseo-mcp' } },
      composioConnected: ['dataforseo'],
      externalConnected: [],
    });
    mocks.runAgent.mockResolvedValue({
      text: 'done',
      totalCostUsd: 0.01,
      numTurns: 2,
      sessionId: 'sdk-bg',
      subtype: 'success',
      runId: 'run-bg',
      permissionMode: 'dontAsk',
      allowedToolsApplied: ['Agent'],
      builtinToolsApplied: ['Agent'],
      mcpServersApplied: ['dataforseo'],
    });
  });

  it('forces queued chat background tasks through a subagent worker', async () => {
    await runAgentCron({
      jobName: 'bg:bg-test-123',
      jobPrompt: 'Scrape 20 firms, write the Google Sheet, and report back.',
      tier: 2,
    });

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const opts = mocks.runAgent.mock.calls[0]![1];
    expect(opts.allowedTools).toEqual(['Agent']);
    expect(opts.forceSubagent).toBe('background-task-worker');
    expect(opts.maxTurns).toBe(5);
    expect(opts.permissionTools).toContain('Agent');
    expect(opts.permissionTools).toContain('mcp__clementine-tools__*');
    expect(opts.permissionTools).toContain('mcp__dataforseo__*');
    expect(opts.agents['background-task-worker'].tools).toContain('mcp__dataforseo__*');
  });
});
