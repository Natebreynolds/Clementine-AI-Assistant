# Skills-First Redesign Proposal

**Date:** 2026-05-08
**Author:** post-1.18.105 walkthrough
**Status:** proposal — needs your approval before any code

---

## What I found when I actually opened the dashboard

### The Tasks page is 6,483 pixels tall

That's nine full viewport heights of stacked content. Walking from top to bottom you see, in order:

1. **Health Strip** — 7 metric tiles (Runs · 24h, Success rate, Cost, P50, P95, Running now, Top failure)
2. **Mini-dashboards** — 4 more cards (Cost · 7d, Latency, Reliability, Activity)
3. **Operations summary** — 5 more tiles (Needs Attention, Scheduled Tasks, Scheduled Workflows, Running Now, Scheduled Tokens)
4. **Needs attention** — 931 px of broken-task cards
5. **Your tasks** — 1,817 px of cards (where the user actually wanted to go)
6. **Recent history** — 2,901 px of run rows

That's **three different metrics dashboards stacked** before the user even reaches their tasks. 14 distinct metric labels in the first fold, 179 buttons in the panel, 44 cards. The user lands wanting to edit a task; we hand them a SaaS analytics product.

### One task editor is 8 dimensions of navigation

To edit a single task, the modal exposes:

- **3 outer tabs** (Configure / What will run / Last run)
- **5 inner tabs** under Configure (Basics / Prompt / Tools & MCP / Scope / Limits)
- **25 form fields** across those tabs
- **23 buttons** in the chrome
- **8 named sections** (Identity / Schedule / What it does / Goal / Skills & tools / Scope / Limits / Last run)
- A **"LEGACY MODE" banner** acknowledging the model is already drifting

To change a prompt the user clicks Prompt. To change a skill they click Tools & MCP. To change a schedule they click Basics. To enable hooks they click Last run. **Every part of "what this task does" lives in a different tab.**

### The smoking gun

I opened `audit-inbox-check`. Its prompt is **2,679 characters / 22 lines**:

```
TOOL RESTRICTIONS — MANDATORY. Violating these is a critical error.
1. FORBIDDEN — ALL mcp__kernel tools: …
2. FORBIDDEN — ALL filesystem tools: Glob, Read, Write, Edit, Bash. …
3. FORBIDDEN — ALL Discord tools EXCEPT discord_channel_send_buttons …
4. ALLOWED tools (the COMPLETE list): cron_progress_read, cron_progress_write,
   outlook_search, outlook_read_email, discord_channel_send_buttons.

STEP 1 — Call cron_progress_read with job name "audit-inbox-check"…
STEP 2 — Call outlook_search with query "audit" and count 10. …
STEP 3 — Compare each email id against processed_ids. …
STEP 4 — For each new email: call outlook_read_email…
STEP 5 — For each parsed new audit, call discord_channel_send_buttons…
STEP 5b — Call cron_progress_write…
STEP 6 (no new audits path) — …
```

**This is a skill, not a prompt.** It declares allowed tools, defines a procedure, manages state, specifies output formats, and handles the no-op path. It's a self-contained capability that happens to be stored as a string field on a cron record.

I checked the rest of your crons: **10 of 16 prompts** have explicit numbered STEP procedures. The average prompt length is **2,872 chars**. The longest is **7,052 chars**. Most of your crons are skills-in-disguise.

### Skills exist, but aren't being used

You already have `~/.clementine/vault/00-System/skills/` with 12 skill `.md` files that are well-formed:

```yaml
---
title: Audit Queue Approval → Proposal Brief
description: >-
  When Nate clicks "Build Brief"…
triggers: […]
source: manual
toolsUsed: […]
useCount: 6
createdAt: …
---

# Audit Queue Approval → Proposal Brief
…
```

The infrastructure for skills-as-files exists. The runtime resolves them. **The dashboard just doesn't put them in the user's primary path** — they're an obscure chip picker buried inside Tools & MCP.

---

## So is your simplification right?

**Yes, unambiguously.** What you described — *"crons or tasks are scheduled triggers; the cron itself is made up of skill files that have access to tools and data"* — is the correct architectural primitive.

The current shape (cron = trigger + fat prompt + auxiliary skills) was the path of least resistance for a system that grew organically. It's not wrong by accident; it just kept accumulating. We've now reached the point where the wrongness is visible:

- 10 of your 16 crons have inline procedures — they should be skills.
- The skills directory is half-orphaned because the dashboard nudges users away from it.
- The editor has 8 navigation dimensions because the cron record has 25 fields — most of which would belong to the skill, not the trigger.

