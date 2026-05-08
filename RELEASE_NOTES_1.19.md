# Clementine 1.19 — Skills-First Stable

This is the first stable release of the Skills-First architecture. Everything below is **additive** — your existing crons, skills, and workflows keep working as-is. The migration tools surface inside the dashboard are **opt-in**: nothing changes on disk until you click a button.

If you're upgrading from 1.18.x or earlier, read the **Upgrade path** section before restarting your daemon.

## TL;DR for users on 1.18.x

1. Update: `npm i -g clementine-agent@latest && clementine restart`
2. Open the dashboard: `clementine dashboard`
3. Go to **Tasks**. If you have legacy crons (the common case), you'll see **"✨ Clean up N legacy tasks"** at the top of the page.
4. Click **Preview changes** → review the diff → click **Migrate all**.
5. That's it. Every cron job's `.bak` is preserved for rollback.

Optional follow-ups:
- Try **+ New skill** on the Skills page or in chat: *"Hey Clemmy, create a skill called {name} that …"*
- Use **+ New task** on the Tasks page to author a fresh trigger that pins one or more skills.

## What changed since 1.18.0 (the architecture, not the runtime)

The **runtime stayed identical.** The Claude Agent SDK layer is unchanged. What we did was add a clean data-shape on top:

| Layer | What | Status |
|---|---|---|
| Claude Agent SDK | Tool execution, prompt routing, model calls | **Untouched** — still `@anthropic-ai/claude-agent-sdk` v0.2.x |
| Skill loader | `~/.clementine/vault/00-System/skills/<name>/SKILL.md` (Anthropic spec folder form) | New canonical layout — flat-form skills still load |
| Cron-clean migrator | Pure data transform: legacy YAML → clean YAML, no behavior change | New, opt-in |
| Dashboard | Surfaces both, with bulk + per-task migration | New UI on existing endpoints |

Nothing in this release rewrites how a cron fires, how a skill body is loaded, or how Claude sees tools. The migrator only changes the **shape of the YAML** so the dashboard can render it cleanly.

## What "legacy" means and what migration does

