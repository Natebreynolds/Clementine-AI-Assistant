# Tasks Dashboard Audit

**Date:** 2026-05-08 (refreshed after Phase 0–6 ship streak)
**Branch:** `main`
**Scope:** Tasks domain only (cron jobs + workflows). Brain, Team, Heartbeat, Settings excluded.
**Codebase:** `clementine-agent` 1.18.105, `@anthropic-ai/claude-code` SDK
**Audit owner:** Post-implementation refresh — original audit was Phase 0 baseline at 1.18.76.

This document was the prerequisite for Phase 1 implementation per the PRD §4. The original 2026-05-07 baseline mapped every Tasks-domain surface as of 1.18.76; this refresh adds an **Implementation status** section at the top reflecting everything shipped through 1.18.105.

---

## 0. Implementation status (2026-05-08)

All six PRD phases shipped at v1+ level. Updated entity gap matrix below in §5.

### What's live

| Phase | Surface | Ship | Status |
|---|---|---|---|
| **§5.1 Task editor** | 5-tab cron modal (Basics / Prompt / Tools&MCP / Scope / Limits) | 1.18.80 | ✓ |
| **§5.1 Goal-orientation** | `success_schema` (JSON Schema, ajv-validated) + `success_criteria_text` (Haiku evaluator) | 1.18.78 | ✓ |
| **§5.1 Run task once** | Inline run + Last run pane with running pulse + Cancel button | 1.18.79, 1.18.91 | ✓ |
| **§5.2 Tools & MCP catalog** | Read-only foundation + Reconnect + Edit modal for user-managed servers | 1.18.81–82 | ✓ (McpToolBinding entity not yet shipped) |
| **§5.3 Run list** | Single sortable filterable table, default Failures-24h, Saved Views, trigger filter, click-to-sort columns | 1.18.83, 98, 100 | ✓ |
| **§5.4 Run detail** | Waterfall reading from per-run Event store, color-coded by kind, expandable spans | 1.18.86 | ✓ |
| **§6 Path A (in-process tap)** | runAgent SDK message → RunEvent rows in `~/.clementine/events/<runId>.jsonl` | 1.18.85 | ✓ |
| **§6 Path B (hook side-channel)** | hook-session-registry + `POST /api/hooks/event` + `.claude/settings.local.json` installer | 1.18.101–103 | ✓ |
| **§6 Path C (subagent backfill)** | After-run scan of `~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl` → synthesized RunEvent rows with `source='backfill'` | 1.18.92 | ✓ |
| **§9 Failure taxonomy (11 categories)** | `RunFailureCategory` union + `classifyRunFailure()` + Run list filter chip | 1.18.87 | ✓ |
| **§10 Cancel running task** | `cancelCronJob()` via gateway AbortController registry; SIGTERM-free | 1.18.91 | ✓ |
| **§11 Versions / Diff / Publish** | Prompt history modal (1.18.90) + line diff (1.18.97) + per-task draft sidecars + Publish button (1.18.105) | 1.18.90, 97, 105 | ✓ |
| **§12 Health Strip** | 7-tile glanceable strip (24h runs, success rate, cost, P50/P95, active, top failure) | 1.18.88 | ✓ |
| **§12 Cost dashboard** | Mini-card with 7d sparkline + total | 1.18.93 | ✓ (per-model breakdown deferred) |
| **§12 Latency dashboard** | Mini-card with split bar; **real numbers** when path B coverage ≥ 50%, heuristic otherwise | 1.18.93, 104 | ✓ |
| **§12 Reliability dashboard** | Mini-card stacked-by-category 7d column chart, colors match Run list filters | 1.18.93 | ✓ |
| **§12 Activity ("Behavior")** | Mini-card with trigger split (manual/scheduled/after/api/webhook), runs/day, busiest task | 1.18.96 | ✓ |
| **§13 Replay tooling** | v1: Rerun task / Copy prompt / Open run list buttons on Run detail header | 1.18.94 | ✓ (Rerun-from-step deferred) |

### What's deferred (out of session)

- **McpToolBinding entity** — per-task per-tool `visibility: allowed | disallowed | ask` records. Currently the per-task allowlist lives on `CronJobDefinition.allowedTools` (just names, no per-tool ask/deny granularity). Not blocking; users get coarser-but-functional control.
- **Workflow ↔ Task unification** — `vault/00-System/workflows/` and CRON.md remain separate write paths. The dashboard renders both kinds in one Tasks page (zone 1 + zone 2) so users see them together; canonical merging into one Task entity awaits future work.
- **Real per-model cost split + per-tool cost attribution** — would need usage_log enrichment that's not in scope for this PRD round.
- **Rerun-from-step** — needs SDK resume support keyed on a specific tool_use_id; not yet exposed.
- **Threshold alerts → Discord** — PRD §13 metric. The dispatch infrastructure exists (Discord channels are wired); alert rule storage + UI is unbuilt.

