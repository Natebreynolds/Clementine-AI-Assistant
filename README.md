```
 ██████╗██╗     ███████╗███╗   ███╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗
██╔════╝██║     ██╔════╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝
██║     ██║     █████╗  ██╔████╔██║█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗
██║     ██║     ██╔══╝  ██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝
╚██████╗███████╗███████╗██║ ╚═╝ ██║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗
 ╚═════╝╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝
```

A persistent, ever-learning personal AI assistant that runs as a background daemon on macOS.
Built on the [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code-sdk), Obsidian-compatible vault, and SQLite FTS5.

Connects to Discord, Slack, Telegram, WhatsApp, and webhooks. Remembers everything. Runs 24/7.

---

## How it works

Clementine is three layers stacked on a shared memory store:

```
                    ┌─────────────────────────────────────────┐
                    │            Channel Layer                 │
                    │  Discord · Slack · Telegram · WhatsApp   │
                    │  Webhook API · Discord Guild Channels     │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │           Gateway Layer                  │
                    │  Router · Session Manager · Heartbeat    │
                    │  Cron Scheduler · Notification Dispatch  │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │            Agent Layer                   │
                    │  Claude Code SDK · Security Hooks        │
                    │  Auto-Memory · Session Rotation          │
                    │  Agent Profiles · Team Spawning          │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │          MCP Tool Server                 │
                    │  27 tools over stdio transport           │
                    │  Memory · Tasks · Vault · Workspace      │
                    └────────────────┬────────────────────────┘
                                     │
              ┌──────────────────────▼──────────────────────┐
              │              Memory Store                    │
              │  SQLite FTS5 · Salience Scoring · Decay     │
              │  Episodic Memory · Wikilink Graph            │
              │  Obsidian Vault (source of truth)            │
              └─────────────────────────────────────────────┘
```

### The memory loop

Every conversation triggers a background extraction pass (Haiku) that saves facts, preferences, people, and tasks to the Obsidian vault. The vault is indexed into SQLite FTS5 with automatic triggers. Retrieved memories get salience boosts. Stale memories decay over time. Old data is pruned on startup.

The result: Clementine gets better the more you talk to it.

---

## Quick start

```bash
git clone https://github.com/Natebreynolds/Clementine-AI-Assistant.git clementine && cd clementine && npm install --loglevel=error --no-audit && npm run build && npm install -g . --loglevel=error --no-audit
```

Already have it? Update in place:

```bash
clementine update
```

Then configure and launch:

```bash
clementine config setup   # interactive wizard
clementine launch         # start as background daemon
clementine status         # verify it's running
```

That's it. Clementine is now running, connected to your configured channels, and learning.

---

## Architecture

### File layout

```
~/.clementine/                     ← Data home (created on first run)
├── .env                           ← Configuration (created by setup wizard)
├── .sessions.json                 ← Session persistence
├── .memory.db                     ← SQLite FTS5 index
├── .clementine.pid                ← Daemon PID lock
├── logs/
│   ├── clementine.log             ← Daemon stdout/stderr
│   └── audit.log                  ← Security audit trail
└── vault/                         ← Obsidian-compatible vault
    ├── 00-System/                 ← SOUL.md, MEMORY.md, HEARTBEAT.md, CRON.md
    ├── 01-Daily-Notes/            ← Auto-generated daily logs (YYYY-MM-DD.md)
    ├── 02-People/                 ← Person notes (auto-created from conversations)
    ├── 03-Projects/               ← Project notes
    ├── 04-Topics/                 ← Knowledge topics
    ├── 05-Tasks/                  ← TASKS.md master list ({T-NNN} IDs)
    ├── 06-Templates/              ← Note templates
    └── 07-Inbox/                  ← Quick captures

src/                               ← Package code (wherever npm installed it)
├── agent/
│   ├── assistant.ts               ← PersonalAssistant — the brain
│   ├── hooks.ts                   ← Security enforcement (3-tier model)
│   └── profiles.ts                ← Agent profile switching
├── channels/
│   ├── discord.ts                 ← Discord.js adapter
│   ├── slack.ts                   ← Slack Socket Mode adapter
│   ├── telegram.ts                ← grammY adapter
│   ├── whatsapp.ts                ← Twilio WhatsApp bridge
│   └── webhook.ts                 ← HTTP webhook API
├── gateway/
│   ├── router.ts                  ← Message routing + session management
│   ├── heartbeat.ts               ← HeartbeatScheduler + CronScheduler
│   └── notifications.ts           ← Channel-agnostic notification fan-out
├── memory/
│   ├── store.ts                   ← SQLite FTS5 memory store
│   ├── search.ts                  ← Temporal decay, dedup, formatting
│   └── chunker.ts                 ← Vault file parser (## headers, frontmatter)
├── tools/
│   └── mcp-server.ts             ← 27-tool MCP stdio server
├── cli/
│   ├── index.ts                   ← CLI commands (launch, stop, status, config, doctor)
│   └── setup.ts                   ← Interactive configuration wizard
├── config.ts                      ← Paths, secrets, models (never pollutes process.env)
├── types.ts                       ← Shared TypeScript interfaces
└── index.ts                       ← Main entry point (multi-channel startup)
```

