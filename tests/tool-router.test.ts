import { describe, expect, it } from 'vitest';
import { routeToolSurface, TOOL_SURFACE_HARD_LIMIT, TOOL_SURFACE_WARN_THRESHOLD } from '../src/agent/tool-router.js';

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
