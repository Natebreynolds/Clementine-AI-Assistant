/**
 * Skill templates — 1.18.130 (Phase 2 / Skill Builder).
 *
 * Each template scaffolds a SKILL.md frontmatter + body skeleton plus
 * (optionally) starter bundled files. Templates encode the five common
 * skill archetypes the user pulled out of the Anthropic skills video:
 *
 *   - **Orchestrator** — the meta-skill that routes work to other skills
 *   - **Scraper / Poller** — read external data, surface what's new
 *   - **Transformer** — mutate input → produce output (no side effects)
 *   - **Notifier** — send a message to Discord/Slack/email when X happens
 *   - **Conversational** — interactive multi-turn agent for one workflow
 *
 * The Builder asks the user to pick one when creating a new skill;
 * the chosen template defines the starting body + suggested tools.allow.
 * Authors edit from there. Templates aren't a runtime concept — they're
 * just initial content the writeSkill() helper persists like any other
 * skill.
 */

export interface SkillTemplate {
  /** Stable id used by the picker. */
  id: string;
  /** Display name shown in the picker. */
  label: string;
  /** One-line "use when" hint for the picker subtitle. */
  hint: string;
  /** Emoji shown next to the label — gives the picker visual texture. */
  emoji: string;
  /** Initial frontmatter description filled into the create modal.
   *  User can override before save; serves as a writing prompt. */
  defaultDescription: string;
  /** Initial Markdown body. Should follow the Anthropic procedure
   *  shape (numbered steps, clear inputs/outputs section) so authors
   *  start from a good pattern instead of a blank page. */
  body: string;
  /** Suggested clementine.tools.allow allowlist. The Builder pre-fills
   *  the tools chip list so authors see "this archetype usually needs
   *  Read + Bash + memory_write" right away. */
  suggestedTools: string[];
  /** Optional bundled files to drop alongside SKILL.md. Each entry is
   *  written via the same writeSkill folder as the entry-point file.
   *  Example: an Orchestrator template ships a templates/output.md
   *  scaffold; a Scraper ships a scripts/fetch.py stub. */
  bundledFiles?: Array<{ relPath: string; content: string }>;
}

