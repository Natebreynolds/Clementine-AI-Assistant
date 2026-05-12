import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.hoisted(() => {
  process.env.CLEMENTINE_HOME = `/private/tmp/clementine-run-agent-session-store-${process.pid}`;
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMocks.query,
  foldSessionSummary: (_prev: unknown, key: { sessionId: string }, entries: unknown[]) => ({
    sessionId: key.sessionId,
    mtime: Date.now(),
    data: { entries: entries.length },
  }),
}));

import { isSdkContextDiagnosticText, runAgent } from '../src/agent/run-agent.js';

function makeSdkStream() {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-session-1', mcp_servers: [] };
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-session-1',
      result: 'hello',
      total_cost_usd: 0,
      num_turns: 1,
      modelUsage: {
        'claude-test': {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    };
  })();
}

function fakeMemoryStore() {
  return {
    appendSessionEntries: vi.fn(),
    loadSessionEntries: vi.fn(() => null),
    listSdkSessions: vi.fn(() => []),
    listSdkSessionSubkeys: vi.fn(() => []),
    listSdkSessionSummaries: vi.fn(() => []),
    deleteSdkSession: vi.fn(),
    upsertSessionSummary: vi.fn(),
    logUsage: vi.fn(),
  };
}

beforeEach(() => {
  sdkMocks.query.mockReset();
  sdkMocks.query.mockImplementation(() => makeSdkStream());
});

describe('runAgent session persistence', () => {
  it('recognizes SDK context diagnostic text blocks', () => {
    expect(isSdkContextDiagnosticText('Autocompact is thrashing: the context refilled to the limit within 3 turns.')).toBe(true);
    expect(isSdkContextDiagnosticText('The previous run hit rapid_refill_breaker because the file was huge.')).toBe(false);
  });

  it('passes the SQLite-backed SDK SessionStore when a memory store is available', async () => {
    const store = fakeMemoryStore();

    await runAgent('remember this turn', {
      sessionKey: 'discord:user:123',
      source: 'chat',
      memoryStore: store as never,
      allowedTools: [],
    });

    const call = sdkMocks.query.mock.calls[0]?.[0] as { options?: { sessionStore?: unknown } };
    expect(call.options?.sessionStore).toBeDefined();
    expect(typeof (call.options!.sessionStore as { append?: unknown }).append).toBe('function');
    expect(typeof (call.options!.sessionStore as { load?: unknown }).load).toBe('function');
    expect((call.options as { mcpServers?: Record<string, { env?: Record<string, string> }> })?.mcpServers?.['clementine-tools']?.env?.CLEMENTINE_SESSION_KEY)
      .toBe('discord:user:123');
  });

  it('pre-approves permissionTools without widening visible built-in tools', async () => {
    await runAgent('delegate only', {
      sessionKey: 'cron:skill',
      source: 'scheduled-skill',
      allowedTools: ['Agent'],
      permissionTools: ['Agent', 'Read', 'memory_read'],
    });

    const call = sdkMocks.query.mock.calls[0]?.[0] as {
      options?: {
        tools?: string[];
        allowedTools?: string[];
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
    };
    expect(call.options?.tools).toEqual(['Agent']);
    expect(call.options?.allowedTools).toContain('Agent');
    expect(call.options?.allowedTools).toContain('Read');
    expect(call.options?.allowedTools).toContain('mcp__clementine-tools__memory_read');
    expect(call.options?.mcpServers?.['clementine-tools']?.env?.CLEMENTINE_SESSION_KEY).toBe('cron:skill');
    expect(call.options?.mcpServers?.['clementine-tools']?.env?.CLEMENTINE_TOOL_ALLOWLIST).toBe('memory_read');
  });

  it('suppresses SDK context diagnostics from live text streaming', async () => {
    sdkMocks.query.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-session-2', mcp_servers: [] };
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.',
            },
            { type: 'text', text: 'Still working.' },
          ],
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      };
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sdk-session-2',
        terminal_reason: 'rapid_refill_breaker',
        total_cost_usd: 0,
        num_turns: 1,
      };
    })());

    const onText = vi.fn();
    const result = await runAgent('do the long task', {
      sessionKey: 'discord:user:123',
      source: 'chat',
      allowedTools: [],
      onText,
    });

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('Still working.');
    expect(result.text).toBe('Still working.');
    expect(result.subtype).toBe('error_during_execution');
    expect(result.terminalReason).toBe('rapid_refill_breaker');
  });
});