### Test coverage at 1.18.105

- 1128 tests passing across 121 files.
- New tests this session: failure-taxonomy (15), subagent-backfill (10), hook-session-registry (15), path-b-installer (17), draft-store (16) = **73 new unit tests**.
- HTML smoke parse run on every ship: 6 inline `<script>` blocks parse cleanly under `vm.Script`.

---

## 1. Map of existing routes / pages / components

### 1.1 Tasks-domain HTTP routes

All routes live in `src/cli/dashboard.ts`. Line numbers as of 1.18.76.

#### CRUD on cron jobs (the canonical Task entity today)

| Route | Method | File:Line | Intent |
|---|---|---|---|
| `/api/cron` | GET | `dashboard.ts:2814` | List all cron jobs (returns `{jobs: CronJobDefinition[]}` with `recentRuns` attached per job from `CronRunLog.readRecent`) |
| `/api/cron` | POST | `dashboard.ts:6216` | Create a new cron job. Validates name, schedule (cron-parser), prompt; rejects duplicate names with 409 |
| `/api/cron/:name` | PUT | `dashboard.ts:6286` | Update an existing cron job. Maps camelCase API → snake_case YAML; supports rename with dup check |
| `/api/cron/:name` | DELETE | `dashboard.ts:6451` | Delete a cron job + cascade-purge `runs/<safe>.jsonl`, `traces/<safe>_*.json`, `uploads/cron-<safe>/`. Broadcasts `cron_deleted` SSE |
| `/api/cron/:name/toggle` | POST | `dashboard.ts:6423` | Flip enabled. Broadcasts `cron_toggled` SSE. Scheduler reloads via 2s `watchFile` polling |
| `/api/cron/run/:job` | POST | `dashboard.ts:4413` | Manual run-now. Spawns detached subprocess. **As of 1.18.76: rejects 409 when job is already in-flight** (reads `~/.clementine/cron-running.json`) |
| `/api/cron/runs` | GET | `dashboard.ts:5502` | Cross-job recent run history (last 50 entries across all `runs/*.jsonl`). Backed by `CronRunLog.readAllRecent` |
| `/api/cron/traces/:job` | GET | `dashboard.ts:5515` | **BROKEN**: reads `~/.clementine/cron/traces/<safe>_*.json`. **No code writes these files anywhere in the codebase.** See §6. |
| `/api/cron/:name/preview` | GET | `dashboard.ts:6528` | What-will-run preview (resolved skills, tools, MCP). Useful for the existing modal's preview tab |
| `/api/cron/:job/prompt-history` | GET | `dashboard.ts:6505` | Per-job prompt revision log (kept on PUT when prompt changes) |
| `/api/cron/:job/attachments` | GET / POST | `dashboard.ts:6640 / 6655` | Per-job file attachments under `~/.clementine/uploads/cron-<safe>/` |
| `/api/cron/:job/attachments/:filename` | GET / DELETE | `dashboard.ts:6687 / 6674` | Read or remove a single attachment |
| `/api/cron/broken-jobs` | GET | `dashboard.ts:5381` | Self-improve loop output: jobs that have failed N consecutive runs |
| `/api/cron/broken-jobs/:jobName/apply-fix` | POST | `dashboard.ts:5395` | Apply the AI-proposed fix to a broken job |
| `/api/cron/broken-jobs/:jobName/dismiss-diagnosis` | POST | `dashboard.ts:5488` | Dismiss the proposed fix |
| `/api/cron/train` | POST | `dashboard.ts:8215` | Chat-train the prompt for a cron job (suggested prompt/context/skills) |

#### CRUD on workflows (multi-step tasks today)

Two parallel API surfaces — `/api/routines` (the original) and `/api/builder/workflows` (drawflow visual builder). Both write to `vault/00-System/workflows/<id>.md`.

