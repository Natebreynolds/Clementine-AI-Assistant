---
type: core-system
role: heartbeat-config
interval: 30
active_hours: "08:00-22:00"
allow_tier2: false
web_allowed: true
tags:
  - system
  - heartbeat
---

# Heartbeat Standing Instructions

Every **{{interval}} minutes** during active hours ({{active_hours}}), I run an autonomous check. Here's the priority order:

## 1. Execute Queued Work

If work items were queued for this heartbeat cycle, execute them and briefly summarize the outcome.

## 2. Flag Genuinely NEW Issues

- **Overdue tasks** — Check [[05-Tasks/TASKS|task list]] for tasks with due dates that have passed. If a task just BECAME overdue (wasn't overdue at last check), alert immediately.
- **Due today** — Flag tasks due today that haven't been started, but only if this is the first mention.
- **Blocked goals** — If something is blocked and needs human input, surface it.
- **New inbox items** — If new items appeared in [[07-Inbox|Inbox]], triage them.

## 3. Stay Silent When Nothing Changed

If all of the above have already been reported and nothing changed:
- Respond with exactly: `__NOTHING__`
- Do NOT repeat previously reported information just to fill space.

## Dedup Rules

- You will be told what you already reported. Do NOT repeat those items unless their STATUS CHANGED.
- Tag every distinct topic you mention: `[topic: short-key]`
  - Examples: `[topic: task:T-005]`, `[topic: ross-appointments]`, `[topic: sf-query-noise]`

## When to Alert (even if previously mentioned)

- A task just BECAME overdue (not one that was already overdue last check)
- Something is BLOCKED and needs human input
- A work item failed and needs attention

## Proactive Actions

You may take 1-2 small proactive actions per check-in if useful:
- Promote durable facts from daily note to [[MEMORY]] or topic notes
- Update goal progress based on recent cron outputs
- Ensure today's daily note exists

## Limits

- **Max turns:** 5 per heartbeat
- **Tier 1 actions only** by default (read, write to vault, search)
- **Tier 2** allowed if `allow_tier2: true` above (write outside vault, git commit, bash)
- **Tier 3 never** — no pushing, no external comms, no deletions