---

## The redesigned model

### Three first-class entities, not one

```
┌─────────────────────────────────────────────────────────┐
│ TRIGGER                                                 │
│   when:    every 2h | weekdays 9am | webhook | event    │
│   skill:   audit-inbox-check                            │
│   inputs:  { channel_id: "1478611196604190792" }        │
│   scope:   inherits from skill (override per-trigger)   │
│ ──────────────────────────────────────────────────────  │
│ Stored as: lines in CRON.md or sidecar files            │
│ Lifetime: minutes to author. Edit-friendly.             │
└─────────────────────────────────────────────────────────┘
                         ↓ invokes
┌─────────────────────────────────────────────────────────┐
│ SKILL                                                   │
│   description: what this skill does, in one sentence    │
│   inputs:      typed parameters with defaults           │
│   tools:       exact allowlist (kernel/MCP/built-in)    │
│   data:        memory keys, files, MCPs to read from    │
│   state:       what state.* keys this skill owns        │
│   procedure:   numbered steps, in markdown              │
│   success:     declared verdict (schema or criterion)   │
│ ──────────────────────────────────────────────────────  │
│ Stored as: ~/skills/<name>.md (one file per skill)      │
│ Lifetime: lives across many triggers. Reusable.         │
│ Reviewed like code. Versioned. Tested independently.    │
└─────────────────────────────────────────────────────────┘
                         ↓ uses
┌─────────────────────────────────────────────────────────┐
│ TOOLS  +  DATA SOURCES                                  │
│   tools:        Read/Write/Bash + MCP servers           │
│   data:         memory store / vault files / CLI cmds   │
│ ──────────────────────────────────────────────────────  │
│ Catalog: Tools & MCP page (read-only, status pills)     │
│ Bound:   per-skill (not per-trigger)                    │
└─────────────────────────────────────────────────────────┘
```

### The skill file format (Anthropic-aligned)

This shape mirrors Anthropic's published skill format (frontmatter + markdown body) and extends it with the data-flow declarations Clementine actually needs.

```markdown
---
name: audit-inbox-check
description: Watch the @scorpion.co audit inbox and post new requests to Discord with approve/deny buttons.

# Typed inputs — what the skill needs from its caller
inputs:
  channel_id:
    type: string
    description: Discord channel to post audit cards to
    default: "1478611196604190792"
  search_query:
    type: string
    default: "audit"
  source_domain_suffix:
    type: string
    description: Only process emails from senders ending in this suffix
    default: "@scorpion.co"

# Exact tool allowlist — the skill cannot invoke anything else
tools:
  allow:
    - cron_progress_read     # state I/O
    - cron_progress_write
    - outlook_search         # data sources
    - outlook_read_email
    - discord_channel_send_buttons  # outputs
  deny: []  # explicit deny wins if both lists ever conflict

# Where this skill reads data from. Each entry shows in the dashboard
# tools panel so users see the data flow at a glance.
data_sources:
  - kind: outlook
    purpose: read inbound emails matching search_query + domain suffix
  - kind: state
    purpose: track processed_ids so we don't re-post

# State this skill owns. Other skills cannot read/write these keys.
state_keys:
  - processed_ids  # array of message_ids already turned into Discord cards

# Success criterion. Either a JSON Schema (validated) OR a free-text
# check (Haiku evaluator). Both = both must pass.
success:
  schema:
    type: object
    properties:
      posted_count: { type: integer, minimum: 0 }
    required: [posted_count]
  criterion: |
    Either: zero new audits found (output "__NOTHING__"),
    OR: every new audit got a Discord card AND processed_ids was updated.

# Optional: limits for the skill itself (a trigger may tighten further)
limits:
  max_turns: 8
  max_budget_usd: 0.05
  timeout_seconds: 120

# Versioning + provenance
version: 2
created_at: "2026-04-15T09:00:00Z"
updated_at: "2026-05-08T01:00:00Z"
last_test_pass: "2026-05-08T01:05:00Z"
---

# Audit Inbox Check

Polls the audit inbox for new requests from `{{ source_domain_suffix }}`
addresses and posts each one to Discord with approve/deny buttons.

## Procedure

1. **Read state.** Call `cron_progress_read("audit-inbox-check")`.
   Take `state.processed_ids` (default `[]`).

2. **Search inbox.** Call `outlook_search(query={{ search_query }}, count=10)`.
   Filter to `from_email` ending in `{{ source_domain_suffix }}`.
   No matches → output `__NOTHING__`.

3. **Find new ones.** Drop ids already in `processed_ids`.
   None new → output `__NOTHING__`.

4. **Parse + post.** For each new email:
   - Call `outlook_read_email`
   - Parse: company, domain, rep, location, type, services, competitors, notes
   - Call `discord_channel_send_buttons` with the card format below

5. **Update state.** Write back `processed_ids` = all ids seen this run.

## Output card format

```
## New Audit Request
**From:** <rep>
**Company:** <company>
…
```

## Success
Output: `📋 N new audit request(s) posted to #audit-queue.` (where N = count posted).
```

**Notice what's now first-class**: tools allowlist, data sources, state ownership, success criterion, version. None of those are buried prompt-text any more — they're declared structurally.

### The trigger record shrinks to 4 lines

```yaml
- name: audit-inbox-check-poll
  schedule: "0 */2 * * *"
  skill: audit-inbox-check
  inputs:
    channel_id: "1478611196604190792"
