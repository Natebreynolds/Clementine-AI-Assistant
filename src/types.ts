/**
 * Clementine TypeScript — Shared types.
 */

// ── Memory / Search ──────────────────────────────────────────────────

export interface SearchResult {
  sourceFile: string;
  section: string;
  content: string;
  score: float;
  chunkType: string;
  matchType: 'fts' | 'recency' | 'timeline' | 'vector' | 'graph';
  lastUpdated: string;
  chunkId: number;
  salience: number;
  lastOutcomeScore?: number;
  agentSlug?: string | null;
  category?: string | null;
  topic?: string | null;
  pinned?: boolean;
  confidence?: number;
}

export type ChunkCategory = 'facts' | 'events' | 'discoveries' | 'preferences' | 'advice' | 'procedure';

export interface Chunk {
  sourceFile: string;
  section: string;
  content: string;
  chunkType: 'frontmatter' | 'heading' | 'preamble' | 'episodic';
  frontmatterJson: string;
  contentHash: string;
  category?: ChunkCategory | null;
  topic?: string | null;
}

export interface SyncStats {
  filesScanned: number;
  filesUpdated: number;
  filesDeleted: number;
  chunksTotal: number;
}

// ── Sessions ─────────────────────────────────────────────────────────

export interface SessionData {
  sessionId: string;
  exchanges: number;
  timestamp: string;
  exchangeHistory: Array<{ user: string; assistant: string }>;
  pendingContext?: Array<{ user: string; assistant: string }>;
}

// ── Session Provenance ──────────────────────────────────────────────

/** Origin context for a session — who/what created it and with what authority. */
export interface SessionProvenance {
  /** Channel that originated this session (e.g., 'discord', 'slack', 'cron', 'heartbeat', 'dashboard'). */
  channel: string;
  /** User ID within the channel (e.g., Discord user ID), or 'system' for autonomous. */
  userId: string;
  /** Interaction source determines trust level. */
  source: 'owner-dm' | 'owner-channel' | 'member-channel' | 'autonomous';
  /** Parent session key if spawned by another session (e.g., !plan sub-tasks). */
  spawnedBy?: string;
  /** Depth in the spawn hierarchy: 0 = top-level, 1 = sub-task, etc. */
  spawnDepth: number;
  /** Role assigned at spawn time — immutable once set. */
  role: 'primary' | 'orchestrator' | 'worker';
  /** What this session can control: 'children' = own spawns only, 'none' = no control. */
  controlScope: 'children' | 'none';
  /** ISO timestamp of session creation. */
  createdAt: string;
}

// ── Channel Messages ─────────────────────────────────────────────────

export interface ChannelMessage {
  sessionKey: string;
  text: string;
  channel: string;
  userId: string;
  attachments?: Attachment[];
}

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
  localPath?: string;
}

// ── Channel Capabilities ────────────────────────────────────────────

/** Declares what a channel can do, enabling graceful degradation. */
export interface ChannelCapabilities {
  /** Channel supports threaded conversations. */
  threads: boolean;
  /** Channel supports rich text (markdown, formatting). */
  richText: boolean;
  /** Channel supports file/image attachments. */
  attachments: boolean;
  /** Channel supports interactive buttons/actions. */
  buttons: boolean;
  /** Channel supports emoji reactions. */
  reactions: boolean;
  /** Channel supports typing indicators. */
  typingIndicators: boolean;
  /** Channel supports editing previously sent messages. */
  editMessages: boolean;
  /** Channel supports inline images in responses. */
  inlineImages: boolean;
  /** Maximum message length (0 = unlimited). */
  maxMessageLength: number;
}

/** Default capabilities for channels that don't declare their own. */
export const DEFAULT_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  threads: false,
  richText: false,
  attachments: false,
  buttons: false,
  reactions: false,
  typingIndicators: false,
  editMessages: false,
  inlineImages: false,
  maxMessageLength: 0,
};

// ── Gateway ──────────────────────────────────────────────────────────

export type OnTextCallback = (text: string) => Promise<void>;

export type OnToolActivityCallback = (toolName: string, toolInput: Record<string, unknown>) => Promise<void>;

/**
 * Pre-query progress callback. Fired at stage transitions BEFORE the SDK
 * query starts (routing, complexity classification, lock waits, etc.) so
 * the user sees the indicator change instead of staring at "thinking..."
 * for several seconds.
 */
export type OnProgressCallback = (status: string) => Promise<void>;

export interface NotificationContext {
  agentSlug?: string;
  /** When set, the dispatcher routes the message back to the channel that owns this session. */
  sessionKey?: string;
}

export type NotificationSender = (text: string, context?: NotificationContext) => Promise<void>;

// ── Send Policy (SDR / Autonomous Email) ────────────────────────────

/** Policy governing autonomous outbound email sending for an agent. */
export interface SendPolicy {
  /** Maximum emails this agent can send per calendar day. */
  maxDailyEmails: number;
  /** Glob patterns for allowed email templates (e.g., ['intro-*', 'followup-*']). Omit to allow any. */
  allowedTemplates?: string[];
  /** When human approval is required: 'none' = fully autonomous, 'first-in-sequence' = approve first email per lead, 'all' = approve every send. */
  requiresApproval: 'none' | 'first-in-sequence' | 'all';
  /** If true, restrict sends to 8am–6pm in the system timezone. */
  businessHoursOnly?: boolean;
}

// ── Agent Profiles ───────────────────────────────────────────────────

export interface TeamAgentConfig {
  channelName: string | string[];  // Discord channel name(s) (e.g., "research" or ["research", "general"])
  channels: string[];              // Resolved runtime channel keys (populated by bot on connect)
  canMessage: string[];            // Agent slugs this agent can directly message
  allowedTools?: string[];         // Tool whitelist (omit = all tools)
  allowedUsers?: string[];         // Discord/Slack user IDs allowed to interact (omit = owner only)
  teamChat?: boolean;              // If true, this is a shared team channel — multiple agents respond when @mentioned
  respondToAll?: boolean;          // If true, agent responds to all messages (not just @mentions) even in team chat
}

export interface TeamMessage {
  id: string;                      // 8-char hex
  fromAgent: string;               // Sender agent slug
  toAgent: string;                 // Recipient agent slug
  content: string;                 // Message body
  timestamp: string;               // ISO
  delivered: boolean;              // Was it injected into target session?
  depth: number;                   // Depth counter for anti-loop (0 = original)
  response?: string;               // Agent's response (populated by active bot delivery)
  protocol?: 'fire-and-forget' | 'request' | 'response' | 'broadcast';
  requestId?: string;              // Links request/response pairs
  replyTo?: string;                // requestId this is replying to
  expectedBy?: string;             // ISO timestamp — when requester needs reply
}

export interface PendingRequest {
  requestId: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: string;
  expectedBy?: string;
  status: 'pending' | 'responded' | 'expired';
  responseMessageId?: string;
}

