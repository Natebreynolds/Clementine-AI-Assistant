/**
 * Clementine — Connector Feed recipes.
 *
 * Each recipe is a blueprint for a one-click "auto-seed feed" that turns an
 * authenticated Claude Desktop connector (Google Drive, Gmail, Outlook, etc.)
 * into a scheduled data feed that writes into the brain's ingest folder.
 *
 * A feed materializes as:
 *   1. A CRON.md job entry with `managed: connector-feed` frontmatter
 *   2. (optional) A source registry row tying the target folder to the run
 *
 * The cron prompt tells the Claude Code agent to use the integration's MCP
 * tools to pull records, then call `brain_ingest_folder` to commit them —
 * which writes markdown files and runs the distillation pipeline in one step.
 *
 * Field syntax in prompt templates:
 *   {{fieldKey}}   — user-supplied value
 *   {{slug}}       — the feed's computed slug (used for folder + dedup)
 */

export interface RecipeFieldPicker {
  /** Full tool name, e.g. "mcp__claude_ai_Google_Drive__search_files" */
  tool: string;
  /** Natural-language instruction to the probe agent — becomes the body of
   *  "Call the tool X to {intent}, return a JSON array of {id, label}".
   *  For typeahead pickers, may include the placeholder `{{query}}` which
   *  the server substitutes with the user's typed search string. */
  intent: string;
  /** When set, the picker renders as a typeahead: user types at least
   *  `minQueryLength` chars (default 2), we debounce ~400ms, then fire the
   *  probe with `{{query}}` replaced. Use for tools whose list operation
   *  requires a query argument (e.g. search_contacts, Gmail search). */
  queryArg?: string;
  /** Minimum characters the user must type before firing the probe. Ignored
   *  when queryArg is unset. Default 2. */
  minQueryLength?: number;
  /** If true, user can type a custom value instead of picking from the list
   *  (falls back to the raw text). Useful when the source allows queries
   *  that aren't enumerable. */
  allowCustom?: boolean;
}

export interface RecipeField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  defaultValue?: string;
  /** When present, render as a searchable picker populated by /api/brain/mcp/probe. */
  picker?: RecipeFieldPicker;
}

export interface ConnectorRecipe {
  /** Stable id, used as the job-name prefix. */
  id: string;
  /** Short human label shown in the recipe picker. */
  label: string;
  /** One-line description for the UI card. */
  description: string;
  /** Emoji shown next to the label. */
  icon: string;
  /** Matches the key in ~/.clementine/claude-integrations.json */
  integration: string;
  /** Tools we rely on for this recipe. Used only to warn if the integration
   *  hasn't surfaced them yet in claude-integrations.json. */
  requiredTools: string[];
  /** User-visible form fields shown in the wizard. */
  fields: RecipeField[];
  /** Default cron expression when the user picks "Daily / Hourly / etc." */
  defaultSchedule: string;
  /** Which cron tier to run at (1 = auto, 2 = logged, 3 = approval). Feeds
   *  typically need tier 2 because they call external MCP tools and write
   *  into the vault. */
  tier: number;
  /** Build the cron prompt from the user's field values + derived slug. */
  buildPrompt: (vals: Record<string, string>, ctx: { slug: string; targetFolder: string }) => string;
  /** Compute the slug from field values. Must be URL-safe. */
  slugFromValues: (vals: Record<string, string>) => string;
}

function slugify(s: string): string {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feed';
}

const COMMIT_INSTRUCTIONS = `When you have the records collected, call the \`brain_ingest_folder\` MCP tool with:
- \`slug\`: "{{slug}}"
- \`records\`: an array of \`{title, externalId, content, metadata}\` objects (one per item). \`externalId\` should be the source provider's stable id so re-runs dedup. \`metadata\` can include any fields you want preserved (url, modifiedAt, author).

That tool writes each record to \`{{targetFolder}}/\` and runs the brain's distillation pipeline. You do NOT need to use Write — brain_ingest_folder handles file creation. Finish by reporting a one-line summary like "Ingested N new records, M unchanged".

If the tool returns an error, include the error text in your summary.`;