```

That's it. No prompt. No tool allowlist. No success criterion. No work_dir. **All of those moved to the skill.** The trigger only specifies (a) when to fire and (b) which skill to invoke with which inputs.

If you have 5 schedules pointing at the same skill (different times of day, different channels), you have 5 four-line trigger entries and **one** skill file. Editing the skill once propagates everywhere.

### Multiple triggers per skill, multiple skills per trigger

For the simple case it's 1:1. For workflows the trigger record can chain:

```yaml
- name: audit-inbox-pipeline
  schedule: "0 */2 * * *"
  steps:
    - skill: audit-inbox-check
      inputs: { channel_id: "1478611196604190792" }
    - skill: pipe-to-team
      inputs: { agent: ross-the-sdr }
      when: "previous.posted_count > 0"
```

This collapses today's split between **CRON.md** (single-prompt) and **vault/00-System/workflows/** (multi-step) into one shape. Workflows aren't a separate concept; they're triggers with multiple skill steps.

---

## The redesigned dashboard

### Top-level IA

```
[ Sidebar ]
   Home
   Triggers       ← what was Tasks. Just the schedule list.
   Skills         ← NEW. The unit-of-work catalog.
   Runs           ← unchanged.
   Tools & MCP    ← unchanged but now shows which skills use each.
   Insights       ← NEW. Where Health Strip + 4 mini-cards moved.
   Heartbeat / Team / Brain / Settings