export interface AgentProfile {
  slug: string;
  name: string;
  tier: number;
  description: string;
  systemPromptBody: string;
  model?: string;
  avatar?: string;                 // URL for agent avatar
  team?: TeamAgentConfig;          // Present if agent has a channel assignment
  project?: string;                // Bind agent to a single project (legacy — use projects[] for multiple)
  projects?: string[];             // Bind agent to multiple projects from projects.json
  agentDir?: string;               // Path to agent's directory (agents/{slug}/)
  discordToken?: string;           // Dedicated Discord bot token (gives agent its own bot presence)
  discordChannelId?: string;       // Channel ID for the agent bot to listen in (auto-discovered from channelName if omitted)
  slackBotToken?: string;          // Slack bot token (xoxb-...) for agent's own Slack presence
  slackAppToken?: string;          // Slack app token (xapp-...) required for Socket Mode
  slackChannelId?: string;         // Explicit Slack channel ID override
  sendPolicy?: SendPolicy;         // Autonomous outbound email policy (SDR agents)
  allowedMcpServers?: string[];    // MCP servers this agent can access (empty = all enabled)
  status?: AgentStatus;            // Persistent agent status (default: active)
  budgetMonthlyCents?: number;     // Monthly token budget in cents (0 = unlimited)
  spentMonthlyCents?: number;      // Current month's spend (computed from usage_log)
  strictMemoryIsolation?: boolean; // If true (default), only see own + global memory. false = soft boost (legacy).
  /**
   * Active-hours window for adaptive heartbeat cadence. Decimal hours in
   * the local timezone, e.g., { start: 8, end: 18 } = 8:00am–6:00pm.
   * When the current time is outside this window, the agent's next-check
   * interval is multiplied by 4. Parsed from `active_hours: "HH:MM-HH:MM"`
   * in agent.md frontmatter; same-day windows only.
   */
  activeHours?: { start: number; end: number };
  /**
   * Short imperative routing hints used to build this agent's
   * AgentDefinition.description for SDK auto-routing. Each entry is a
   * capability phrase the main agent might match against user input
   * (e.g., "outbound prospect emails", "content calendar drafting").
   * Free-form strings, comma-joined when assembled. Optional.
   */
  routingHints?: string[];
  /**
   * Short label describing the role (e.g., "SDR", "CMO"). Used in the
   * routing description when present.
   */
  role?: string;
  /**
   * SDK reasoning effort tier when this profile runs as a subagent.
   * Defaults to 'medium' if unset. Low = Haiku-style cheap fanout,
   * High = deep reasoning, Max = max effort.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export type AgentStatus = 'active' | 'paused' | 'error' | 'terminated';

// ── Heartbeat ────────────────────────────────────────────────────────

export interface HeartbeatReportedTopic {
  topic: string;
  summary: string;
  reportedAt: string;
  agentSlug?: string;
}

export interface HeartbeatState {
  fingerprint: string;
  details: Record<string, number | string>;
  timestamp: string;
  reportedTopics?: HeartbeatReportedTopic[];
  consecutiveSilentBeats?: number;
  lastDiscordMessageAt?: string;
  /** Persisted scheduling dates — survive process restarts */
  lastSelfImproveDate?: string;
  lastConsolidationDate?: string;
  lastAgentSiRuns?: Record<string, string>;
  lastSkillDecayDate?: string;
  lastSalienceDecayDate?: string;
  lastMemoryPulseDate?: string;
  /** Proactive insight engine state */
  insightState?: {
    sentToday: string[];
    lastSentAt?: string;
    unackedCount: number;
    cooldownMultiplier: number;
    currentDate?: string;
  };
}

export interface HeartbeatWorkItem {
  id: string;
  description: string;
  prompt: string;
  source: string;
  // Stable hash used for cross-tick dedup. When omitted, dedup falls back to `source`.
  idempotencyKey?: string;
  priority: 'high' | 'normal';
  queuedAt: string;
  maxTurns: number;
  tier: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  completedAt?: string;
  result?: string;
  error?: string;
  agentSlug?: string;
}

// ── Background tasks ─────────────────────────────────────────────────

/**
 * Long-running autonomous task an agent kicks off via the
 * `start_background_task` MCP tool. The task runs in the daemon as an
 * unleashed cron-style job with the requesting agent's profile, then
 * notifies that agent's Discord channel on completion.
 *
 * Lifecycle: pending → running → (done | failed | aborted)
 *
 * Persisted as ~/.clementine/background-tasks/<id>.json. The file is
 * the source of truth; status is updated in place as the task progresses.
 */
export interface BackgroundTask {
  id: string;
  fromAgent: string;          // Slug of the agent that initiated the task
  sessionKey?: string;        // Chat/session that requested the task, when user-visible
  prompt: string;             // The full task prompt
  maxMinutes: number;         // Hard wall-clock cap
  status: 'pending' | 'running' | 'done' | 'failed' | 'aborted';
  createdAt: string;          // ISO when the request was filed (status='pending')
  startedAt?: string;         // ISO when the daemon actually picked it up
  completedAt?: string;       // ISO when terminal status was reached
  result?: string;            // Final output (truncated to ~3KB on save)
  error?: string;             // If status='failed' or 'aborted'
  deliverableNote?: string;   // Optional vault path produced by the run
}

// ── Per-agent heartbeat ──────────────────────────────────────────────

/**
 * State for one specialist agent's heartbeat scheduler. Persisted at
 * ~/.clementine/heartbeat/agents/<slug>/state.json. Manager reads
 * `nextCheckAt` to decide whether the agent is due for a tick.
 */
export interface AgentHeartbeatState {
  slug: string;
  lastTickAt: string;          // ISO timestamp of the last tick (cheap or LLM)
  nextCheckAt: string;         // ISO timestamp at which the agent is next due
  silentTickCount: number;     // Consecutive ticks with no signal change (bounds idle cost)
  fingerprint: string;         // Hash of "anything material" — unchanged → silent tick
  lastSignalSummary?: string;  // Short note: last reason a tick lit up
  /**
   * Outcome of the last tick. Drives adaptive cadence:
   *   - 'acted' → next check at active-mode interval (10 min default)
   *   - 'quiet' → next check at quiet interval (60 min)
   *   - 'silent' → exponential backoff (30 → 60 → 120 → 240 → 480, capped)
   *   - 'override' → agent explicitly set [NEXT_CHECK: Xm], honored as-is
   *   - undefined → first tick or pre-1.0.84 state
   */
  lastTickKind?: 'acted' | 'quiet' | 'silent' | 'override';
}

// ── Skills (Skills-First redesign — Phase A / Phase A.5) ─────────────
//
// Skills are reusable units of work. The format is **Anthropic-compatible**:
// every skill has only two required frontmatter fields (`name` and
// `description`) and a markdown body. Skills authored against the
// Anthropic Agent Skills spec (https://platform.claude.com/docs/en/
// agents-and-tools/agent-skills/) load unmodified.
//
// On top of the canonical fields we layer **Clementine-specific extensions**
// under a `clementine:` namespace so a vanilla Anthropic skill drops in
// cleanly while a Clementine skill can additionally declare typed inputs,
// tool policies, owned state, success criteria, and limits — concepts our
// cron triggers need but Anthropic doesn't standardize.
//
// File layouts the loader supports:
//   1. **Anthropic folder form** (preferred):
//        <skills-dir>/<skill-name>/SKILL.md      ← entry point (capital)
//        <skills-dir>/<skill-name>/FORMS.md      ← bundled, loaded on demand
//        <skills-dir>/<skill-name>/scripts/*.py  ← bundled, executed via bash
//   2. **Clementine flat form** (legacy):
//        <skills-dir>/<skill-name>.md            ← single-file skill, no bundles
//
// Skills directories the loader scans (per-project wins on name collision):
//   - global:      ~/.clementine/vault/00-System/skills/
//   - per-project: <work_dir>/.clementine/skills/

