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
  matchType: 'fts' | 'recency' | 'timeline' | 'vector';
  lastUpdated: string;
  chunkId: number;
  salience: number;
  lastOutcomeScore?: number;
  agentSlug?: string | null;
  category?: string | null;
  topic?: string | null;
  pinned?: boolean;
}

export type ChunkCategory = 'facts' | 'events' | 'discoveries' | 'preferences' | 'advice';

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

// ── Cron Jobs ────────────────────────────────────────────────────────

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
  agentSlug?: string;              // Agent that owns this cron job (scoped execution)
  successCriteria?: string[];      // Verifiable acceptance criteria for goal-backward reflection
  alwaysDeliver?: boolean;         // If true, retry once with explicit prompt when response is empty/noise
  context?: string;                 // Freeform context/notes injected into prompt at runtime (training data, guidelines, etc.)
  preCheck?: string;               // Shell command gate — exit 0 = run, non-zero = skip. Stdout injected as context.
  attachments?: string[];          // Filenames in ~/.clementine/attachments/{job-name}/ injected at runtime
  requiresConfirmation?: boolean;  // If true, ask owner before running — auto-proceeds after timeout
  confirmationTimeoutMin?: number; // Minutes to wait for confirmation before auto-proceeding (default: 5)
}

export type TerminalReason =
  | 'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long'
  | 'image_error' | 'model_error' | 'aborted_streaming' | 'aborted_tools'
  | 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred'
  | 'max_turns' | 'completed';

export interface CronRunEntry {
  jobName: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error' | 'retried' | 'skipped';
  durationMs: number;
  error?: string;
  errorType?: 'transient' | 'permanent';
  terminalReason?: TerminalReason;  // precise SDK-reported reason for query termination
  attempt: number;
  outputPreview?: string;
  deliveryFailed?: boolean;
  deliveryError?: string;
  advisorApplied?: {
    adjustedMaxTurns?: number;
    adjustedModel?: string;
    adjustedTimeoutMs?: number;
    enriched?: boolean;
    escalated?: boolean;
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
  status: 'active' | 'corrected' | 'dismissed' | 'dedup_skipped';
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

export interface BehavioralCorrection {
  correction: string;
  category: 'verbosity' | 'tone' | 'workflow' | 'format' | 'accuracy' | 'proactivity' | 'scope';
  strength: 'explicit' | 'implicit';
}

export interface PreferenceLearned {
  preference: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface SessionReflection {
  id?: number;
  sessionKey: string;
  exchangeCount: number;
  frictionSignals: string[];
  qualityScore: number;            // 1-5
  behavioralCorrections: BehavioralCorrection[];
  preferencesLearned: PreferenceLearned[];
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

export interface PlanProgressUpdate {
  stepId: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  description: string;
  durationMs?: number;
  resultPreview?: string;
}

// ── Workflow Automation ─────────────────────────────────────────────

export interface WorkflowInput {
  type: 'string' | 'number';
  default?: string;
  description?: string;
}

export interface WorkflowStep {
  id: string;
  prompt: string;
  dependsOn: string[];
  model?: string;
  tier: number;
  maxTurns: number;
  workDir?: string;
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
  agentSlug?: string;              // Agent that owns this workflow (scoped execution)
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

// ── Agent Config Revisions ──────────────────────────────────────────

export interface ConfigRevision {
  id?: number;
  agentSlug: string;
  fileName: string;              // e.g., 'agent.md', 'CRON.md', 'PLAYBOOK.md'
  content: string;               // Full file content at this revision
  changedBy?: string;            // 'dashboard', 'self-improve', agent slug
  createdAt?: string;
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

export interface SequenceEnrollment {
  id?: number;
  leadId: number;
  sequenceName: string;
  currentStep: number;
  status: 'active' | 'paused' | 'replied' | 'completed' | 'opted_out';
  nextStepDueAt?: string;
  startedAt?: string;
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

export interface SuppressionEntry {
  id?: number;
  email: string;
  reason: 'unsubscribe' | 'bounce' | 'manual' | 'complaint';
  addedAt?: string;
  addedBy?: string;                 // agent_slug or 'manual'
}

export interface ApprovalRequest {
  id?: number;
  agentSlug: string;
  actionType: 'email_send' | 'sequence_start' | 'escalation';
  summary: string;
  detail?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// ── Salesforce Sync ─────────────────────────────────────────────────

export interface SfSyncRecord {
  id?: number;
  localTable: 'leads' | 'activities';
  localId: number;
  sfObjectType: 'Lead' | 'Contact' | 'Opportunity' | 'Task' | 'Event';
  sfId: string;
  syncDirection: 'push' | 'pull';
  syncedAt?: string;
  syncStatus: 'success' | 'error' | 'conflict';
  errorMessage?: string;
}

export interface SfFieldMapping {
  localField: string;
  sfField: string;
  direction: 'bidirectional' | 'push-only' | 'pull-only';
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