| Route | Method | File:Line | Intent |
|---|---|---|---|
| `/api/routines` | GET | `dashboard.ts:4049` | List workflows |
| `/api/routines` | POST | `dashboard.ts:4112` | Create workflow. **Now (1.18.75) preserves all step kinds** (mcp/cli/channel/transform/conditional/loop) from the chat-builder draftYaml |
| `/api/routines/:id` | GET / PUT / DELETE | `dashboard.ts:4099 / 4211 / 4236` | Read / update / delete |
| `/api/routines/:id/toggle` | POST | `dashboard.ts:4259` | Flip enabled |
| `/api/routines/:id/run` | POST | `dashboard.ts:4274` | Trigger manual run. Returns 409 with `sideEffects[]` when destructive ops detected |
| `/api/routines/:id/dry-run` | POST | `dashboard.ts:4340` | Dry-run analysis: per-step description + warnings |
| `/api/routines/:id/test` | POST | `dashboard.ts:4355` | Mock-mode test run (prompt steps stubbed) |
| `/api/routines/:id/runs` | GET | `dashboard.ts:4379` | Per-workflow run history |
| `/api/routines/mcp-tools` | GET | `dashboard.ts:4058` | List available MCP tools across discovered servers |
| `/api/routines/cli-tools` | GET | `dashboard.ts:4089` | List installed CLI binaries (sf, gh, gcloud, etc.) |
| `/api/builder/workflows` | GET / POST | `dashboard.ts:3780 / 4007` | Drawflow builder list / create |
| `/api/builder/workflows/:id` | GET / PUT / DELETE | `dashboard.ts:3789 / 3809 / 3893` | Drawflow CRUD |
| `/api/builder/workflows/:id/run` | POST | `dashboard.ts:3834` | Drawflow run |
| `/api/builder/workflows/:id/save-from-drawflow` | POST | `dashboard.ts:3917` | Persist canvas state |
| `/api/builder/workflows/:id/validate` | POST | `dashboard.ts:3941` | Validate (cycle detection, missing prompts, etc.) |
| `/api/builder/workflows/:id/test` | POST | `dashboard.ts:3956` | Test run from canvas |
| `/api/builder/workflows/:id/dry-run` | POST | `dashboard.ts:3992` | Dry-run from canvas |
| `/api/builder/runs/:runId/cancel` | POST | `dashboard.ts:3981` | Cancel an in-flight builder run |
| `/api/builder/mcp-discovery` | GET | `dashboard.ts:3874` | Discover MCP servers for the builder picker |
| `/api/builder/chat` | POST | `dashboard.ts:8261` | Non-streaming chat with the builder agent |
| `/api/builder/chat/stream` | POST | `dashboard.ts:8306` | SSE-streaming chat with the builder agent (the chat-first builder UI uses this) |
| `/api/builder/save` | POST | `dashboard.ts:8426` | Save canvas-edited workflow |
| `/api/builder/test` | POST | `dashboard.ts:8399` | Test from builder |
| `/api/builder/reset` | POST | `dashboard.ts:8387` | Reset builder canvas state |

#### Aggregations

| Route | File:Line | Intent |
|---|---|---|
| `/api/build/operations` | `dashboard.ts:9009` | Single-shot aggregation for the Tasks page: `{summary, scheduledTasks[], scheduledWorkflows[], runningNow[], needsAttention[]}` |
| `/api/build/usage` | `dashboard.ts:8714` | Per-task token + cost totals |

### 1.2 Tasks-domain page surface (HTML + inline JS)

Single page id: `<div class="page" id="page-build">` at `dashboard.ts:16104`. Sub-tab buttons hidden by default since 1.18.74:

- `#build-tab-crons` (visible, default) — the "Tasks" surface from the user's POV
- `#build-tab-workflows` (hidden, deep-linkable via `?tab=workflows`) — multi-step workflows; chat-first builder lives here

The cron sub-tab renders four zones (since 1.18.74):
1. **Operations summary** — `renderOperationsSummary`
2. **Running now** — promoted to top by 1.18.74; renders `renderRunningCard` per in-flight job
3. **Needs attention** — broken jobs (`renderAttentionCard`)
4. **Your tasks** — `renderScheduledTaskCard` grid (`dashboard.ts:23022+`)
5. **Multi-step workflows** — `renderScheduledWorkflowCard` grid (only renders if any exist)
6. **Recent history** — `renderRecentHistoryList` (last 50 runs across all jobs, added in 1.18.74)

### 1.3 Modals in the Tasks domain

| Modal | File:Line | Purpose | Notes |
|---|---|---|---|
| Unified cron modal (Configure / What will run) | `dashboard.ts:19479-19773` | Create/edit a cron job | Heavy form. 1.18.75 added field-specific validation, dirty-guard, predictable-mode hidden by default |
| Workflow chat-first builder | `dashboard.ts:16133-17220` | Two-pane: chat left, live spec right | Now (1.18.75) preserves all step-kind configs on save |
| Workflow editor (canvas) | `dashboard.ts:16270-16410` | Drawflow visual editor | The 2D builder; out of scope per PRD §15 |
| Trace viewer | `dashboard.ts:23286+` | Read traces from `/api/cron/traces/:job` | **Reads files that don't exist** — the writer side was never implemented |