/** Where a skill was loaded from. Per-project skills shadow global. */
export type SkillScope = 'global' | 'project';

/** Three states the dashboard surfaces as badges:
 *    'anthropic' — only `name` + `description` (vanilla Anthropic spec)
 *    'clementine' — has the `clementine:` namespace with extensions
 *    'legacy'    — pre-redesign flat frontmatter (title/triggers/toolsUsed) */
export type SkillSchemaVersion = 'anthropic' | 'clementine' | 'legacy';

/** Whether the on-disk layout is a folder-with-SKILL.md (Anthropic spec)
 *  or a single .md file (Clementine flat legacy). New skills should be
 *  created in folder form so they can grow bundled files later. */
export type SkillLayout = 'folder' | 'flat';

/** A typed skill input — backed by JSON Schema. Used in `clementine.inputs`. */
export interface SkillInputSchema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: SkillInputSchema;
  properties?: Record<string, SkillInputSchema>;
  required?: string[];
}

/** Declarative entry describing where a skill reads data from. */
export interface SkillDataSource {
  /** Loose identifier — 'outlook', 'memory', 'vault', 'cli', 'mcp:ElevenLabs'. */
  kind: string;
  /** One-line human description of what gets read. */
  purpose: string;
}

/** Tool allowlist + denylist. Deny wins on conflict. Phase C runtime
 *  refuses tools not in `allow`, even when a trigger tries to override. */
export interface SkillToolPolicy {
  allow?: string[];
  deny?: string[];
}

/** Success criterion — JSON Schema (ajv-validated) and/or free-text. */
export interface SkillSuccess {
  schema?: SkillInputSchema;
  criterion?: string;
}

/** Per-skill caps. A trigger can tighten but never loosen. */
export interface SkillLimits {
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutSeconds?: number;
}

/** Clementine-specific extensions. All optional. Lives under the
 *  `clementine:` key in the YAML frontmatter so an Anthropic skill that
 *  doesn't have these stays valid. */
export interface ClementineSkillExtensions {
  /** Typed parameters the skill accepts at invocation time. */
  inputs?: Record<string, SkillInputSchema>;
  /** Tool allowlist + denylist enforced by the runtime. */
  tools?: SkillToolPolicy;
  /** Where the skill reads data from — purely declarative. */
  dataSources?: SkillDataSource[];
  /** state.* keys this skill owns. Others can't touch them. */
  stateKeys?: string[];
  /** Success criterion — schema and/or free-text evaluator. */
  success?: SkillSuccess;
  /** Caps the trigger can tighten but never loosen. */
  limits?: SkillLimits;
  /** Skill version — bumped on Publish in Phase B. */
  version?: number;
  /** Timestamps Clementine captures. */
  createdAt?: string;
  updatedAt?: string;
  lastUsed?: string;
  /** Last successful "Test this skill" run (Phase B). */
  lastTestPass?: string;
  // ── Legacy Clementine concepts preserved through migration ─────────
  /** Legacy: NLP-style trigger phrases the pre-redesign chat router used
   *  to match incoming messages against this skill. Preserved for the
   *  migration UI; not enforced. */
  triggers?: string[];
  /** Legacy: 'manual' / 'auto' / 'imported' — provenance label on the
   *  pre-redesign skills. */
  source?: string;
  /** Legacy: incrementing counter of runs that invoked the skill. */
  useCount?: number;
  // ── Migration provenance (stamped by migrateLegacySkill) ───────────
  /** Filename the original legacy skill was migrated from. Helps the
   *  migration UI show what came from where. */
  migratedFrom?: string;
  /** ISO timestamp of when the migration ran. */
  migratedAt?: string;
}

/** Parsed frontmatter. Anthropic-canonical fields are top-level; our
 *  extensions live under `clementine`. Legacy fields (title/triggers/
 *  toolsUsed/useCount) are also top-level — they're what the existing
 *  pre-redesign skills already use and we keep them readable. */
export interface SkillFrontmatter {
  // ── Anthropic-canonical (REQUIRED on every skill) ────────────────────
  /** Skill identifier. Filename is canonical; this field is honored when
   *  set but not required. Anthropic spec: max 64 chars, lowercase letters
   *  + numbers + hyphens, no XML, no reserved words ('anthropic'/'claude'). */
  name: string;
  /** What the skill does AND when to use it (third person). Anthropic
   *  spec: non-empty, max 1024 chars, no XML tags. */
  description?: string;

  // ── Clementine extensions (under `clementine:` in YAML) ──────────────
  /** Optional namespace for cron-tailored fields. Absent on vanilla
   *  Anthropic skills; present on Clementine-extended skills. */
  clementine?: ClementineSkillExtensions;

  // ── Legacy pre-redesign fields (top-level for back-compat) ───────────
  /** Legacy: human-friendly display title. Falls back to `name` when absent. */
  title?: string;
  /** Legacy: NLP-style trigger phrases for chat-message matching. */
  triggers?: string[];
  /** Legacy: 'manual' / 'auto' / 'imported' — provenance label. */
  source?: string;
  /** Legacy: tools observed during runs. Informational, not enforced. */
  toolsUsed?: string[];
  /** Legacy: incrementing counter of runs that invoked the skill. */
  useCount?: number;
}

/** A bundled file inside a folder-form skill. `kind` distinguishes
 *  loadable markdown from executable scripts so the dashboard can
 *  render them differently. */
export interface SkillBundledFile {
  /** Path relative to the skill folder (e.g. 'FORMS.md', 'scripts/extract.py'). */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Loose categorization for rendering: markdown reference vs script vs other. */
  kind: 'markdown' | 'script' | 'other';
  /** File size in bytes — surfaced as "X KB" in the dashboard. */
  sizeBytes: number;
}

/** A validation finding for a skill — surfaced in the dashboard so
 *  authors can see what to fix. Severity 'error' indicates a spec
 *  violation (rejected by Anthropic API); 'warning' is a best-practice
 *  hint (still loadable). */
export interface SkillValidationWarning {
  severity: 'error' | 'warning';
  field: 'name' | 'description' | 'body' | 'frontmatter' | 'layout';
  message: string;
}

/** Resolved skill record — frontmatter + body + computed extras the
 *  dashboard surfaces. */
