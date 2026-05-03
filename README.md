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

Clementine is four layers over a shared memory store:

```
  Channels   →   Gateway     →   Agent           →   MCP tools  →   Memory
  Discord        Router          Claude SDK          100+ tools     SQLite FTS5
  Slack          Sessions        Security hooks      stdio          + vectors
  Telegram       Heartbeats      Auto-memory                        Knowledge graph
  WhatsApp       Cron + queues   Sub-agents                         Obsidian vault
  Webhook        Delivery        Self-improve                       (source of truth)
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

### Install issues

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
├── .clementine.pid                ← Daemon PID lock
├── logs/                          ← Daemon log + security audit log
├── cron/runs/                     ← Per-job JSONL run logs
├── unleashed/<task>/              ← Long-running task progress + status
├── self-improve/                  ← Experiment log, state, pending proposals
├── heartbeat/agents/<slug>/       ← Per-agent heartbeat state
└── vault/                         ← Obsidian-compatible vault (see Vault section)
    └── .memory.db                 ← SQLite FTS5 + vector index

src/                               ← Package code (npm install location)
├── agent/                         ← The brain: assistant, hooks, agent manager,
│                                    proactive engine, self-improvement, advisor,
│                                    skill extraction, complexity classifier, …
├── channels/                      ← Discord, Slack, Telegram, WhatsApp, Webhook
│                                    (+ per-agent Discord/Slack bot managers)
├── gateway/                       ← Router, heartbeat schedulers, cron scheduler,
│                                    delivery queue, failure monitor
├── memory/                        ← SQLite FTS5 store, embeddings, MMR rerank,
│                                    chunker, consolidation, graph store
├── tools/                         ← MCP stdio server (100+ tools, by domain)
├── cli/                           ← CLI entry, setup wizard, dashboard, cron runner
├── brain/                         ← Ingestion pipeline + connectors
├── analytics/                     ← Tool-usage telemetry
├── security/, secrets/            ← Secret/credential helpers, hardening
├── vault-migrations/              ← Versioned vault upgrades
├── config.ts                      ← Paths, secrets, models (never leaks to env)
├── types.ts                       ← Shared TypeScript types
└── index.ts                       ← Multi-channel startup entry
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

Retrieval merges three signals (FTS5 BM25, TF-IDF cosine, recency), reranks with MMR for diversity, and fills a token-budgeted context window. After each turn, a background Sonnet pass extracts memories to the vault. Sessions get summarized into episodic chunks. A nightly consolidation pass dedups, summarizes, and rebuilds the embedding vocabulary. Startup applies temporal decay and prunes old data.

- **FTS5** — Full-text BM25 search, local, zero-cost
- **TF-IDF embeddings** — Local 512-dim vectors (no API calls), rebuilt nightly
- **MMR reranking** — Jaccard-based diversity, removes near-duplicates
- **Salience** — Boost on retrieval, 7-day half-life decay
- **Episodic memory** — Session summaries indexed as searchable chunks
- **Wikilink + knowledge graph** — `[[wikilinks]]` graph + optional FalkorDB typed relationships (visualized in dashboard)
- **Procedural skills** — Auto-extracted from successful tasks, stored at `vault/00-System/skills/`, injected into future runs
- **Evening consolidation** — Nightly: Jaccard dedup (>70%), topic summarization (Haiku), behavioral-rule extraction, vocabulary rebuild
- **Agent isolation** — Per-agent scoping via `agent_slug`; soft (1.4× boost) or strict modes
- **Transparency** — Every write logged to `memory_extractions`; correct/dismiss from dashboard
- **Pruning** — Episodic >90 days with salience <0.01 removed; old transcripts and access logs trimmed

### MCP tools (100+)

Tools are grouped by domain. Run `clementine tools` to see the live list.

| Group | Examples |
|-------|----------|
| **Memory** | `memory_read`, `memory_write`, `memory_search`, `memory_recall`, `memory_connections`, `memory_timeline`, `memory_consolidate`, `memory_correct`, `memory_report`, `memory_graph_*` |
| **Vault & notes** | `note_create`, `note_take`, `daily_note`, `task_list`, `task_add`, `task_update`, `vault_stats`, `transcript_search` |
| **Workspace** | `workspace_config`, `workspace_list`, `workspace_info` |
| **External** | `web_search`, `rss_fetch`, `github_prs`, `browser_screenshot`, `analyze_image`, `outlook_*`, `sf_*` (Salesforce), `discord_channel_*` |
| **Agents & teams** | `create_agent`, `update_agent`, `delete_agent`, `team_list`, `team_message`, `team_request`, `team_status`, `delegate_task`, `wake_agent` |
| **Goals & background** | `goal_create`, `goal_update`, `goal_work`, `start_background_task`, `get_background_task`, `discover_work` |
| **Cron & workflows** | `add_cron_job`, `cron_list`, `cron_run_history`, `trigger_cron_job`, `workflow_create`, `workflow_run`, `workflow_save`, `workflow_*` |
| **Self-improvement** | `self_improve_run`, `self_improve_status`, `self_edit_source`, `prompt_override_*`, `decision_reflection`, `feedback_log`, `feedback_report` |
| **System** | `self_restart`, `self_update`, `set_timer`, `env_set`, `allow_tool`, `setup_integration`, `auth_profile_status` |

---

## CLI reference

Run `clementine --help` to see everything; the most common commands:

**Daemon**
```
clementine launch [-f] [--install]   Start daemon (foreground / macOS login service)
clementine stop | restart | rebuild  Lifecycle controls
clementine status                    PID, uptime, active channels
clementine update [--dry-run]        Pull latest, rebuild, reinstall (preserves config)
clementine doctor [--fix]            Verify (and optionally repair) config and vault
clementine dashboard                 Open the web command center (localhost:3030)
clementine tools                     List available MCP tools, plugins, and channels
```

**Config & secrets**
```
clementine setup                     Interactive setup wizard
clementine config set KEY VAL        Write to ~/.clementine/.env
clementine config get KEY
clementine config list               Show all overrides
clementine config edit               Open .env in $EDITOR
clementine login | auth              Authenticate Claude Code / OAuth providers
```

**Chat & memory**
```
clementine chat                      Interactive REPL
clementine memory status             Index size, recent activity
clementine memory search <q>         FTS5 search
clementine memory dedup | reembed    Maintenance
clementine brain digest              Run the brain digest pipeline
```

**Projects & agents**
```
clementine projects list | add <p> | remove <p>
clementine agent list | new <slug> | show <slug>
clementine skills list | pending | approve <name> | reject <name> | search <q>
```

**Cron, workflows, heartbeat**
```
clementine cron list | run <job> | run-due | runs [job]
clementine cron add <name> <schedule> <prompt>
clementine cron install | uninstall  OS-level scheduler (launchd / crontab)
clementine workflow list | run <name>
clementine heartbeat                 One-shot heartbeat tick
```

**Self-improvement**
```
clementine self-improve status | run | history | pending | apply <id>
```

**Diagnostics**
```
clementine advisor | rules           Live advisor rules
clementine mode <mode>               Switch operating mode
clementine analytics | tool-usage    Telemetry on tool usage
clementine ingest seed <path> | run <slug> | list
```

### Daemon behavior

- **Default mode** — `clementine launch` daemonizes (detached, returns to shell)
- **Logs** — `~/.clementine/logs/clementine.log` (pino JSON lines, appended)
- **PID lock** — `~/.clementine/.clementine.pid` prevents duplicate instances
- **LaunchAgent** — `--install` creates a macOS plist with `KeepAlive` + `ThrottleInterval`
- **Graceful shutdown** — Handles SIGTERM/SIGINT, cleans up PID file, checkpoints SQLite WAL

### Dashboard

Run `clementine dashboard` to open the command center at `http://localhost:3030`. Five pages:

