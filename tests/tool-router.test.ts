import { describe, expect, it } from 'vitest';
import { routeToolSurface, TOOL_SURFACE_WARN_THRESHOLD } from '../src/agent/tool-router.js';

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

  it('routes Google Sheets without loading every Google toolkit', () => {
    const route = routeToolSurface('update the Google Sheets pipeline tracker');

    expect(route.bundles).toEqual(['sheets_google']);
    expect(route.externalMcpServers).toEqual(['Google_Workspace', 'Google_Drive']);
    expect(route.composioToolkits).toEqual(['googlesheets', 'googledrive']);
    expect(route.fullSurface).toBe(false);
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
  });
});