export interface Skill {
  /** Parsed frontmatter (or synthesized when none / unparseable). */
  frontmatter: SkillFrontmatter;
  /** Markdown body of the skill (the actual procedure). */
  body: string;
  /** Absolute path to the entry-point file. For folder-form skills this
   *  points at <folder>/SKILL.md. For flat skills it points at <name>.md. */
  filePath: string;
  /** Where this skill was loaded from (global vs per-project). */
  scope: SkillScope;
  /** Folder-form (Anthropic-spec) vs flat-file (Clementine legacy). */
  layout: SkillLayout;
  /** Anthropic / clementine / legacy — drives the schema badge. */
  schemaVersion: SkillSchemaVersion;
  /** Sibling .md files + scripts/ contents (only populated for folder-form). */
  bundledFiles: SkillBundledFile[];
  /** Used-by join: cron jobs that reference this skill via skills[]. */
  usedByTriggers: string[];
  /** Validation findings — populated lazily so listSkills stays cheap. */
  validation: SkillValidationWarning[];
}

// ── Cron Jobs ────────────────────────────────────────────────────────

export interface CronJobDefinition {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  tier: number;
  /** Human-readable description of what this task does (one paragraph, ~200
   *  chars). Surfaces on the task card as the preview line — replaces the
   *  "first sentence of prompt" fallback when present. Auto-populated by
   *  the cron-migrator from the matching skill's description. Optional. */
  description?: string;
  maxTurns?: number;
  model?: string;
  workDir?: string;
  /** Display/intent hint — 'unleashed' jobs are typically long autonomous
   *  tasks. The canonical SDK path runs every job through runAgentCron
   *  identically; this field affects only UI badges + budget heuristics. */
  mode?: 'standard' | 'unleashed';
  /** Wall-clock cap in hours. Defaults to 1h. Triggers an AbortSignal
   *  on the runAgentCron call when exceeded. */
  maxHours?: number;
  maxRetries?: number;
  after?: string;
  agentSlug?: string;              // Agent that owns this cron job (scoped execution)
  /** @deprecated Use successCriteriaText (free-text) or successSchema (JSON Schema)
   *  per PRD Phase 1. successCriteria is kept readable for one release; on read,
   *  parseCronJobs coalesces it into successCriteriaText. */
  successCriteria?: string[];
  /** PRD Phase 1: free-text "this task is done when…". An evaluator sub-agent reads
   *  the run's final state and the criterion and emits a pass/fail with reasoning.
   *  Stored as RunEvaluation on the Run. Optional but recommended. */
  successCriteriaText?: string;
  /** PRD Phase 1: JSON Schema validated against ResultMessage.structured_output.
   *  If it parses, the run is mechanically successful. The Task editor shows a
   *  non-blocking "Goal not set" warning when neither this nor successCriteriaText
   *  is present. */
  successSchema?: Record<string, unknown>;
  /** PRD Phase 1: read scope beyond the cwd (workDir). Surfaced as a chip list
   *  in the editor's Scope tab. The runner passes these to the SDK as add_dirs. */
  addDirs?: string[];
  alwaysDeliver?: boolean;         // If true, retry once with explicit prompt when response is empty/noise
  context?: string;                 // Freeform context/notes injected into prompt at runtime (training data, guidelines, etc.)
  preCheck?: string;               // Shell command gate — exit 0 = run, non-zero = skip. Stdout injected as context.
  attachments?: string[];          // Filenames in ~/.clementine/attachments/{job-name}/ injected at runtime
  requiresConfirmation?: boolean;  // If true, ask owner before running — auto-proceeds after timeout
  confirmationTimeoutMin?: number; // Minutes to wait for confirmation before auto-proceeding (default: 5)
  // ── Trick capabilities (optional, all backward-compatible) ──────────
  /** Pinned skill slugs (filename-flattened, e.g. "auto-discord-send-message").
   *  Loaded ahead of any auto-matched skills via `loadSkillByName`.
   *  Missing/disabled pins are warned, not fatal. */
  skills?: string[];
  /** Per-trick tool whitelist. When set, intersected with the agent
   *  profile's `team.allowedTools` (when present). 'Agent' is always
   *  force-included so subagent delegation still works. Empty/undefined
   *  preserves today's behavior — falls through to profile or default. */
  allowedTools?: string[];
  /** Per-trick MCP server whitelist (server names from `discoverMcpServers`).
   *  Applied AFTER `buildExtraMcpForRunAgent` runs, so the effective set
   *  is `profile ∩ trick`. */
  allowedMcpServers?: string[];
  /** Free-form tags. Surfaced in the dashboard for grouping/filtering.
   *  No execution-path coupling. */
  tags?: string[];
  /** Single category bucket — convenience for default grouping in the
   *  dashboard (e.g. "ops", "research", "morning"). */
  category?: string;
  /**
   * Predictable mode (the "contract" model) — runs the trick with ONLY
   * the prompt + explicitly-attached skills/criteria/goals + tools. Skips
   * MEMORY.md injection, auto-matched skills, team comms, and delegation
   * queue. The fix for "agent said OK in chat then fired with stale memory."
   *
   * - undefined / false: legacy behavior — runner injects everything
   *   (MEMORY.md, auto-matched skills, team activity, delegation). What
   *   chat-style autonomous work needs, but contaminates scheduled tasks.
   * - true: contract mode — runner only includes what was explicitly
   *   attached. The trick executes the plan you saw in chat, nothing more.
   *
   * `add_cron_job` defaults this to `true` for new chat-created tricks.
   * Existing tricks (no field set) keep current behavior — backward compat.
   */
  predictable?: boolean;
}

export type LongTaskRisk = 'normal' | 'long' | 'huge' | 'unsafe';
export type LongTaskRoute = 'standard' | 'checkpointed' | 'opus_1m' | 'sonnet_1m' | 'split_required';

export interface LongTaskPreflightSnapshot {
  risk: LongTaskRisk;
  route: LongTaskRoute;
  estimatedInputTokens: number;
  contextWindowTokens: number;
  modelBefore?: string;
  modelAfter?: string;
  modeBefore?: CronJobDefinition['mode'];
  modeAfter?: CronJobDefinition['mode'];
  requiresUserRefinement: boolean;
  canProceedWithApproval?: boolean;
  approvalReason?: string;
  approvalModel?: string;
  reasons: string[];
}

export type TerminalReason =
  | 'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long'
  | 'image_error' | 'model_error' | 'aborted_streaming' | 'aborted_tools'
  | 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred'
  | 'max_turns' | 'completed';

/**
 * PRD §6 Event entity — one row per significant SDK message during a Run.
 * Stored as JSONL at ~/.clementine/events/<run_id>.jsonl. Powers the new
 * Run detail waterfall (Phase 4b) and the metrics dashboards (Phase 6).
 *
 * Designed to fit the SDK's typed message stream + the 12 hook events. Most
 * fields are optional because each event kind populates a different subset.
 */