---

## 2. Existing data model — verbatim field maps

### 2.1 `CronJobDefinition` — `src/types.ts:365-427`

```ts
export interface CronJobDefinition {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  tier: number;
  maxTurns?: number;
  model?: string;
  workDir?: string;
  mode?: 'standard' | 'unleashed';
  maxHours?: number;
  maxRetries?: number;
  after?: string;
  agentSlug?: string;
  successCriteria?: string[];
  alwaysDeliver?: boolean;
  context?: string;
  preCheck?: string;
  attachments?: string[];
  requiresConfirmation?: boolean;
  confirmationTimeoutMin?: number;
  // Trick capabilities
  skills?: string[];
  allowedTools?: string[];
  allowedMcpServers?: string[];
  tags?: string[];
  category?: string;
  predictable?: boolean;
}
```

YAML form (snake_case in `vault/00-System/CRON.md` frontmatter): `work_dir`, `max_hours`, `max_retries`, `agent_slug`, `success_criteria`, `always_deliver`, `pre_check`, `requires_confirmation`, `confirmation_timeout_min`, `allowed_tools`, `allowed_mcp_servers`. Reader at `src/gateway/cron-scheduler.ts:146-211` accepts both casings.

### 2.2 `CronRunEntry` — `src/types.ts:454-494`

Updated in 1.18.76 to add running/timeout/lost states and optional `finishedAt`. Persisted as JSONL at `~/.clementine/cron/runs/<safeName>.jsonl` (one file per job, auto-pruned to 2MB / 2000 lines). Writer: `CronRunLog.append` (`src/gateway/cron-scheduler.ts:457`).

```ts
export interface CronRunEntry {
  jobName: string;
  startedAt: string;
  finishedAt?: string;          // optional since 1.18.76
  status: 'ok' | 'error' | 'retried' | 'skipped' | 'running' | 'timeout' | 'lost';
  durationMs: number;
  error?: string;
  errorType?: 'transient' | 'permanent';
  terminalReason?: TerminalReason;
  attempt: number;
  outputPreview?: string;
  deliveryFailed?: boolean;
  deliveryError?: string;
  longTaskPreflight?: LongTaskPreflightSnapshot;
  advisorApplied?: { adjustedMaxTurns?, adjustedModel?, adjustedTimeoutMs?, enriched?, escalated? };
  skillsApplied?: Array<{ name; source: 'pinned' | 'auto'; score? }>;
  skillsMissing?: string[];
  allowedToolsApplied?: string[];
  mcpServersApplied?: string[];
}
```

`TerminalReason` (`src/types.ts:448-452`): `blocking_limit | rapid_refill_breaker | prompt_too_long | image_error | model_error | aborted_streaming | aborted_tools | stop_hook_prevented | hook_stopped | tool_deferred | max_turns | completed`

### 2.3 `ManagedMcpServer` — `src/types.ts:601-612`

```ts
export interface ManagedMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  description: string;
  enabled: boolean;
  source: 'auto-detected' | 'user';
}
```

Discovered from 4 sources by `src/agent/mcp-bridge.ts:66-185`:
1. `~/.claude/claude_desktop_config.json`
2. Claude Code settings
3. Claude Desktop Extensions
4. User-managed `~/.clementine/mcp-servers.json`

Per-task tool binding **does not exist** as a standalone entity — only job-level (`allowed_tools`/`allowed_mcp_servers`) and profile-level (`team.allowedTools`) lists are intersected at runtime by `computeEffectiveAllowedTools` (`src/agent/run-agent-cron.ts:61-93`).

### 2.4 Workflows — `src/types.ts:725-758`

```ts
export interface WorkflowStep {
  id: string;
  prompt: string;
  dependsOn: string[];
  model?: string;
  tier: number;
  maxTurns: number;
  workDir?: string;
  kind?: 'prompt' | 'mcp' | 'cli' | 'channel' | 'transform' | 'conditional' | 'loop';
  mcp?: WorkflowStepMcpConfig;
  cli?: WorkflowStepCliConfig;
  channel?: WorkflowStepChannelConfig;
  transform?: WorkflowStepTransformConfig;
  conditional?: WorkflowStepConditionalConfig;
  loop?: WorkflowStepLoopConfig;
  canvas?: WorkflowStepCanvas;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  enabled: boolean;
  trigger: { schedule?: string; manual?: boolean };
  inputs: Record<string, WorkflowInput>;
  steps: WorkflowStep[];
  synthesis?: { prompt: string };
  sourceFile: string;
  agentSlug?: string;
  project?: string;
  model?: string;
}
```