### Code vs. data separation

| Concept | Variable | Location |
|---------|----------|----------|
| Package root | `PKG_DIR` | Wherever npm installed the package |
| Data home | `BASE_DIR` | `~/.clementine/` (or `CLEMENTINE_HOME` env var) |

The CLI works from any directory. First run copies vault templates from the package to `~/.clementine/`.

### Security model

Three-tier enforcement via the SDK `canUseTool` callback:

| Tier | Auto-allowed | Examples |
|------|-------------|----------|
| **1** | Always | Read files, vault writes, web search, safe git |
| **2** | Logged | External writes, git commit, bash dev commands |
| **3** | Blocked in autonomous mode | Push, delete, credentials, form submit |

Heartbeats run Tier 1 only. Cron jobs respect per-job tier settings in `CRON.md`.
Secrets never reach the Claude subprocess — `SAFE_ENV` filters credentials from `process.env`, and `.env` is parsed locally without polluting the environment.

### Memory architecture

```
User message
    │
    ▼
┌──────────────┐     ┌────────────────────┐
│ FTS5 search  │────▶│ Context injection   │──▶ System prompt
│ + recency    │     │ (top 3 + recent 5)  │
└──────────────┘     └────────────────────┘
    │
    │ salience boost on retrieval
    ▼
┌──────────────┐     ┌────────────────────┐
│ Assistant     │────▶│ Auto-memory pass   │──▶ Vault writes
│ responds     │     │ (background Haiku)  │    (MEMORY.md, people, tasks)
└──────────────┘     └────────────────────┘
    │
    ▼
┌──────────────┐
│ Session       │──▶ Episodic chunk indexed
│ summarization │    (sector='episodic')
└──────────────┘
    │
    ▼
┌──────────────┐
│ Startup       │──▶ Temporal decay + pruning
│ maintenance   │    (stale memories sink, old data trimmed)
└──────────────┘
```

- **FTS5** — Full-text search with BM25 ranking, zero-cost, zero-latency
- **Salience scoring** — Chunks gain score on retrieval, decay over time (30-day half-life)
- **Episodic memory** — Session summaries indexed as searchable chunks
- **Wikilink graph** — `[[wikilinks]]` parsed and queryable for connection discovery
- **Temporal decay** — Applied on every startup; stale memories naturally sink
- **Pruning** — Episodic chunks >90 days with salience <0.01 are removed; old transcripts and access logs trimmed

### MCP tools (27 total)