export interface RunEvent {
  /** Run this event belongs to — links back to CronRunEntry.id. */
  runId: string;
  /** SDK session id once known (system/init lands first; everything else carries it). */
  sessionId?: string;
  /** Monotonic sequence within the run. Used to order events that share a ts. */
  seq: number;
  /** ISO timestamp when the event was captured. */
  ts: string;
  /** Event kind — semantic grouping for the dashboard's span types. */
  kind:
    | 'session_start'
    | 'session_end'
    | 'llm_text'
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'subagent_start'
    | 'subagent_stop'
    | 'rate_limit'
    | 'hook'
    | 'error';
  /** Hook event name when kind='hook' (PreToolUse / PostToolUse / etc.). */
  hookEventName?: string;
  /** Tool name when kind='tool_call' or 'tool_result'. Includes mcp__ prefix. */
  toolName?: string;
  /** SDK-assigned tool_use id — pairs tool_call with its tool_result. */
  toolUseId?: string;
  /** For nested tool calls (parallel sub-spawning). */
  parentToolUseId?: string;
  /** Tool input as JSON, truncated at 8KB. */
  toolInput?: unknown;
  /** Tool result as JSON or string, truncated at 16KB. */
  toolResult?: unknown;
  /** Tool error message when result.is_error or PostToolUseFailure. */
  toolError?: string;
  /** Assistant text block content when kind='llm_text'. */
  text?: string;
  /** ThinkingBlock content when kind='thinking'. */
  thinking?: string;
  /** Cost so far for this run when kind='session_end'. */
  costUsd?: number;
  /** Stop reason from ResultMessage when kind='session_end'. */
  stopReason?: string;
  /** Subagent id when kind='subagent_*' OR when an event was synthesized from
   *  a subagent transcript via Path C backfill (subagent-backfill.ts). */
  agentId?: string;
  /** PRD §6 Phase 4e: subagent slug ("bright-petting-kahn") for friendly
   *  display in the Run detail waterfall. Only populated for events
   *  synthesized from subagent transcripts. */
  subagentSlug?: string;
  /** PRD §6 Phase 4e: marks events as backfilled from a subagent transcript
   *  rather than captured live by the in-process tap. The Run detail viewer
   *  renders these in a nested swimlane and labels the source so users know
   *  the data came from disk after the run. */
  source?: 'live' | 'backfill';
}

/**
 * PRD §9 / 1.18.87: 11-category failure taxonomy. Replaces the existing
 * JobHealthKind union for surfacing-on-the-dashboard purposes (job-health.ts
 * stays as the lower-level classifier and feeds into this).
 *
 * Stamped on CronRunEntry.failureCategory at write-time when the run is a
 * failure (status: 'error' | 'timeout' | 'lost' | retried-final). Powers
 * the Run list filter chip and the Run detail viewer's failure pill.
 */
export type RunFailureCategory =
  | 'model_error'           // Anthropic API errored (usage_blocked, auth, rate_limited, 5xx)
  | 'model_output_error'    // LLM responded but output unusable (refusal, empty, invalid tool-call JSON)
  | 'tool_error'            // Tool/function threw or returned non-zero / blocked
  | 'tool_timeout'          // Tool exceeded deadline
  | 'schema_error'          // success_schema validation failed or tool I/O failed JSON-schema validation
  | 'context_error'         // Context window exceeded, prompt too long, RAG missing
  | 'prompt_error'          // Guardrail trip, permission deny, prompt-injection
  | 'agent_loop_error'      // num_turns >= max_turns, infinite-loop detected
  | 'subagent_error'        // Failure inside a delegated sub-agent
  | 'infrastructure_error'  // SDK runtime, worker crash, OOM, deserialization
  | 'cancelled';            // User/system interrupted the run

export interface CronRunEntry {
  /** PRD §6 / 1.18.85: stable run UUID. Optional only because pre-1.18.85
   *  entries don't have it; new entries always do. The Event store keys
   *  off this id. */
  id?: string;
  jobName: string;
  startedAt: string;
  /** Optional: in-progress runs are appended with status='running' before the
   *  finishedAt is known. The runner replaces or supersedes the entry on
   *  completion. The stale-running sweep emits a closing 'lost' entry for
   *  any 'running' row whose startedAt has aged past the deadline. */
  finishedAt?: string;
  /** 'ok' | 'error' | 'retried' | 'skipped' are terminal. 'running' is in-flight.
   *  'timeout' fires when max_hours is exceeded. 'lost' is appended by the
   *  daemon-boot stale sweep when a 'running' entry has no companion close
   *  (daemon likely crashed mid-run). */
  status: 'ok' | 'error' | 'retried' | 'skipped' | 'running' | 'timeout' | 'lost';
  /** 0 for in-progress 'running' rows; populated when terminal. */
  durationMs: number;
  error?: string;
  errorType?: 'transient' | 'permanent';
  terminalReason?: TerminalReason;  // precise SDK-reported reason for query termination
  attempt: number;
  outputPreview?: string;
  deliveryFailed?: boolean;
  deliveryError?: string;
  longTaskPreflight?: LongTaskPreflightSnapshot;
  advisorApplied?: {
    adjustedMaxTurns?: number;
    adjustedModel?: string;
    adjustedTimeoutMs?: number;
    enriched?: boolean;
    escalated?: boolean;
  };
  // ── Trick capability metadata (which skills/tools/MCP actually ran) ─
  /** Skills injected into the prompt for this run (pinned + auto-matched). */
  skillsApplied?: Array<{ name: string; source: 'pinned' | 'auto'; score?: number }>;
  /** Pinned skills that didn't resolve (deleted/renamed/suppressed). */
  skillsMissing?: string[];
  /** Effective tool allowlist passed to runAgent (post-intersection). Undefined
   *  means the trick didn't override — runAgent fell through to profile/default. */
  allowedToolsApplied?: string[];
  /** MCP servers live for this run (post profile + trick allowlist intersection). */
  mcpServersApplied?: string[];
  /** PRD §6 / 1.18.84: how this run was triggered. Persisted by the
   *  scheduler (cron tick / chained 'after' / manual-run endpoint /
   *  Discord) so the Run list can filter by source instead of guessing
   *  via heuristics on attempt count. */
  trigger?: 'manual' | 'scheduled' | 'webhook' | 'api' | 'fork' | 'resume' | 'discord' | 'after';
  /** PRD §9 / 1.18.87: PRD-canonical failure bucket. Set on every entry
   *  whose status indicates a failure (error/timeout/lost/cancelled). The
   *  Run list filter chip and Run detail header read from this field. */
  failureCategory?: RunFailureCategory;
  /** PRD §12 / 1.18.89: total cost in USD as reported by the SDK's
   *  ResultMessage.total_cost_usd. Stamped on success/error entries by
   *  the scheduler from the runAgent result side-channel. Powers the
   *  Run list Cost column and the Health Strip's 24h cost tile. */
  totalCostUsd?: number;
  /** PRD Phase 1: did the run accomplish what it was supposed to?
   *  Computed at run-end when the Task has successSchema or successCriteriaText.
   *  - status='pass'      both configured checks passed (or the only one configured did)
   *  - status='fail'      a configured check failed
   *  - status='skipped'   no goal configured on the Task (don't show the pill)
   *  - status='error'     evaluator/validator threw; does NOT mark the run failed
   *  This is orthogonal to CronRunEntry.status — a run can be status='ok' with
   *  goalCheck.status='fail' (the agent finished cleanly but didn't accomplish
   *  the stated goal), and that's the failure mode the PRD is designed to surface. */
  goalCheck?: {
    status: 'pass' | 'fail' | 'skipped' | 'error';
    /** Which evaluators ran. 'both' means schema + evaluator agreed. */
    mode: 'schema' | 'evaluator' | 'both';
    schemaPass?: boolean;
    schemaErrors?: string[];      // ajv error[].message, truncated
    evaluatorPass?: boolean;
    evaluatorReason?: string;     // one-sentence reasoning from the evaluator agent
  };
}