| Page | What's there |
|------|--------------|
| **Home** | Chat with Clementine, today's briefing, recent activity, KPIs |
| **Build** | Workflows, scheduled tasks (visual cron builder), skills, unleashed tasks |
| **Team** | Agents (hire / edit / let go), goals, delegations, decision-reflection reports |
| **Brain** | Memory search (FTS5), knowledge graph, ingestion sources, vault health |
| **Settings** | Channels, integrations, API keys, model config, env vars, service status |

Cron jobs can be project-aware (assign a `work_dir`) and switched between standard and unleashed mode. The agent roster auto-restarts the daemon on changes. No extra deps — runs on Express.

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

### Tuning Clementine

Clementine ships with sensible defaults. To change anything, use:

```bash
clementine config set <KEY> <value>   # writes to ~/.clementine/.env
clementine config get <KEY>
clementine config list                # show all overrides
clementine restart                    # apply changes
```

Your overrides live in `~/.clementine/.env` — **they survive every `npm update -g` / `clementine update`** because they're in your data home, not the package directory.

The dashboard exposes these spend controls in Settings -> Channels & Env ->
Spend Guards & Context Health, including direct dollar-cap editing, Default
Caps, Safe Recovery, and No Caps presets. When a dashboard change needs the
daemon to reload, Clementine shows a Restart Clementine prompt and handles the
restart from the browser.

