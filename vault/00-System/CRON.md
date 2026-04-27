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