// ── Config ───────────────────────────────────────────────────────────

export interface Models {
  haiku: string;
  sonnet: string;
  opus: string;
}

// ── Transcript ───────────────────────────────────────────────────────

export interface TranscriptTurn {
  id?: number;
  sessionKey: string;
  role: string;
  content: string;
  model: string;
  createdAt: string;
}

export interface SessionSummary {
  sessionKey: string;
  summary: string;
  exchangeCount: number;
  createdAt: string;
}

export interface SessionLineageEntry {
  sessionKey: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  reason: string;
  summary: string;
  exchangeCount: number;
  createdAt: string;
}

export interface WikilinkConnection {
  direction: 'incoming' | 'outgoing';
  file: string;
  context: string;
}

// ── Memory Transparency ─────────────────────────────────────────────

export interface MemoryExtraction {
  id?: number;
  sessionKey: string;
  userMessage: string;        // snippet of the user message that triggered extraction
  toolName: string;           // e.g., 'memory_write', 'note_create'
  toolInput: string;          // JSON stringified tool input
  extractedAt: string;        // ISO timestamp
  status:
    | 'active'
    | 'corrected'
    | 'dismissed'
    | 'dedup_skipped'
    | 'skipped:too_short'
    | 'skipped:pure_greeting'
    | 'skipped:rate_limited'
    | 'skipped:injection_blocked'
    | 'skipped:no_memory_store';
  correction?: string;        // replacement fact if corrected
  agentSlug?: string;         // agent that triggered this extraction (null = default/global)
}

// ── Feedback ────────────────────────────────────────────────────────

export interface Feedback {
  id?: number;
  sessionKey?: string;
  channel: string;
  messageSnippet?: string;
  responseSnippet?: string;
  rating: 'positive' | 'negative' | 'mixed';
  comment?: string;
  createdAt?: string;
}

// ── Session Reflections ─────────────────────────────────────────────

export interface SessionReflection {
  id?: number;
  sessionKey: string;
  exchangeCount: number;
  frictionSignals: string[];
  qualityScore: number;            // 1-5
  // Inlined shapes (1.18.122) — the standalone BehavioralCorrection /
  // PreferenceLearned aliases were only used here. Inlining keeps the
  // type expressive without the indirection.
  behavioralCorrections: Array<{
    correction: string;
    category: 'verbosity' | 'tone' | 'workflow' | 'format' | 'accuracy' | 'proactivity' | 'scope';
    strength: 'explicit' | 'implicit';
  }>;
  preferencesLearned: Array<{
    preference: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  agentSlug?: string;
  createdAt?: string;
}

// ── MCP Server Management ───────────────────────────────────────────

export interface ManagedMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;                    // for stdio
  args?: string[];                     // for stdio
  url?: string;                        // for http/sse
  headers?: Record<string, string>;    // for http/sse
  env?: Record<string, string>;        // environment vars
  description: string;
  enabled: boolean;
  source: 'auto-detected' | 'user';   // where it came from
}

// ── User Theory of Mind ─────────────────────────────────────────────

export interface UserModelUpdate {
  field: string;                       // e.g., "expertise.salesforce"
  value: string;                       // e.g., "expert"
  evidence: string;                    // e.g., "user corrected my SOQL query"
  confidence: 'high' | 'medium' | 'low';
}

// ── Procedural Memory (Skills) ──────────────────────────────────────

export interface SkillDocument {
  name: string;                        // kebab-case slug
  title: string;                       // Human-readable title
  description: string;                 // What this skill does (1-2 sentences)
  triggers: string[];                  // Keywords/phrases that should activate this skill
  source: 'unleashed' | 'cron' | 'chat' | 'manual';
  sourceJob?: string;                  // Job name or session key that produced this skill
  agentSlug?: string;                  // Which agent learned this (null = global)
  steps: string;                       // Markdown procedure body
  toolsUsed: string[];                 // MCP tools referenced in the procedure
  useCount: number;
  lastUsed?: string;                   // ISO
  createdAt: string;                   // ISO
  updatedAt: string;                   // ISO
}

// ── Plan Orchestration ───────────────────────────────────────────────

export interface PlanStep {
  id: string;              // "step-1", "step-2"
  description: string;     // Human-readable
  prompt: string;          // Full prompt for the sub-agent
  dependsOn: string[];     // Step IDs this depends on (empty = parallel)
  maxTurns: number;        // Turns budget for this step (default 15, up to 50 for complex)
  tier: number;            // Security tier (default 2)
  model?: string;          // Optional model override (e.g., "haiku" for simple lookups)
  delegateTo?: string;     // Agent slug to delegate this step to (uses their profile, tools, personality)
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  synthesisPrompt: string;
}

// ── Workflow Automation ─────────────────────────────────────────────

export interface WorkflowInput {
  type: 'string' | 'number';
  default?: string;
  description?: string;
}

export type WorkflowStepKind =
  | 'prompt'
  | 'mcp'
  | 'cli'
  | 'channel'
  | 'transform'
  | 'conditional'
  | 'loop';

export interface WorkflowStepMcpConfig {
  server: string;
  tool: string;
  inputs?: Record<string, unknown>;
}

export interface WorkflowStepChannelConfig {
  channel: 'discord' | 'slack' | 'telegram' | 'whatsapp' | 'email' | 'webhook';
  target: string;
  content: string;
}

export interface WorkflowStepTransformConfig {
  expression: string;
}

export interface WorkflowStepConditionalConfig {
  condition: string;
  trueNext?: string[];
  falseNext?: string[];
}

export interface WorkflowStepLoopConfig {
  items: string;
  bodyStepIds: string[];
}

export interface WorkflowStepCanvas {
  x: number;
  y: number;
}

export interface WorkflowStep {
  id: string;
  prompt: string;
  dependsOn: string[];
  model?: string;
  tier: number;
  maxTurns: number;
  workDir?: string;
  kind?: WorkflowStepKind;
  mcp?: WorkflowStepMcpConfig;
  /** CLI step config — inline shape (was the standalone WorkflowStepCliConfig
   *  type that had zero external references; the field stays but the
   *  named alias was dropped in 1.18.122). */
  cli?: {
    cmd: string;                   // CLI binary name (e.g. 'sf', 'gh', 'gcloud')
    args?: string[];               // argv tokens; may include {{steps.x}} templates
    workDir?: string;              // optional cwd; defaults to BASE_DIR
    timeoutMs?: number;            // default 60_000
    captureStderr?: boolean;       // include stderr in output (default: stdout only)
  };
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
  /** Optional linked-project path. Becomes the default cwd for CLI steps and
   *  the fallback workDir for prompt/MCP steps that don't set one explicitly. */
  project?: string;
  /** Default model for prompt steps that don't set their own. e.g. "claude-opus-4-7". */
  model?: string;
}

