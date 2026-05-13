/**
 * Pins the lane → permissionMode mapping introduced in Commit 2 of the
 * orchestrator-first sequence. Until 1.18.209 the autonomous lanes
 * relied on the implicit `buildExecutionToolPolicy()` default of
 * `'dontAsk'` — meaning any future change to that default would silently
 * widen scheduled work. This test pins the contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CLEMENTINE_HOME = `/private/tmp/clementine-permission-mode-${process.pid}`;
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

import { defaultPermissionModeForLane } from '../src/agent/execution-policy.js';
import { runAgentCron } from '../src/agent/run-agent-cron.js';
import { runAgentHeartbeat } from '../src/agent/run-agent-heartbeat.js';
import { runAgentTeamTask } from '../src/agent/run-agent-team-task.js';

describe('defaultPermissionModeForLane', () => {
  it('returns bypassPermissions for chat (trusted local owner)', () => {
    expect(defaultPermissionModeForLane('chat')).toBe('bypassPermissions');
  });

  it('returns dontAsk for cron (scheduled autonomous)', () => {
    expect(defaultPermissionModeForLane('cron')).toBe('dontAsk');
  });

  it('returns dontAsk for heartbeat (decision-only autonomous)', () => {
    expect(defaultPermissionModeForLane('heartbeat')).toBe('dontAsk');
  });

  it('returns dontAsk for team-task (agent-to-agent autonomous)', () => {
    expect(defaultPermissionModeForLane('team-task')).toBe('dontAsk');
  });

  it('fails closed to dontAsk for unknown sources', () => {
    expect(defaultPermissionModeForLane('plugin-x')).toBe('dontAsk');
    expect(defaultPermissionModeForLane('')).toBe('dontAsk');
  });
});

describe('autonomous lane wrappers pin explicit permissionMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildExtraMcpForRunAgent.mockResolvedValue({
      servers: {},
      composioConnected: [],
      externalConnected: [],
    });
    mocks.runAgent.mockResolvedValue({
      text: 'ok',
      totalCostUsd: 0.01,
      numTurns: 1,
      sessionId: 'sdk-test',
      subtype: 'success',
      runId: 'run-test',
      permissionMode: 'dontAsk',
      allowedToolsApplied: [],
      builtinToolsApplied: [],
      mcpServersApplied: [],
    });
  });

  it('runAgentCron forwards permissionMode=dontAsk explicitly', async () => {
    await runAgentCron({
      jobName: 'permission-pin-test',
      jobPrompt: 'noop',
      tier: 0,
    });
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const opts = mocks.runAgent.mock.calls[0]![1];
    expect(opts.permissionMode).toBe('dontAsk');
  });

  it('runAgentHeartbeat forwards permissionMode=dontAsk explicitly', async () => {
    await runAgentHeartbeat({
      standingInstructions: 'be brief',
    });
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const opts = mocks.runAgent.mock.calls[0]![1];
    expect(opts.permissionMode).toBe('dontAsk');
  });

  it('runAgentTeamTask forwards permissionMode=dontAsk explicitly', async () => {
    await runAgentTeamTask({
      fromSlug: 'alice',
      content: 'ping',
      profile: {
        slug: 'bob',
        displayName: 'Bob',
      } as any,
    } as any);
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const opts = mocks.runAgent.mock.calls[0]![1];
    expect(opts.permissionMode).toBe('dontAsk');
  });
});
