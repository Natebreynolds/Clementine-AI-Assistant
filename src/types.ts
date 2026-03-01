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

// ── Utility types ────────────────────────────────────────────────────

type float = number;
