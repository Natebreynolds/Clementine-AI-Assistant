import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

vi.hoisted(() => {
  process.env.CLEMENTINE_HOME = `/private/tmp/clementine-chat-orchestrator-opus-${process.pid}`;
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

import { MODELS } from '../src/config.js';
import { Gateway } from '../src/gateway/router.js';

function fakeRunResult(text = 'done') {
  return {
    text,
    totalCostUsd: 0.01,
    numTurns: 1,
    sessionId: 'sdk-session',
    subtype: 'success',
    runId: 'run-chat-model',
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
    getExchangeCount: vi.fn(() => 0),
    compactSessionForGateway: vi.fn(() => ({ compacted: false, exchangeCount: 0, reason: 'test' })),
    getSdkSessionId: vi.fn(() => undefined),
    clearSession: vi.fn(),
    setSdkSessionId: vi.fn(),
    injectContext: vi.fn(),
    getMemoryChunkCount: vi.fn(() => 0),
    triggerMemoryExtractionPostExchange: vi.fn(async () => undefined),
  };
}

function makeGateway(): Gateway {
  const gateway = new Gateway(fakeAssistant() as never) as Gateway & {
    getAgentManager: () => unknown;
    _maybeRouteToSpecialist: () => Promise<null>;
  };
  gateway.getAgentManager = vi.fn(() => null);
  gateway._maybeRouteToSpecialist = vi.fn(async () => null);
  return gateway;
}

function lastRunAgentOptions(): Record<string, unknown> {
  return mocks.runAgent.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe('chat Opus orchestrator routing', () => {
  beforeEach(() => {
    rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
    vi.clearAllMocks();
    mocks.runAgent.mockResolvedValue(fakeRunResult());
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

  it('defaults ordinary chat to Opus as the orchestrator model', async () => {
    const gateway = makeGateway();

    await gateway.handleMessage('discord:user:model-default', 'Please inspect the project files and summarize the implementation.');

    expect(lastRunAgentOptions().model).toBe(MODELS.opus);
  });

  it('lets a one-off caller model override the Opus default', async () => {
    const gateway = makeGateway();

    await gateway.handleMessage(
      'discord:user:model-explicit',
      'Please inspect the project files and summarize the implementation.',
      undefined,
      MODELS.sonnet,
    );

    expect(lastRunAgentOptions().model).toBe(MODELS.sonnet);
  });

  it('lets a persisted session model override the Opus default', async () => {
    const gateway = makeGateway();
    gateway.setSessionModel('discord:user:model-session', MODELS.haiku);

    await gateway.handleMessage('discord:user:model-session', 'Please inspect the project files and summarize the implementation.');

    expect(lastRunAgentOptions().model).toBe(MODELS.haiku);
  });

  it('keeps builder sessions on Haiku', async () => {
    const gateway = makeGateway();

    await gateway.handleMessage('dashboard:builder:test', 'Draft the agent configuration.');

    expect(lastRunAgentOptions().model).toBe(MODELS.haiku);
  });

  it('reports Opus as the default presence model when no override is set', () => {
    const gateway = makeGateway();

    expect(gateway.getPresenceInfo('discord:user:model-presence').model).toBe('Opus');
  });
});
