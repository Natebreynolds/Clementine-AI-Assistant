/**
 * Tool surface router.
 *
 * The Claude Agent SDK charges for the tool schema surface it receives, so
 * "attach every integration" is an expensive default. Route each query to the
 * smallest known bundle and let explicit allowlists/admin phrases opt into
 * broader access.
 */

export type ToolBundleId =
  | 'email_outlook'
  | 'email_gmail'
  | 'calendar_google'
  | 'drive_google'
  | 'docs_google'
  | 'sheets_google'
  | 'slack'
  | 'notion'
  | 'github'
  | 'linear'
  | 'browser'
  | 'web_research'
  | 'database'
  | 'figma'
  | 'imessage'
  | 'voice'
  | 'phone'
  | 'hosting'
  | 'docs_lookup';

export interface ToolRouteDecision {
  /** Matched semantic bundles. Empty means Clementine core tools only. */
  bundles: ToolBundleId[];
  /** undefined means all external MCP servers; [] means none. */
  externalMcpServers: string[] | undefined;
  /** undefined means all active Composio toolkits; [] means none. */
  composioToolkits: string[] | undefined;
  /** Whether the Claude Code subprocess should inherit full process.env. */
  inheritFullClaudeEnv: boolean;
  /** True only for explicit all-tools/admin requests. */
  fullSurface: boolean;
  reason: 'empty' | 'matched' | 'full_surface';
}

interface ToolBundleDefinition {
  id: ToolBundleId;
  patterns: RegExp[];
  externalMcpServers?: string[];
  composioToolkits?: string[];
  inheritFullClaudeEnv?: boolean;
}

export const TOOL_SURFACE_WARN_THRESHOLD = 150;
export const TOOL_SURFACE_HARD_LIMIT = 220;

export const TOOL_BUNDLES: readonly ToolBundleDefinition[] = [
  {
    id: 'email_outlook',
    patterns: [/\b(outlook|microsoft 365|m365|office 365|mailbox|inbox|email|e-mail|send mail|reply detection|follow-?up)\b/i],
    externalMcpServers: ['Microsoft_365'],
    composioToolkits: ['outlook'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'email_gmail',
    patterns: [/\b(gmail|google mail)\b/i],
    externalMcpServers: ['Gmail'],
    composioToolkits: ['gmail'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'calendar_google',
    patterns: [/\b(google calendar|gcal)\b/i],
    externalMcpServers: ['Google_Calendar'],
    composioToolkits: ['googlecalendar'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'drive_google',
    patterns: [/\b(google drive|gdrive)\b/i],
    externalMcpServers: ['Google_Drive'],
    composioToolkits: ['googledrive'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'docs_google',
    patterns: [/\b(google docs?|gdocs?)\b/i],
    externalMcpServers: ['Google_Drive'],
    composioToolkits: ['googledocs', 'googledrive'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'sheets_google',
    patterns: [/\b(google sheets?|gsheets?|spreadsheet)\b/i],
    externalMcpServers: ['Google_Workspace', 'Google_Drive'],
    composioToolkits: ['googlesheets', 'googledrive'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'slack',
    patterns: [/\b(slack)\b/i],
    externalMcpServers: ['Slack'],
    composioToolkits: ['slack'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'notion',
    patterns: [/\b(notion)\b/i],
    externalMcpServers: ['notion', 'Notion'],
    composioToolkits: ['notion'],
    inheritFullClaudeEnv: true,
  },
  {
    id: 'github',
    patterns: [/\b(github|pull request|pull requests|prs?)\b/i, /\b(repo|github)\s+issues?\b/i],
    externalMcpServers: ['github'],
    composioToolkits: ['github'],
  },
  {
    id: 'linear',
    patterns: [/\b(linear)\b/i],
    externalMcpServers: ['linear'],
    composioToolkits: ['linear'],
  },
  {
    id: 'browser',
    patterns: [/\b(playwright|localhost|127\.0\.0\.1|web\s?page|webpage|website|screenshot|click|fill(?: out)? form|navigate to|open .*browser|use .*browser|inspect .*page)\b/i],
    externalMcpServers: ['browser-harness', 'browsermcp', 'playwright', 'kernel', 'plugin:playwright:playwright'],
  },
  {
    id: 'web_research',
    patterns: [/\b(scrape|scraping|crawl|crawler|bright data|brightdata|firecrawl|apify|serp|dataforseo|seo)\b/i],
    externalMcpServers: ['firecrawl', 'Bright Data', 'brightdata', 'dataforseo', 'apify', 'plugin:proposal-builder:brightdata', 'plugin:proposal-builder:apify'],
  },
  {
    id: 'database',
    patterns: [/\b(supabase|database|postgres|sql)\b/i],
    externalMcpServers: ['supabase'],
  },
  {
    id: 'figma',
    patterns: [/\b(figma|design file|mockup)\b/i],
    externalMcpServers: ['figma'],
  },
  {
    id: 'imessage',
    patterns: [/\b(imessage|iMessage|messages app|text message)\b/i],
    externalMcpServers: ['imessage'],
  },
  {
    id: 'voice',
    patterns: [/\b(elevenlabs|text to speech|tts|voice synthesis)\b/i],
    externalMcpServers: ['ElevenLabs'],
  },
  {
    id: 'phone',
    patterns: [/\b(vapi|phone call|voice agent)\b/i],
    externalMcpServers: ['vapi'],
  },
  {
    id: 'hosting',
    patterns: [/\b(hostinger|hosting|website deploy)\b/i],
    externalMcpServers: ['hostinger-mcp'],
  },
  {
    id: 'docs_lookup',
    patterns: [/\b(context7|library docs|api docs)\b/i],
    externalMcpServers: ['context7'],
  },
];

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((v): v is string => !!v && v.trim().length > 0))];
}

function explicitMcpServers(scopeText: string): string[] {
  const servers = new Set<string>();
  const re = /\bmcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.:-]+\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scopeText)) !== null) {
    servers.add(match[1]);
  }
  return uniqueStrings(servers);
}

