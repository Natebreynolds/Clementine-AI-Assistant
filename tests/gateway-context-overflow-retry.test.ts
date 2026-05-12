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

  it('retries with fresh SDK session when overflow happens on a resumed session (1.18.196)', async () => {
    // 1.18.196 — SDK session JSONLs can grow to 80+MB after months of
    // chat. Resuming one of those blows context on the first user
    // message. Smart recovery: drop the resume, retry once fresh.
    // Zach hit this on a freshly-installed 1.18.195.
    const assistant = fakeAssistant(); // getSdkSessionId returns 'sdk-old'
    mocks.runAgent
      .mockRejectedValueOnce(new Error('Prompt is too long'))
      .mockResolvedValueOnce(fakeRunResult('done after fresh-session retry'));

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

    // Owner gets the actual response from the retry, not the
    // recovery message. They lose the prior session's chat memory
    // (it's gone — we couldn't load it) but they get a working answer.
    expect(response).toBe('done after fresh-session retry');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    // First call had resumeSessionId; second did not.
    expect(mocks.runAgent.mock.calls[0]![1].resumeSessionId).toBe('sdk-old');
    expect(mocks.runAgent.mock.calls[1]![1].resumeSessionId).toBeUndefined();
    expect(assistant.clearSession).toHaveBeenCalledWith('discord:user:123');
    expect(progress).toHaveBeenCalledWith('long conversation history — starting a fresh session...');
  });

  it('surfaces recovery message when fresh-session retry ALSO overflows', async () => {
    // The retry is one shot. If even a fresh session can't fit the
    // message, that's a real ceiling — surface the recovery prompt
    // with rephrase/`/plan` options. No second retry.
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockRejectedValueOnce(new Error('Prompt is too long'))
      .mockRejectedValueOnce(new Error('Autocompact is thrashing'));

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

    expect(response).toContain('past the context limit');
    expect(response).toContain('/plan');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
  });

  it('surfaces recovery message when SDK returns rapid-refill result on a virgin (no-resume) session', async () => {
    // No resume to drop = no retry to try. Surface the recovery
    // message directly.
    const assistant = fakeAssistant();
    assistant.getSdkSessionId.mockReturnValue(null); // no prior session
    mocks.runAgent.mockResolvedValueOnce(fakeContextOverflowResult());

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

    expect(response).toContain('past the context limit');
    expect(response).toContain('/plan');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(assistant.clearSession).toHaveBeenCalledWith('discord:user:123');
  });

  it('retries on result-shaped overflow (resumed session, not thrown)', async () => {
    // The SDK can also report overflow via the result subtype rather
    // than throwing. The retry should fire either way.
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockResolvedValueOnce(fakeContextOverflowResult())
      .mockResolvedValueOnce(fakeRunResult('done after fresh-session retry'));

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

    expect(response).toBe('done after fresh-session retry');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(mocks.runAgent.mock.calls[0]![1].resumeSessionId).toBe('sdk-old');
    expect(mocks.runAgent.mock.calls[1]![1].resumeSessionId).toBeUndefined();
  });

  it('does not retry when SDK reports a thrash error (autocompact ceiling)', async () => {
    const assistant = fakeAssistant();
    assistant.getSdkSessionId.mockReturnValue(null); // no resume → no retry to try
    mocks.runAgent.mockRejectedValueOnce(new Error('Autocompact is thrashing: the context refilled to the limit within 3 turns.'));

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

    // 1.18.194 — overflow no longer queues a planner task. SDK's own
    // autocompact has already tried; we surface a clean rephrase/plan
    // message and clear the session. No more "Planning failed" stack.
    expect(response).toContain('past the context limit');
    expect(response).toContain('/plan');
    expect(response).not.toContain('decomposing your request');
    expect(response).not.toContain('Please resend your message');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
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

  it('surfaces clean recovery message when both attempts overflow', async () => {
    // Result-shaped overflow on a resumed session → retry fresh → retry
    // ALSO returns overflow result → surface recovery message.
    const assistant = fakeAssistant();
    mocks.runAgent
      .mockResolvedValueOnce(fakeContextOverflowResult())
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

    // 1.18.194 — no more planner queue on result-shaped overflow either.
    expect(response).toContain('past the context limit');
    expect(response).toContain('/plan');
    expect(response).not.toContain('decomposing your request');
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

    // 1.18.194 — context_overflow no longer falls back to "resend" OR
    // to a background task. New message offers two clean recovery paths.
    expect(response).not.toMatch(/resend/i);
    expect(response).toContain('past the context limit');
    expect(response).toContain('/plan');
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
