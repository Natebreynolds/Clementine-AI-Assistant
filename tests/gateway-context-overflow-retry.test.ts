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

import { buildContextOverflowRetryPrompt, Gateway } from '../src/gateway/router.js';

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