export function routeToolSurface(text: string | undefined): ToolRouteDecision {
  const scopeText = text?.trim() ?? '';
  if (!scopeText) {
    return {
      bundles: [],
      externalMcpServers: [],
      composioToolkits: [],
      inheritFullClaudeEnv: false,
      fullSurface: false,
      reason: 'empty',
    };
  }

  if (/\b(all tools|all integrations|every integration|full tool surface|any connected tools?|all connected tools?)\b/i.test(scopeText)) {
    return {
      bundles: [],
      externalMcpServers: undefined,
      composioToolkits: undefined,
      inheritFullClaudeEnv: true,
      fullSurface: true,
      reason: 'full_surface',
    };
  }

  const external = new Set<string>();
  const composio = new Set<string>();
  const bundles = new Set<ToolBundleId>();
  let inheritFullClaudeEnv = false;

  for (const bundle of TOOL_BUNDLES) {
    if (!bundle.patterns.some(pattern => pattern.test(scopeText))) continue;
    bundles.add(bundle.id);
    for (const server of bundle.externalMcpServers ?? []) external.add(server);
    for (const slug of bundle.composioToolkits ?? []) composio.add(slug);
    inheritFullClaudeEnv = inheritFullClaudeEnv || bundle.inheritFullClaudeEnv === true;
  }

  for (const server of explicitMcpServers(scopeText)) {
    if (server.startsWith('claude_ai_')) {
      external.add(server.slice('claude_ai_'.length));
    } else {
      // Exact `mcp__<server>__<tool>` mentions are authoritative. Add the
      // name as both a direct MCP server and a Composio toolkit; whichever
      // source is actually connected will mount, and the other path no-ops.
      external.add(server);
      composio.add(server);
    }
    inheritFullClaudeEnv = true;
  }

  return {
    bundles: uniqueStrings(bundles) as ToolBundleId[],
    externalMcpServers: uniqueStrings(external),
    composioToolkits: uniqueStrings(composio),
    inheritFullClaudeEnv,
    fullSurface: false,
    reason: bundles.size > 0 || external.size > 0 || composio.size > 0 ? 'matched' : 'empty',
  };
}

// ── Per-service dedup: pick ONE source per service ─────────────────────
//
// Bundles in TOOL_BUNDLES list both a Composio toolkit AND a Claude
// Desktop integration (when Claude Desktop has a counterpart) so the
// caller can route to whichever is connected. But when BOTH are connected
// today's behavior loads both sets of schemas — duplicate work, doubled
// system-prompt size, and (worst) Claude Desktop's auto-attach pulls in
// every other claude.ai integration the user has authorized via the env
// path. That's the immediate cause of Sonnet's autocompact thrash.
//
// Dedup walks the matched route's external + composio sets, looks up each
// service in KNOWN_SERVICES (the canonical Composio↔claude.ai pairing
// table from src/integrations/tool-preferences.ts), and drops the loser
// per the user's preference (default: Composio when both connected). The
// caller uses `droppedClaudeAi` to disable claude.ai-specific env
// inheritance and add disallowedTools entries.

import type { ServiceDefinition, ToolSource } from '../integrations/tool-preferences.js';

