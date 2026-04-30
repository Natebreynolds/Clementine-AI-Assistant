/**
 * Tool source preferences — when a service has tools available from
 * multiple MCP sources (e.g., Composio's outlook AND Claude Desktop's
 * Microsoft 365), let the user pick which one the agent should use.
 *
 * Storage: ~/.clementine/tool-preferences.json
 *
 * Design decisions:
 * - Only services with multiple available sources show up. No noise.
 * - When a conflict exists but the user hasn't picked, silently default
 *   to Composio (broader scope, OAuth tokens you control).
 * - When no conflict exists (one or zero sources), no preference is
 *   needed and no system-prompt clutter is emitted.
 * - The mapping between Composio slugs and Claude Desktop integration
 *   names lives here (small, bounded — only services where Claude
 *   Desktop has a connector).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

const PREFS_FILE = path.join(BASE_DIR, 'tool-preferences.json');

export type ToolSource = 'composio' | 'claude-desktop' | 'off';

/**
 * Canonical service registry. Each entry maps a stable service ID to its
 * Composio toolkit slug (if any) and Claude Desktop integration name (if
 * any). Adding a new service = one line here.
 */
export interface ServiceDefinition {
  /** Stable canonical ID — what the user sees and what we key prefs by. */
  id: string;
  /** Friendly name for the dashboard. */
  label: string;
  /** Composio toolkit slug, if Composio offers this service. */
  composioSlug?: string;
  /** Claude Desktop integration name (matches mcp__claude_ai_<name>__*). */
  claudeDesktopName?: string;
}

export const KNOWN_SERVICES: ServiceDefinition[] = [
  { id: 'outlook',         label: 'Outlook / Microsoft 365', composioSlug: 'outlook',        claudeDesktopName: 'Microsoft_365' },
  { id: 'gmail',           label: 'Gmail',                   composioSlug: 'gmail',          claudeDesktopName: 'Gmail' },
  { id: 'googledrive',     label: 'Google Drive',            composioSlug: 'googledrive',    claudeDesktopName: 'Google_Drive' },
  { id: 'googlecalendar',  label: 'Google Calendar',         composioSlug: 'googlecalendar', claudeDesktopName: 'Google_Calendar' },
  { id: 'googlesheets',    label: 'Google Sheets',           composioSlug: 'googlesheets',   claudeDesktopName: 'Google_Workspace' },
  { id: 'slack',           label: 'Slack',                   composioSlug: 'slack',          claudeDesktopName: 'Slack' },
  { id: 'notion',          label: 'Notion',                  composioSlug: 'notion',         claudeDesktopName: 'Notion' },
  { id: 'github',          label: 'GitHub',                  composioSlug: 'github',         claudeDesktopName: 'GitHub' },
  { id: 'linear',          label: 'Linear',                  composioSlug: 'linear',         claudeDesktopName: 'Linear' },
];

export interface ToolPreferences {
  version: 1;
  /** id → chosen source. Missing = use silent default (composio when conflict). */
  preferences: Record<string, ToolSource>;
  updatedAt?: string;
}

const EMPTY_PREFS: ToolPreferences = { version: 1, preferences: {} };

export function loadToolPreferences(): ToolPreferences {
  try {
    if (!existsSync(PREFS_FILE)) return { ...EMPTY_PREFS, preferences: {} };
    const data = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')) as ToolPreferences;
    if (data?.version !== 1 || typeof data.preferences !== 'object') {
      return { ...EMPTY_PREFS, preferences: {} };
    }
    return data;
  } catch {
    return { ...EMPTY_PREFS, preferences: {} };
  }
}

export function saveToolPreferences(prefs: Omit<ToolPreferences, 'version' | 'updatedAt'>): void {
  const out: ToolPreferences = {
    version: 1,
    preferences: prefs.preferences,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(PREFS_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
}

export interface ServiceAvailability {
  service: ServiceDefinition;
  composioAvailable: boolean;
  claudeDesktopAvailable: boolean;
  /** True when both sources are connected — preference matters. */
  hasConflict: boolean;
  /** Effective source: user pref if set, else "composio" when conflict, else
   *  whichever single source is connected, else null. */
  effective: ToolSource | null;
}

/**
 * Walk every known service and compute availability + effective preference.
 * Pure function — caller passes in what's connected.
 */
export function computeAvailability(
  composioConnectedSlugs: Set<string>,
  claudeDesktopActiveNames: Set<string>,
  preferences: Record<string, ToolSource>,
): ServiceAvailability[] {
  return KNOWN_SERVICES.map(service => {
    const composioAvailable = !!service.composioSlug && composioConnectedSlugs.has(service.composioSlug);
    const claudeDesktopAvailable = !!service.claudeDesktopName && claudeDesktopActiveNames.has(service.claudeDesktopName);
    const hasConflict = composioAvailable && claudeDesktopAvailable;

    let effective: ToolSource | null = null;
    const userPref = preferences[service.id];
    if (userPref === 'off') {
      effective = 'off';
    } else if (hasConflict) {
      effective = userPref ?? 'composio'; // default to composio when conflict + no pref
    } else if (composioAvailable) {
      effective = 'composio';
    } else if (claudeDesktopAvailable) {
      effective = 'claude-desktop';
    }

    return { service, composioAvailable, claudeDesktopAvailable, hasConflict, effective };
  });
}

/**
 * Build the system-prompt instruction listing which tool source the agent
 * should use for each service. Only includes services where:
 *   - There IS a conflict (both sources connected), AND
 *   - The user has explicitly picked a non-default preference, OR
 *   - The user picked 'off' (so we tell the agent NOT to use it)
 *
 * Returns empty string when no instruction is needed — that's the goal:
 * silent default, zero prompt overhead, until the user actually configures.
 */
export function buildPromptInstruction(
  availability: ServiceAvailability[],
  preferences: Record<string, ToolSource>,
): string {
  const lines: string[] = [];
  for (const a of availability) {
    if (!a.hasConflict) continue;
    const userPref = preferences[a.service.id];
    if (!userPref) continue; // no explicit pref → silent default, no prompt cost

    if (userPref === 'off') {
      lines.push(`- ${a.service.label}: do NOT use any of its tools (user disabled)`);
    } else if (userPref === 'composio' && a.service.composioSlug) {
      lines.push(`- ${a.service.label}: use \`mcp__${a.service.composioSlug}__*\` (NOT \`mcp__claude_ai_${a.service.claudeDesktopName}__*\`)`);
    } else if (userPref === 'claude-desktop' && a.service.claudeDesktopName) {
      lines.push(`- ${a.service.label}: use \`mcp__claude_ai_${a.service.claudeDesktopName}__*\` (NOT \`mcp__${a.service.composioSlug}__*\`)`);
    }
  }
  if (lines.length === 0) return '';
  return `## Tool Source Preferences\n\n${lines.join('\n')}`;
}
