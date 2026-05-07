---
type: core-system
role: cron-config
jobs:
  - name: morning-briefing
    schedule: "0 8 * * *"
    prompt: >
      Give the owner a comprehensive morning briefing:
      1. Read the task list and list any overdue, due-today, or high-priority pending tasks
      2. Read yesterday's daily note summary for context on what was happening
      3. Check today's daily note for anything already logged
      4. Check the inbox for unsorted items
      5. Format as a clear briefing with sections: Tasks, Yesterday Recap, Today's Focus
      Keep it concise but actionable.
    tier: 1
    enabled: false

  - name: weekly-review
    schedule: "0 18 * * 5"
    prompt: >
      Create a weekly review note:
      1. Read daily notes from the past 7 days
      2. Summarize what got done this week
      3. List what's still pending
      4. Suggest priorities for next week
      5. Write the review to today's daily note under a "## Weekly Review" section
    tier: 2
    enabled: false

  - name: daily-memory-cleanup
    schedule: "0 22 * * *"
    prompt: >
      End of day cleanup:
      1. Review today's daily note
      2. Extract any durable facts (preferences, decisions, people details) and write them to MEMORY.md or the appropriate topic/person note
      3. Move completed tasks from Pending to Completed in TASKS.md
      4. Write a brief summary of the day in today's daily note under ## Summary
    tier: 1
    enabled: false

  - name: weekly-decision-reflection
    schedule: "0 9 * * 0"
    prompt: >
      Run a self-reflection on the past week's autonomous decisions.
      1. Call `decision_reflection` with window_days=7, save_to_history=true, append_to_memory=true.
         This reads the proactive ledger, computes per-action success rates, identifies
         miscalibration patterns, and writes a tuning note to your working-memory so the
         next heartbeat tick reads it as context.
      2. For each specialist on the team (use `team_list` to enumerate), also run
         `decision_reflection` with their slug, save_to_history=true, append_to_memory=true.
      3. Briefly summarize in today's daily note under "## Decision reflection" — list each
         agent's headline pattern.
    tier: 1
    enabled: false
tags:
  - system
  - cron
---

# Cron Jobs

> **Fresh installs ship with all jobs disabled.** Review each one and flip `enabled: true` for the workflows you actually want. Edit the schedules and prompts to match your routine.

Scheduled tasks that run automatically at specific times. Edit the frontmatter above to add, modify, or enable jobs.

## Example Jobs (disabled by default)

| Job | Schedule | Description |
|-----|----------|-------------|
| morning-briefing | 8:00 AM daily | Comprehensive morning briefing |
| weekly-review | 6:00 PM Fridays | Weekly summary + planning |
| daily-memory-cleanup | 10:00 PM daily | Promote daily facts to long-term memory |
| weekly-decision-reflection | 9:00 AM Sundays | Per-agent self-tuning from proactive ledger |

## Schedule Syntax

Standard cron expressions: `minute hour day-of-month month day-of-week`
See [crontab.guru](https://crontab.guru) for help.

## Adding a Job

Add a new entry to the `jobs` list in the frontmatter above:
```yaml
  - name: my-new-job
    schedule: "0 12 * * *"
    prompt: "What should the assistant do"
    tier: 1
    enabled: true
```

## Tricks: Capability-aware jobs

A "trick" is a cron job that explicitly declares the **skills**, **tools**, and
**MCP servers** it should run with. All capability fields below are optional —
omit them to inherit defaults from the agent profile (or, for global jobs, the
SDK's defaults). Surfaces in the dashboard as the **Capabilities** card section
and the **Preview** modal.

```yaml
  - name: morning-research
    schedule: "0 7 * * *"
    prompt: >
      Pull the overnight news, summarize the top three items relevant to me,
      and post the digest to the briefing channel.
    tier: 2
    enabled: true

    # ── Trick capabilities ────────────────────────────────────────
    skills:
      - research-protocol      # pinned skill, loaded ahead of auto-match
      - summarize-news
    allowed_tools:
      - Read
      - Write
      - WebFetch               # 'Agent' is always force-included for sub-agent delegation
    allowed_mcp_servers:
      - firecrawl
      - claude_ai_Gmail
    tags:
      - morning
      - briefing
    category: research
```

### Field reference

| Field | Type | Behavior |
|-------|------|----------|
| `skills` | `string[]` | Pinned skill slugs (filename minus `.md`, slashes flattened to dashes — e.g. `auto/discord/send-message.md` → `auto-discord-send-message`). Loaded **before** the runtime auto-match. Total skills injected per run is capped at 4. Missing pins are warned + surfaced on the dashboard run-status line, not fatal. |
| `allowed_tools` | `string[]` | Per-trick tool whitelist. When set, the effective list is `(allowed_tools) ∩ (agent_profile.team.allowedTools)` with `Agent` always force-included. Bare tricks (no `agentSlug`) use the trick list as the only constraint. |
| `allowed_mcp_servers` | `string[]` | Per-trick MCP server whitelist (server names from the dashboard's MCP servers list). Applied **after** the agent profile's allowlist, so the effective set is `profile ∩ trick`. |
| `tags` | `string[]` | UI-only — surfaced as `#tag` chips on cards and as filter pills above the Scheduled Tasks grid. No execution coupling. |
| `category` | `string` | UI-only — single category bucket shown as a badge on the card. |

Both `camelCase` and `snake_case` keys are accepted (`allowedTools` works the
same as `allowed_tools`). Empty arrays are treated as absent so the
`inherit ⇒ default` semantic is preserved.

The dashboard's edit modal builds these YAML keys for you when you pin skills,
add MCP servers, or set tags through the **Capabilities** section of the
trick edit form. Clearing all chips removes the YAML key.

### Preview before fire

To see exactly what a trick will send the agent the next time it runs — before
the next cron tick — click **Preview** on the trick card or call:

```
GET /api/cron/<job-name>/preview
```

The response includes the fully-built prompt, every skill that would be
injected (with its full markdown content), the effective tool/MCP allowlists
after profile intersection, and any warnings (missing pins, etc.). Use this to
sanity-check chat-configured or hand-edited tricks before they fire.