// ── Recipes ────────────────────────────────────────────────────────────

export const RECIPES: ConnectorRecipe[] = [
  {
    id: 'gdrive-watch-folder',
    label: 'Google Drive: watch a folder',
    description: 'Pull new or modified files from a Drive folder on a schedule.',
    icon: '📁',
    integration: 'Google_Drive',
    requiredTools: ['search_files', 'read_file_content'],
    fields: [
      {
        key: 'folder',
        label: 'Folder',
        required: true,
        help: 'Pick a folder from your Google Drive. You can also type a name to filter the list.',
        picker: {
          tool: 'mcp__claude_ai_Google_Drive__search_files',
          intent: 'find up to 20 Google Drive folders. Call search_files exactly once with mimeType filter "application/vnd.google-apps.folder". For each returned folder, output {id: folder.id, label: folder.name, sublabel: "Modified " + folder.modifiedTime}.',
          allowCustom: true,
        },
      },
    ],
    defaultSchedule: '0 8 * * *',
    tier: 2,
    slugFromValues: (v) => `gdrive-${slugify(v.folder || 'folder')}`,
    buildPrompt: (v, ctx) => `You are running the "${v.folder}" Google Drive feed.

Goal: find files in the Drive folder "${v.folder}" that are new or modified since the last run, read their content, and ingest them into the brain under slug "${ctx.slug}".

Steps:
1. Use \`search_files\` (Google Drive) to locate files in or under a folder named "${v.folder}". Limit to the top 25 most recently modified files.
2. For each file, call \`read_file_content\` to get the full body. If a file is a binary/PDF and read_file_content returns an error, skip it with a note in the summary.
3. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'gdrive-recent',
    label: 'Google Drive: my recent files',
    description: 'Daily snapshot of files you\'ve opened or edited recently.',
    icon: '🕒',
    integration: 'Google_Drive',
    requiredTools: ['list_recent_files', 'read_file_content'],
    fields: [
      { key: 'limit', label: 'How many recent files', placeholder: '15', defaultValue: '15' },
    ],
    defaultSchedule: '0 9 * * *',
    tier: 2,
    slugFromValues: () => 'gdrive-recent',
    buildPrompt: (v, ctx) => `You are running the "recent Google Drive files" feed.

Goal: capture the ${v.limit || '15'} most recently-modified Google Drive files as brain records.

Steps:
1. Use \`list_recent_files\` (Google Drive) with limit ${v.limit || '15'}.
2. For each file, call \`read_file_content\` to get the body. Skip files that error.
3. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'gmail-query',
    label: 'Gmail: query watch',
    description: 'Ingest emails matching a Gmail search query.',
    icon: '✉️',
    integration: 'Gmail',
    requiredTools: ['search_messages', 'read_message'],
    fields: [
      { key: 'query', label: 'Gmail query', placeholder: 'is:unread from:@stripe.com', required: true,
        help: 'Standard Gmail search syntax (from:, to:, label:, has:attachment, newer_than:7d, etc.)' },
      { key: 'limit', label: 'Max messages per run', placeholder: '25', defaultValue: '25' },
    ],
    defaultSchedule: '0 */4 * * *',
    tier: 2,
    slugFromValues: (v) => `gmail-${slugify(v.query || 'query')}`,
    buildPrompt: (v, ctx) => `You are running the Gmail feed for query: \`${v.query}\`.

Goal: pull up to ${v.limit || '25'} messages matching this query and ingest their subjects, senders, and bodies into the brain.

Steps:
1. Use the Gmail MCP tool to search for messages matching \`${v.query}\`, limit ${v.limit || '25'}.
2. For each message, fetch the full body (plain text is fine). Keep the message id as \`externalId\` so re-runs dedup.
3. For each record, set \`title\` to the email subject, \`content\` to "From: <sender>\\nDate: <iso>\\n\\n<body>", and \`metadata\` to \`{from, to, date, messageId, labels}\`.
4. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'gcal-daily',
    label: 'Google Calendar: daily events',
    description: 'Snapshot today\'s calendar events as a single daily note.',
    icon: '📅',
    integration: 'Google_Calendar',
    requiredTools: ['list_events'],
    fields: [],
    defaultSchedule: '0 7 * * *',
    tier: 2,
    slugFromValues: () => 'gcal-daily',
    buildPrompt: (_v, ctx) => `You are running the daily Google Calendar feed.

Goal: capture today's calendar events as a single brain record so the agent has them at hand.

Steps:
1. Use \`list_events\` to fetch today's events (local timezone).
2. Build ONE record with:
   - \`title\`: "Calendar — <today ISO date>"
   - \`externalId\`: "gcal-<today ISO date>" (so each day gets one deterministic record)
   - \`content\`: a markdown bullet list of each event (time, title, attendees, location)
   - \`metadata\`: \`{date, eventCount}\`
3. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'outlook-inbox',
    label: 'Outlook (Microsoft 365): inbox watch',
    description: 'Pull recent Outlook emails into the brain.',
    icon: '📥',
    integration: 'Microsoft_365',
    requiredTools: ['outlook_email_search', 'read_resource'],
    fields: [
      { key: 'query', label: 'Search query (optional)', placeholder: 'received last 24h', defaultValue: 'received last 24h' },
      { key: 'limit', label: 'Max messages per run', placeholder: '25', defaultValue: '25' },
    ],
    defaultSchedule: '0 */6 * * *',
    tier: 2,
    slugFromValues: (v) => `outlook-${slugify(v.query || 'inbox')}`,
    buildPrompt: (v, ctx) => `You are running the Outlook inbox feed.

Goal: ingest up to ${v.limit || '25'} Outlook emails matching "${v.query || 'received last 24h'}" into the brain.

Steps:
1. Call \`outlook_email_search\` with query "${v.query || 'received last 24h'}", limit ${v.limit || '25'}.
2. For each result, use \`read_resource\` if needed to load the full body.
3. For each record: \`title\` = subject, \`externalId\` = the message id, \`content\` = "From: <sender>\\nDate: <iso>\\n\\n<body>", \`metadata\` = \`{from, to, date, messageId, folder}\`.
4. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'sharepoint-folder',
    label: 'SharePoint: watch a folder',
    description: 'Pull new or modified files from a SharePoint folder.',
    icon: '📂',
    integration: 'Microsoft_365',
    requiredTools: ['sharepoint_folder_search', 'read_resource'],
    fields: [
      {
        key: 'folder',
        label: 'Folder',
        required: true,
        help: 'Pick a SharePoint folder. Type to filter.',
        picker: {
          tool: 'mcp__claude_ai_Microsoft_365__sharepoint_folder_search',
          intent: 'list available SharePoint folders and document libraries. Use the folder\'s drive-item id as id, the folder name as label, and the site/library path as sublabel.',
          allowCustom: true,
        },
      },
    ],
    defaultSchedule: '0 8 * * *',
    tier: 2,
    slugFromValues: (v) => `sharepoint-${slugify(v.folder || 'folder')}`,
    buildPrompt: (v, ctx) => `You are running the SharePoint feed for folder "${v.folder}".

Goal: find files in SharePoint folder "${v.folder}" that are new or modified since the last run and ingest them.

Steps:
1. Use \`sharepoint_folder_search\` to list files under "${v.folder}". Limit to top 25 most-recent.
2. For each file, use \`read_resource\` to fetch content.
3. For each record: \`externalId\` = the SharePoint item id, \`title\` = the file name, \`content\` = the extracted text, \`metadata\` = \`{path, modifiedAt, author, size}\`.
4. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'imessage-thread',
    label: 'iMessage: watch a conversation',
    description: 'Ingest recent messages from a specific iMessage contact into the brain.',
    icon: '💬',
    integration: 'imessage',
    requiredTools: ['search_contacts', 'read_imessages'],
    fields: [
      {
        key: 'contact',
        label: 'Contact',
        required: true,
        help: 'Pick an iMessage contact. Their phone number or email becomes the thread id.',
        picker: {
          tool: 'mcp__imessage__search_contacts',
          intent: 'call search_contacts with query "{{query}}". For each match, output {id: the contact\'s phone number or email handle, label: the display name (or the handle if no name), sublabel: "handle: " + handle}. Return up to 15 results.',
          queryArg: 'query',
          minQueryLength: 2,
          allowCustom: true,
        },
      },
      { key: 'limit', label: 'Max messages per run', placeholder: '50', defaultValue: '50' },
    ],
    defaultSchedule: '0 */6 * * *',
    tier: 2,
    slugFromValues: (v) => `imessage-${slugify(v.contact || 'thread')}`,
    buildPrompt: (v, ctx) => `You are running the iMessage feed for contact "${v.contact}".

Goal: ingest up to ${v.limit || '50'} recent iMessage messages from the thread with ${v.contact} into the brain.

Steps:
1. Call \`read_imessages\` (iMessage) for contact "${v.contact}" with limit ${v.limit || '50'}.
2. For each message: \`externalId\` = the message id (or a stable hash of contact + timestamp + text if no id), \`title\` = first 60 chars of the text or "[attachment]", \`content\` = "From: <handle>\\nDate: <iso>\\n\\n<text>", \`metadata\` = \`{contact, sender, timestamp, isFromMe, service}\`.
3. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },

  {
    id: 'slack-channel',
    label: 'Slack: channel archive',
    description: 'Ingest messages from a Slack channel (once Slack is authenticated in Claude Desktop).',
    icon: '💬',
    integration: 'Slack',
    requiredTools: ['search_messages', 'conversations_history'],
    fields: [
      { key: 'channel', label: 'Channel name (without #)', placeholder: 'general', required: true },
      { key: 'limit', label: 'Max messages per run', placeholder: '50', defaultValue: '50' },
    ],
    defaultSchedule: '0 18 * * *',
    tier: 2,
    slugFromValues: (v) => `slack-${slugify(v.channel || 'channel')}`,
    buildPrompt: (v, ctx) => `You are running the Slack feed for channel #${v.channel}.

Goal: pull up to ${v.limit || '50'} recent messages from #${v.channel} and ingest them into the brain.

Steps:
1. Use the Slack MCP tools to list messages in #${v.channel} since the last run (or last 24h if this is the first run). Limit ${v.limit || '50'}.
2. For each message: \`externalId\` = the slack ts id, \`title\` = first 80 chars of the message, \`content\` = the full text, \`metadata\` = \`{channel, user, timestamp, threadTs}\`.
3. ${COMMIT_INSTRUCTIONS.replace(/{{slug}}/g, ctx.slug).replace(/{{targetFolder}}/g, ctx.targetFolder)}
`,
  },
];

export function recipeById(id: string): ConnectorRecipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function recipesForIntegration(integration: string): ConnectorRecipe[] {
  return RECIPES.filter((r) => r.integration === integration);
}

/** Validate that all required fields are present. Returns missing keys. */
export function missingFields(recipe: ConnectorRecipe, values: Record<string, string>): string[] {
  return recipe.fields
    .filter((f) => f.required && !(values[f.key] ?? '').trim())
    .map((f) => f.key);
}

/** Produce { slug, targetFolder, prompt, jobName } for a recipe + values. */
export function buildFeedSpec(
  recipe: ConnectorRecipe,
  values: Record<string, string>,
): { slug: string; targetFolder: string; prompt: string; jobName: string } {
  const slug = recipe.slugFromValues(values);
  const targetFolder = `04-Ingest/${slug}`;
  const jobName = `feed:${slug}`;
  const prompt = recipe.buildPrompt(values, { slug, targetFolder });
  return { slug, targetFolder, prompt, jobName };
}
