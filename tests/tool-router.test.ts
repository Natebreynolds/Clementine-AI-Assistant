import { describe, expect, it } from 'vitest';
import { applyServiceDedup, routeToolSurface, TOOL_SURFACE_HARD_LIMIT, TOOL_SURFACE_WARN_THRESHOLD } from '../src/agent/tool-router.js';
import { KNOWN_SERVICES } from '../src/integrations/tool-preferences.js';

describe('tool router', () => {
  it('defaults routine turns to the core Clementine tool surface', () => {
    const route = routeToolSurface('what changed in the repo?');

    expect(route.bundles).toEqual([]);
    expect(route.externalMcpServers).toEqual([]);
    expect(route.composioToolkits).toEqual([]);
    expect(route.inheritFullClaudeEnv).toBe(false);
    expect(route.fullSurface).toBe(false);
  });

  it('routes Outlook/email work to the email bundle only', () => {
    const route = routeToolSurface('check the Outlook inbox and do reply detection');

    expect(route.bundles).toEqual(['email_outlook']);
    expect(route.externalMcpServers).toEqual(['Microsoft_365']);
    expect(route.composioToolkits).toEqual(['outlook']);
    expect(route.inheritFullClaudeEnv).toBe(true);
  });

  it('does not route browser just because profile text mentions browser context', () => {
    const route = routeToolSurface('audit inbox check with browser automation mentioned as context');

    expect(route.bundles).toEqual(['email_outlook']);
  });

  it('routes explicit browser inspection work to browser tools', () => {
    const route = routeToolSurface('open localhost and take a screenshot');

    expect(route.bundles).toEqual(['browser']);
    expect(route.externalMcpServers).toContain('playwright');
  });

  it('routes Google Sheets without loading every Google toolkit', () => {
    const route = routeToolSurface('update the Google Sheets pipeline tracker');

    expect(route.bundles).toEqual(['sheets_google']);
    expect(route.externalMcpServers).toEqual(['Google_Workspace', 'Google_Drive']);
    expect(route.composioToolkits).toEqual(['googlesheets', 'googledrive']);
    expect(route.fullSurface).toBe(false);
  });

  it('routes exact Composio MCP tool mentions for generic seed feeds', () => {
    const route = routeToolSurface('Call exactly this selected tool: `mcp__hubspot__HUBSPOT_GET_CONTACTS`');

    expect(route.bundles).toEqual([]);
    expect(route.externalMcpServers).toEqual(['hubspot']);
    expect(route.composioToolkits).toEqual(['hubspot']);
    expect(route.inheritFullClaudeEnv).toBe(true);
    expect(route.reason).toBe('matched');
  });

  it('routes exact Claude Desktop tool mentions back to the integration name', () => {
    const route = routeToolSurface('Call exactly this selected tool: `mcp__claude_ai_Google_Drive__search_files`');

    expect(route.externalMcpServers).toEqual(['Google_Drive']);
    expect(route.composioToolkits).toEqual([]);
    expect(route.inheritFullClaudeEnv).toBe(true);
  });

  it('does not route generic issue follow-ups to GitHub', () => {
    const route = routeToolSurface('How do we fix that issue?');

    expect(route.bundles).toEqual([]);
    expect(route.externalMcpServers).toEqual([]);
    expect(route.composioToolkits).toEqual([]);
  });

  it('still routes explicit repo issues to GitHub', () => {
    const route = routeToolSurface('check the repo issue about the failing workflow');

    expect(route.bundles).toEqual(['github']);
    expect(route.externalMcpServers).toEqual(['github']);
  });

  it('combines multiple required bundles deterministically', () => {
    const route = routeToolSurface('find the lead in Google Drive and send a follow-up email');

    expect(route.bundles).toEqual(['email_outlook', 'drive_google']);
    expect(route.externalMcpServers).toEqual(['Microsoft_365', 'Google_Drive']);
    expect(route.composioToolkits).toEqual(['outlook', 'googledrive']);
  });

  it('keeps all-tool access explicit', () => {
    const route = routeToolSurface('debug with all integrations and the full tool surface');

    expect(route.fullSurface).toBe(true);
    expect(route.externalMcpServers).toBeUndefined();
    expect(route.composioToolkits).toBeUndefined();
    expect(route.inheritFullClaudeEnv).toBe(true);
  });

  it('exposes a concrete high-surface warning threshold', () => {
    expect(TOOL_SURFACE_WARN_THRESHOLD).toBeGreaterThan(0);
    expect(TOOL_SURFACE_WARN_THRESHOLD).toBeLessThan(953);
    expect(TOOL_SURFACE_HARD_LIMIT).toBeGreaterThan(TOOL_SURFACE_WARN_THRESHOLD);
  });
});

