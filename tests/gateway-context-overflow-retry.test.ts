import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const home = `/private/tmp/clementine-gateway-context-retry-${process.pid}`;
  process.env.CLEMENTINE_HOME = home;
});

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  buildExtraMcpForRunAgent: vi.fn(),
  buildChatSystemAppend: vi.fn(),
  resolveSkillsForChat: vi.fn(),
  buildActiveContextSnapshot: vi.fn(),
  persistConversationLearning: vi.fn(),
  detectCommitmentInTurn: vi.fn(),
  recordDetectedCommitment: vi.fn(),
  getEntityRegistry: vi.fn(),
  findEntitiesInText: vi.fn(),
  detectComplexTaskForBackground: vi.fn(),
}));

vi.mock('../src/agent/run-agent.js', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('../src/agent/run-agent-mcp.js', () => ({
  buildExtraMcpForRunAgent: mocks.buildExtraMcpForRunAgent,
}));

vi.mock('../src/agent/run-agent-context.js', () => ({
  buildChatSystemAppend: mocks.buildChatSystemAppend,
}));

vi.mock('../src/agent/chat-skill-resolver.js', () => ({
  resolveSkillsForChat: mocks.resolveSkillsForChat,
}));

vi.mock('../src/gateway/active-context.js', () => ({
  buildActiveContextSnapshot: mocks.buildActiveContextSnapshot,
}));

vi.mock('../src/gateway/conversation-learning.js', () => ({
  persistConversationLearning: mocks.persistConversationLearning,
}));

vi.mock('../src/gateway/commitments.js', () => ({
  detectCommitmentInTurn: mocks.detectCommitmentInTurn,
  recordDetectedCommitment: mocks.recordDetectedCommitment,
}));

vi.mock('../src/gateway/entity-registry.js', () => ({
  getEntityRegistry: mocks.getEntityRegistry,
  findEntitiesInText: mocks.findEntitiesInText,
}));

vi.mock('../src/agent/complex-task-detector.js', () => ({
  detectComplexTaskForBackground: mocks.detectComplexTaskForBackground,
}));

import { buildContextOverflowRetryPrompt, Gateway, runAgentResultIndicatesContextOverflow } from '../src/gateway/router.js';
import { loadBackgroundTask } from '../src/agent/background-tasks.js';

function fakeRunResult(text = 'published dashboard') {
  return {
    text,
    totalCostUsd: 0.01,
    numTurns: 2,
    sessionId: 'sdk-new',
    subtype: 'success',
    runId: 'run-retry',
    permissionMode: 'dontAsk' as const,
    allowedToolsApplied: ['Agent', 'Read'],
    builtinToolsApplied: ['Agent', 'Read'],
    mcpServersApplied: [],
  };
}

function fakeContextOverflowResult() {
  return {
    text: '',
    totalCostUsd: 0.01,
    numTurns: 3,
    sessionId: 'sdk-overflow',
    subtype: 'error_during_execution',
    terminalReason: 'rapid_refill_breaker',
    runId: 'run-overflow',
    permissionMode: 'dontAsk' as const,
    allowedToolsApplied: ['Agent', 'Read'],
    builtinToolsApplied: ['Agent', 'Read'],
    mcpServersApplied: [],
  };
}

function fakeAssistant() {
  return {
    hasRecentApprovalPrompt: vi.fn(() => false),
    getMemoryStore: vi.fn(() => null),
    getExchangeCount: vi.fn(() => 3),
    compactSessionForGateway: vi.fn(() => ({ compacted: false, exchangeCount: 3, reason: 'test' })),
    getSdkSessionId: vi.fn(() => 'sdk-old'),
    clearSession: vi.fn(),
    setSdkSessionId: vi.fn(),
    injectContext: vi.fn(),
    triggerMemoryExtractionPostExchange: vi.fn(async () => undefined),
  };
}

describe('gateway context overflow retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAgent.mockReset();
    mocks.buildExtraMcpForRunAgent.mockResolvedValue({
      servers: {},
      composioConnected: [],
      externalConnected: [],
      droppedClaudeAi: [],
      droppedComposio: [],
    });
    mocks.buildChatSystemAppend.mockReturnValue('System context');
    mocks.resolveSkillsForChat.mockReturnValue(null);
    mocks.buildActiveContextSnapshot.mockReturnValue(null);
    mocks.persistConversationLearning.mockReturnValue(null);
    mocks.detectCommitmentInTurn.mockReturnValue(null);
    mocks.getEntityRegistry.mockReturnValue([]);
    mocks.findEntitiesInText.mockReturnValue([]);
    mocks.detectComplexTaskForBackground.mockReturnValue(null);
  });

  it('retries the current chat message once in a fresh SDK session after context overflow', async () => {
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockRejectedValueOnce(new Error('Prompt is too long'))
      .mockResolvedValueOnce(fakeRunResult());

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const progress = vi.fn(async () => undefined);
    const response = await gateway.handleMessage(
      'discord:user:123',
      'Please recreate the coaches dashboard in the project and host it on Netlify.',
      undefined,
      undefined,
      undefined,
      undefined,
      progress,
    );

    expect(response).toBe('published dashboard');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);

    const firstCall = mocks.runAgent.mock.calls[0]!;
    const secondCall = mocks.runAgent.mock.calls[1]!;
    expect(firstCall[1].resumeSessionId).toBe('sdk-old');
    expect(secondCall[1].resumeSessionId).toBeUndefined();
    expect(secondCall[0]).toContain('fresh session');
    expect(secondCall[0]).toContain('Do not ask the user to resend it');
    expect(secondCall[0]).toContain('Please recreate the coaches dashboard');
    expect(assistant.clearSession).toHaveBeenCalledWith('discord:user:123');
    expect(assistant.setSdkSessionId).toHaveBeenCalledWith('discord:user:123', 'sdk-new');
    expect(progress).toHaveBeenCalledWith('refreshing conversation context...');
  });

  it('retries when the SDK returns a rapid-refill result instead of throwing', async () => {
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockResolvedValueOnce(fakeContextOverflowResult())
      .mockResolvedValueOnce(fakeRunResult('done after retry'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const progress = vi.fn(async () => undefined);
    const response = await gateway.handleMessage(
      'discord:user:123',
      'Please recreate the coaches dashboard in the project and host it on Netlify.',
      undefined,
      undefined,
      undefined,
      undefined,
      progress,
    );

    expect(response).toBe('done after retry');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(mocks.runAgent.mock.calls[1]![1].resumeSessionId).toBeUndefined();
    expect(assistant.clearSession).toHaveBeenCalledWith('discord:user:123');
    expect(progress).toHaveBeenCalledWith('refreshing conversation context...');
  });

  it('queues background work instead of asking the user to resend when the retry also overflows', async () => {
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockRejectedValueOnce(new Error('Prompt is too long'))
      .mockRejectedValueOnce(new Error('Autocompact is thrashing: the context refilled to the limit within 3 turns.'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'Please recreate the coaches dashboard in the project and host it on Netlify.',
    );

    // 1.18.190 — overflow now routes to the planner-orchestrator chain
    // instead of a monolithic bg-task. Message describes the new flow.
    expect(response).toContain('decomposing your request into chained steps');
    expect(response).toContain('bg-');
    expect(response).not.toContain('Please resend your message');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(assistant.clearSession).toHaveBeenCalledWith('discord:user:123');
  });

  it('queues immediately when the user explicitly asks for background work', async () => {
    const assistant = fakeAssistant();
    // The narrow detector only returns a recommendation when EXPLICIT_BACKGROUND_RE
    // matches. The mock simulates that branch firing — chat must not run.
    mocks.detectComplexTaskForBackground.mockReturnValue({
      reasons: ['explicit background/deep-work wording'],
      suggestedMaxMinutes: 90,
      plan: ['Do the work in bounded batches.', 'Return the final deliverable.'],
      queueImmediately: true,
    });

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'Run this in the background: recreate the coaches dashboard and host it on Netlify overnight.',
    );

    expect(response).toContain('Queued background task');
    expect(response).toContain('fresh task session');
    expect(mocks.runAgent).not.toHaveBeenCalled();
    const id = response.match(/bg-[a-z0-9]+-[a-f0-9]{6}/)?.[0];
    expect(id).toBeTruthy();
    const task = loadBackgroundTask(id!);
    expect(task?.prompt).toContain('Background task from chat');
    expect(task?.prompt).toContain('recreate the coaches dashboard');
  });

  it('does NOT pre-queue ordinary "build and deploy" chat — that runs in-chat now', async () => {
    // Saturday-feel guard: chat should not silently route project-build /
    // deploy requests to the Tasks tab. The model uses planner/researcher
    // subagents and Bash for the work, in the live SDK loop.
    const assistant = fakeAssistant();
    mocks.runAgent.mockResolvedValueOnce(fakeRunResult('deployed to Netlify'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'Look at this project locally, do X, Y, and Z, spin up an HTML file, send it back, host it on Netlify.',
    );

    expect(response).toBe('deployed to Netlify');
    expect(response).not.toContain('Queued background task');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it('queues background work when the fresh retry returns rapid-refill again', async () => {
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockRejectedValueOnce(new Error('Prompt is too long'))
      .mockResolvedValueOnce(fakeContextOverflowResult());

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'Please recreate the coaches dashboard in the project and host it on Netlify.',
    );

    // 1.18.190 — overflow now routes through planner. Same code path
    // as the prior test; message updated to match new flow.
    expect(response).toContain('decomposing your request into chained steps');
    expect(response).not.toContain('Please resend your message');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
  });

  it('does not expose the old resend fallback for context overflow classification', async () => {
    const assistant = fakeAssistant();
    mocks.runAgent.mockRejectedValue(new Error('maximum context length exceeded'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage('discord:user:123', 'Do a large local project build and deploy.');

    expect(response).not.toMatch(/resend/i);
    expect(response).toContain('background task');
  });

  it('classifies rapid-refill run results as context overflow', () => {
    expect(runAgentResultIndicatesContextOverflow(fakeContextOverflowResult())).toBe(true);
    expect(runAgentResultIndicatesContextOverflow(fakeRunResult())).toBe(false);
  });

  it('keeps retry context compact while preserving the active project path', () => {
    const prompt = buildContextOverflowRetryPrompt({
      chatPrompt: 'Deploy the dashboard.',
      turnContextPrefix: 'x'.repeat(20_000),
      project: {
        path: '/Users/zach/Projects/Track Coaches',
        description: 'Track coaches dashboard',
      },
    });

    expect(prompt).toContain('/Users/zach/Projects/Track Coaches');
    expect(prompt).toContain('Deploy the dashboard.');
    expect(prompt).toContain('trimmed oversized carry-over context');
    expect(prompt.length).toBeLessThan(7_000);
  });
});
