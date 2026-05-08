# Tasks Domain — Migration Plan

**Companion to** `DASHBOARD_AUDIT.md`. Read that first.
**Branch:** `feat/tasks-prd-phase-0`
**Scope:** every field rename, addition, or merge required to land the PRD's 7 entities + 11-category failure taxonomy on top of the existing codebase.

Each migration carries:
- **Old → New** column mapping
- **Type** (rename / additive / merged / removed)
- **Compat alias** kept for one release (so external code that reads YAML or JSONL doesn't break)
- **Migration step** (script / additive / read-time normalization)
- **Rollback path**

---

## 1. Task entity (CronJobDefinition → Task)

Old store: `vault/00-System/CRON.md` (single file with `jobs[]` frontmatter array) + `vault/00-System/agents/<slug>/CRON.md` (agent-scoped variant).
New store: same physical files, expanded fields. **No file relocation.** Workflows fold in (see §2).

### 1.1 Renames (one-release alias)

| Old (YAML / TS) | New (PRD canonical) | Type | Notes |
|---|---|---|---|
| `name` | `name` (also serves as `id` slug) | unchanged | Document the slug stability rule: renames create a new task; the old name 410s |
| `prompt` | `prompt` | unchanged | |
| `enabled` | `enabled` | unchanged | |
| `tier` (1/2) | `permission_mode` (mapped) | rename | Mapping: tier 1 → `acceptEdits`, tier 2 → `default`, tier 3 → `bypassPermissions` |
| `work_dir` / `workDir` | `cwd` | rename | Old keys readable for one release |
| `max_hours` / `maxHours` | `max_duration_s` (×3600) | rename + type-change | Read-time normalization: `if has max_hours, set max_duration_s = max_hours * 3600` |
| `max_retries` / `maxRetries` | `max_retries` | unchanged (snake-case canonical) | |
| `max_turns` / `maxTurns` | `max_turns` | unchanged | |
| `successCriteria: string[]` | `success_criteria_text: string` | rename + reshape | Migration: `success_criteria_text = (successCriteria ?? []).join('\n')` |
| `mode` (`standard\|unleashed`) | merged into `permission_mode` | merged | `unleashed` → `bypassPermissions`; otherwise inherits from tier mapping |
| `agent_slug` / `agentSlug` | `agent_slug` | unchanged | |
| `skills` | `skill_ids[]` | rename | Old key readable for one release |
| `allowed_tools` / `allowedTools` | promoted to `McpToolBinding[]` | merged (see §3) | |
| `allowed_mcp_servers` / `allowedMcpServers` | promoted to `McpToolBinding[]` + `mcp_server_ids[]` | merged (see §3) | |
| `tags`, `category`, `context`, `pre_check`, `attachments`, `requires_confirmation`, `confirmation_timeout_min`, `always_deliver` | unchanged | unchanged | All fields keep their YAML names |
| `predictable` | deprecated alias for "no auto-injection" | deprecate | Keep readable, do not write new. Slated for removal two releases after Phase 1 |

### 1.2 Net-new fields (additive)

| New field | Type | Purpose |
|---|---|---|
| `description` | `string` | Free-text task summary surfaced in the editor + run list |
| `system_prompt` | `string` | Distinct from `prompt`; the SDK system message |
| `fallback_model` | `string` | When primary model rate-limits |
| `disallowed_tools[]` | `string[]` | Explicit deny-list (precedence over allow-list) |
| `setting_sources[]` | `string[]` | Default `['project']`; surfaced for Phase 4 hook side-channel |
| `add_dirs[]` | `string[]` | Read scope beyond cwd |
| `sandbox{}` | structured | Replace implicit tier+mode sandbox |
| `max_budget_usd` | `number` | Per-run cost cap |
| `thinking{type, budget_tokens}` | structured | Extended thinking config |
| `effort` | `'low' \| 'medium' \| 'high'` | Reasoning effort |
| `mcp_server_ids[]` | `string[]` | Per-task MCP server allowlist (PRD names IDs but server.id === name today) |
| `subagent_ids[]` | `string[]` | Per-task subagent allowlist |
| `hook_ids[]` | `string[]` | Per-task hook subscriptions (Phase 4) |
| `plugin_paths[]` | `string[]` | Per-task plugin loader |
| `default_input_template` | `string` | Default prompt scaffold for "Run task once" |
| `success_schema` | JsonSchema | **PRD's centerpiece**: validate `ResultMessage.structured_output` against this on every run |
| `schedule{}` | structured (see §6) | Replaces flat `schedule` string |
| `steps[]` | `WorkflowStep[]` | **Folded from workflows** (see §2) — multi-step tasks are now first-class on Task |

### 1.3 Migration

Read-time normalization in `src/gateway/cron-scheduler.ts:parseCronJobs`. No file relocation. On WRITE (new save), only canonical names go to YAML. On READ, both old + new are accepted.

**Rollback:** previous CRON.md remains valid because new fields are added as `?optional`. Reverting to 1.18.x: drop new fields silently.

---

## 2. Workflow merger into Task

Today: `vault/00-System/workflows/<id>.md` files + `WorkflowDefinition` in `src/types.ts:743-758`.

Plan: workflows become Tasks with `steps[]` populated. Each `WorkflowStep` becomes a `Task.steps[i]`.

### 2.1 Field mapping

| Workflow field | Task field | Notes |
|---|---|---|
| `name` | `name` | direct |
| `description` | `description` | direct |
| `enabled` | `enabled` | direct |
| `trigger.schedule` | `schedule.cron_expr` | direct |
| `trigger.manual` | derived: `schedule.kind === 'manual'` | |
| `inputs{}` | `default_input_template` (rendered) | reshape |
| `steps[]` | `steps[]` | direct — `WorkflowStep` shape preserved |
| `synthesis.prompt` | `prompt` | becomes the final-step prompt for synthesis |
| `sourceFile` | derived: `vault/.../<id>.md` | dropped from canonical schema; computed |
| `agentSlug` | `agent_slug` | rename |
| `project` | `cwd` (when set) | merge |
| `model` | `model` | direct |

### 2.2 Migration

Phase 1 read-side coalescing: `TaskStore.list()` returns the union of `parseCronJobs(CRON.md)` + `parseWorkflows(workflows/*.md)`, both mapped onto the unified Task shape. Files stay where they are. Saves go to whichever physical location matches the Task type (single-prompt → CRON.md frontmatter, multi-step → workflows/<id>.md).

In Phase 5 (Versions), introduce `tasks/<id>.md` as the canonical file. Old paths kept readable for one more release, then auto-migrated.

**Rollback:** if Phase 1 needs to revert, the dual-read keeps old paths valid. Just stop emitting the unified Task surface in the dashboard.

---

## 3. McpToolBinding (net-new)

Today: only job-level (`allowed_tools`/`allowed_mcp_servers`) + profile-level allowlists.

PRD: per-task per-tool record:
```ts
McpToolBinding {
  mcp_server_id: string,
  tool_name: string,
  visibility: 'allowed' | 'disallowed' | 'ask',
  scope: 'task' | 'run',
}
```

### 3.1 Migration

Phase 2 introduces `McpToolBinding[]` as a Task field (frontmatter or sidecar JSON). Initial population on first read of an existing job:

```
for each tool in (job.allowed_tools ?? []):
  bindings.push({ mcp_server_id: <inferred>, tool_name: tool, visibility: 'allowed', scope: 'task' })
for each server in (job.allowed_mcp_servers ?? []):
  for each tool in server.exposed_tools:
    bindings.push({ mcp_server_id: server.id, tool_name: tool, visibility: 'allowed', scope: 'task' })
```

Old `allowed_tools` and `allowed_mcp_servers` stay readable; new saves write `McpToolBinding[]` only. After 2 releases, drop the old reads.

**Rollback:** if McpToolBinding rollout breaks, fall back to old computation in `computeEffectiveAllowedTools` (`src/agent/run-agent-cron.ts:61-93`) — which still reads the legacy fields.

---

## 4. Run entity (CronRunEntry → Run)

### 4.1 Renames

| Old (TS / JSONL) | New (PRD) | Type |
|---|---|---|
| `jobName` | `task_id` | rename |
| `startedAt` | `started_at` | rename (snake_case canonical) |
| `finishedAt` | `ended_at` | rename |
| `durationMs` | `duration_ms` | rename |
| `terminalReason` | `stop_reason` | rename |
| `outputPreview` | `result_text` | rename |
| `attempt` | `attempt` | unchanged |
| `error`, `errorType` | `error`, `error_type` | rename |
| `skillsApplied` | `skills_applied` | rename |
| `skillsMissing` | `skills_missing` | rename |
| `allowedToolsApplied` | `allowed_tools_applied` | rename |
| `mcpServersApplied` | `mcp_servers_applied` | rename |

### 4.2 Net-new fields

| New | Type | Purpose |
|---|---|---|
| `id` | `string` (UUID) | Stable run ID; replaces composite `jobName + startedAt` |
| `task_id` | `string` | Reference to the Task |
| `session_id` | `string` | SDK session id from `SystemMessage` |
| `parent_run_id` | `string?` | For forks/replays |
| **`trigger`** | `'manual' \| 'scheduled' \| 'webhook' \| 'api' \| 'fork' \| 'resume' \| 'discord'` | **Fixes the missing trigger source** |
| `prompt` | `string` | Snapshotted at fire-time |
| `cwd` | `string` | Snapshotted at fire-time |
| `duration_api_ms` | `number` | Time spent in model API vs total |
| `num_turns` | `number` | From `ResultMessage.numTurns` |
| `total_cost_usd` | `number` | From `ResultMessage` |
| `usage{}` | structured | Token usage from `ResultMessage` |
| `model_usage{}` | structured | Per-model breakdown for fallback runs |
| `is_error` | `boolean` | Derived from `status` |
| **`structured_output`** | `unknown` | **Validated against `Task.success_schema`** |
| `options_snapshot` | `Record<string, unknown>` | Full SDK options at fire-time |
| `mcp_status_snapshot` | `Record<string, ServerStatus>` | MCP server status at fire-time |
| `custom_title` | `string?` | User-friendly run name |
| `tag` | `string?` | Free-form tag (e.g. `dry-run`, `regression-test`) |
| `rate_limit_state` | structured? | Captured from `RateLimitEvent` |

### 4.3 Migration

Append-only JSONL. Existing entries stay readable (1.18.76 already added running/timeout/lost states). New entries write the PRD schema. Read-time normalization in `CronRunLog.readRecent` accepts both shapes.

**Rollback:** old JSONL stays valid. New JSONL has unknown fields; readers ignore them.

---

## 5. Event store (net-new)

Today: `~/.clementine/logs/audit.jsonl` (mixed event types, not run-scoped).

PRD: `Event` rows per Run, indexed by `(run_id, ts)` and `(tool_use_id)`.

### 5.1 New store

`~/.clementine/events/<run_id>.jsonl` — one file per Run. Append-only. Same auto-prune pattern as `CronRunLog` (2MB / 2000 lines).

Writer: new `EventLog` class in `src/gateway/event-log.ts` (Phase 4). Three writers feed it:
1. **Path A** in-process tap in `src/agent/run-agent.ts` and `src/agent/run-agent-cron.ts`
2. **Path B** hook side-channel CLI (`src/cli/hooks-cli.ts`)
3. **Path C** subagent backfill on `SubagentStop` (`src/agent/subagent-backfill.ts`)

### 5.2 Migration

`audit.jsonl` keeps writing for one release for back-compat. New surfaces (Run detail, metrics dashboards) read only from the Event store. After Phase 6 ships, audit.jsonl can be removed.

**Rollback:** if Path A/B/C have bugs, dashboards fall back to audit.jsonl reads (slower, fewer fields, but functional).

---

## 6. Schedule entity (flat string → structured)

Today: `schedule: '0 8 * * *'` (cron expression only) + optional `after: 'other-job-name'`.

PRD: `Schedule{kind, cron_expr?, interval_seconds?, webhook_url?, event_match?, session_target?, enabled, last_run_id?, next_run_at?, delivery_context?}`.

### 6.1 Migration

Phase 1 read-time mapping:
- `if schedule starts with '@reboot' or contains 5-6 fields` → `kind: 'cron', cron_expr: <value>`
- `else` → `kind: 'manual'`
- `after` field stays separate (the chain trigger is orthogonal to the kind)

New saves write the structured form when the user picks `interval`/`webhook`/`event`/`discord` in the editor. Cron remains the default.

**Rollback:** read-time mapping handles both shapes. Old saves keep working.

---

## 7. Failure taxonomy rename

Existing `JobHealthKind` (`src/gateway/job-health.ts:4-15`) → PRD's 11 categories.

| Existing bucket | PRD bucket | Notes |
|---|---|---|
| `healthy` | (terminal — not an error) | Stays as `Run.status === 'success'`; not in failure taxonomy |
| `recovered` | (terminal — not an error) | Stays as run-level meta on next-success-after-failure |
| `partial` | `tool_error` | Delivery-failed runs surface as tool_error in the new taxonomy |
| `context_overflow` | `context_error` | Direct rename |
| `prompt_too_large` | `context_error` | Same bucket — rename and merge |
| `usage_blocked` | `model_error` | Anthropic billing/limit failures |
| `auth` | `model_error` | 401/403 from API |
| `rate_limited` | `model_error` | 429 |
| `tool_scope` | `tool_error` | Permission-denied tool calls |
| `failed` | `tool_error` (default), or `model_error` if SDK terminalReason indicates so | Catch-all today; Phase 4 disambiguates by inspecting `terminalReason` |
| `unknown` | `infrastructure_error` | When classification fails entirely |

### 7.1 Net-new PRD categories not in existing taxonomy

| PRD bucket | Detection signal |
|---|---|
| `model_output_error` | `stop_reason: 'refusal'`, empty content, invalid tool-call JSON |
| `tool_timeout` | tool_error subtype with timeout signature; MCP status flips to failed |
| `schema_error` | `success_schema` validation failure or hook validator |
| `prompt_error` | hook decision `block`, `permission_decision: 'deny'` |
| `agent_loop_error` | `num_turns >= max_turns`, `stop_reason: 'max_turns'` |
| `subagent_error` | `SubagentStop` with is_error |
| `cancelled` | `client.interrupt()`, `stop_reason: 'stop_sequence'` from abort |

### 7.2 Migration

Phase 4 adds the new classifier in `src/gateway/job-health.ts`. The function name becomes `classifyRunFailure()` and returns one of the PRD's 11 buckets. The old `classifyRunHealth()` is kept as a deprecated alias that maps to the new categories via the table above.

**Re-classification of historical run logs:** one-shot script `scripts/migrate-failure-taxonomy.ts` reads every `~/.clementine/cron/runs/*.jsonl`, applies the new classifier, and rewrites entries with the new `failure_category` field. Idempotent — running twice is a no-op.

**Rollback:** old classifier stays. If Phase 4's classifier mis-buckets, revert to `classifyRunHealth` and re-run the migration script with a flag that picks the old buckets.

---

## 8. SubagentInvocation surface

Today: SQLite `transcripts` table (`src/memory/store.ts:230-296`). Keyed by `session_key` (composite).

PRD: per-invocation entity with `id`, `run_id`, `parent_invocation_id`, etc. Stored as a SQLite **view** over the transcripts table, not a new physical table.

### 8.1 Migration

Phase 4 adds:
- `transcripts.run_id` column (nullable, populated by Path A)
- `transcripts.tool_use_id` column (populated by Path C from JSONL backfill)
- View `subagent_invocations` aggregating message rows into invocation records

**Rollback:** new columns are nullable and additive. Drop the view, the underlying table is unchanged.

---

## 9. `cron-running.json` sidecar

Already exists (`src/gateway/cron-scheduler.ts:586`). Used by 1.18.76 concurrency lock and 1.18.x daemon-restart reconciliation.

Phase 4 extends to add `trigger` field per entry so Run detail can render trigger source for in-flight runs:

```json
[
  { "jobName": "...", "startedAt": "...", "runId": "...", "pid": 12345, "trigger": "discord" }
]
```

**Migration:** additive. Old entries without `trigger` default to `'manual'` on read.

---

## 10. Migration order (executes phase-by-phase)

| Phase | Migrations |
|---|---|
| **0** | None (docs only) |
| **1** (Task editor) | §1 (Task fields) + §2 (workflow merger) + §6 (Schedule structured) |
| **2** (Tools & MCP) | §3 (McpToolBinding) |
| **3** (Run list) | §4.2 partial (`trigger`, `id`, `session_id`) |
| **4** (Run detail + ingestion) | §4 full + §5 (Event store) + §7 (failure taxonomy) + §8 (subagent view) + §9 (sidecar trigger) |
| **5** (Versions) | None new (Versions writes alongside existing files) |
| **6** (Metrics) | None new (reads from Event store) |

---

## 11. Sign-off checklist

- [ ] Every old field has either a rename, a deprecation alias, or a removal note
- [ ] Every PRD entity field marked MISSING in the audit has a migration plan here
- [ ] Failure taxonomy mapping covers all 11 existing buckets and all 11 PRD buckets
- [ ] Rollback paths are documented for every additive change
- [ ] No file relocations are required to ship Phase 1 (workflows + cron stay in place; canonical migration deferred to Phase 5)

Human reviewer signature: **___________________________**
Date: **___________________________**