| Tool | Description |
|------|-------------|
| `memory_read` | Read vault notes (shortcuts: today, yesterday, memory, tasks, soul) |
| `memory_write` | Write/append to vault (daily log, MEMORY.md sections, arbitrary notes) |
| `memory_search` | FTS5 full-text search across all vault notes |
| `memory_recall` | Combined FTS5 + recency search with salience boost |
| `memory_connections` | Query the wikilink graph for a note |
| `memory_timeline` | Chronological view of vault changes by date range |
| `transcript_search` | Search past conversation transcripts |
| `note_create` | Create notes (person, project, topic, task, inbox) |
| `note_take` | Quick timestamped capture to daily log |
| `daily_note` | Create or read today's daily note |
| `task_list` | List tasks with status/project filters |
| `task_add` | Add tasks with priority, due dates, projects |
| `task_update` | Update task status (supports recurring tasks) |
| `vault_stats` | Dashboard of vault health and activity |
| `rss_fetch` | Fetch and parse RSS/Atom feeds |
| `github_prs` | Check GitHub PRs (review-requested + authored) |
| `browser_screenshot` | Take screenshots via Kernel cloud browser |
| `set_timer` | Set short-term reminders (notifies via active channels) |
| `outlook_inbox` | Read recent emails from Outlook inbox |
| `outlook_search` | Search Outlook emails by query |
| `outlook_calendar` | View upcoming calendar events |
| `outlook_draft` | Create an email draft in Outlook |
| `outlook_send` | Send an email from Outlook (Tier 3, requires approval) |
| `discord_channel_send` | Post messages to any Discord text channel by ID |
| `workspace_config` | Add, remove, or list workspace directories at runtime |
| `workspace_list` | Scan workspace directories for local project roots |
| `workspace_info` | Read a project's README, CLAUDE.md, manifest, and directory tree |

---

## CLI reference

```
clementine launch              Start as background daemon (default)
clementine launch -f           Start in foreground (debug mode)
clementine launch --install    Install as macOS login service (survives reboots)
clementine stop                Stop the daemon
clementine restart             Stop + relaunch
clementine status              Show PID, uptime, active channels
clementine update              Pull latest, rebuild, reinstall (preserves config)
clementine update --dry-run    Preview update without making changes
clementine doctor              Verify configuration and vault health
clementine config setup        Interactive configuration wizard
clementine config set KEY VAL  Set a single config value
clementine config get KEY      Read a config value
clementine cron list           List all cron jobs and last run status
clementine cron run <job>      Run a specific cron job
clementine cron run-due        Run all due jobs (for OS scheduler)
clementine cron runs [job]     View run history (with retry/error details)
clementine cron install        Install OS-level scheduler (launchd/crontab)
clementine cron uninstall      Remove OS-level scheduler
clementine heartbeat           Run a one-shot heartbeat check
clementine --help              Show all commands
```

### Daemon behavior

- **Default mode** — `clementine launch` daemonizes (detached, returns to shell)
- **Logs** — `~/.clementine/logs/clementine.log` (pino JSON lines, appended)
- **PID lock** — `~/.clementine/.clementine.pid` prevents duplicate instances
- **LaunchAgent** — `--install` creates a macOS plist with `KeepAlive` + `ThrottleInterval`
- **Graceful shutdown** — Handles SIGTERM/SIGINT, cleans up PID file, checkpoints SQLite WAL

---

## Configuration

The setup wizard (`clementine config setup`) writes `~/.clementine/.env`:

```bash
# Assistant Identity
ASSISTANT_NAME=Clementine
ASSISTANT_NICKNAME=Clemmy
OWNER_NAME=Nathan

# Model (haiku / sonnet / opus)
DEFAULT_MODEL_TIER=sonnet

# Channels — configure one or more
DISCORD_TOKEN=...
DISCORD_OWNER_ID=...
DISCORD_WATCHED_CHANNELS=...   # optional, comma-separated channel IDs
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
TELEGRAM_BOT_TOKEN=...
TWILIO_ACCOUNT_SID=...

# Voice (optional)
GROQ_API_KEY=...           # Whisper STT
ELEVENLABS_API_KEY=...     # TTS

# Video analysis (optional)
GOOGLE_API_KEY=...         # Gemini

# Workspace (optional)
WORKSPACE_DIRS=~/projects,~/work

# Security
ALLOW_ALL_USERS=false      # true = skip owner checks
```