export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    hint: 'Routes work to other skills based on conditions. The "meta-skill" pattern from the Anthropic agent skills video.',
    emoji: '🎯',
    defaultDescription:
      'Route incoming work through a sequence of decisions. For each item, pick the right downstream skill based on the conditions in the body.',
    suggestedTools: ['Agent', 'Read'],
    body: `# {{TITLE}}

This skill is an **orchestrator** — it doesn't do the work itself, it routes work to other skills based on conditions.

## Procedure

1. **Gather inputs.** State what you need to know to make routing decisions (e.g., query a data source, read state, check a flag).

2. **For each item, decide the path:**
   - If <condition A> → invoke the **<skill-name-a>** skill with \`{key: value}\`
   - If <condition B> → invoke the **<skill-name-b>** skill with \`{key: value}\`
   - Otherwise → log to the daily note as "no match"

3. **Summarize.** Send a short Discord summary: how many items, which skills fired, any errors.

## Sub-skills referenced

- \`<skill-name-a>\` — describe what it does
- \`<skill-name-b>\` — describe what it does

## Tips for writing orchestrators

- Keep the routing logic in this body. Sub-skills should be pure functions that don't know they're being called from here.
- Pin every sub-skill to the same scheduled task so their bodies are loaded into context together.
- The Agent tool is what dispatches sub-skills — keep it in your tools.allow.
`,
  },
  {
    id: 'scraper',
    label: 'Scraper / Poller',
    hint: 'Read an external source, surface what is new since the last run.',
    emoji: '🔍',
    defaultDescription:
      'Poll an external source on a schedule and surface what is new since the last run. Tracks state via the cron progress mechanism so it does not re-process old items.',
    suggestedTools: ['Read', 'WebFetch', 'cron_progress_read', 'cron_progress_write'],
    body: `# {{TITLE}}

Read an external data source on a schedule, surface only what's changed since the last run.

## Procedure

1. **Read state.** \`cron_progress_read\` to get \`{processed_ids: [...]}\` (default \`[]\`).

2. **Query the source.** Describe exactly what you fetch (URL, MCP tool call, file path).

3. **Filter to new items.** Compare each item's id against \`processed_ids\`. Skip ones already seen.

4. **For each new item:**
   - <do the thing>

5. **Persist state.** \`cron_progress_write({processed_ids: [...]})\` with the union of old + new ids.

6. **Output.** If nothing was new, output \`__NOTHING__\`. Otherwise summarize what was processed.

## Inputs

- (declare any \`clementine.inputs\` parameters here so the agent reads them as inputs)
`,
    bundledFiles: [
      {
        relPath: 'references/state-shape.md',
        content: `# State shape\\n\\nThis skill reads/writes its state via \`cron_progress_*\`. Document the shape here so future-you remembers what each key means.\\n\\n\\\`\\\`\\\`json\\n{\\n  "processed_ids": ["id1", "id2"],\\n  "last_run_summary": "..."\\n}\\n\\\`\\\`\\\`\\n`,
      },
    ],
  },
  {
    id: 'transformer',
    label: 'Transformer',
    hint: 'Take input → produce output. Pure function, no side effects.',
    emoji: '⚙',
    defaultDescription:
      'Pure transformation: receives input, produces output. No external side effects. Useful as a sub-skill called by an orchestrator.',
    suggestedTools: ['Read', 'Write'],
    body: `# {{TITLE}}

Transform input into output. No side effects — safe to call from any context.

## Inputs

Declare in \`clementine.inputs\`:

\\\`\\\`\\\`yaml
clementine:
  inputs:
    source_text:
      type: string
      description: The raw text to transform
      required: true
    style:
      type: string
      enum: [casual, formal, urgent]
      default: casual
\\\`\\\`\\\`

## Procedure

1. **Read inputs.** All inputs are interpolated as \`{{ input_name }}\`.

2. **Transform.** Describe the transformation step by step.

3. **Output.** Return the transformed text only — no commentary, no narration.

## Output shape

\\\`\\\`\\\`
<one-line summary>

<transformed body>
\\\`\\\`\\\`
`,
  },
  {
    id: 'notifier',
    label: 'Notifier',
    hint: 'Send a message somewhere when a condition fires.',
    emoji: '📣',
    defaultDescription:
      'Send a message to Discord/Slack/email/SMS when a condition is met. Composes well with a Scraper that detects "something changed."',
    suggestedTools: ['Read', 'discord_channel_send', 'slack_post_message'],
    body: `# {{TITLE}}

Notify a destination when a condition fires.

## Procedure

1. **Check the condition.** Describe what triggers the notification (e.g., new audit row, daily digest ready, alert threshold crossed).

2. **Build the message.** Keep it short. Include:
   - What happened
   - Why it matters (one line)
   - Action the recipient should take, if any

3. **Send via the right channel:**
   - Use \`discord_channel_send\` for the team / yourself
   - Use \`slack_post_message\` if the recipient prefers Slack
   - Use \`mcp__gmail__send\` for external recipients

4. **Confirm delivery.** Output a one-liner like "Sent to #ops-alerts at 09:14."

## Inputs

\\\`\\\`\\\`yaml
clementine:
  inputs:
    destination:
      type: string
      enum: [discord-ops, slack-team, email-owner]
      default: discord-ops
    severity:
      type: string
      enum: [info, warning, urgent]
      default: info
\\\`\\\`\\\`
`,
  },
  {
    id: 'conversational',
    label: 'Conversational',
    hint: 'Multi-turn interactive agent for one specific workflow.',
    emoji: '💬',
    defaultDescription:
      'Multi-turn conversational agent for a specific workflow (e.g., onboarding a new client, debugging a system). Maintains a focused context across the conversation.',
    suggestedTools: ['Read', 'memory_read', 'memory_write', 'note_create'],
    body: `# {{TITLE}}

Run a focused multi-turn conversation. The user comes to you with a specific goal; you guide them step by step until it's done.

## Procedure

1. **Open with intent confirmation.** "Sounds like you want to do X. Is that right?" Don't start tools until they confirm.

2. **Gather what you need.** Ask one question at a time, not a wall.

3. **Use tools sparingly.** Each tool call should be obvious and explainable in the next turn.

4. **Save what you learn.** Use \`memory_write\` for facts that should persist beyond this conversation.

5. **Close cleanly.** When done, summarize what was accomplished + any next steps for the user.

## Conversation principles

- Match the user's tone (casual / formal / urgent — read their first message)
- Never start a multi-step process without checking in first
- If the user changes direction mid-conversation, acknowledge + pivot — don't pretend they asked for what you started
`,
  },
];

/** Lookup by id. */
export function getSkillTemplate(id: string): SkillTemplate | null {
  return SKILL_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Apply a template to a skill name — substitutes \`{{TITLE}}\` placeholders
 *  in the body with the user's display title. */
export function renderTemplateBody(template: SkillTemplate, displayTitle: string): string {
  return template.body.replace(/\{\{TITLE\}\}/g, displayTitle);
}