describe('applyServiceDedup', () => {
  // Outlook bundle's route shape — same as routeToolSurface('check Outlook')
  const outlookRoute = {
    bundles: ['email_outlook'] as any,
    externalMcpServers: ['Microsoft_365'],
    composioToolkits: ['outlook'],
    inheritFullClaudeEnv: true,
    fullSurface: false,
    reason: 'matched' as const,
  };

  it('drops claude.ai source when both Composio + claude.ai connected, no preference set', () => {
    const result = applyServiceDedup(outlookRoute, {
      composioConnected: new Set(['outlook']),
      claudeDesktopActive: new Set(['Microsoft_365']),
      preferences: {},
      knownServices: KNOWN_SERVICES,
    });

    expect(result.droppedClaudeAi).toEqual(['Microsoft_365']);
    expect(result.droppedComposio).toEqual([]);
    expect(result.route.externalMcpServers).toEqual([]);
    expect(result.route.composioToolkits).toEqual(['outlook']);
    expect(result.route.inheritFullClaudeEnv).toBe(false);
    expect(result.anyClaudeDesktopKept).toBe(false);
  });

  it('drops Composio source when user explicitly prefers claude.ai', () => {
    const result = applyServiceDedup(outlookRoute, {
      composioConnected: new Set(['outlook']),
      claudeDesktopActive: new Set(['Microsoft_365']),
      preferences: { outlook: 'claude-desktop' },
      knownServices: KNOWN_SERVICES,
    });

    expect(result.droppedClaudeAi).toEqual([]);
    expect(result.droppedComposio).toEqual(['outlook']);
    expect(result.route.externalMcpServers).toEqual(['Microsoft_365']);
    expect(result.route.composioToolkits).toEqual([]);
    expect(result.route.inheritFullClaudeEnv).toBe(true);
    expect(result.anyClaudeDesktopKept).toBe(true);
  });

  it('drops nothing when only one source is available (no conflict)', () => {
    const result = applyServiceDedup(outlookRoute, {
      composioConnected: new Set(['outlook']),
      claudeDesktopActive: new Set(),
      preferences: {},
      knownServices: KNOWN_SERVICES,
    });

    expect(result.droppedClaudeAi).toEqual(['Microsoft_365']);
    expect(result.droppedComposio).toEqual([]);
    expect(result.route.composioToolkits).toEqual(['outlook']);
    expect(result.anyClaudeDesktopKept).toBe(false);
  });

  it('disables both sources when service preference is "off"', () => {
    const result = applyServiceDedup(outlookRoute, {
      composioConnected: new Set(['outlook']),
      claudeDesktopActive: new Set(['Microsoft_365']),
      preferences: { outlook: 'off' },
      knownServices: KNOWN_SERVICES,
    });

    expect(result.droppedClaudeAi).toEqual(['Microsoft_365']);
    expect(result.droppedComposio).toEqual(['outlook']);
    expect(result.route.externalMcpServers).toEqual([]);
    expect(result.route.composioToolkits).toEqual([]);
    expect(result.route.inheritFullClaudeEnv).toBe(false);
  });

  it('skips dedup entirely for fullSurface routes', () => {
    const fullRoute = {
      bundles: [] as any,
      externalMcpServers: undefined as string[] | undefined,
      composioToolkits: undefined as string[] | undefined,
      inheritFullClaudeEnv: true,
      fullSurface: true,
      reason: 'full_surface' as const,
    };

    const result = applyServiceDedup(fullRoute, {
      composioConnected: new Set(['outlook', 'gmail']),
      claudeDesktopActive: new Set(['Microsoft_365', 'Gmail']),
      preferences: {},
      knownServices: KNOWN_SERVICES,
    });

    // fullSurface = explicit "all tools" admin/debug request; honor user intent.
    expect(result.droppedClaudeAi).toEqual([]);
    expect(result.droppedComposio).toEqual([]);
    expect(result.route).toBe(fullRoute);
    expect(result.anyClaudeDesktopKept).toBe(true);
  });

  it('handles a multi-bundle route with mixed availability per service', () => {
    // Route matched both email_outlook and drive_google. Only Composio
    // connected for Outlook; only claude.ai connected for Drive.
    const multiRoute = {
      bundles: ['email_outlook', 'drive_google'] as any,
      externalMcpServers: ['Microsoft_365', 'Google_Drive'],
      composioToolkits: ['outlook', 'googledrive'],
      inheritFullClaudeEnv: true,
      fullSurface: false,
      reason: 'matched' as const,
    };

    const result = applyServiceDedup(multiRoute, {
      composioConnected: new Set(['outlook']),
      claudeDesktopActive: new Set(['Google_Drive']),
      preferences: {},
      knownServices: KNOWN_SERVICES,
    });

    // Outlook: Composio only → drop claude.ai Microsoft_365
    // Drive: claude.ai only → drop Composio googledrive
    expect(result.droppedClaudeAi).toEqual(['Microsoft_365']);
    expect(result.droppedComposio).toEqual(['googledrive']);
    expect(result.route.externalMcpServers).toEqual(['Google_Drive']);
    expect(result.route.composioToolkits).toEqual(['outlook']);
    // Drive is claude.ai → still need full env
    expect(result.route.inheritFullClaudeEnv).toBe(true);
    expect(result.anyClaudeDesktopKept).toBe(true);
  });
});