```

### Triggers page (was: Tasks)

**Goal:** simple list of what fires when. No metrics on this page. **One job: edit the schedule.**

```
┌──────────────────────────────────────────────────────────────┐
│ Triggers                              [+ Schedule a skill]   │
├──────────────────────────────────────────────────────────────┤
│ ◉ audit-inbox-check-poll                                     │
│   every 2h · skill: audit-inbox-check · last run: 4m ago ✓   │
│   inputs: channel_id="1478…", search_query="audit"           │
├──────────────────────────────────────────────────────────────┤
│ ◉ morning-briefing                                           │
│   weekdays 8am · skill: morning-briefing · last: today ✓     │
├──────────────────────────────────────────────────────────────┤
│ ⊘ market-leader-followup (paused)                            │
│   every Monday · skill: market-leader-cold-outreach · …      │
└──────────────────────────────────────────────────────────────┘
```

Edit modal is **3 fields**: Schedule, Skill (picker), Inputs (typed form generated from the skill's `inputs:` schema). That's it.

Total page height target: **~1,500 px** (down from 6,483).

### Skills page (NEW)

**The new center of gravity.** Browse, search, edit, test, and version skills.

```
┌────────────────────────────────────────────────────────────────┐
│ Skills                              [+ New skill]   [Import…] │
│ Search: [_______]  Category: [All ▾]  Status: [All ▾]         │
├────────────────────────────────────────────────────────────────┤
│ 📄 audit-inbox-check                                  v2 · ✓  │
│    Watch @scorpion.co audit inbox, post to Discord.           │
│    Tools: 5 · Triggers: 1 · Last run: 4m ago · Test: ✓ today │
├────────────────────────────────────────────────────────────────┤
│ 📄 morning-briefing                                   v1 · ⚠  │
│    Compose daily briefing from yesterday's notes + calendar.  │
│    Tools: 4 · Triggers: 1 · Last test: 3 weeks ago            │
├────────────────────────────────────────────────────────────────┤
│ 📄 daily-content-intelligence-brief                   v3 · ✓  │
│    …                                                           │
└────────────────────────────────────────────────────────────────┘
```

Click a skill → side-pane editor:

- **Header:** name, description, version, "Test this skill →" button, "Used by N triggers" link
- **Inputs panel:** typed parameter editor (add/remove/document params)
- **Tools panel:** allow/deny picker reading from the Tools & MCP catalog
- **Data sources panel:** declarative list of where data comes from (memory / Outlook / vault / CLI / specific MCP)
- **State panel:** which `state.*` keys this skill owns
- **Procedure:** the markdown body with prompt-style editor + version history (we already shipped that!)
- **Success criterion:** schema + free-text editor (already shipped)
- **Limits:** max_turns / budget / timeout (already shipped)

A user can hit **Test** at the top, the dashboard runs the skill in a sandbox with provided inputs, and shows the run detail viewer inline. **Skills become testable without scheduling them**, which is the biggest unlock.

### Tools & MCP page (kept, enriched)

Same as today's read-only catalog but each tool now shows **which skills use it**. So a user clicking on `outlook_search` sees:

```
outlook_search  · MCP · Connected ✓
Used by: audit-inbox-check, morning-briefing, weekly-review
```

That's the visibility the user asked for: *"making sure all available tools can be seen."* Today the tools list exists but skills don't reach into it — the page is decorative.

### Insights page (was: top of Tasks)

The 7-tile Health Strip + 4 mini-dashboards move HERE. Not on the Triggers page. The user opens Triggers when they want to edit triggers; they open Insights when they want to see how things are going. **Two jobs, two pages.**

---

## Migration: legacy tasks → skills

This is the trickiest part. You have 16 crons today, 10 with procedural prompts. You can't ask the user to manually rewrite all of them.

### The auto-extraction pass

A one-time migration script + UI:

1. **For each cron**, scan its prompt for skill-shape markers:
   - Numbered steps (`STEP 1`, `1.`, `2)`)
   - Tool restrictions blocks
   - State references (`processed_ids`, `cron_progress_*`)
   - Output format declarations

2. **If skill-shape detected → propose a skill.** Generate `vault/00-System/skills/<cron-name>.md` with:
   - Frontmatter populated from existing `allowed_tools`, `success_schema`, `success_criteria_text`, `max_turns`, `max_budget_usd`
   - Body = the prompt as-is (we don't try to rewrite the procedure mechanically)
   - `version: 1`, `migrated_from: <cron-name>`, `migrated_at: <now>`
   - Mark inputs as TODO (user fills in)

3. **Update the cron record** to point at the new skill:
   - Set `skill: <name>`, `inputs: {}`
   - Move `prompt:` to a `legacy_prompt:` field for one release (rollback safety)
   - Show a "Migrated" badge on the trigger card

4. **Migration UI:** a banner at the top of Triggers page reading "10 tasks ready to migrate to skills" with a "Review and migrate →" button. Clicking opens a per-task review screen showing:
   - Original prompt (left)
   - Generated skill file (right)
   - "Migrate this one" / "Skip" buttons
   - Bulk "Migrate all" at the bottom

5. **Rollback path.** Each migration writes a `.migration.json` sidecar so a single click restores the original cron exactly. We've already shipped drafts (1.18.105) — same machinery.

For non-skill-shape crons (the 6 that don't have STEP X procedures), don't auto-migrate. Surface them as "Custom prompt — keep or convert" and let the user decide.

### Backwards compat at runtime

For the same release that ships skills-as-primary, the runtime keeps reading `legacy_prompt:`. A cron with `skill:` set takes priority; one with only `prompt:` falls back to the old path.

The user can run **mixed** — some triggers point at skills, others have legacy prompts — for as long as they want. The Migration UI just nags gently until everything's migrated.

---

## Phasing — what to build, in what order

This is bigger than the previous PRD. Five phases over ~3-4 weeks of focused work:

### Phase A — Skill catalog read-only (1-2 days)

Just a Skills page that lists existing files and renders them nicely. No editing yet.
- Indexes `vault/00-System/skills/*.md`
- Search + category filter
- Detail pane shows frontmatter as structured fields, body as markdown
- "Used by N triggers" join (read CRON.md, find skill references)

**Ship gate:** users can see what skills exist.

### Phase B — Skill editor + Test runner (3-4 days)

Make the skill page editable and runnable in isolation.
- Per-field editor for frontmatter (inputs, tools, data_sources, state_keys, success, limits)
- Markdown editor for body with the existing prompt-history infra reused
- "Test this skill" button: spawn a one-off run with input form generated from the skill's `inputs:` schema, show the run detail viewer inline
- Skill versioning (drafts/publish) — reuse 1.18.105 machinery exactly

**Ship gate:** users can build new skills from scratch and verify them.

### Phase C — Trigger record refactor (2-3 days)

Cron record becomes thin. New schema with `skill:` + `inputs:` fields. Runtime knows how to invoke either form (skill-based or legacy prompt-based).
- New TypeScript fields on `CronJobDefinition` (`skill?`, `inputs?`, `legacy_prompt?`)
- Update `runAgentCron` to load the skill file when `skill:` is set, parse frontmatter, build the prompt from skill body + interpolated inputs
- Tools allowlist: union of skill's allow + trigger's override (trigger can never grant tools the skill didn't declare)

**Ship gate:** new triggers can be authored against skills; existing triggers keep working.

### Phase D — Triggers page redesign (3-4 days)

The new minimal Triggers page. 1500 px tall. Three fields per trigger.
- Migrate Health Strip + 4 mini-dashboards to a new Insights page (not deletion — just a move)
- Trigger card = name, schedule, skill name, inputs, last run, run/edit/cancel buttons
- Trigger edit modal = schedule + skill picker + auto-generated input form

**Ship gate:** users can author triggers in the new shape; old shape still rendered for unmigrated triggers (with an "Edit as legacy" option).

### Phase E — Migration tooling (3-5 days)

The auto-extraction pass + UI.
- Heuristic detector for skill-shape prompts
- Migration script (skill file generator + CRON.md rewriter)
- Migration review UI (per-trigger and bulk)
- Rollback per migration via `.migration.json` sidecars

**Ship gate:** the user can migrate all 16 of their existing crons in <30 minutes of review time.

### Phase F — Tools & MCP join + Insights polish (1-2 days)

- Tools page shows "Used by" join from skills
- Insights page polish (move things, tidy up)
- Final correctness audit
- Update DASHBOARD_AUDIT.md and the project memory

**Ship gate:** session ends with a clean state.

---

## What I'd want answers to before I write a line of code

1. **Skill scope: project or global?** Today skills live under `vault/00-System/skills/`. Should they also be loadable per-project (e.g. a `~/proposal-builder/.clementine/skills/` directory) so different projects can carry their own skill libraries? My instinct: yes, mirroring how `.claude/settings.local.json` works.

2. **Inputs schema language: JSON Schema or simpler?** The PRD already uses JSON Schema for `success_schema:`. For skill `inputs:` it'd be consistent. Trade-off: JSON Schema is verbose for "string with default '/foo'". A lightweight DSL would read better but means a custom parser.

3. **Skill testing: with what data?** A test run needs sample inputs and tools the skill is allowed to use. Two answers: (a) "dry run" mode where tools are mocked, (b) "real run" against the actual user environment. (b) is more useful but riskier (real Discord posts, real emails). I'd default to (a) with an explicit "Run for real" toggle.

4. **Workflow merger: now or later?** Today there's CRON.md + `vault/00-System/workflows/`. The new model can collapse both into one trigger shape with multi-step support. Is that part of this redesign, or do we leave workflows alone and only refactor CRON.md? My instinct: do it now. Two trigger shapes is the same problem we're solving.

5. **Skill marketplace, eventually?** Once skills are first-class files with versions, they're shareable. Is "import a skill from a URL / GitHub repo / npm package" something you'd want? If yes, the schema needs to be designed with portability in mind (no hardcoded user paths).

---

## Bottom line

You're not over-thinking. The PRD I worked from locked in the wrong primitive, and the polish I shipped is real but on the wrong abstraction. Your simpler model is correct, the code we have already supports most of it underneath the dashboard, and 10 of your 16 existing crons are already shaped like skills — they're just stored as prompt strings.

This is a 3-4 week refactor done right, not an evening's worth of marathon ships. Five phases, gated, with a real migration story. The end state is a dashboard where:

- A **trigger** is 4 lines.
- A **skill** is one reviewable, testable, versioned file.
- A **tool** has a "used by" list so the data flow is visible.
- The **dashboard** has Triggers / Skills / Runs / Tools / Insights as five separate pages, each doing one job.

I'd say **yes, do it.** But don't let me do it inside another rapid-fire session — this deserves a proper design pass and an answer to those five questions first.

If you want, my next move is to draft the migration heuristic in detail (which prompt patterns extract cleanly, which need user judgement) so we know what Phase E actually looks like before committing to the rest.
