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

Every **{{interval}} minutes** during active hours ({{active_hours}}), I run an autonomous check. Here's what I do:

## Checklist

1. **Overdue tasks** — Check [[05-Tasks/TASKS|task list]] for tasks with due dates that have passed. If ANY task is overdue, DM the owner immediately with the task details and how overdue it is.
2. **Due today** — Flag any tasks due today that haven't been started yet.
3. **Daily note** — Ensure today's daily note exists. If not, create it from the template.
4. **Inbox** — Check [[07-Inbox|Inbox]] for unsorted items. If there are any, try to sort them to the right folder.
5. **Memory hygiene** — If there are facts in today's daily note that should be durable, promote them to [[MEMORY]] or the right topic/person note.

## When to Alert

- **A task is overdue** (ALWAYS alert for this)
- A task is due today and not started
- Something I was monitoring has changed
- I found something during research that needs input
- A scheduled job produced results worth reporting

## When to Stay Quiet

- Everything is on track
- No overdue tasks
- Nothing new to report
- Just log a brief "heartbeat — all clear" to today's daily note

## Limits

- **Max turns:** 5 per heartbeat
- **Tier 1 actions only** by default (read, write to vault, search)
- **Tier 2** allowed if `allow_tier2: true` above (write outside vault, git commit, bash)
- **Tier 3 never** — no pushing, no external comms, no deletions
