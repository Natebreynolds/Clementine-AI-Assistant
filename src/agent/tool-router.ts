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
    patterns: [/\b(github|pull request|pull requests|prs?|issues?)\b/i],
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
    patterns: [/\b(browser|playwright|localhost|web page|webpage|screenshot|click|fill form|navigate)\b/i],
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

  return {
    bundles: uniqueStrings(bundles) as ToolBundleId[],
    externalMcpServers: uniqueStrings(external),
    composioToolkits: uniqueStrings(composio),
    inheritFullClaudeEnv,
    fullSurface: false,
    reason: bundles.size > 0 ? 'matched' : 'empty',
  };
}

