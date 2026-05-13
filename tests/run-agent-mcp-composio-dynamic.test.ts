import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listConnectedToolkits: vi.fn(),
  matchConnectedToolkitsInText: vi.fn(),
  buildComposioMcpServers: vi.fn(),
  getMcpServersForAgent: vi.fn(),
  loadClaudeIntegrations: vi.fn(),
  loadToolPreferences: vi.fn(),
}));

vi.mock('../src/integrations/composio/client.js', () => ({
  listConnectedToolkits: mocks.listConnectedToolkits,
  matchConnectedToolkitsInText: mocks.matchConnectedToolkitsInText,
}));

vi.mock('../src/integrations/composio/mcp-bridge.js', () => ({
  buildComposioMcpServers: mocks.buildComposioMcpServers,
}));

vi.mock('../src/agent/mcp-bridge.js', () => ({
  getMcpServersForAgent: mocks.getMcpServersForAgent,
  loadClaudeIntegrations: mocks.loadClaudeIntegrations,
}));

vi.mock('../src/integrations/tool-preferences.js', () => ({
  KNOWN_SERVICES: [],
  loadToolPreferences: mocks.loadToolPreferences,
}));

describe('runAgent MCP Composio dynamic routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.listConnectedToolkits.mockResolvedValue([
      { slug: 'airtable', connectionId: 'conn-airtable', status: 'ACTIVE' },
    ]);
    mocks.matchConnectedToolkitsInText.mockReturnValue(['airtable']);
    mocks.buildComposioMcpServers.mockImplementation(async (slugs?: string[]) => {
      const servers: Record<string, Record<string, unknown>> = {};
      for (const slug of slugs ?? []) {
        servers[slug] = { type: 'sdk', name: slug };
      }
      return servers;
    });
    mocks.getMcpServersForAgent.mockReturnValue({});
    mocks.loadClaudeIntegrations.mockReturnValue({});
    mocks.loadToolPreferences.mockReturnValue({ preferences: {} });
  });

  it('mounts an arbitrary active Composio toolkit mentioned in the run scope', async () => {
    const { buildExtraMcpForRunAgent } = await import('../src/agent/run-agent-mcp.js');

    const result = await buildExtraMcpForRunAgent({
      scopeText: 'Sync the Airtable base, then summarize the changed records.',
    });

    expect(mocks.listConnectedToolkits).toHaveBeenCalledTimes(1);
    expect(mocks.matchConnectedToolkitsInText).toHaveBeenCalledWith(
      'Sync the Airtable base, then summarize the changed records.',
      [{ slug: 'airtable', connectionId: 'conn-airtable', status: 'ACTIVE' }],
    );
    expect(mocks.buildComposioMcpServers).toHaveBeenCalledWith(['airtable']);
    expect(result.composioConnected).toEqual(['airtable']);
    expect(Object.keys(result.servers)).toEqual(['airtable']);
  });

  it('does not widen beyond an explicit agent Composio allowlist', async () => {
    const { buildExtraMcpForRunAgent } = await import('../src/agent/run-agent-mcp.js');

    const result = await buildExtraMcpForRunAgent({
      scopeText: 'Sync the Airtable base.',
      profile: {
        slug: 'ops',
        name: 'Ops',
        tier: 1,
        description: '',
        systemPromptBody: '',
        allowedComposioToolkits: ['slack'],
      } as never,
    });

    expect(mocks.listConnectedToolkits).not.toHaveBeenCalled();
    expect(mocks.matchConnectedToolkitsInText).not.toHaveBeenCalled();
    expect(mocks.buildComposioMcpServers).toHaveBeenCalledWith(['slack']);
    expect(result.composioConnected).toEqual(['slack']);
  });
});
