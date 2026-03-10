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

export type NotificationSender = (text: string) => Promise<void>;

// ── Agent Profiles ───────────────────────────────────────────────────

export interface AgentProfile {
  slug: string;
  name: string;
  tier: number;
  description: string;
  systemPromptBody: string;
  model?: string;
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
  status: 'active' | 'corrected' | 'dismissed';
  correction?: string;        // replacement fact if corrected
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

// ── Utility types ────────────────────────────────────────────────────

type float = number;