export type WorkflowOriginKind = 'workflow' | 'cron';

export type WorkflowOwnerScope = 'global' | 'agent';

export interface BuilderWorkflowSummary {
  id: string;
  origin: WorkflowOriginKind;
  scope: WorkflowOwnerScope;
  name: string;
  description: string;
  enabled: boolean;
  schedule?: string;
  stepCount: number;
  sourceFile: string;
  agentSlug?: string;
}

export interface WorkflowRunEntry {
  workflowName: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error' | 'partial';
  durationMs: number;
  inputs: Record<string, string>;
  stepResults: Array<{
    stepId: string;
    status: 'done' | 'failed' | 'skipped';
    durationMs: number;
    outputPreview?: string;
  }>;
  outputPreview?: string;
  error?: string;
}

// ── Self-Improvement ────────────────────────────────────────────────

export interface SelfImproveExperiment {
  id: string;                          // 8-char hex prefix
  iteration: number;                   // Sequential (1, 2, 3...)
  startedAt: string;                   // ISO
  finishedAt: string;                  // ISO
  durationMs: number;
  area: 'soul' | 'cron' | 'workflow' | 'memory' | 'agent' | 'source' | 'communication' | 'goal' | 'advisor-rule' | 'prompt-override';
  target: string;                      // e.g., "SOUL.md personality section"
  hypothesis: string;                  // What the LLM decided to try
  proposedChange: string;              // The actual modification
  baselineScore: number;               // Score before (0-1)
  score: number;                       // Evaluation score (0-1)
  accepted: boolean;                   // Did it pass evaluation threshold?
  approvalStatus: 'pending' | 'approved' | 'denied' | 'expired' | 'unsurfaced';
  reason: string;                      // Why accepted/rejected
  error?: string;
}

/** Tracks a versioned evolution change for rollback chains. */
export interface EvolutionVersion {
  experimentId: string;                // Links back to the experiment
  area: string;
  target: string;
  appliedAt: string;                   // ISO
  parentVersion?: string;              // experimentId of previous change to same target
  rationale: string;                   // Why this change was made
  beforeSnapshot: string;              // Content before the change (for rollback)
  rolledBack?: boolean;
  rolledBackAt?: string;
}

export interface SelfImproveState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastRunAt: string;                   // ISO
  currentIteration: number;
  totalExperiments: number;
  baselineMetrics: {
    feedbackPositiveRatio: number;     // positive / total
    cronSuccessRate: number;           // ok / total
    avgResponseQuality: number;        // LLM judge score (0-1)
  };
  pendingApprovals: number;
  /** Version lineage for applied changes — enables rollback chains. */
  evolutionVersions?: EvolutionVersion[];
  /** Set when the loop aborted due to a persistent infrastructure error. */
  infraError?: {
    category: string;
    diagnostic: string;
  };
  /** Last non-fatal state diagnostic, such as a stale run being reconciled. */
  lastDiagnostic?: string;
}

export interface SelfImproveConfig {
  maxIterations: number;               // Default: 10
  iterationBudgetMs: number;           // Default: 300_000 (5 min)
  maxDurationMs: number;               // Default: 3_600_000 (1 hour)
  acceptThreshold: number;             // Default: 0.7 (score must beat this to register as accepted)
  /**
   * Default: 0.85. Stricter floor for what reaches the user's pending-changes
   * inbox. Proposals scoring >= acceptThreshold but < surfaceThreshold are
   * marked 'unsurfaced' — kept in the experiment log for trend analysis but
   * NOT written to PENDING_DIR. Cuts noise without losing signal data.
   */
  surfaceThreshold?: number;
  plateauLimit: number;                // Default: 3 consecutive low-score stops loop
  areas: ('soul' | 'cron' | 'workflow' | 'memory' | 'agent' | 'source' | 'communication' | 'goal' | 'advisor-rule' | 'prompt-override')[];
  /** Enable tiered auto-apply: low-risk changes apply without approval. Default: false. */
  autoApply?: boolean;
  /** Target a specific agent slug (for per-agent improvement cycles). */
  agentSlug?: string;
  /** How to handle source code proposals. 'skip' = drop silently, 'propose-only' = save for human review. Default: 'propose-only'. */
  sourceMode?: 'skip' | 'propose-only';
}

// ── Restart Sentinel ────────────────────────────────────────────────

export interface RestartSentinel {
  previousPid: number;
  restartedAt: string;         // ISO
  reason: 'source-edit' | 'update' | 'manual';
  sourceChangeId?: string;     // experiment ID
  sessionKey?: string;         // which session triggered it
  changedFiles?: string[];     // for rollback if child crashes
  // Update details (populated by `clementine update` and auto-update)
  updateDetails?: {
    /** Semver before the update — read from package.json prior to git pull. */
    previousVersion?: string;
    /** Semver after the update — read from package.json after build. */
    newVersion?: string;
    commitHash?: string;
    commitDate?: string;
    commitsBehind?: number;     // how many commits were pulled
    summary?: string;           // one-line upstream change summary
    modsReapplied?: number;
    modsSuperseded?: number;
    modsNeedReconciliation?: number;
    modsFailed?: number;
  };
}

// ── Graph Memory ────────────────────────────────────────────────────

export interface EntityNode {
  label: string;
  id: string;
  properties: Record<string, any>;
}

export interface EntityRef {
  label: string;
  id: string;
}

export interface RelationshipTriplet {
  from: EntityRef;
  rel: string;
  to: EntityRef;
  context?: string;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface TraversalResult {
  entity: EntityNode;
  depth: number;
  path: string[];
}

export interface PathResult {
  nodes: EntityNode[];
  relationships: string[];
  length: number;
}

export interface GraphSyncStats {
  nodesCreated: number;
  relationshipsCreated: number;
  duration: number;
}

// ── Persistent Goals ────────────────────────────────────────────────

export interface PersistentGoal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  owner: string;              // agent slug or 'clementine'
  priority: 'high' | 'medium' | 'low';
  createdAt: string;
  updatedAt: string;
  targetDate?: string;
  progressNotes: string[];    // appended by agent after each work session
  nextActions: string[];      // what to do next time
  blockers?: string[];
  reviewFrequency: 'daily' | 'weekly' | 'on-demand';
  linkedCronJobs?: string[];  // cron jobs that contribute to this goal
  autoSchedule?: boolean;     // if true, daily planner can create/adjust cron jobs for this goal
}

export interface GoalProgressEntry {
  timestamp: string;
  goalId: string;
  focus: string;
  source: string;
  madeProgress: boolean;
  newProgressNotes: number;
  resultSnippet: string;
  status: 'progress' | 'no-change' | 'error';
}

// ── Cron Progress Continuity ────────────────────────────────────────

