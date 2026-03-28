# Architecture

**Analysis Date:** 2026-03-27

## Pattern Overview

**Overall:** Multi-layer service-oriented agent framework with lane-based concurrency control.

**Key Characteristics:**
- Agent-centric (Claude API with MCP tools) at the core
- Vault-as-source-of-truth with SQLite FTS5 indexing
- Lane-based concurrency (chat, cron, heartbeat, self-improve, team) preventing starvation
- Channel adapters (Discord, Slack, Telegram, WhatsApp) providing multi-platform access
- Gateway pattern for session management and message routing
- Lazy initialization throughout to minimize startup overhead

## Layers

**CLI Layer:**
- Purpose: Command-line interface, daemon control, setup, configuration
- Location: `src/cli/`
- Contains: Command definitions (commander.js), dashboard server (Express), chat, cron management, tunnel setup
- Depends on: Gateway, config, agent layer
- Used by: User shell commands; spawns main daemon

**Agent Layer:**
- Purpose: Core AI reasoning, memory integration, tool execution
- Location: `src/agent/`
- Contains: PersonalAssistant (Claude SDK wrapper), orchestrator (task decomposition), team system (multi-agent coordination), security hooks, prompt caching
- Depends on: Memory store, MCP tools, Claude SDK
- Used by: Gateway, CLI

**Gateway Layer:**
- Purpose: Session management, message routing, concurrency control, error classification
- Location: `src/gateway/`
- Contains: Router (core message dispatcher), HeartbeatScheduler (periodic tasks), CronScheduler (scheduled jobs), lanes (concurrency pools), notifications
- Depends on: Agent layer, memory store
- Used by: Channel adapters, CLI, dashboard

**Channel Adapters:**
- Purpose: Platform-specific integration (Discord, Slack, Telegram, WhatsApp, webhooks)
- Location: `src/channels/`
- Contains: Protocol handlers, streaming message adapters, command parsing, bot managers
- Depends on: Gateway, platform SDKs (discord.js, @slack/bolt, grammy, twilio)
- Used by: Main daemon to handle incoming messages

**Memory Layer:**
- Purpose: Vault indexing, search, fact extraction, conversation history
- Location: `src/memory/`
- Contains: SQLite FTS5 store, chunker (vault parsing), semantic search (MMR reranking), graph store
- Depends on: better-sqlite3, vault filesystem
- Used by: Agent layer for context retrieval, MCP tools for write operations

**Security & Scanning:**
- Purpose: Tool permission enforcement, vulnerability detection, input validation
- Location: `src/security/`
- Contains: Scanner (malicious pattern detection), integrity checks, permission framework
- Depends on: Zod validation
- Used by: Agent hooks to gate tool execution

**Tools & MCP:**
- Purpose: Model Context Protocol server providing 27+ tools (memory, vault, external APIs)
- Location: `src/tools/mcp-server.ts`
- Contains: Standalone MCP stdio server, tool definitions and handlers
- Depends on: Agent layer for context, vault and memory for data, external SDKs (Anthropic, Salesforce, etc.)
- Used by: Claude SDK subprocess via stdio transport

**Configuration:**
- Purpose: Centralized secrets, paths, and environment setup
- Location: `src/config.ts`
- Contains: .env parser (never pollutes process.env), path constants, secret lookups with macOS Keychain fallback
- Depends on: Node.js builtins
- Used by: All layers for configuration data

## Data Flow

**Interactive Chat (User → Agent → Response):**

1. Channel adapter receives message (Discord DM, Slack message, etc.)
2. Adapter calls `Gateway.chat()` with session key, text, provenance
3. Gateway acquires a "chat" lane slot (max 3 concurrent chats)
4. Gateway instantiates or retrieves `SessionState` (model, profile, context)
5. Memory layer searches vault (FTS5) for relevant context based on query
6. Agent layer calls Claude SDK `query()` with tools enabled
7. Agent executes tools (memory reads, vault lookups, external APIs via MCP)
8. Tool loop detector checks for infinite repetition
9. On text completion, auto-memory extracts facts via background Haiku
10. Response streamed back to channel, chunked by adapter
11. Chat lane slot released, next waiter dequeued

**Cron/Scheduled Execution (Internal → Task Execution):**

1. CronScheduler parses CRON.md frontmatter on startup
2. At trigger time, acquires a "cron" lane slot (max 2 concurrent jobs)
3. Creates ephemeral session with 'autonomous' provenance
4. Runs job-specific prompt via Agent layer with security policies
5. CronRunLog appends result to daily note
6. Lane slot released

**Heartbeat (Periodic Check-in):**

1. HeartbeatScheduler ticks on interval (default 1 hour, bounded to active hours)
2. Acquires "heartbeat" lane slot (max 1 concurrent)
3. Reads HEARTBEAT.md frontmatter for enabled checks
4. Queries memory for anomalies (overdue tasks, unread messages)
5. Dispatches notifications via NotificationDispatcher to all channels
6. Optionally triggers self-improve cycles per agent
7. Logs state to .heartbeat_state.json for dedup

**Team Communication (Agent → Agent):**

1. Primary agent spawns child agents via orchestrator dependency graph
2. TeamRouter routes inter-agent messages via TeamBus (async queue)
3. Each child runs with 'worker' role, isolated context, spawn depth counter
4. Parent receives results and synthesizes final response
5. Child sessions expire after completion; depth prevents runaway spawning

**Memory Extraction (Post-Chat):**

