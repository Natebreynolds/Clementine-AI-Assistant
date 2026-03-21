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
  matchType: 'fts' | 'recency' | 'timeline';
  lastUpdated: string;
  chunkId: number;
  salience: number;
  agentSlug?: string | null;
}

export interface Chunk {
  sourceFile: string;
  section: string;
  content: string;
  chunkType: 'frontmatter' | 'heading' | 'preamble' | 'episodic';
  frontmatterJson: string;
  contentHash: string;
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
  source: 'owner-dm' | 'owner-channel' | 'autonomous';
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

// ── Gateway ──────────────────────────────────────────────────────────

export type OnTextCallback = (text: string) => Promise<void>;

export type OnToolActivityCallback = (toolName: string, toolInput: Record<string, unknown>) => Promise<void>;

export interface NotificationContext {
  agentSlug?: string;
}

export type NotificationSender = (text: string, context?: NotificationContext) => Promise<void>;

// ── Agent Profiles ───────────────────────────────────────────────────

export interface TeamAgentConfig {
  channelName: string | string[];  // Discord channel name(s) (e.g., "research" or ["research", "general"])
  channels: string[];              // Resolved runtime channel keys (populated by bot on connect)
  canMessage: string[];            // Agent slugs this agent can directly message
  allowedTools?: string[];         // Tool whitelist (omit = all tools)
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
  project?: string;                // Bind agent to a project from projects.json
  agentDir?: string;               // Path to agent's directory (agents/{slug}/)
  discordToken?: string;           // Dedicated Discord bot token (gives agent its own bot presence)
  discordChannelId?: string;       // Channel ID for the agent bot to listen in (auto-discovered from channelName if omitted)
  slackBotToken?: string;          // Slack bot token (xoxb-...) for agent's own Slack presence
  slackAppToken?: string;          // Slack app token (xapp-...) required for Socket Mode
  slackChannelId?: string;         // Explicit Slack channel ID override
}

// ── Heartbeat ────────────────────────────────────────────────────────

export interface HeartbeatState {
  fingerprint: string;
  details: Record<string, number | string>;
  timestamp: string;
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
}

export interface CronRunEntry {
  jobName: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error' | 'retried';
  durationMs: number;
  error?: string;
  errorType?: 'transient' | 'permanent';
  attempt: number;
  outputPreview?: string;
  deliveryFailed?: boolean;
  deliveryError?: string;
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

// ── Plan Orchestration ───────────────────────────────────────────────

export interface PlanStep {
  id: string;              // "step-1", "step-2"
  description: string;     // Human-readable
  prompt: string;          // Full prompt for the sub-agent
  dependsOn: string[];     // Step IDs this depends on (empty = parallel)
  maxTurns: number;        // Turns budget for this step (default 15, up to 50 for complex)
  tier: number;            // Security tier (default 2)
  model?: string;          // Optional model override (e.g., "haiku" for simple lookups)
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
  area: 'soul' | 'cron' | 'workflow' | 'memory' | 'agent' | 'source' | 'communication';
  target: string;                      // e.g., "SOUL.md personality section"
  hypothesis: string;                  // What the LLM decided to try
  proposedChange: string;              // The actual modification
  baselineScore: number;               // Score before (0-1)
  score: number;                       // Evaluation score (0-1)
  accepted: boolean;                   // Did it pass evaluation threshold?
  approvalStatus: 'pending' | 'approved' | 'denied' | 'expired';
  reason: string;                      // Why accepted/rejected
  error?: string;
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
}

export interface SelfImproveConfig {
  maxIterations: number;               // Default: 10
  iterationBudgetMs: number;           // Default: 300_000 (5 min)
  maxDurationMs: number;               // Default: 3_600_000 (1 hour)
  acceptThreshold: number;             // Default: 0.6 (score must beat this)
  plateauLimit: number;                // Default: 3 consecutive low-score stops loop
  areas: ('soul' | 'cron' | 'workflow' | 'memory' | 'agent' | 'source' | 'communication')[];
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
}

// ── Verbose Level ───────────────────────────────────────────────────

export type VerboseLevel = 'quiet' | 'normal' | 'detailed';

// ── Utility types ────────────────────────────────────────────────────

type float = number;