Stored as one Markdown file per workflow at `vault/00-System/workflows/<id>.md` (frontmatter + body).

### 2.5 Crash-safe in-flight sidecar — `~/.clementine/cron-running.json`

Persisted by `CronScheduler.persistRunningJobs` (`src/gateway/cron-scheduler.ts:613`). Used by 1.18.76's Run-Now concurrency lock and the daemon-startup interrupted-run reconciliation. Shape:

```json
[
  { "jobName": "morning-briefing", "startedAt": "2026-05-07T15:00:00.000Z", "runId": "...", "pid": 12345 }
]
```

---

## 3. Existing telemetry surface

### 3.1 `audit.jsonl` — `~/.clementine/logs/audit.jsonl`

Writer: `logAuditJsonl` (`src/agent/hooks.ts:142-160`). Rotates at 5MB. Every event includes:

```ts
{
  ts: ISO_string,
  trace_id: string,           // 8-char distributed trace ID
  span_id: string,
  parent_span_id?: string,
  session_id?: string,
  channel?: string,           // 'discord' | 'slack' | 'cron' | 'chat' | ...
  agent_slug?: string,
  event_type: string,         // 'query_complete' | 'tool_use' | 'message_received' | 'message_completed' | 'message_failed' | 'cron_interrupted' | 'cron_sla_breach' | ...
  // event-specific fields:
  tool_name?, duration_ms?, tokens_in?, tokens_out?,
  cache_read_tokens?, cache_creation_tokens?, cost_usd?, num_turns?, error?
}
```

`runWithTrace` (`src/agent/hooks.ts:74-119`) provides AsyncLocalStorage-based span stacking so nested calls inherit parent_span_id automatically.

### 3.2 `cron/traces/<job>_<ts>.json` — **NEVER WRITTEN**

The dashboard's `/api/cron/traces/:job` endpoint and the inline `openTraceViewer` JS expect files at `~/.clementine/cron/traces/<safeName>_<timestamp>.json` with shape `{jobName, startedAt, trace: TraceStep[]}`. **No code in the entire codebase writes these files.** Confirmed by grep across `src/`. Every "Trace" button in the dashboard today opens a viewer that always shows "No traces recorded yet." This is the latent bug — see §6.

### 3.3 SDK signals consumed today

Callsites of `query()` from `@anthropic-ai/claude-code`:
- `src/agent/run-agent.ts:26-175` — wrapper `runAgent()` consumes the message stream and extracts `RunAgentResult{sessionId, numTurns, totalCostUsd, subtype, usage}`
- `src/agent/run-agent-cron.ts` — cron variant, additionally builds the execution plan from `CronJobDefinition`
- `src/agent/assistant.ts:644-651` — `getContentBlocks()` extracts assistant content for chat replies

Message types consumed: `SystemMessage` (init), `AssistantMessage` (content blocks), `ResultMessage` (final close). **Dropped on the floor:** `ToolUseBlock`/`ToolResultBlock` per-event details, `ThinkingBlock`, `RateLimitEvent`, individual stop reasons per turn.

### 3.4 SDK hooks — **NOT WIRED**

`grep -rn "PreToolUse\|PostToolUse\|SubagentStart\|SubagentStop"` across `src/` returns zero results. None of the 12 PRD hook events (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStart, SubagentStop, PreCompact, Notification, PermissionRequest, SessionStart, SessionEnd) are registered today. This is greenfield work for PRD's ingestion path B.

### 3.5 `~/.claude/projects/` JSONL transcripts — **NOT READ**

The Claude Agent SDK persists session transcripts to `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` and subagent transcripts to `~/.claude/projects/<encoded-cwd>/subagents/agent-*.jsonl`. **No code reads these.** PRD's path C (subagent backfill) is greenfield.

### 3.6 OpenTelemetry — **MISSING**

No references to `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, or any OTel SDK in `package.json` or source. PRD's optional org-wide cost rollups are not available today.

### 3.7 MCP status — **PARTIAL**

`Assistant.getMcpStatus()` (`src/agent/assistant.ts:948-950`) returns a cached `_lastMcpStatus` set during the last query. There is no reactive polling, no `notifications/list_changed` listener, and the cache is only updated as a side-effect of running an agent query. Endpoint `/api/mcp-status` (`dashboard.ts:243`) reads this static cache.

### 3.8 Failure classification — `src/gateway/job-health.ts:4-15`

Already an 11-bucket classifier, but **the buckets differ from the PRD's 11**:

```ts
export type JobHealthKind =
  | 'healthy' | 'recovered' | 'partial'
  | 'context_overflow' | 'usage_blocked' | 'auth' | 'rate_limited'
  | 'tool_scope' | 'prompt_too_large' | 'failed' | 'unknown';
