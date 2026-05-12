import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted handles to the SDK mocks so we can reach in and rewire them
// per-test. The Composio singleton holds onto whatever `Composio(...)` returns
// on first construction, so the cleanest way to vary behaviour is to keep the
// underlying `.list` etc. as `vi.fn` references we can `mockImplementation` on.
const mocks = vi.hoisted(() => ({
  connectedAccountsList: vi.fn(),
  connectedAccountsGet: vi.fn(),
  connectedAccountsDelete: vi.fn(),
  toolsExecute: vi.fn(),
}));

vi.mock('@composio/core', () => {
  class Composio {
    public readonly client: { connectedAccounts: { list: typeof mocks.connectedAccountsList } };
    public readonly connectedAccounts: {
      list: typeof mocks.connectedAccountsList;
      get: typeof mocks.connectedAccountsGet;
      delete: typeof mocks.connectedAccountsDelete;
    };
    public readonly tools: { execute: typeof mocks.toolsExecute };
    public readonly toolkits = { authorize: vi.fn() };
    public readonly authConfigs = { list: vi.fn(() => ({ items: [] })) };

    constructor(_opts: unknown) {
      this.client = { connectedAccounts: { list: mocks.connectedAccountsList } };
      this.connectedAccounts = {
        list: mocks.connectedAccountsList,
        get: mocks.connectedAccountsGet,
        delete: mocks.connectedAccountsDelete,
      };
      this.tools = { execute: mocks.toolsExecute };
    }
  }
  return { Composio };
});

vi.mock('@composio/claude-agent-sdk', () => ({
  ClaudeAgentSDKProvider: class {},
}));

const ORIGINAL_API_KEY = process.env.COMPOSIO_API_KEY;

describe('Composio client connection cache', () => {
  beforeEach(async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    vi.clearAllMocks();
    // Reset module state so the singleton + cache fields restart clean per test.
    vi.resetModules();
    // Default identity fetches: return nothing useful (we don't assert on labels).
    mocks.connectedAccountsGet.mockResolvedValue({ state: {}, data: {} });
    mocks.toolsExecute.mockResolvedValue({ successful: false, data: {} });
  });

  afterEach(() => {
    if (ORIGINAL_API_KEY === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = ORIGINAL_API_KEY;
  });

  it('serves repeat calls from the cache without re-hitting the API', async () => {
    mocks.connectedAccountsList.mockResolvedValue({
      items: [
        {
          id: 'conn-1',
          toolkit: { slug: 'gmail' },
          status: 'EXPIRED', // EXPIRED skips the identity round-trip — keeps the test focused
          alias: null,
          createdAt: '2026-05-09T00:00:00Z',
        },
      ],
    });

    const { listConnectedToolkits } = await import('../src/integrations/composio/client.js');

    const first = await listConnectedToolkits();
    const second = await listConnectedToolkits();
    const third = await listConnectedToolkits();

    expect(first).toHaveLength(1);
    expect(first[0]!.slug).toBe('gmail');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // The whole point: 3 caller invocations -> exactly 1 API call.
    expect(mocks.connectedAccountsList).toHaveBeenCalledTimes(1);
  });

  it('returns the stale cache when a refresh attempt fails after TTL', async () => {
    // First call seeds the cache successfully…
    mocks.connectedAccountsList.mockResolvedValueOnce({
      items: [
        {
          id: 'conn-1',
          toolkit: { slug: 'gmail' },
          status: 'EXPIRED',
          alias: null,
          createdAt: '2026-05-09T00:00:00Z',
        },
      ],
    });
    // …then the API craps out on the very next refresh, simulating the
    // mid-conversation Composio blip that used to make tools vanish.
    mocks.connectedAccountsList.mockRejectedValueOnce(new Error('Composio API 503'));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));

    try {
      const { listConnectedToolkits } =
        await import('../src/integrations/composio/client.js');

      const first = await listConnectedToolkits();
      expect(first).toHaveLength(1);

      // Jump past the 60s TTL so the next call attempts a refresh.
      vi.setSystemTime(new Date('2026-05-11T12:02:00Z'));

      const afterFailure = await listConnectedToolkits();
      expect(afterFailure).toHaveLength(1);
      expect(afterFailure[0]!.slug).toBe('gmail');
      expect(mocks.connectedAccountsList).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an empty list when the first ever fetch fails (no stale cache)', async () => {
    mocks.connectedAccountsList.mockRejectedValueOnce(new Error('Composio API 500'));

    const { listConnectedToolkits } = await import('../src/integrations/composio/client.js');
    const result = await listConnectedToolkits();
    expect(result).toEqual([]);
  });

  it('busts the cache on disconnect so the next call hits the API', async () => {
    mocks.connectedAccountsList.mockResolvedValue({
      items: [
        {
          id: 'conn-1',
          toolkit: { slug: 'gmail' },
          status: 'EXPIRED',
          alias: null,
          createdAt: '2026-05-09T00:00:00Z',
        },
      ],
    });
    mocks.connectedAccountsDelete.mockResolvedValue(undefined);

    const { listConnectedToolkits, disconnectToolkit } =
      await import('../src/integrations/composio/client.js');

    await listConnectedToolkits();
    await listConnectedToolkits();
    expect(mocks.connectedAccountsList).toHaveBeenCalledTimes(1);

    await disconnectToolkit('conn-1');

    await listConnectedToolkits();
    expect(mocks.connectedAccountsList).toHaveBeenCalledTimes(2);
  });
});