Secrets can also be stored in macOS Keychain (`security find-generic-password`) — Clementine checks Keychain as a fallback for any missing `.env` value.

---

## Models

| Tier | Model | Use case |
|------|-------|----------|
| `haiku` | `claude-haiku-4-5-20251001` | Auto-memory extraction (background, fast, cheap) |
| `sonnet` | `claude-sonnet-4-6` | Default conversation model (1M context) |
| `opus` | `claude-opus-4-6` | Available via config or agent profiles |

Change the default with `clementine config set DEFAULT_MODEL_TIER opus`, then `clementine restart`.

---

## Channels

Enable channels by providing their tokens in `.env`. Clementine auto-detects which channels to start based on available credentials.

| Channel | Requires | Notes |
|---------|----------|-------|
| **Discord** | `DISCORD_TOKEN` + `DISCORD_OWNER_ID` | DMs + optional guild channels |
| **Slack** | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Socket Mode (no public URL needed) |
| **Telegram** | `TELEGRAM_BOT_TOKEN` | Long polling, owner-only by default |
| **WhatsApp** | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `WHATSAPP_OWNER_PHONE` | Twilio bridge, requires webhook URL |
| **Webhook** | `WEBHOOK_ENABLED=true` + `WEBHOOK_SECRET` | HTTP API for custom integrations |

#### Discord guild channels

By default, Discord is DM-only. To let Clementine listen and respond in server text channels, set `DISCORD_WATCHED_CHANNELS` to a comma-separated list of channel IDs:

```bash
DISCORD_WATCHED_CHANNELS=1234567890,9876543210
```

Each watched channel gets its own session (separate from DM conversations). Replying to a bot message in a watched channel automatically includes the referenced message as context. Bot commands (`!clear`, `!model`, etc.) only work in DMs.

The `discord_channel_send` tool lets Clementine post to any channel by ID, useful for cron jobs that send digests or alerts to specific channels.

---

## Workspace discovery

Clementine can discover and work with your local projects. Point her at parent directories that contain project folders:

```bash
WORKSPACE_DIRS=~/projects,~/work
```

Or let her manage it at runtime — just say "add ~/projects to my workspace" and she'll use the `workspace_config` tool to update the config without a restart.

Three tools power this:

- **`workspace_config`** — Add, remove, or list workspace directories. Writes directly to `.env` and takes effect immediately (no restart needed).
- **`workspace_list`** — Scans configured directories for project roots by detecting markers (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). Returns name, type, path, description, and whether the project has a `CLAUDE.md`.
- **`workspace_info`** — Deep-reads a project: `README.md`, `.claude/CLAUDE.md`, `package.json`/`pyproject.toml`, and a directory tree (depth 2).

Clementine can then use her built-in file tools (`Read`, `Glob`, `Grep`, `Edit`, `Bash`) to work directly in any discovered project.

---

## Vault

The vault is an Obsidian-compatible folder of Markdown files with YAML frontmatter, `[[wikilinks]]`, and `#tags`. Open `~/.clementine/vault/` in Obsidian to browse your assistant's memory visually.

Key system files:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality and behavioral instructions |
| `MEMORY.md` | Auto-extracted facts, preferences, people context |
| `HEARTBEAT.md` | Autonomous check-in configuration |
| `CRON.md` | Scheduled task definitions (cron syntax) |
| `TASKS.md` | Master task list with `{T-NNN}` IDs |

---

## Requirements

- **Node.js 20+** (for `--import` loader and `cpSync`)
- **macOS** (Keychain integration, LaunchAgent, iMessage — works on Linux without these)
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **Anthropic API key** (set in `.env` or Keychain)

---

## Development

```bash
# Run from source (foreground, hot reload)
npm run dev

# Type check without emitting
npm run typecheck

# Build
npm run build

# Run MCP server standalone (for testing tools)
npm run mcp
```

---

## License

MIT