```

Mapping is documented in `MIGRATIONS.md`.

---

## 4. Discord trigger path

The Discord gateway (`src/channels/discord-bot.ts`, `src/channels/discord-agent-bot.ts`) accepts slash commands and DMs. Cron jobs can be triggered indirectly:

1. A user sends a slash command or DM in Discord.
2. The Discord bot routes through `src/gateway/router.ts` to the agent layer.
3. The agent may decide to schedule or invoke a cron via the `add_cron_job` / `run_cron_job` MCP tools (defined in `src/tools/cron-tools.ts` per the codebase pattern).
4. The cron runner spawns under `src/agent/run-agent-cron.ts`.

**Trigger source is NOT persisted on `CronRunEntry` today.** There is no `trigger` field on a Run. The only signal of "this run came from Discord" is in the audit log's `channel: 'discord'` field on adjacent events. The PRD wants explicit `Run.trigger: 'manual' | 'scheduled' | 'webhook' | 'api' | 'fork' | 'resume' | 'discord'` — net-new field.

---

## 5. Gap matrix per PRD entity

Legend: ✅ EXISTS · 🟡 PARTIAL · ❌ MISSING

### 5.1 Task

PRD field → today's source → status.

| PRD field | Today's source | Status |
|---|---|---|
| `id` | `name` (no separate UUID; filename-safe slug) | 🟡 PARTIAL — name doubles as ID; risks if user renames |
| `name` | `CronJobDefinition.name` | ✅ |
| `description` | not present | ❌ |
| `system_prompt` | not present (just `prompt`) | ❌ |
| `model` | `model` | ✅ |
| `fallback_model` | not present | ❌ |
| `permission_mode` | implicit via `tier` | 🟡 |
| `allowed_tools[]` | `allowedTools` | ✅ |
| `disallowed_tools[]` | not present (only allowlist) | ❌ |
| `setting_sources[]` | hardcoded `["project"]` in run-agent | 🟡 |
| `cwd` | `workDir` | ✅ (rename) |
| `add_dirs[]` | not present | ❌ |
| `sandbox{}` | implicit via tier+mode | ❌ as structured field |
| `max_turns` | `maxTurns` | ✅ |
| `max_budget_usd` | not present (heartbeat enforces globally) | ❌ |
| `thinking{type, budget_tokens}` | not present | ❌ |
| `effort` | not present | ❌ |
| `mcp_server_ids[]` | `allowedMcpServers` (names not IDs) | 🟡 |
| `subagent_ids[]` | implicit via skills loading subagents | 🟡 |
| `hook_ids[]` | not present (no hooks wired) | ❌ |
| `plugin_paths[]` | not present | ❌ |
| `skill_ids[]` | `skills` | ✅ (rename) |
| `default_input_template` | not present | ❌ |
| **`success_schema`** | not present | ❌ — **the PRD's most important new field** |
| **`success_criteria_text`** | `successCriteria: string[]` (array, not freeform text) | 🟡 — type/shape differs |
| `schedule{}` | `schedule` (string, cron-only) | 🟡 — see §5.8 |

### 5.2 Run

| PRD field | Today's source | Status |
|---|---|---|
| `id` | composite `jobName + startedAt` | 🟡 — no UUID |
| `task_id` | `jobName` | ✅ (rename) |
| `session_id` | not on run record (in audit log only) | ❌ on Run |
| `parent_run_id` | not present | ❌ |
| `status` | `status` | ✅ but enum needs PRD rename (ok→success, etc.) |
| **`trigger`** | not present | ❌ |
| `prompt` | not on run (snapshotted only via prompt-history endpoint) | ❌ |
| `cwd` | not on run (read from job at fire-time) | ❌ |
| `started_at` | `startedAt` | ✅ |
| `ended_at` | `finishedAt` | ✅ |
| `duration_ms` | `durationMs` | ✅ |
| `duration_api_ms` | not present | ❌ |
| `num_turns` | not on run | ❌ |
| `total_cost_usd` | not on run (in audit log) | ❌ on Run |
| `usage{}` | not on run | ❌ |
| `model_usage{}` | not on run | ❌ |
| `result_text` | `outputPreview` (truncated) | 🟡 |
| `stop_reason` | `terminalReason` | ✅ |
| `is_error` | derivable from `status` | ✅ |
| `structured_output` | not present | ❌ — **needed for success_schema validation** |
| `options_snapshot` | not present | ❌ |
| `mcp_status_snapshot` | not present | ❌ |
| `custom_title` | not present | ❌ |
| `tag` | not present | ❌ |
| `rate_limit_state` | not on run (not captured at all) | ❌ |

### 5.3 McpServer

| PRD field | Today's source | Status |
|---|---|---|
| `id` | `name` | 🟡 |
| `name` | `name` | ✅ |
| `transport` | `type: 'stdio'\|'http'\|'sse'` | ✅ (rename) — PRD also has `'sdk'` for in-process |
| `command/args/env` | ✅ for stdio | ✅ |
| `url/headers` | ✅ for http/sse | ✅ |
| `auth` | partial (headers can carry it) | 🟡 |
| `sdk_module_path` | not supported (no in-process MCP today) | ❌ |
| `scope` | implicit via discovery `source` | 🟡 |
| `enabled` | `enabled` | ✅ |
| `status` | static cache from getMcpStatus | 🟡 |
| `server_info` | not stored | ❌ |
| `last_error` | not stored | ❌ |
| `last_checked_at` | not stored | ❌ |
| `exposed_tools[]` | not stored per-server (gathered via mcp-discovery endpoint on demand) | 🟡 |
| `exposed_resources[]` | not stored | ❌ |
| `exposed_prompts[]` | not stored | ❌ |

### 5.4 McpToolBinding — **ENTIRELY MISSING**

No per-task-per-tool visibility entity exists. All fields ❌. Today only:
- Job-level allowlists (`allowed_tools`, `allowed_mcp_servers`)
- Profile-level allowlists (`team.allowedTools`)
- Intersection at runtime in `computeEffectiveAllowedTools`

PRD's `visibility: 'allowed' | 'disallowed' | 'ask'` and `scope: 'task' | 'run'` are net-new.

### 5.5 Event

| PRD field | Today's source | Status |
|---|---|---|
| `id` | not assigned (audit events are append-only with ts+trace_id) | 🟡 |
| `run_id` | not present (audit not run-scoped) | ❌ — **breaks Path A correlation** |
| `session_id` | `session_id` in audit | ✅ |
| `agent_id` | `agent_slug` | ✅ (rename) |
| `agent_type` | not present | ❌ |
| `parent_tool_use_id` | not present | ❌ |
| `tool_use_id` | not present | ❌ — **needed for waterfall pairing** |
| `hook_event_name` | not present (no hooks wired) | ❌ |
| `ts` | `ts` | ✅ |
| `cwd` | not on event | ❌ |
| `tool_name` | `tool_name` (in `tool_use` events) | ✅ |
| `tool_input` | not stored | ❌ |
| `tool_response` | not stored | ❌ |
| `tool_error` | `error` field on event | ✅ |
| `permission_decision` | not present | ❌ |
| `decision_source` | not present | ❌ |
| `prompt` | not present | ❌ |
| `message_text` | partial (`text_preview` on `message_received`) | 🟡 |
| `thinking_text` | not captured (ThinkingBlock dropped) | ❌ |
| `size_bytes_input` | not present | ❌ |
| `size_bytes_output` | not present | ❌ |
| `raw` | implicit (full audit JSON line) | 🟡 |

### 5.6 SubagentInvocation

Today: subagent transcripts are stored in SQLite via the SDK (`src/memory/store.ts:230-296`, `transcripts` table). Retrieval via `getSubagentList(sessionId)` and `getSubagentHistory(sessionId, agentId, limit)` (`src/agent/assistant.ts:3619-3640`). **Not file-based**, **not run-scoped**, **no explicit invocation entity**.

| PRD field | Today's source | Status |
|---|---|---|
| `id` | composite (session_key) | 🟡 |
| `run_id` | not linked | ❌ |
| `parent_invocation_id` | not present | ❌ |
| `agent_id` | agentId from SDK | ✅ |
| `agent_type` | not present | ❌ |
| `spawning_tool_use_id` | not present | ❌ |
| `description` | not stored | ❌ |
| `prompt` | first message content | 🟡 |
| `started_at` | first transcript message ts | 🟡 |
| `ended_at` | last transcript message ts | 🟡 |
| `duration_ms` | derivable | 🟡 |
| `result_text` | last message content | 🟡 |
| `usage{}`, `total_cost_usd` | not stored per-invocation | ❌ |
| `status` | not tracked (running/success/error/timeout) | ❌ |
| `transcript_path` | n/a — SQLite, not file | 🟡 |

### 5.7 Scope

PRD wants a structured `Scope{cwd, add_dirs[], worktree_path, permission_rules[], sandbox, file_checkpoints[]}`. Today scope is **scattered**:

- `cwd` ← `workDir` ✅
- `add_dirs[]` ← ❌
- `worktree_path` ← ❌
- `permission_rules[]` ← implicit via `tier` (1=read-mostly, 2=read+write, 3=full); no per-task rules ❌ as structured
- `sandbox` ← implicit via `mode` and `tier` ❌ as structured
- `file_checkpoints[]` ← ❌ (no equivalent of `client.rewind_files`)

### 5.8 Schedule

| PRD field | Today's source | Status |
|---|---|---|
| `task_id` | `jobName` | ✅ (rename) |
| `kind: cron\|interval\|webhook\|event\|discord` | only `cron` supported | 🟡 — only one variant |
| `cron_expr` | `schedule` | ✅ |
| `interval_seconds` | not supported | ❌ |
| `webhook_url` | not supported | ❌ |
| `event_match{}` | not supported | ❌ |
| `session_target` | implicit (always isolated cron session) | ❌ |
| `enabled` | `enabled` | ✅ |
| `last_run_id` | not stored on schedule (computed from runs) | 🟡 |
| `next_run_at` | computed at runtime via cron-parser, not persisted | ❌ |
| `delivery_context` | implicit (channel auto-detected from trigger source) | ❌ |

---

## 6. Risks (top 5)

### 6.1 Trace writer was never implemented (latent bug)

The dashboard reads `~/.clementine/cron/traces/<safeName>_<ts>.json` but **no code in the codebase writes those files**. The `Trace` button on every task card opens a modal that always shows the empty state. This has likely been broken since the feature was first added. The PRD's Run detail surface (Phase 4) replaces this entirely with a proper Event store, so don't bandaid — but document the deception in user-visible help text on 1.18.x while Phase 4 is in flight.

**Mitigation:** Phase 4 redirects `/api/cron/traces/:job` → 404 with a JSON pointing at the new Run detail URL (or 410 Gone if we want to be loud about the deprecation).

### 6.2 Workflow ↔ Task unification has two save paths

`/api/cron` POST writes to `vault/00-System/CRON.md` (frontmatter array). `/api/routines` POST writes to `vault/00-System/workflows/<id>.md` (one file per workflow). Behind the unified Task entity, both endpoints either need to route to a single writer or be merged outright.

**Mitigation:** Phase 1 introduces an internal `TaskStore` abstraction. Both old endpoints become deprecated thin wrappers for one release; the new `/api/tasks` POST is canonical. Field migration handled in `MIGRATIONS.md`.

### 6.3 Failure taxonomy rename is not a 1-1 map

Existing buckets (`context_overflow`, `usage_blocked`, `tool_scope`, `prompt_too_large`, `partial`, `recovered`, `unknown`) don't all have direct PRD equivalents. The migration table needs care so historical job-health verdicts don't disappear.

**Mitigation:** `MIGRATIONS.md` documents the mapping. Phase 4 ships the rename in one commit with a database-style migration script that re-classifies existing run logs in place.

### 6.4 `predictable` boolean becomes redundant under success_schema + scoped allowlists

`predictable: true` was 1.18.68's solution to "the agent agreed in chat then fired with stale memory". The PRD's model — explicit `success_schema` plus scoped `McpToolBinding[]` — gives the same guarantee structurally. Keeping `predictable` long-term creates two ways to pin behavior.

**Mitigation:** Phase 1 keeps `predictable` as a deprecated alias that maps to "no auto-injection". Sunset planned for two releases after Phase 1 ships.

### 6.5 Hook side-channel (path B) requires writing `.claude/settings.json` into projects

Per-project `.claude/settings.json` registering command-type hooks for all 12 events. Dropping that file unconditionally would conflict with users' existing `.claude/` config in monorepos.

**Mitigation:** Phase 4 introduces an opt-in flow. The dashboard's Tools & MCP catalog page (Phase 2) gains a "Enable rich telemetry" toggle per project that asks the user before writing `.claude/settings.json`. Default off.

---

## 7. Sign-off checklist

Before merging this branch and starting Phase 1, confirm:

- [ ] Every `/api/cron/*`, `/api/routines/*`, `/api/builder/*`, `/api/build/*` endpoint listed in §1.1 is acknowledged
- [ ] Every PRD entity field in §5 is marked EXISTS / PARTIAL / MISSING
- [ ] The trace-writer bug (§6.1) is acknowledged and Phase 4 owns the fix
- [ ] The workflow + cron unification (§6.2) is acknowledged with a migration path
- [ ] The failure taxonomy rename (§6.3) is acknowledged
- [ ] `MIGRATIONS.md` covers every renamed/added/merged field

Human reviewer signature: **___________________________**
Date: **___________________________**
