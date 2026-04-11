/**
 * Centralized tool descriptions for MCP tools.
 *
 * Inspired by Anthropic's finding that better tool descriptions yield a 40%
 * decrease in task completion time. Descriptions here are agent-facing:
 * they explain WHEN to use each tool, what to expect, and common pitfalls.
 *
 * Usage: import { getToolDescription } from './tool-meta.js';
 *        const desc = getToolDescription('memory_search') ?? defaultDesc;
 */

export interface ToolMeta {
  /** Agent-facing description: when to use, what it returns, tips. */
  description: string;
  /** One-line example showing a typical invocation context. */
  exampleUsage?: string;
  /** What the return value looks like. */
  returnHint?: string;
  /** Guidance for tools that paginate or truncate. */
  paginationNote?: string;
}

const TOOL_META: Record<string, ToolMeta> = {

  // ── Memory & Vault ────────────────────────────────────────────────

  working_memory: {
    description: 'Persistent scratchpad that survives across conversations. Use to jot down current project context, TODOs, reminders, or anything you need to remember for next time. Actions: read, append, replace, clear. ALWAYS read before replacing to avoid overwriting useful notes.',
    exampleUsage: 'Before starting complex work, read working_memory to check for context from prior sessions.',
    returnHint: 'Full working memory contents (markdown text).',
  },

  memory_search: {
    description: 'Full-text search across all vault notes. Best for finding specific keywords or phrases. For broader semantic matching, use memory_recall instead. Results include file path, section heading, and relevance score.',
    exampleUsage: 'Use when the user asks "what did we discuss about X" or you need to find a specific note.',
    returnHint: 'Ranked list: **file > section** (score) — preview text.',
    paginationNote: 'Default limit is 20 results. For broad queries, start with limit=5 and increase only if needed.',
  },

  memory_recall: {
    description: 'Context retrieval combining text relevance + recency. Better than memory_search for finding related content — it considers how recently notes were updated. Use this as your default "what do I know about X" tool.',
    exampleUsage: 'Use before responding to questions about people, projects, or topics the user has discussed before.',
    returnHint: 'Ranked chunks with source file, category, and content preview.',
  },

  memory_read: {
    description: "Read a note from the Obsidian vault. Shortcuts: 'today' (daily note), 'yesterday', 'memory' (MEMORY.md), 'tasks' (TASKS.md), 'heartbeat', 'cron', 'soul'. Or pass a relative path like '03-Projects/my-project.md'.",
    exampleUsage: "memory_read('today') to check what happened today before making plans.",
    returnHint: 'Full note content with YAML frontmatter.',
  },

  memory_write: {
    description: "Write or append to a vault note. Actions: 'append_daily' (add to today's log — use for recording activities), 'update_memory' (update a section of MEMORY.md — use for durable facts), 'write_note' (write/overwrite a note), 'update_identity' (set your identity context).",
    exampleUsage: "After completing a task, use append_daily to record what was done.",
  },

  memory_connections: {
    description: 'Query the wikilink graph — find all notes connected to/from a given note. Use to discover related context you might not find via text search.',
    returnHint: 'List of linked notes with titles and paths.',
  },

  memory_timeline: {
    description: 'Chronological view of memory/vault changes within a date range. Use for "what happened last week" or "show me recent changes" queries.',
    returnHint: 'Date-ordered list of changes with file, section, and timestamp.',
  },

  transcript_search: {
    description: 'Search past conversation transcripts by keyword. Returns matching turns with session context. Use when you need to recall what was said in a specific conversation.',
    returnHint: 'Matching conversation turns with session key and timestamp.',
  },

  // ── External APIs ────────────────────────────────────────────────

  outlook_inbox: {
    description: 'Read recent emails from Outlook inbox. Returns sender, subject, date, preview, and read/unread status. Use count=5 for a quick check, count=25 for comprehensive review.',
    exampleUsage: 'Check inbox at the start of a work session or when user asks about emails.',
    returnHint: 'JSON array of email objects with id, from, subject, date, preview, unread, hasAttachments.',
    paginationNote: 'Max 25 emails per call. Use outlook_search for targeted lookups instead of fetching all.',
  },

  outlook_search: {
    description: 'Search emails by keyword across subject, body, and sender. More efficient than scanning inbox when looking for specific emails or threads.',
    exampleUsage: "outlook_search({ query: 'quarterly review' }) to find meeting-related emails.",
    returnHint: 'JSON array of matching email objects (same format as outlook_inbox).',
    paginationNote: 'Default limit 10. Increase only if the user needs comprehensive results.',
  },

  outlook_send: {
    description: 'Send an email. IMPORTANT: This actually sends — there is no undo. Always confirm with the user before sending unless you have explicit pre-approval (send policy). For drafting without sending, use outlook_draft.',
    exampleUsage: 'Only use after user explicitly says "send it" or send policy allows autonomous sending.',
  },

  outlook_draft: {
    description: 'Save an email as a draft without sending. Use this when the user wants to review before sending, or when preparing multiple emails for batch review.',
    exampleUsage: 'Draft the email first, show the user, then send only after approval.',
  },

  github_prs: {
    description: 'Check GitHub PRs requiring your review and your open PRs. Read-only overview. Requires gh CLI to be authenticated.',
    returnHint: 'Two sections: PRs needing review + your open PRs, formatted as text.',
  },

  rss_fetch: {
    description: 'Fetch and parse RSS feeds. If no URL provided, reads all enabled feeds from vault/00-System/RSS-FEEDS.md. Returns article titles, links, dates, and summaries.',
    paginationNote: 'Each feed returns up to 10 articles. For many feeds, output can be large — consider processing feeds one at a time.',
  },

  web_search: {
    description: 'Search the web via DuckDuckGo. Returns titles, URLs, and snippets. Use for current events, fact-checking, or research that vault notes cannot answer.',
    exampleUsage: "web_search({ query: 'latest AI news this week' })",
    returnHint: 'List of search results with title, URL, and snippet text.',
  },

  // ── Goals & Tasks ────────────────────────────────────────────────

  task_list: {
    description: 'List tasks from the master task list (TASKS.md). Returns task IDs, status, and descriptions. Filter by status to focus on pending or in-progress items.',
    returnHint: 'Formatted task list with IDs like {T-001}, status, and description.',
  },

  task_add: {
    description: 'Add a new task to the master list. Auto-generates a unique ID. Use for actionable items the user wants tracked.',
  },

  goal_create: {
    description: 'Create a persistent goal with milestones and success criteria. Goals are long-running objectives that span multiple sessions. Use for multi-week projects or recurring objectives.',
  },

  goal_work: {
    description: 'Spawn a focused work session on a specific goal. The sub-agent gets the goal context and works autonomously. Use when a goal needs dedicated attention.',
  },

  // ── Team & Agents ────────────────────────────────────────────────

  team_message: {
    description: 'Send a message to another agent on your team. The message is delivered to their active session or queued for later. Use for delegation, status updates, or requesting information from a specialist.',
    exampleUsage: "team_message({ to: 'sdr-agent', message: 'Research Acme Corp for our call tomorrow' })",
  },

  delegate_task: {
    description: 'Delegate a task to another agent with full context. More structured than team_message — includes objectives, expected output, and deadline. The delegated agent works asynchronously.',
  },

  // ── System ───────────────────────────────────────────────────────

  self_restart: {
    description: 'Restart the Clementine daemon. Use only when the user explicitly requests a restart or when a critical configuration change requires it.',
  },

  set_timer: {
    description: 'Set a reminder timer that fires after a delay. The reminder message is delivered to the current session when it triggers.',
  },
};

/**
 * Get the enhanced description for a tool, or null if not defined.
 * Falls back gracefully so existing inline descriptions still work.
 */
export function getToolDescription(toolName: string): string | null {
  return TOOL_META[toolName]?.description ?? null;
}

/**
 * Get full tool metadata for a tool.
 */
export function getToolMeta(toolName: string): ToolMeta | null {
  return TOOL_META[toolName] ?? null;
}

/**
 * Get all tool names that have enhanced descriptions.
 */
export function getEnhancedToolNames(): string[] {
  return Object.keys(TOOL_META);
}