1. After every human-agent exchange, triggered asynchronously
2. Background Haiku pass extracts facts, connections, insights
3. Writes structured data to MEMORY.md via MCP append_memory tool
4. Vault chunker detects changes and re-indexes FTS5

**State Management:**

- **Sessions:** Stored in `Gateway.sessions` Map (key: `{channel}:{userId}` or `dashboard:web`)
  - Each session tracks: model, profile, context, abort controller, provenance, last access time
  - Expires automatically after 24 hours of inactivity via periodic cleanup
  - Context auto-rotates before hitting token limits

- **Cron State:** Persisted in CRON.md frontmatter (source of truth)
  - CronRunLog appends execution records to daily notes
  - Dashboard syncs state from vault on each query

- **Heartbeat State:** Persisted in `.heartbeat_state.json` (prevents duplicate notifications)
  - Tracks last execution hash, last self-improve date per agent

- **Concurrency:** Managed by `lanes` global, separate limits per work type
  - Prevents cron from starving chat, heartbeat from blocking responsive commands

## Key Abstractions

**PersonalAssistant:**
- Purpose: Wraps Claude SDK query(), manages sessions, context window, auto-memory
- Examples: `src/agent/assistant.ts`
- Pattern: Stateful singleton with internal session map; enforces tool permissions via hooks

**Gateway:**
- Purpose: Routes channel messages to agent, manages session state, error classification
- Examples: `src/gateway/router.ts`
- Pattern: Request/response with session key lookup; lazy-initializes team system

**MemoryStore:**
- Purpose: SQLite FTS5 index over vault markdown files
- Examples: `src/memory/store.ts`
- Pattern: Initialize-once singleton; concurrent reads via WAL mode; serialized writes from MCP

**HeartbeatScheduler:**
- Purpose: Periodic check-ins and notifications
- Examples: `src/gateway/heartbeat-scheduler.ts`
- Pattern: setInterval-based ticker with state file dedup; lazy-loads gateway on first tick

**TeamRouter / TeamBus:**
- Purpose: Orchestrate multi-agent workflows
- Examples: `src/agent/team-router.ts`, `src/agent/team-bus.ts`
- Pattern: Dependency graph topological sort; async message queue with parent-child hierarchy

**PromptCache:**
- Purpose: Reuses Anthropic SDK prompt caching for expensive contexts (SOUL, MEMORY, vault index)
- Examples: `src/agent/prompt-cache.ts`
- Pattern: LRU cache of cache_control tokens; invalidates on vault sync

## Entry Points

**Main Daemon:**
- Location: `src/index.ts`
- Triggers: `npm start` or launchd
- Responsibilities: Initializes agent, gateway, all channel adapters, heartbeat, cron; runs concurrently; handles graceful shutdown; PID management

**CLI Commands:**
- Location: `src/cli/index.ts`
- Triggers: `clementine` shell command
- Responsibilities: start, stop, restart, status, doctor, config management; spawns daemon via child process; works from any directory

**Dashboard:**
- Location: `src/cli/dashboard.ts`
- Triggers: `clementine dashboard`
- Responsibilities: Serves Express SPA on localhost:3030; lazy-initializes gateway for chat; provides JSON APIs for metrics, cron management, memory search

**Chat REPL:**
- Location: `src/cli/chat.ts`
- Triggers: `clementine chat`
- Responsibilities: Interactive terminal chat with the agent; spawns gateway locally; handles readline input/output

**MCP Server:**
- Location: `src/tools/mcp-server.ts`
- Triggers: Spawned by Claude SDK as subprocess
- Responsibilities: Listens on stdio; dispatches tool calls to handlers; manages vault read/write, memory index, external API calls

## Error Handling

**Strategy:** Classification at gateway level with exponential backoff for transient errors.

**Patterns:**

- **Rate Limiting (429):** Classified as `rate_limit`; agent retries with exponential backoff up to 3x
- **Context Overflow:** Classified as `context_overflow`; triggers session rotation to new context
- **Auth/Permission (401, 403):** Classified as `auth`; throws to user with hint to check credentials
- **Transient (5xx, timeout, ECONNREFUSED):** Classified as `transient`; retries automatically
- **Unknown:** Logged with full stack; returned to user as generic error message

Tool execution errors within agent:
- `canUseTool` hook validates before execution (permission/security enforcement)
- Tool failures are caught and formatted as "Tool {name} failed: {error}" for agent to see
- `toolLoopDetector` catches infinite tool loops (same tool called 5+ times in row)

## Cross-Cutting Concerns

**Logging:**
- Framework: Pino (structured JSON logs to stdout)
- Pattern: Each module creates logger with name (e.g., `pino({ name: 'clementine.agent' })`)
- All async operations log entry/exit; errors logged with full context

**Validation:**
- Framework: Zod schemas for public API inputs
- Pattern: Define schema once, reuse in type inference (`type X = z.infer<typeof XSchema>`)
- MCP tool inputs validated before dispatch

**Authentication:**
- Session provenance: Every session tagged with channel, userId, source (owner-dm vs member-channel), spawn depth
- Tool security: `setInteractionSource()` hook restricts dangerous tools to owner-only
- Approval workflows: For sensitive operations (send email, modify vault), gateway collects approvals async

**Concurrency:**
- Framework: Lane-based pooling with acquirable slots
- Pattern: `const release = await lanes.acquire('chat')` wraps async work; releases on completion
- Deadlock prevention: Each lane has independent limit; no cross-lane waits

---

*Architecture analysis: 2026-03-27*
