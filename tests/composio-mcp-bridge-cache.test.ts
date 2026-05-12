import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK MCP server factory so we don't try to spin up real servers —
// we only care that the bridge avoids re-fetching toolkit tools on a hit.
const mocks = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((cfg: { name: string }) => ({
    type: 'sdk' as const,
    name: cfg.name,
    instance: { _stub: true, name: cfg.name },
  })),
  toolsGet: vi.fn(),
  listConnectedToolkits: vi.fn(),
  getPreferredUserId: vi.fn(async () => 'default'),
  getComposio: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: mocks.createSdkMcpServer,
}));

vi.mock('../src/integrations/composio/client.js', () => ({
  getComposio: mocks.getComposio,
  getPreferredUserId: mocks.getPreferredUserId,
  listConnectedToolkits: mocks.listConnectedToolkits,
}));

describe('Composio MCP bridge server cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.getComposio.mockReturnValue({
      tools: { get: mocks.toolsGet },
    });
    mocks.listConnectedToolkits.mockResolvedValue([
      { slug: 'gmail', connectionId: 'conn-1', status: 'ACTIVE', createdAt: '2026-05-09T00:00:00Z' },
    ]);
    // Pretend Gmail has a couple of tool handlers — the bridge will namespace
    // them under `gmail`. We don't execute them; we just verify the cache.
    mocks.toolsGet.mockResolvedValue([
      { name: 'GMAIL_SEND_EMAIL', handler: () => undefined, inputSchema: {} },
      { name: 'GMAIL_LIST_MESSAGES', handler: () => undefined, inputSchema: {} },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses cached SDK servers across calls and only fetches tools once per toolkit', async () => {
    const { buildComposioMcpServers } = await import('../src/integrations/composio/mcp-bridge.js');

    const first = await buildComposioMcpServers(['gmail']);
    const second = await buildComposioMcpServers(['gmail']);
    const third = await buildComposioMcpServers(['gmail']);

    expect(Object.keys(first)).toEqual(['gmail']);
    expect(second['gmail']).toBe(first['gmail']);
    expect(third['gmail']).toBe(first['gmail']);
    expect(mocks.toolsGet).toHaveBeenCalledTimes(1);
    expect(mocks.createSdkMcpServer).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the cache is explicitly cleared', async () => {
    const { buildComposioMcpServers, clearComposioMcpCache } =
      await import('../src/integrations/composio/mcp-bridge.js');

    await buildComposioMcpServers(['gmail']);
    await buildComposioMcpServers(['gmail']);
    expect(mocks.toolsGet).toHaveBeenCalledTimes(1);

    clearComposioMcpCache('gmail');

    await buildComposioMcpServers(['gmail']);
    expect(mocks.toolsGet).toHaveBeenCalledTimes(2);
    expect(mocks.createSdkMcpServer).toHaveBeenCalledTimes(2);
  });

  it('rebuilds after the TTL window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));

    const { buildComposioMcpServers } = await import('../src/integrations/composio/mcp-bridge.js');

    await buildComposioMcpServers(['gmail']);
    expect(mocks.toolsGet).toHaveBeenCalledTimes(1);

    // Just under TTL — still a hit.
    vi.setSystemTime(new Date('2026-05-11T12:04:00Z'));
    await buildComposioMcpServers(['gmail']);
    expect(mocks.toolsGet).toHaveBeenCalledTimes(1);

    // Past 5-minute TTL — refetch.
    vi.setSystemTime(new Date('2026-05-11T12:06:00Z'));
    await buildComposioMcpServers(['gmail']);
    expect(mocks.toolsGet).toHaveBeenCalledTimes(2);
  });
});
