```
 ██████╗██╗     ███████╗███╗   ███╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗
██╔════╝██║     ██╔════╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝
██║     ██║     █████╗  ██╔████╔██║█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗
██║     ██║     ██╔══╝  ██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝
╚██████╗███████╗███████╗██║ ╚═╝ ██║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗
 ╚═════╝╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝
```

A persistent, ever-learning personal AI assistant that runs as a background daemon on macOS and Linux.
Built on the [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code-sdk), Obsidian-compatible vault, and SQLite FTS5.

Connects to Discord, Slack, Telegram, WhatsApp, and webhooks. Remembers everything. Runs 24/7.

**Requirements:** Node.js 20+ (22 recommended) · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) authenticated · macOS or Linux.

**Contents:** [How it works](#how-it-works) · [Install](#install-recommended) · [Architecture](#architecture) · [CLI](#cli-reference) · [Configuration](#configuration) · [Channels](#channels) · [Agents & Teams](#agents--teams) · [Cron](#scheduled-tasks--cron-jobs) · [Unleashed mode](#unleashed-mode) · [Self-improvement](#self-improvement) · [Vault](#vault) · [Development](#development) · [Troubleshooting](#troubleshooting)

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
                    │  Cron Scheduler · Unleashed Engine       │
                    │  Notification Dispatch                   │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │            Agent Layer                   │
                    │  Claude Code SDK · Security Hooks        │
                    │  Auto-Memory · Session Rotation          │
                    │  Agent Profiles · Sub-Agent Teams        │
                    │  Self-Improvement Loop                   │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │          MCP Tool Server                 │
                    │  30+ tools over stdio transport          │
                    │  Memory · Tasks · Vault · Workspace      │
                    └────────────────┬────────────────────────┘
                                     │
              ┌──────────────────────▼──────────────────────┐
              │              Memory Store                    │
              │  SQLite FTS5 · Salience Scoring · Decay     │
              │  Episodic Memory · Wikilink Graph            │
              │  FalkorDB Knowledge Graph · Procedural Skills│
              │  Obsidian Vault (source of truth)            │
              └─────────────────────────────────────────────┘
```

### The memory loop

Every conversation triggers a background extraction pass (Sonnet) that saves facts, preferences, people, and tasks to the Obsidian vault. The vault is indexed into SQLite FTS5 with automatic triggers. Retrieved memories get salience boosts. Stale memories decay over time. Old data is pruned on startup.

The result: Clementine gets better the more you talk to it.

---

## Install (recommended)

Runtime: **Node.js 22 (recommended) or Node.js 20+**.

```bash
npm install -g clementine-agent@latest
clementine setup
```

After setup:

```bash
clementine launch         # start as background daemon
clementine status         # verify it's running
clementine dashboard      # open the web command center
```

Already installed? Update in place with `clementine update`.

### Troubleshooting

**`EACCES: permission denied` on `npm install -g`.** Your Node was installed system-wide (`/usr/local/lib/...`) and npm can't write there without sudo. Fix it once, permanently:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc && source ~/.zshrc
npm install -g clementine-agent@latest
```

Or install Node via [nvm](https://github.com/nvm-sh/nvm) — user-scoped by default, no permission issues ever.

**`clementine: command not found` after install succeeded.** Run `npm config get prefix` — its `/bin` directory needs to be on your `PATH`. Add `export PATH="$(npm config get prefix)/bin:$PATH"` to your shell profile.

**Node version too old.** Install via nvm:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22
```

### Install from source (for development)

```bash
git clone https://github.com/Natebreynolds/Clementine-AI-Assistant.git clementine
cd clementine
bash install.sh
```

Handles system dependencies (redis, libomp, build tools), npm packages, TypeScript build, global CLI install, and launches the setup wizard. Safe to re-run.

---

## Architecture

### File layout

```
~/.clementine/                     ← Data home (created on first run)
├── .env                           ← Configuration (created by setup wizard)
├── .sessions.json                 ← Session persistence
├── .memory.db                     ← (legacy, unused — real DB is vault/.memory.db)
├── .clementine.pid                ← Daemon PID lock
├── logs/
│   ├── clementine.log             ← Daemon stdout/stderr
│   └── audit.log                  ← Security audit trail
├── cron/runs/                     ← Per-job JSONL run logs
├── unleashed/                     ← Unleashed task progress & checkpoints
│   └── <task>/
│       ├── status.json            ← Current status, phase, timing
│       └── progress.jsonl         ← Phase-by-phase event log
├── self-improve/                  ← Self-improvement state
│   ├── experiment-log.jsonl       ← Append-only experiment history
│   ├── state.json                 ← Loop status, baseline metrics
│   └── pending-changes/           ← Proposed diffs awaiting approval
│       └── {experiment-id}.json
└── vault/                         ← Obsidian-compatible vault
    ├── 00-System/                 ← SOUL.md, MEMORY.md, HEARTBEAT.md, CRON.md
    │   └── skills/                ← Procedural memory (auto-extracted from successful tasks)
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
│   ├── profiles.ts                ← Agent profile switching
│   └── self-improve.ts            ← Nightly self-improvement loop engine
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
│   ├── store.ts                   ← SQLite FTS5 memory store + embedding backfill
│   ├── embeddings.ts              ← TF-IDF embedding provider (local, 512-dim vectors)
│   ├── search.ts                  ← Temporal decay, dedup, formatting
│   ├── chunker.ts                 ← Vault file parser (## headers, frontmatter)
│   ├── mmr.ts                     ← Maximal Marginal Relevance reranker
│   ├── consolidation.ts           ← Evening consolidation engine (dedup, summarize, extract)
│   ├── context-assembler.ts       ← Token-budgeted context slot filler
│   └── graph-store.ts             ← FalkorDB knowledge graph layer (optional)
├── tools/                         ← MCP stdio server (30+ tools, decomposed by domain)
│   ├── mcp-server.ts             ← Server entry + registration
│   ├── goal-tools.ts             ← Goal lifecycle tools
│   ├── vault-tools.ts            ← Vault read/write/search tools
│   ├── team-tools.ts             ← Team agent tools
│   ├── session-tools.ts          ← Session management tools
│   └── admin-tools.ts            ← System admin tools
├── cli/
│   ├── index.ts                   ← CLI commands (launch, stop, status, config, doctor)
│   ├── setup.ts                   ← Interactive configuration wizard
│   ├── dashboard.ts               ← Local web dashboard (command center)
│   └── cron.ts                    ← Cron job runner and scheduler
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

Heartbeats run Tier 1 only. Cron jobs respect per-job tier settings in `CRON.md`. Unleashed tasks inherit their job's tier.
All autonomous tasks (cron jobs, heartbeats, unleashed) can spawn sub-agents for parallel work — sub-agents inherit the parent's tier constraints.
Secrets never reach the Claude subprocess — `SAFE_ENV` filters credentials from `process.env`, and `.env` is parsed locally without polluting the environment.

### Memory architecture

Three-layer retrieval merges full-text, vector, and recency signals into a single ranked context window:

```
User message
    │
    ├──▶ Layer 1: FTS5 (BM25 relevance)
    ├──▶ Layer 2: TF-IDF vector similarity (cosine, threshold 0.15)
    ├──▶ Layer 3: Recent chunks (time-windowed)
    │
    ▼
┌──────────────────┐     ┌────────────────────┐
│ MMR rerank       │────▶│ Context assembly    │──▶ System prompt
│ + deduplication  │     │ (token-budgeted)    │
└──────────────────┘     └────────────────────┘
    │
    │ salience boost on retrieval
    ▼
┌──────────────┐     ┌────────────────────┐
│ Assistant     │────▶│ Auto-memory pass   │──▶ Vault writes
│ responds     │     │ (background Sonnet) │    (MEMORY.md, people, tasks)
└──────────────┘     └────────────────────┘
    │
    ▼
┌──────────────┐
│ Session       │──▶ Episodic chunk indexed
│ summarization │    (sector='episodic')
└──────────────┘
    │
    ▼
┌──────────────────────┐
│ Evening consolidation │──▶ Dedup (Jaccard) + topic summarization (LLM)
│ + embedding rebuild   │    + principle extraction + TF-IDF vocab rebuild
└──────────────────────┘
    │
    ▼
┌──────────────┐
│ Startup       │──▶ Temporal decay + pruning
│ maintenance   │    (stale memories sink, old data trimmed)
└──────────────┘
```

- **FTS5** — Full-text search with BM25 ranking, zero-cost, zero-latency
- **TF-IDF embeddings** — Local 512-dim vectors (no API calls), vocabulary rebuilt during sync and evening consolidation, cosine similarity search over recent chunks
- **MMR reranking** — Maximal Marginal Relevance via Jaccard similarity removes near-duplicates and promotes diversity in results
- **Salience scoring** — Chunks gain score on retrieval, decay over time (7-day half-life). Formula: `log(access_count + 1) * 0.15 + recency_decay * 0.3`
- **Episodic memory** — Session summaries indexed as searchable chunks
- **Wikilink graph** — `[[wikilinks]]` parsed and queryable for connection discovery
- **Knowledge graph** — FalkorDB-powered typed relationships and multi-hop traversal (people → projects → topics). Visualized on a dark canvas in the dashboard with type legend and edge labels.
- **Procedural skills** — Reusable how-to recipes auto-extracted from successful task executions. Stored as Markdown in `vault/00-System/skills/` and injected into cron jobs and unleashed tasks at runtime. Teach new skills manually via the dashboard Skills tab or let Clementine learn them from conversations.
- **Evening consolidation** — Nightly pass: deduplicates chunks by Jaccard similarity (>70%), summarizes topic groups via LLM (Haiku), extracts recurring behavioral corrections into permanent rules, and rebuilds TF-IDF vocabulary + backfills embeddings
- **Agent isolation** — Per-agent memory scoping via `agent_slug` column. Soft mode (default) boosts matching agent chunks 1.4x; strict mode filters to agent + global only
- **Memory transparency** — Every memory write is logged to `memory_extractions` with user correction/dismissal support from the dashboard
- **Temporal decay** — Applied on every startup; stale memories naturally sink
- **Pruning** — Episodic chunks >90 days with salience <0.01 are removed; old transcripts, access logs, and orphaned references trimmed

### MCP tools (30+)

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
| `add_cron_job` | Create scheduled tasks (supports standard and unleashed mode, project context) |
| `self_restart` | Restart the daemon (for self-updates and config changes) |
| `analyze_image` | Analyze images with vision capabilities |
| `memory_report` | Generate a transparency report of all memory extractions |
| `memory_correct` | Correct or dismiss a previously extracted memory |
| `feedback_log` | Log user feedback on responses |
| `feedback_report` | View feedback history and patterns |
| `team_list` | List all team agents with status, channel, and capabilities |
| `team_message` | Send a message to another agent (permission-scoped, synchronous) |
| `create_agent` | Create a new agent with name, role, tools, project, and team connections |
| `self_improve_status` | Check self-improvement state, pending approvals, experiment history |
| `self_improve_run` | Trigger a self-improvement analysis cycle |

---

## CLI reference

```
clementine launch              Start as background daemon (default)
clementine launch -f           Start in foreground (debug mode)
clementine launch --install    Install as macOS login service (survives reboots)
clementine stop                Stop the daemon
clementine restart             Stop + relaunch
clementine rebuild             Build + restart daemon + dashboard in one step
clementine status              Show PID, uptime, active channels
clementine update              Pull latest, rebuild, reinstall (preserves config)
clementine update --dry-run    Preview update without making changes
clementine doctor              Verify configuration and vault health
clementine doctor --fix        Auto-fix common issues (redis, sqlite, FalkorDB)
clementine dashboard           Open the local web command center (localhost:3030)
clementine tools               List available MCP tools, plugins, and channels
clementine config setup        Interactive configuration wizard
clementine config set KEY VAL  Set a single config value
clementine config get KEY      Read a config value
clementine config edit         Open .env in your editor ($EDITOR)
clementine memory search <q>   Search memory from the terminal (FTS5)
clementine projects list       Show all linked projects
clementine projects add <path> Link a project directory (-d desc, -k keywords)
clementine projects remove <p> Unlink a project directory
clementine cron list           List all cron jobs and last run status
clementine cron run <job>      Run a specific cron job
clementine cron run-due        Run all due jobs (for OS scheduler)
clementine cron runs [job]     View run history (with retry/error details)
clementine cron install        Install OS-level scheduler (launchd/crontab)
clementine cron uninstall      Remove OS-level scheduler
clementine heartbeat           Run a one-shot heartbeat check
clementine self-improve status Show self-improvement state and baseline metrics
clementine self-improve run    Trigger a self-improvement cycle
clementine self-improve history Show experiment history
clementine self-improve apply <id>  Approve and apply a pending change
clementine --help              Show all commands
```

### Daemon behavior

- **Default mode** — `clementine launch` daemonizes (detached, returns to shell)
- **Logs** — `~/.clementine/logs/clementine.log` (pino JSON lines, appended)
- **PID lock** — `~/.clementine/.clementine.pid` prevents duplicate instances
- **LaunchAgent** — `--install` creates a macOS plist with `KeepAlive` + `ThrottleInterval`
- **Graceful shutdown** — Handles SIGTERM/SIGINT, cleans up PID file, checkpoints SQLite WAL

### Dashboard

Run `clementine dashboard` to open a local web command center at `http://localhost:3030`. The dashboard provides:

- **Metrics** — Time saved estimates, session counts, cron job stats, memory size
- **Chat** — Talk to your assistant directly from the browser
- **Memory search** — Full-text search across all vault notes (FTS5)
- **Scheduled tasks** — Create, edit, run, toggle, and delete cron jobs with a visual schedule builder
- **Project-aware cron** — Assign cron jobs to specific project directories
- **Unleashed mode** — Create long-running autonomous tasks, monitor phase progress, cancel running tasks
- **Projects** — Browse all discovered workspace projects with type, description, and tool badges
- **Live status** — Daemon health, LaunchAgent status, active channels
- **Sessions** — View and manage active conversation sessions
- **The Office** — Visual agent management with desk-station cards showing status, avatars, channels, and tools
- **Hiring Interview** — Click "Hire a New Employee" and Clementine interviews you to build the agent config conversationally
- **Manual Agent Setup** — Form modal with project dropdown (auto-populated from discovered projects) and categorized tool browser with checkboxes
- **Auto-restart** — Daemon restarts automatically when the agent roster changes (from either the interview or manual path)
- **Training Center** — Click any agent to open a 4-tab detail view: Schedule (per-agent cron jobs), Skills (per-agent procedural memory), Execution Traces (tool call history with timing), and Prompt Lab (test prompts against the agent)
- **Skills** — Teach, view, and delete procedural skills. Skills are auto-extracted from successful tasks or taught manually via the dashboard.
- **Self-Improvement** — View experiment history, approve/deny pending proposals, monitor baseline metrics
- **Settings** — API key management, model config, custom env vars, service status

No extra dependencies — the dashboard uses Express, which is already installed.

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

# Beta Features
ENABLE_1M_CONTEXT=false    # Enable 1M token context for Sonnet (toggle in dashboard)
```

Secrets can also be stored in macOS Keychain (`security find-generic-password`) — Clementine checks Keychain as a fallback for any missing `.env` value.

### Tuning Clementine

Clementine ships with sensible defaults. To change anything, use:

```bash
clementine config set <KEY> <value>   # writes to ~/.clementine/.env
clementine config get <KEY>
clementine config list                # show all overrides
clementine restart                    # apply changes
```

Your overrides live in `~/.clementine/.env` — **they survive every `npm update -g` / `clementine update`** because they're in your data home, not the package directory.

**Commonly tuned knobs:**

| Key | Default | What it does |
|-----|---------|--------------|
| `BUDGET_CHAT_USD` | `5.00` | Max spend per interactive chat message |
| `BUDGET_CRON_T1_USD` | `2.00` | Max spend per tier-1 cron job |
| `BUDGET_CRON_T2_USD` | `5.00` | Max spend per tier-2 cron job |
| `BUDGET_HEARTBEAT_USD` | `0.50` | Max spend per heartbeat tick |
| `DEFAULT_MODEL_TIER` | `sonnet` | Default model: `haiku` / `sonnet` / `opus` |
| `ENABLE_1M_CONTEXT` | `false` | Enable Sonnet 1M-token context (beta) |
| `HEARTBEAT_INTERVAL_MINUTES` | `30` | How often the agent auto-checks in |
| `HEARTBEAT_ACTIVE_START` | `8` | First hour of the active window (0–23) |
| `HEARTBEAT_ACTIVE_END` | `22` | Last hour of the active window |
| `TIMEZONE` | system TZ | IANA timezone string (e.g., `America/Los_Angeles`) |
| `ALLOW_ALL_USERS` | `false` | `true` = skip owner-only gate (trust all DMs) |
| `ASSISTANT_NAME` | `Clementine` | Display name across channels |

Example — raise the chat budget to `$10` without ever touching source:

```bash
clementine config set BUDGET_CHAT_USD 10
clementine restart
```

---

## Models

| Tier | Model Alias | Use case |
|------|-------------|----------|
| `haiku` | `haiku` (latest Haiku) | Lightweight tasks, cron noise filtering |
| `sonnet` | `sonnet` (latest Sonnet) | Default conversation + auto-memory extraction |
| `opus` | `opus` (latest Opus) | Available via config or agent profiles |

Model aliases always resolve to the latest version via the Claude Code SDK. To pin a specific version, set `DEFAULT_MODEL_TIER` to a full model name (e.g. `claude-sonnet-4-6`).

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

Clementine automatically discovers local projects with zero configuration. On every scan, she checks common developer directories in your home folder:

> `Desktop`, `Documents`, `Developer`, `Projects`, `repos`, `src`, `code`, `work`, `dev`, `github`, `gitlab`

Any that exist are scanned for project roots (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.).

For non-standard locations, add them via `WORKSPACE_DIRS` in `.env`:

```bash
WORKSPACE_DIRS=~/company/repos,/opt/projects
```

Or just tell Clementine at runtime — "add ~/company/repos to my workspace" — and she'll update the config immediately (no restart needed).

Three tools power this:

- **`workspace_config`** — Add, remove, or list workspace directories. Lists show which are auto-detected vs. explicitly configured. Changes take effect immediately.
- **`workspace_list`** — Scans all workspace directories for project roots. Returns name, type, path, description, and whether the project has a `CLAUDE.md`.
- **`workspace_info`** — Deep-reads a project: `README.md`, `.claude/CLAUDE.md`, `package.json`/`pyproject.toml`, and a directory tree (depth 2).

Clementine can then use her built-in file tools (`Read`, `Glob`, `Grep`, `Edit`, `Bash`) to work directly in any discovered project.

---

## Agents & Teams

Clementine supports multi-agent teams — each agent gets its own Discord bot, channel, project binding, tool allowlist, and personality. Agents can message each other via `team_message` with permission-scoped routing.

### Creating agents

Two paths to create a new agent:

| Method | How |
|--------|-----|
| **Hiring interview** | Click "Hire a New Employee" in the dashboard (or an empty desk card). Clementine asks 3–5 questions about the agent's name, role, tools, project, and team connections, then calls `create_agent` automatically. |
| **Manual setup** | Click "Manual Setup" to open a form with project dropdown, categorized tool browser, model selector, and team connection fields. |

Both paths trigger an automatic daemon restart when the new agent is detected.

### Agent configuration

Each agent is defined by a YAML frontmatter file in `~/.clementine/vault/00-System/agents/<slug>/agent.md`:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `description` | Role description shown on desk card |
| `personality` | System prompt defining expertise and communication style |
| `channelName` | Discord channel the agent monitors |
| `model` | Model tier (haiku, sonnet, opus) |
| `project` | Bound project directory for workspace context |
| `tier` | Security tier (1 = read-only, 2 = read/write) |
| `allowedTools` | Tool allowlist (blank = all available) |
| `canMessage` | List of agent slugs this agent can message |
| `discordToken` | Dedicated Discord bot token for independent presence |

### Inter-agent communication

Agents communicate via the `team_message` tool. Messages are permission-scoped — an agent can only message slugs listed in its `canMessage` field. The primary agent can message anyone.

Messages are delivered synchronously: the sender waits for the recipient's response. Conversation depth is tracked to prevent infinite loops.

### The Office (dashboard)

The dashboard's "The Office" page shows each agent as an animated desk station with:
- Live status indicator (online / connecting / error / offline)
- Discord bot avatar (auto-pulled) or initial
- Channel assignment, model badge, project badge, tool count
- Edit and "Let Go" (delete) actions

### Decision-loop reflection

Each agent's autonomous decisions are recorded to a proactive ledger (action chosen, signal source, eventual outcome). The `decision_reflection` MCP tool reads that ledger, computes per-action success rates, and surfaces calibration patterns:

- "act_now success rate is 33% — many autonomous actions did not advance"
- "Queue-heavy bias: 12 queued vs 2 act_now — engine is being conservative"
- "Zero ask_user despite active autonomous work"
- Plus concrete tuning suggestions

By default the report is saved to `vault/00-System/agents/<slug>/reflections/<date>.md`. Pass `append_to_memory: true` to also write a compact summary into the agent's `working-memory.md` so the next heartbeat tick reads it as prompt context — that's how agents self-tune without code changes.

The shipped `vault/00-System/CRON.md` template includes a `weekly-decision-reflection` job (Sundays 9am) that runs reflection for the daemon and every active specialist.

### Per-agent heartbeats

Each specialist (Ross / Sasha / your hires) gets their own autonomous heartbeat scheduler alongside Clementine's. The cycle:

1. **Cheap tick** every 30 min: load the agent's state, hash three signals (pending delegated tasks, latest goal update, latest cron run). If unchanged → silent tick, no LLM call, no cost.
2. **LLM tick** when a signal *changes* between ticks (a delegated task arrived, a goal moved, a cron deliverable to review): the scheduler invokes `assistant.heartbeat()` with the agent's profile. Output flows through their dedicated Discord bot to their channel.
3. **Self-adjusting cadence**: agents end their LLM-tick output with `[NEXT_CHECK: Xm]` to set when to check in next (5–720 min). Clamped at the bounds. Default 30m if omitted.

State per agent at `~/.clementine/heartbeat/agents/<slug>/state.json`. Live observability via:

```bash
curl -H "X-Token: $(cat ~/.clementine/.dashboard-token)" \
     http://localhost:3030/api/agent-heartbeats | jq
```

Routing rules — Clementine remains the master delegator:
- Inbox triage runs as Clementine, but she'll hand off via `team_message` when an item clearly belongs to a specialist (she's allowed to guess).
- Daily-plan goal-priorities owned by a specialist now fire goal-triggers (which run as the owner) instead of queueing as Clementine's work.
- Goal advancement triggers route to `goal.owner` automatically.

---

## Scheduled tasks & cron jobs

Define scheduled tasks in `vault/00-System/CRON.md` using YAML frontmatter, or create them from the dashboard or any chat channel.

```yaml
---
jobs:
  - name: Morning Digest
    schedule: "0 9 * * 1-5"
    prompt: "Check my inbox, calendar, and overdue tasks. Send a morning summary."
    tier: 2
    enabled: true

  - name: Codebase Audit
    schedule: "0 2 * * 0"
    prompt: "Audit the main repo for dead code, missing tests, and security issues."
    tier: 2
    work_dir: ~/projects/my-app
    mode: unleashed
    max_hours: 4
---
```

All cron jobs have **sub-agent support** — they can use the Agent and Task tools to spawn parallel workers, delegate sub-tasks, and coordinate multi-step workflows.

### Project-aware cron jobs

Set `work_dir` on any job to run it inside a specific project directory. The agent gets access to that project's `CLAUDE.md`, MCP servers, tools, and file tree — exactly like running Claude Code inside the project locally.

### Visual schedule builder

The dashboard provides a visual schedule builder with dropdowns for frequency (daily, weekdays, weekly, every N hours/minutes), day picker, and time picker — no cron syntax required. Advanced users can still enter raw cron expressions.

---

## Unleashed mode

For tasks that take hours — codebase refactors, research projects, content generation pipelines — unleashed mode runs autonomously with phased execution and checkpointing.

```
Phase 1 (75 turns) ──▶ Checkpoint ──▶ Phase 2 (75 turns) ──▶ Checkpoint ──▶ ...
     │                      │                │                      │
     └─ Session resume ─────┘                └─ Session resume ─────┘
```

### How it works

1. The task runs in phases (default 75 turns per phase)
2. Between phases, the SDK session is **resumed** — the agent keeps its full conversation history
3. Progress is saved to `~/.clementine/unleashed/<task>/` (JSONL log + status file)
4. The agent can spawn sub-agents for parallel work streams
5. Cancel anytime via the dashboard or by touching a `CANCEL` file

### Safety guardrails

| Guard | Behavior |
|-------|----------|
| **Max hours** | Configurable deadline (default 6h, up to 24h) |
| **Max phases** | Hard cap at 50 phases |
| **Consecutive errors** | Aborts after 3 consecutive phase failures |
| **Concurrency** | Same job can't run twice simultaneously |
| **Cancellation** | Checked between every phase |
| **Error recovery** | Failed phases reset the session and re-inject the original task |

### Smart auto-escalation

When you ask Clementine something complex in chat, she automatically assesses the scope:

1. **Quick tasks** — handled inline within the normal chat turn budget
2. **Complex tasks** — auto-escalated to deep mode (100 turns) with progress check-ins every 2 minutes
3. **Multi-hour tasks** — escalated to unleashed mode with phased execution and checkpointing

You can also trigger deep mode explicitly with `!deep <task>` in Discord or by prefixing any message with "deep:".

### Triggering unleashed tasks

| Method | How |
|--------|-----|
| **Dashboard** | Create a cron job with mode "Unleashed", set max hours, click Run |
| **Discord** | `!cron run <task>` — fires in background, sends completion notification |
| **CLI** | `clementine cron run <task>` — runs in foreground (for manual runs) |
| **Cron schedule** | Set `mode: unleashed` in CRON.md — fires on schedule automatically |
| **Chat** | Ask Clementine to create an unleashed task — she'll use the `add_cron_job` tool |
| **Auto-escalation** | Chat automatically escalates to deep/unleashed when max turns are hit |

### Monitoring

The dashboard shows a live **Unleashed Tasks** panel below scheduled tasks with:
- Current phase number and elapsed time
- Status badges (running / completed / cancelled / timeout / error)
- Output preview from the last completed phase
- Cancel button for running tasks

Progress is also logged to `~/.clementine/unleashed/<task>/progress.jsonl` for debugging.

---

## Self-improvement

Clementine can autonomously improve herself using an iterative loop inspired by Karpathy's autoresearch pattern: **gather data, diagnose weaknesses, hypothesize a fix, evaluate the fix, and propose the change for approval**.

```
  ┌──────────┐    ┌──────────┐    ┌─────────────┐    ┌──────────┐    ┌──────────┐
  │  Gather  │───▶│ Diagnose │───▶│ Hypothesize │───▶│ Evaluate │───▶│   Gate   │
  │ feedback │    │ weakness │    │  a change   │    │ LLM judge│    │ approve? │
  │ cron logs│    │ patterns │    │  (minimal)  │    │  0-10    │    │          │
  └──────────┘    └──────────┘    └─────────────┘    └──────────┘    └──────────┘
       │                                                                   │
       │              ┌──────────────────────────────────────┐             │
       └──────────────│  Repeat until plateau or time limit  │◀────────────┘
                      └──────────────────────────────────────┘
```

### What it targets

| Area | Target file | Examples |
|------|-------------|---------|
| **Soul** | `SOUL.md` | Personality tweaks, tone adjustments, new behavioral instructions |
| **Cron** | `CRON.md` | Prompt improvements for scheduled tasks, missing instructions |
| **Workflows** | `workflows/*.md` | Step refinements, better prompts, missing error handling |
| **Memory** | Configuration | Retrieval tuning, salience thresholds |
| **Agents** | `agents/<slug>/agent.md` | Agent personality refinements, tool allowlist tuning, role clarification |

### How it works

1. **Gathers** recent feedback (positive/negative reactions), cron job success/error rates, and transcript patterns from the last 7 days
2. **Diagnoses** the single highest-impact weakness using an LLM analysis pass
3. **Proposes** a specific, minimal change — informed by experiment history to avoid repeating failed approaches
4. **Evaluates** the proposal with an LLM judge scoring clarity, safety, impact, risk, and minimality (0-10)
5. **Gates** proposals that score above the threshold (default 6/10) — saves to pending and sends a Discord approval embed with Approve/Deny buttons
6. **Logs** every experiment to an append-only JSONL file for full history
7. **Stops** on plateau detection (3 consecutive low scores), time limits (1 hour max), or iteration caps (10 per cycle)

After the loop completes, memory maintenance runs automatically (temporal decay + stale data pruning).

### Safety guardrails

- **Nothing is applied without approval** — every change requires explicit Approve via Discord buttons, CLI, or dashboard
- **Changes are reversible** — the original file content is saved alongside each proposal
- **LLM judge evaluation** — proposals must pass a multi-criteria quality check before even being submitted for approval
- **Experiment history prevents loops** — the LLM sees all prior attempts and avoids repeating failed strategies
- **Plateau detection** — the loop stops automatically when consecutive iterations yield no improvements
- **Own concurrency lane** — runs independently without blocking cron jobs or chat

### Triggering

| Method | How |
|--------|-----|
| **Nightly cron** | Add `nightly-self-improve` job to `CRON.md` with schedule `0 2 * * *` |
| **Discord** | `!self-improve run` or `/self-improve run` |
| **CLI** | `clementine self-improve run` |
| **Dashboard** | View status and manage proposals from the Self-Improve page |

### Discord commands

```
!self-improve run              Trigger a self-improvement cycle
!self-improve status           Show current state and baseline metrics
!self-improve history [n]      Show last N experiments (default 10)
!self-improve pending          List pending approval proposals
!self-improve apply <id>       Approve a pending change
!self-improve deny <id>        Deny a pending change
```

### Data storage

```
~/.clementine/self-improve/
├── experiment-log.jsonl       Append-only history of all experiments
├── state.json                 Current status, iteration count, baseline metrics
└── pending-changes/
    └── {8-char-hex}.json      Proposal with before/after content, score, hypothesis
```

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

## Troubleshooting

### `clementine update` fails with "local changes"

Clementine auto-stashes local customizations during updates. If you're on an older version that doesn't have this yet, run manually:

```bash
cd ~/clementine   # or wherever you cloned it
git stash
clementine update
git stash pop      # restore your customizations
```

Future updates will handle this automatically.

### `better-sqlite3` won't load (NODE_MODULE_VERSION mismatch)

This happens when you upgrade Node.js after installing. The native SQLite module needs to be recompiled:

```bash
cd ~/clementine
npm rebuild better-sqlite3
```

Run `clementine doctor` to verify the fix. This check is now built-in — doctor will catch it early.

### Memory search returns empty results

1. Run `clementine doctor` — check the `better-sqlite3` line
2. Verify the database exists: `ls ~/.clementine/vault/.memory.db`
3. If the DB is missing, restart the daemon — it creates the DB and indexes the vault on startup

### Daemon won't start / duplicate instances

```bash
clementine stop           # stop any running instance
rm ~/.clementine/.clementine.pid   # clear stale PID if needed
clementine launch
```

---

## License

MIT