For spend/context tuning, `clementine budgets` gives a safer shortcut:

```bash
clementine budgets              # show chat/cron/heartbeat caps and 1M context state
clementine budgets safe         # lower background budgets and force standard 200K context
clementine budgets 1m auto      # allow included Opus 1M, keep Sonnet on 200K
clementine budgets 1m on        # force 1M context for Extra Usage/API users
clementine budgets 1m off       # disable 1M context for maximum compatibility
clementine budgets set chat 10  # raise one budget cap
clementine budgets set chat 0   # remove one cap
```

**Commonly tuned knobs:**

| Key | Default | What it does |
|-----|---------|--------------|
| `BUDGET_CHAT_USD` | `5.00` | Max spend per interactive chat message |
| `BUDGET_CRON_T1_USD` | `0.75` | Max spend per tier-1 cron job |
| `BUDGET_CRON_T2_USD` | `1.50` | Max spend per tier-2 cron job |
| `BUDGET_HEARTBEAT_USD` | `0.25` | Max spend per heartbeat tick |
| `CLEMENTINE_1M_CONTEXT_MODE` | `auto` | `auto` allows included Opus 1M on Max/Team/Enterprise while keeping Sonnet on 200K; `off` forces 200K; `on` forces 1M |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | legacy | Backward-compatible Claude Code switch; `budgets safe` writes `1`, `budgets 1m auto` removes it |
| `DEFAULT_MODEL_TIER` | `sonnet` | Default model: `haiku` / `sonnet` / `opus` |
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

| Tier | Use case |
|------|----------|
| `haiku` | Lightweight tasks, cron noise filtering |
| `sonnet` | Default conversation + auto-memory extraction |
| `opus` | Per-agent override or global default |

Aliases resolve to the latest version via the Claude Code SDK. To pin a specific version, set `DEFAULT_MODEL_TIER` to a full model name (e.g. `claude-sonnet-4-6`). Each agent can override the model in its `agent.md` frontmatter.

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

Open the **Team** page in the dashboard, then either:

- **Hire a New Employee** — Clementine interviews you (3–5 questions: name, role, tools, project, team connections) and calls `create_agent`.
- **Manual Setup** — form with project dropdown, categorized tool browser, model selector, and team-connection fields.

Both paths auto-restart the daemon when the new agent appears.

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

For tasks that take hours — codebase refactors, research projects, content pipelines — unleashed mode runs autonomously in phases with session resumption between each.

### How it works

1. Runs in phases (default 75 turns each)
2. Between phases, the SDK session is **resumed** — full conversation history preserved
3. Progress saved to `~/.clementine/unleashed/<task>/` (status + JSONL log)
4. Can spawn sub-agents for parallel work
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

Clementine runs an iterative self-improvement loop: **gather data → diagnose weakness → hypothesize a fix → LLM-judge it → gate for human approval**. Repeats until plateau or time limit.

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

Folder structure under `~/.clementine/vault/`:

```
00-System/         SOUL.md, MEMORY.md, HEARTBEAT.md, CRON.md, AGENTS.md
                   agents/<slug>/agent.md   ← per-agent config
                   skills/                  ← procedural skills
01-Daily-Notes/    YYYY-MM-DD.md auto-generated daily logs
02-People/         Person notes (auto-created from conversations)
03-Projects/       Project notes
04-Topics/         Knowledge topics
05-Tasks/          TASKS.md master list with {T-NNN} IDs
06-Templates/      Note templates
07-Inbox/          Quick captures
```

Key system files:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality and behavioral instructions |
| `MEMORY.md` | Auto-extracted facts, preferences, people context |
| `HEARTBEAT.md` | Autonomous check-in configuration |
| `CRON.md` | Scheduled task definitions |
| `AGENTS.md` | Master roster of agents |
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