export interface CronProgress {
  jobName: string;
  lastRunAt: string;
  runCount: number;
  state: Record<string, unknown>;  // job-specific state (agent writes what it needs)
  completedItems: string[];        // e.g., "researched account X", "drafted email for Y"
  pendingItems: string[];          // what's left to do
  notes: string;                   // free-form observations from last run
}

// ── Delegated Tasks ─────────────────────────────────────────────────

export interface DelegatedTask {
  id: string;
  fromAgent: string;           // who delegated
  toAgent: string;             // who should do it
  task: string;                // task description
  expectedOutput: string;      // what the result should look like
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: string;
  updatedAt: string;
  result?: string;             // the deliverable once completed
  goalId?: string;             // linked goal (for goal-driven delegations)
}

// ── Verbose Level ───────────────────────────────────────────────────

export type VerboseLevel = 'quiet' | 'normal' | 'detailed';

// ── Adaptive Execution ──────────────────────────────────────────────

export interface ExecutionAdvice {
  adjustedMaxTurns: number | null;
  adjustedModel: string | null;
  adjustedTimeoutMs: number | null;
  promptEnrichment: string;
  shouldEscalate: boolean;
  escalationReason?: string;
  shouldSkip: boolean;
  skipReason?: string;
}

export interface AdvisorDecision {
  jobName: string;
  timestamp: string;
  advice: ExecutionAdvice;
  originalModel?: string;
  originalMaxTurns?: number;
  runOutcome?: 'ok' | 'error' | 'skipped';
  runDurationMs?: number;
}

// ── Daily Planning ──────────────────────────────────────────────────

export interface DailyPlanPriority {
  type: 'goal' | 'task' | 'cron-fix' | 'inbox';
  id: string;
  action: string;
  urgency: number;
}

export interface DailyPlan {
  date: string;
  createdAt: string;
  priorities: DailyPlanPriority[];
  suggestedCronChanges: Array<{ job: string; change: string; reason: string }>;
  newWork: Array<{ description: string; goalId?: string; suggestedSchedule?: string }>;
  summary: string;
}

// ── Remote Access ──────────────────────────────────────────────────

export interface RemoteAccessConfig {
  enabled: boolean;
  authToken: string;
  tunnelUrl?: string;
  autoPost: boolean;
  lastStarted?: string;
}

export interface SessionRecord {
  id: string;
  expiresAt: number;
  persistent: boolean;
  createdAt: number;
  lastUsedAt: number;
  userAgent?: string;
}
// ── SDR Operational Data ────────────────────────────────────────────

export interface Lead {
  id?: number;
  agentSlug: string;
  email: string;
  name: string;
  company?: string;
  title?: string;
  status: 'new' | 'contacted' | 'replied' | 'qualified' | 'meeting_booked' | 'won' | 'lost' | 'opted_out';
  source?: string;
  sfId?: string;                    // Salesforce lead/contact ID
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface Activity {
  id?: number;
  leadId?: number;
  agentSlug: string;
  type: 'email_sent' | 'email_received' | 'meeting_booked' | 'call' | 'note' | 'status_change';
  subject?: string;
  detail?: string;
  templateUsed?: string;
  performedAt?: string;
}

// ── Brain / Ingestion ────────────────────────────────────────────────

/** Supported v1 ingest formats detected by format-detector. */
export type DetectedFormat =
  | 'csv' | 'json' | 'jsonl' | 'markdown' | 'pdf' | 'email' | 'docx' | 'unknown';

/** Operational mode for a source. */
export type SourceKind = 'seed' | 'poll' | 'webhook';

/** How per-record intelligence runs. `auto` = tiered (template for structured, LLM for free-form). */
export type IntelligenceMode = 'auto' | 'template-only' | 'llm-per-record';

/** A declarative external data source registered in the brain. */
export interface Source {
  slug: string;
  kind: SourceKind;
  adapter: DetectedFormat | 'rest' | 'webhook';
  configJson: string;              // adapter-specific config (endpoint, headers, mapping, etc.)
  credentialRef?: string | null;   // key into ~/.clementine/credentials.json
  scheduleCron?: string | null;    // for kind='poll'
  targetFolder?: string | null;    // vault folder for distilled notes
  agentSlug?: string | null;       // NULL = global brain (default)
  project?: string | null;         // project path (from ~/.clementine/projects.json) — tags ingested records
  intelligence: IntelligenceMode;
  enabled: boolean;
  lastRunAt?: string | null;
  lastStatus?: 'ok' | 'error' | 'partial' | null;
  createdAt: string;
  updatedAt: string;
}

/** Audit record for one ingestion run. */
export interface IngestionRun {
  id?: number;
  sourceSlug: string;
  startedAt: string;
  finishedAt?: string | null;
  recordsIn: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  recordsUnchanged?: number;
  recallCheckStatus?: string | null;
  overviewNotePath?: string | null;
  errorsJson?: string | null;      // JSON array of {record, error}
  status: 'running' | 'ok' | 'error' | 'partial';
}

/** Live progress event emitted during an ingestion run. */
export interface IngestionProgress {
  runId: number;
  sourceSlug: string;
  stage: 'detecting' | 'parsing' | 'distilling' | 'writing' | 'summarizing' | 'done' | 'error';
  recordsIn: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  message?: string;
}

/** A raw record emerging from an adapter before distillation. */
export interface RawRecord {
  externalId?: string;             // stable upstream key if available; otherwise derived from content hash
  content: string;                 // text to chunk/distill (may be one CSV row as JSON, one PDF page, one email body, etc.)
  rawPayload: string;              // full original payload (JSON/string) for artifact audit
  metadata?: Record<string, unknown>;  // adapter-specific hints (row_index, pdf_page, email_from, etc.)
}

/** A fully-processed ingestion record ready for write. */
export interface IngestedRecord {
  sourceSlug: string;
  externalId: string;
  title: string;
  summary: string;                 // short distilled summary (feeds batch overview)
  body: string;                    // full markdown body (may embed summary + details)
  frontmatter: Record<string, unknown>;
  tags: string[];
  targetRelPath: string;           // vault relative path for the note (e.g. '04-Deals/stripe-cus_abc.md')
  artifactId?: number;
  rawPayload: string;              // what gets stored as artifact
  structuredRow?: Record<string, unknown>;  // populated for tabular sources → ingested_rows
  graphEntities?: Array<{ label: string; id: string; properties?: Record<string, unknown> }>;
  graphRelationships?: Array<{ from: string; rel: string; to: string; context?: string }>;
}

/** Manifest returned by format-detector for a seed path (file or folder). */
export interface DetectedManifest {
  files: Array<{ path: string; format: DetectedFormat; sizeBytes: number }>;
  totalFiles: number;
  formats: Partial<Record<DetectedFormat, number>>;  // counts per format
  totalBytes: number;
}

/** Health summary for a source on the dashboard. */
export interface SourceHealth {
  slug: string;
  state: 'green' | 'yellow' | 'red' | 'unknown';
  lastRunAt?: string | null;
  lastStatus?: string | null;
  recentErrorRate: number;         // 0-1 over last 10 runs
  recentRecords: number;
  nextRunAt?: string | null;
}

// ── Utility types ────────────────────────────────────────────────────

type float = number;