export interface ServiceDedupOptions {
  /** Composio toolkit slugs the user has actually connected. */
  composioConnected: Set<string>;
  /** Claude Desktop integration names the user has actually connected. */
  claudeDesktopActive: Set<string>;
  /** User-selected source per service id (from tool-preferences.json). */
  preferences: Record<string, ToolSource>;
  /** The KNOWN_SERVICES registry. Passed in so this module stays
   *  decoupled from tool-preferences (and tests can stub the table). */
  knownServices: readonly ServiceDefinition[];
}

export interface ServiceDedupResult {
  /** The route with losing sources removed from external + composio sets. */
  route: ToolRouteDecision;
  /** Claude Desktop integration names that were dropped. Used by the
   *  caller to add disallowedTools and decide whether the SDK subprocess
   *  needs claude.ai env inheritance at all. */
  droppedClaudeAi: string[];
  /** Composio toolkit slugs that were dropped. Mirror of the above. */
  droppedComposio: string[];
  /** True if any claude.ai integration survived dedup. When false, the
   *  caller can drop CLAUDE_CODE_OAUTH_TOKEN from the subprocess env so
   *  Claude Code doesn't auto-attach claude.ai connectors. */
  anyClaudeDesktopKept: boolean;
}

export function applyServiceDedup(
  route: ToolRouteDecision,
  opts: ServiceDedupOptions,
): ServiceDedupResult {
  const droppedClaudeAi: string[] = [];
  const droppedComposio: string[] = [];

  // fullSurface routes intentionally load everything — admin/debug paths.
  // Skip dedup so behavior matches the user's explicit "all tools" intent.
  if (route.fullSurface) {
    return {
      route,
      droppedClaudeAi,
      droppedComposio,
      anyClaudeDesktopKept: true,
    };
  }

  const externalSet = new Set(route.externalMcpServers ?? []);
  const composioSet = new Set(route.composioToolkits ?? []);

  for (const service of opts.knownServices) {
    const cdName = service.claudeDesktopName;
    const composioSlug = service.composioSlug;
    if (!cdName || !composioSlug) continue;

    const routeHasCd = externalSet.has(cdName);
    const routeHasComposio = composioSet.has(composioSlug);
    if (!routeHasCd || !routeHasComposio) continue;

    // Both sources are in the route. Resolve based on availability + pref.
    const cdAvailable = opts.claudeDesktopActive.has(cdName);
    const composioAvailable = opts.composioConnected.has(composioSlug);

    if (!cdAvailable && !composioAvailable) {
      // Neither connected — drop both (the route lists them, but they'll
      // fail at attach time). Cleaner to remove now.
      externalSet.delete(cdName);
      composioSet.delete(composioSlug);
      droppedClaudeAi.push(cdName);
      droppedComposio.push(composioSlug);
      continue;
    }
    if (!cdAvailable) {
      // Only Composio connected — drop the claude.ai entry.
      externalSet.delete(cdName);
      droppedClaudeAi.push(cdName);
      continue;
    }
    if (!composioAvailable) {
      composioSet.delete(composioSlug);
      droppedComposio.push(composioSlug);
      continue;
    }

    // Conflict: both connected. Pick per user preference, default Composio.
    const userPref = opts.preferences[service.id];
    const effective: ToolSource = userPref === 'off'
      ? 'off'
      : userPref ?? 'composio';

    if (effective === 'off') {
      externalSet.delete(cdName);
      composioSet.delete(composioSlug);
      droppedClaudeAi.push(cdName);
      droppedComposio.push(composioSlug);
    } else if (effective === 'composio') {
      externalSet.delete(cdName);
      droppedClaudeAi.push(cdName);
    } else if (effective === 'claude-desktop') {
      composioSet.delete(composioSlug);
      droppedComposio.push(composioSlug);
    }
  }

  // After dedup, the SDK subprocess needs claude.ai env inheritance ONLY
  // if some claude.ai integration is still in the route. If everything
  // routed to Composio, force inheritFullClaudeEnv off so Claude Code
  // can't auto-attach the rest of the user's authorized integrations.
  const anyClaudeDesktopKept = externalSet.size > 0
    && [...externalSet].some(name => opts.claudeDesktopActive.has(name));

  return {
    route: {
      ...route,
      externalMcpServers: [...externalSet],
      composioToolkits: [...composioSet],
      inheritFullClaudeEnv: route.inheritFullClaudeEnv && anyClaudeDesktopKept,
    },
    droppedClaudeAi,
    droppedComposio,
    anyClaudeDesktopKept,
  };
}