A **legacy** cron job has any of:
- No `predictable: true` flag (the runtime auto-injects MEMORY.md + team comms + auto-matched skills at fire-time)
- A "TOOL RESTRICTIONS — MANDATORY" preamble at the top of the prompt body (boilerplate from before `allowed_tools` existed as a YAML field)
- No `description` field (the dashboard's task card preview falls back to showing raw prompt text)
- No pinned `skills` even though the runtime auto-matches one (or several) every fire

The migrator does, **per job**:

| Action | What | Effect |
|---|---|---|
| Set `predictable: true` | Runtime stops auto-injecting at fire-time | Same procedure runs, just from explicit pinned attachments |
| Strip `TOOL RESTRICTIONS — MANDATORY` preamble | Move "ALLOWED tools (the COMPLETE list): X, Y, Z" line into the `allowed_tools:` field | Card preview reads as the actual procedure |
| Pin matching skill | Look up by name, then trigger phrase, then ≥2 word-token overlap | Replaces the prompt body with `Run the {skill} skill.` |
| Generate description | Use the matched skill's description if available, else first sentence of cleaned prompt | Drives the task card preview line |

**The migrator never:**
- Changes the cron schedule
- Disables a previously-enabled job
- Deletes anything (everything goes into a `.bak` file)
- Modifies disabled jobs differently (one-time reminders / test crons get the same treatment)

## Migration is reversible

For every CRON.md the migrator touches, it writes a `<basename>.bak` file in place. To roll back:

```sh
# Undo all migration changes for the main vault
mv ~/.clementine/vault/00-System/CRON.md.bak ~/.clementine/vault/00-System/CRON.md

# Undo per-agent migrations (substitute slug as needed)
mv ~/.clementine/vault/00-System/agents/<slug>/CRON.md.bak \
   ~/.clementine/vault/00-System/agents/<slug>/CRON.md

clementine restart
```

There's also a **full snapshot** at `~/.clementine/migration-snapshots/<YYYYMMDD-HHMMSS>/` written automatically by the dashboard before it offers migration the first time per session. That snapshot covers `CRON.md`, every `agents/*/CRON.md`, the entire `skills/` tree, and the `workflows/` directory.

## What the migrator does NOT touch

- **Workflows** (`vault/00-System/workflows/*.md`) — the migrator only handles individual cron jobs. If you have workflows, they keep working unchanged.
- **Skills already in folder form** (those produced by the 1.18.110 skill migration) — stay as-is.
- **Disabled jobs** — get migrated in shape but stay disabled. No accidental enabling.
- **Per-task tags, category, custom YAML keys** — preserved verbatim. The migrator only edits the fields it knows about.

## New: skill creation from chat

In any chat surface (Discord, dashboard chat, Slack, Telegram), you can now author skills directly:

```
You:    Hey Clemmy, create a skill called morning-deal-review that
        pulls the last 24h of deal pipeline updates from Salesforce
        and surfaces the high-value ones.

Clem:   ✅ Created skill "morning-deal-review" at
        ~/.clementine/vault/00-System/skills/morning-deal-review/SKILL.md
        Description: Pulls the last 24h of deal pipeline updates …
        The skill is ready to pin to any task — open the cron editor,
        go to Tools & MCP, click "+ Add skill" and select
        "morning-deal-review". Or invoke it directly: "Run the
        Morning Deal Review skill."
```

Available tools (callable by Clementine via the agent runtime):
- `create_skill` — author a new skill folder
- `update_skill` — edit an existing skill's description / body / tools / triggers
- `list_skills` — show every skill in the vault

These tools enforce the Anthropic spec on the way in (name regex, ≤1024-char description, ≤500-line body), so a malformed skill can't be created via chat.

## Upgrade path from 1.18.x

1. **Stop the daemon** before updating: `clementine stop`
2. **Update**: `npm i -g clementine-agent@latest`
3. **Optional snapshot**: the dashboard will write one automatically the first time you open the Tasks page after upgrading. If you want one now, just copy `~/.clementine/vault/` somewhere safe.
4. **Start**: `clementine launch` (or `clementine restart` if it auto-started)
5. **Open the dashboard** and look for the migration banner.

If you run into any cron that fails to fire after migration, restore that file's `.bak` and tell us what happened — the migrator should be a pure data transform but the matching logic for skill pinning is heuristic and might have picked the wrong skill for a particular job.

## What did NOT change

- Daemon CLI commands (`clementine launch`, `restart`, `stop`, `dashboard`, `mcp`)
- The `~/.clementine/` filesystem layout (vault, sessions, runs, drafts)
- The Claude Agent SDK version (`@anthropic-ai/claude-agent-sdk`)
- Discord / Slack / Telegram / WhatsApp gateway behavior
- Memory store schema (SQLite FTS5, dense embeddings)
- Cron scheduler (node-cron)
- Heartbeat scheduler

If anything in this list changed for you after upgrading, that's a regression — open an issue.

## Internal: how the migrator stays out of the SDK layer

The cron-clean migrator lives in `src/agent/cron-migrator.ts` as a **pure function**. It:
- Takes a `CronJobDefinition` + a list of available `Skill` records
- Returns a new `CronJobDefinition` + a list of human-readable change bullets
- Never touches the runtime
- Never opens an MCP connection
- Never reads or writes anything outside the parameters it's given

The dashboard endpoints (`/api/cron/migrate-preview`, `/api/cron/:job/migrate`, `/api/cron/migrate-all`) handle file I/O — read CRON.md, run the pure migrator, write back, write `.bak`. That's it.

The runtime path (`src/agent/run-agent-cron.ts`) doesn't know the migrator exists. It reads the YAML the same way it always has; it just sees cleaner shape after the user clicks Migrate. Removing the migrator entirely tomorrow would not change runtime behavior on a single cron.
