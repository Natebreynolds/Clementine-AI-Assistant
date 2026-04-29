---
title: Visual Builder canvas — workflow + cron editing
description: >-
  When the user is on the dashboard's Builder page with a workflow or cron
  open in the visual canvas, use the workflow_* MCP tools to read, edit,
  validate, and dry-run the workflow. Edits land live on the user's canvas
  via SSE.
triggers:
  - edit this workflow
  - add a step
  - add a node
  - remove a step
  - connect these steps
  - change the schedule
  - disable this cron
  - validate the workflow
  - dry run this workflow
  - dry-run
  - show what would happen
  - test the workflow safely
  - rename this workflow
  - duplicate this workflow
  - turn this on
  - turn this off
source: manual
loaded: auto
placement: system
---

# Visual Builder canvas — workflow + cron editing

## When this applies

The user is working in the dashboard's **Builder** page with a workflow
or cron open in the visual canvas. Their chat messages are about editing
that workflow: adding/removing steps, changing the schedule, validating,
etc. The canvas updates live via Server-Sent Events as you make edits, so
the user *sees your changes appear* on screen.

## Tools you have

Discovery and read:
- `workflow_list` — list all workflows + crons (one per line, terse)
- `workflow_read` — read full workflow as JSON before editing
- `workflow_search` — find by name or step content
- `workflow_list_mcp_tools` — discover available MCP servers/tools (use to fill in `mcp` step config)
- `workflow_list_channels` — discover channel kinds for `channel` step config

Validation (cheap, no execution):
- `workflow_validate` — static checks: cycles, missing deps, missing fields per kind
- `workflow_dry_run` — describe what each step would do, in topological order, with rough token estimate. **Use this for long-running jobs to preview safely before scheduling.**

Mutations (always emit a live update to the canvas):
- `workflow_add_node` — append a new step
- `workflow_update_node` — change an existing step's fields (partial patch)
- `workflow_remove_node` — delete a step + edges referencing it
- `workflow_connect` — add edge `from → to` (sets `to.dependsOn += [from]`)
- `workflow_disconnect` — remove edge
- `workflow_set_enabled` — toggle on/off
- `workflow_set_schedule` — change cron schedule (or pass `null` for manual-only)
- `workflow_rename`, `workflow_duplicate`, `workflow_delete`
- `workflow_save` — full replace (use for atomic multi-field changes; otherwise prefer the targeted tools)
- `workflow_create` — new workflow file

## Workflow shape

Every workflow is a step DAG. A step has:
- `id` (unique within workflow)
- `prompt` (string — required for `kind: prompt`, descriptive for others)
- `dependsOn[]` (step ids this step depends on)
- `tier`, `maxTurns`, `model`, `workDir`
- `kind` — one of: `prompt` (default), `mcp`, `channel`, `transform`, `conditional`, `loop`
- Plus a kind-specific config (`mcp`, `channel`, `transform`, `conditional`, `loop`)

A **cron** is a single-step workflow with a cron schedule trigger. You
**cannot** add a second step to a cron — cron entries must remain
single-step. To make a multi-step automation that runs on a schedule,
use `workflow_create` with a schedule.

## How to work

**Always read first.** Before editing, call `workflow_read` to get the
current step ids and structure. Patches reference step ids by exact
match.

**Validate after edits.** Save tools auto-validate and reject errors;
warnings still pass through. Run `workflow_validate` if the user asks
"is this right?" or before recommending they enable a workflow.

**Dry-run before scheduling.** When the user is about to enable a
long-running workflow (multi-hour job, batch outreach, large ingest),
offer `workflow_dry_run` first. It walks the DAG and describes what each
step *would* do — no execution, no side effects.

**One mutation per turn for big changes.** The canvas updates live, so
small targeted edits (`workflow_add_node`, `workflow_connect`) feel
better than wholesale `workflow_save` rewrites. The user can see
intermediate states.

**Step ids should be short and descriptive.** `s1`, `s2` is fine;
`fetch_emails`, `summarize`, `send_to_slack` is better. Don't change
existing step ids unless the user explicitly asks — other steps depend
on them.

**Channel and MCP steps need real config.** Use `workflow_list_mcp_tools`
to find a real `server.tool` pair before adding an MCP step. Use
`workflow_list_channels` to confirm a channel kind is wired up before
adding a channel step.

## Common patterns

User: "Add a slack send step at the end."
1. `workflow_read` to get current step ids
2. Identify the leaf step(s) (no other step depends on them)
3. `workflow_add_node` with `kind: 'channel'`, `channel: { channel: 'slack', target: '#me', content: '{{<leaf>.output}}' }`, `dependsOn: ['<leaf>']`

User: "Make this run every weekday at 9am."
1. `workflow_set_schedule` with `'0 9 * * 1-5'`

User: "Will this work? Don't run it yet."
1. `workflow_validate` for static checks
2. `workflow_dry_run` to walk through what it would do

User: "Skip if there are no unread emails."
1. `workflow_add_node` with `kind: 'conditional'`, condition referencing the email-list step's output count
2. `workflow_connect` to wire it
