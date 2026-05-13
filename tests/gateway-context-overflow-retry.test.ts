import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

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

import { buildContextOverflowRetryPrompt, Gateway, runAgentResultIndicatesContextOverflow, SILENT_GATEWAY_RESPONSE } from '../src/gateway/router.js';
import { loadBackgroundTask } from '../src/agent/background-tasks.js';
import { EventLog } from '../src/gateway/event-log.js';
import type { RunEvent } from '../src/types.js';

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
    rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
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
    delete process.env.CLEMENTINE_BUSY_INPUT_MODE;
  });

  it('summarizes side effects across overflow retry runs and resumes from that state', async () => {
    const assistant = fakeAssistant();
    const log = new EventLog(process.env.CLEMENTINE_HOME);
    const append = (over: Partial<RunEvent>) => log.append({
      runId: 'run-a',
      seq: 0,
      ts: '2026-05-12T21:08:00.000Z',
      kind: 'llm_text',
      ...over,
    } as RunEvent);

    mocks.runAgent
      .mockImplementationOnce(async (_prompt: string, opts: { onRunStart?: (runId: string) => void }) => {
        opts.onRunStart?.('run-a');
        append({
          runId: 'run-a',
          seq: 0,
          kind: 'tool_call',
          toolName: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
          toolUseId: 'send-1',
          toolInput: { to: 'kevin@example.com', subject: 'Denver legal search', body: 'hello' },
        });
        append({
          runId: 'run-a',
          seq: 1,
          kind: 'tool_result',
          toolUseId: 'send-1',
          toolResult: { successful: true, error: null, data: { status_code: 202 }, logId: 'log_1' },
        });
        append({
          runId: 'run-a',
          seq: 2,
          kind: 'tool_call',
          toolName: 'mcp__gmail__GMAIL_SEND_EMAIL',
          toolUseId: 'send-2',
          toolInput: { to: 'busby@example.com', subject: 'Tucson legal market', body: 'hello' },
        });
        append({
          runId: 'run-a',
          seq: 3,
          kind: 'tool_result',
          toolUseId: 'send-2',
          toolResult: { successful: true, error: null, data: { status_code: 202 }, logId: 'log_2' },
        });
        throw new Error('Prompt is too long');
      })
      .mockImplementationOnce(async (_prompt: string, opts: { onRunStart?: (runId: string) => void }) => {
        opts.onRunStart?.('run-b');
        append({
          runId: 'run-b',
          seq: 0,
          kind: 'tool_call',
          toolName: 'mcp__dataforseo__SEARCH',
          toolUseId: 'search-1',
        });
        append({
          runId: 'run-b',
          seq: 1,
          kind: 'tool_result',
          toolUseId: 'search-1',
          toolResult: { successful: true, data: [] },
        });
        throw new Error('Autocompact is thrashing');
      })
      .mockResolvedValueOnce(fakeRunResult('Salesforce cleanup complete'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'OK Alex can we fire off those emails now please',
    );

    expect(response).toContain('work had already happened');
    expect(response).toContain('2 email sends completed');
    expect(response).toContain('kevin@example.com');
    expect(response).toContain('busby@example.com');
    expect(response).toContain('Reply `continue`');

    const continued = await gateway.handleMessage('discord:user:123', 'continue please');
    expect(continued).toBe('Salesforce cleanup complete');
    expect(mocks.runAgent).toHaveBeenCalledTimes(3);
    const continuationPrompt = mocks.runAgent.mock.calls[2]![0] as string;
    expect(continuationPrompt).toContain('DO NOT re-run completed side effects');
    expect(continuationPrompt).toContain('kevin@example.com');
    expect(continuationPrompt).toContain('busby@example.com');
    expect(continuationPrompt).toContain('Focus on remaining follow-up');
  });

  it('asks for a generic deployment-target decision after overflow, then resumes without restarting discovery', async () => {
    const assistant = fakeAssistant();
    assistant.getSdkSessionId.mockReturnValue(null);
    const log = new EventLog(process.env.CLEMENTINE_HOME);
    const append = (over: Partial<RunEvent>) => log.append({
      runId: 'run-deploy',
      seq: 0,
      ts: '2026-05-13T09:13:17.741Z',
      kind: 'llm_text',
      ...over,
    } as RunEvent);

    mocks.runAgent
      .mockImplementationOnce(async (_prompt: string, opts: { onRunStart?: (runId: string) => void }) => {
        opts.onRunStart?.('run-deploy');
        append({
          seq: 0,
          kind: 'tool_call',
          toolName: 'Agent',
          toolUseId: 'agent-discovery',
          toolInput: {
            description: 'Find product site project',
            subagent_type: 'discovery',
            prompt: 'Find the local product site project.',
          },
        });
        append({
          seq: 1,
          kind: 'tool_result',
          toolUseId: 'agent-discovery',
          toolResult: [
            {
              type: 'text',
              text: [
                'Found: 1 matching project',
                'Path: `/Users/example/Projects/product-site/dist/index.html`',
                'No deploy.json found.',
                'agentId: agent-discovery-1',
              ].join('\n'),
            },
          ],
        });
        append({
          seq: 2,
          kind: 'tool_call',
          toolName: 'Read',
          toolUseId: 'read-html',
          toolInput: {
            file_path: '/Users/example/Projects/product-site/dist/index.html',
          },
        });
        append({
          seq: 3,
          kind: 'tool_result',
          toolUseId: 'read-html',
          toolResult: {
            _clementine_guard: true,
            tool: 'Read',
            originalBytes: 17600,
            capBytes: 3500,
            bytesShed: 14100,
            archivePath: '/Users/example/.clementine/tool-archive/run-deploy/Read__read-html.json',
          },
        });
        append({
          seq: 4,
          kind: 'tool_call',
          toolName: 'Write',
          toolUseId: 'write-html',
          toolInput: {
            file_path: '/Users/example/Projects/product-site/dist/index.html',
          },
        });
        append({
          seq: 5,
          kind: 'tool_result',
          toolUseId: 'write-html',
          toolResult: 'File created successfully at: /Users/example/Projects/product-site/dist/index.html',
        });
        append({
          seq: 6,
          kind: 'tool_call',
          toolName: 'Bash',
          toolUseId: 'deploy-fail',
          toolInput: {
            command: 'cd "/Users/example/Projects/product-site" && netlify deploy --prod --dir=dist 2>&1 | tail -40',
          },
        });
        append({
          seq: 7,
          kind: 'tool_result',
          toolUseId: 'deploy-fail',
          toolResult: 'Error: Project not found. Please rerun "netlify link"\nShell cwd was reset to /Users/example/.clementine',
        });
        throw new Error('Autocompact is thrashing');
      })
      .mockResolvedValueOnce(fakeRunResult('Linked the deployment target and deployed the site.'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'can you finish the product landing page and deploy it please',
    );

    expect(response).toContain('I need one decision');
    expect(response).toContain('Provider: Netlify');
    expect(response).toContain('not linked to a deployment target');
    expect(response).toContain('netlify deploy --prod');
    expect(response).toContain('Project not found. Please rerun "netlify link"');
    expect(response).toContain('create target');
    expect(response).toContain('use existing <target-slug-or-id>');

    (gateway as unknown as {
      createBackgroundOffer: (sessionKey: string, prompt: string, recommendation: {
        reasons: string[];
        suggestedMaxMinutes: number;
        plan: string[];
        queueImmediately: true;
      }) => unknown;
    }).createBackgroundOffer('discord:user:123', 'stale background offer', {
      reasons: ['test stale offer'],
      suggestedMaxMinutes: 30,
      plan: ['do unrelated background work'],
      queueImmediately: true,
    });

    const ambiguousYes = await gateway.handleMessage('discord:user:123', 'yes');
    expect(ambiguousYes).toContain('I need a specific decision');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);

    const vague = await gateway.handleMessage('discord:user:123', 'continue');
    expect(vague).toContain('I need a specific decision');
    expect(vague).toContain('create target');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);

    const continued = await gateway.handleMessage('discord:user:123', 'create target');
    expect(continued).toBe('Linked the deployment target and deployed the site.');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    const continuationPrompt = mocks.runAgent.mock.calls[1]![0] as string;
    expect(continuationPrompt).toContain('needs_user_decision -> executing');
    expect(continuationPrompt).toContain('Decision kind: blocked_external_action');
    expect(continuationPrompt).toContain('Provider: Netlify');
    expect(continuationPrompt).toContain('Create/link a new deployment target');
    expect(continuationPrompt).toContain('netlify deploy --prod');
    expect(continuationPrompt).toContain('Project not found. Please rerun "netlify link"');
    expect(continuationPrompt).toContain('Completed before the block');
    expect(continuationPrompt).toContain('dist/index.html');
    expect(continuationPrompt).toContain('Do not restart project discovery');
    expect(continuationPrompt).toContain('Discovery already completed');
    expect(continuationPrompt).toContain('Original owner request');
    expect(continuationPrompt).toContain('can you finish the product landing page');
  });

  it('retries with fresh SDK session when overflow happens on a resumed session (1.18.196)', async () => {
    // 1.18.196 — SDK session JSONLs can grow to 80+MB after months of
    // chat. Resuming one of those blows context on the first user
    // message. Smart recovery: drop the resume, retry once fresh.
    // A freshly-installed version still inherits old provider session
    // files from the user's data directory.
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
      'Please rebuild the product dashboard in the project and publish it.',
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
      'Please rebuild the product dashboard in the project and publish it.',
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
      'Please rebuild the product dashboard in the project and publish it.',
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
      'Please rebuild the product dashboard in the project and publish it.',
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
      'Please rebuild the product dashboard in the project and publish it.',
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
    // The detector can return recommendations for explicit background wording
    // or inferred durable batch work. Either way, chat must not run inline.
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
      'Run this in the background: rebuild the product dashboard and publish it overnight.',
    );

    expect(response).toContain('Queued background task');
    expect(response).toContain('fresh task session');
    expect(mocks.runAgent).not.toHaveBeenCalled();
    const id = response.match(/bg-[a-z0-9]+-[a-f0-9]{6}/)?.[0];
    expect(id).toBeTruthy();
    const task = loadBackgroundTask(id!);
    expect(task?.prompt).toContain('Background task from chat');
    expect(task?.prompt).toContain('rebuild the product dashboard');
  });

  it('queues immediately when the detector infers durable batch work', async () => {
    const assistant = fakeAssistant();
    mocks.detectComplexTaskForBackground.mockReturnValue({
      reasons: ['large batch (100 items)', '2 named systems'],
      suggestedMaxMinutes: 90,
      plan: ['Run discovery preflight.', 'Process records in bounded batches.'],
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
      'Research 100 businesses, put the results in Google Sheets, then draft Outlook emails.',
    );

    expect(response).toContain('Queued background task');
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it('does NOT pre-queue ordinary "build and deploy" chat — that runs in-chat now', async () => {
    // Saturday-feel guard: chat should not silently route project-build /
    // deploy requests to the Tasks tab. The model uses planner/researcher
    // subagents and Bash for the work, in the live SDK loop.
    const assistant = fakeAssistant();
    mocks.runAgent.mockResolvedValueOnce(fakeRunResult('published the site'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const response = await gateway.handleMessage(
      'discord:user:123',
      'Look at this project locally, do X, Y, and Z, spin up an HTML file, send it back, and publish it.',
    );

    expect(response).toBe('published the site');
    expect(response).not.toContain('Queued background task');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it('does not let a stopped prior run answer over the next user message', async () => {
    const assistant = fakeAssistant();
    let firstRunStarted!: () => void;
    const firstRunReady = new Promise<void>((resolve) => { firstRunStarted = resolve; });
    mocks.runAgent
      .mockImplementationOnce(async (_prompt: string, opts: { abortSignal?: AbortSignal }) => {
        firstRunStarted();
        await new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by user')), { once: true });
        });
        return fakeRunResult('should not return');
      })
      .mockResolvedValueOnce(fakeRunResult('sent directly'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const first = gateway.handleMessage('discord:user:123', 'do a long outreach run');
    await firstRunReady;

    const stop = await gateway.handleMessage('discord:user:123', 'stop');
    const next = await gateway.handleMessage('discord:user:123', 'you can send directly please');
    const firstResponse = await first;

    expect(stop).toContain('Stopping');
    expect(firstResponse).toBe(SILENT_GATEWAY_RESPONSE);
    expect(next).toBe('sent directly');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
  });

  it('can queue a new busy-session message instead of interrupting the active run', async () => {
    process.env.CLEMENTINE_BUSY_INPUT_MODE = 'queue';
    const assistant = fakeAssistant();
    let firstRunStarted!: () => void;
    let finishFirst!: () => void;
    const firstRunReady = new Promise<void>((resolve) => { firstRunStarted = resolve; });
    const finishFirstRun = new Promise<void>((resolve) => { finishFirst = resolve; });
    mocks.runAgent
      .mockImplementationOnce(async () => {
        firstRunStarted();
        await finishFirstRun;
        return fakeRunResult('first finished');
      })
      .mockResolvedValueOnce(fakeRunResult('second finished'));

    const gateway = new Gateway(assistant as never) as Gateway & {
      getAgentManager: () => unknown;
      _maybeRouteToSpecialist: () => Promise<null>;
    };
    gateway.getAgentManager = vi.fn(() => null);
    gateway._maybeRouteToSpecialist = vi.fn(async () => null);

    const first = gateway.handleMessage('discord:user:123', 'start a long task');
    await firstRunReady;
    const second = gateway.handleMessage('discord:user:123', 'add this after it finishes');

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);

    finishFirst();
    await expect(first).resolves.toBe('first finished');
    await expect(second).resolves.toBe('second finished');
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
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
      'Please rebuild the product dashboard in the project and publish it.',
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
        path: '/Users/example/Projects/product-dashboard',
        description: 'Product dashboard',
      },
    });

    expect(prompt).toContain('/Users/example/Projects/product-dashboard');
    expect(prompt).toContain('Deploy the dashboard.');
    expect(prompt).toContain('trimmed oversized carry-over context');
    expect(prompt.length).toBeLessThan(7_000);
  });
});
