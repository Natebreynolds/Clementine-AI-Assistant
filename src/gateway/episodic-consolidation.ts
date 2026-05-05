/**
 * Episodic consolidation — turn raw transcript ranges into durable, indexed
 * episodes that hybrid recall can surface across sessions.
 *
 * Why not just keep transcripts? Transcripts are noisy and minute-grained.
 * "What did we decide about auth?" should match a clean summary of the
 * decision, not the eight messages where we worked toward it. Episodes
 * compress a session range into {summary, topics, entities, outcome,
 * openLoops}, persist that to the episodes table, and also write the
 * summary into chunks so PR-1's hybrid recall picks them up automatically.
 *
 * The pass is driven by the heartbeat: every few minutes we look for
 * sessions that have been idle for ≥20 min with ≥3 new exchanges and
 * consolidate up to a small bounded number per pass to keep LLM cost
 * predictable.
 */
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';

import { MODELS } from '../config.js';
import type { MemoryStore } from '../memory/store.js';

const logger = pino({
  name: 'clementine.episodic-consolidation',
  level: process.env.CLEMENTINE_CONSOLIDATION_LOG_LEVEL || 'warn',
});

export interface EpisodicConsolidationOptions {
  /** Minutes of inactivity before a session becomes consolidation-eligible. */
  idleMinutes?: number;
  /** Minimum turns since last cursor for a session to qualify. */
  minExchanges?: number;
  /** Cap LLM calls per pass to bound cost. */
  maxSessionsPerPass?: number;
  /** How long to back off after a consolidation failure for a session. */
  failBackoffMinutes?: number;
  /** Override Anthropic client (used by tests). */
  anthropicClient?: Pick<Anthropic, 'messages'>;
  /** Override the model id (used by tests). */
  model?: string;
  /** Wallclock now() — used by tests for deterministic timestamps. */
  now?: () => Date;
}

export interface EpisodeExtraction {
  summary: string;
  topics: string[];
  entities: string[];
  outcome: string;
  openLoops: string[];
}

interface CandidateRow {
  sessionKey: string;
  startTranscriptId: number;
  endTranscriptId: number;
  startedAt: string;
  endedAt: string;
  exchanges: number;
}

export interface ConsolidationPassResult {
  consolidated: number;
  failed: number;
  skipped: number;
  candidates: number;
}

const SYSTEM_PROMPT = [
  'You are a memory consolidator for a personal AI assistant.',
  'You read a transcript range and produce a compact, durable record of what happened.',
  'Output STRICT JSON matching the schema, with no prose, no markdown, no code fences.',
  'Schema:',
  '{',
  '  "summary": string (2-4 sentences, neutral, factual),',
  '  "topics": string[] (lowercase noun phrases, max 6),',
  '  "entities": string[] (named things: files, services, people; max 8),',
  '  "outcome": string (one short clause: decided / implemented / discussed / blocked / none),',
  '  "openLoops": string[] (unresolved follow-ups; empty array if none, max 5)',
  '}',
].join('\n');

function buildUserPrompt(turns: Array<{ role: string; content: string; createdAt: string }>): string {
  const formatted = turns
    .map(t => `[${t.createdAt}] ${t.role}: ${t.content.replace(/\s+/g, ' ').slice(0, 1200)}`)
    .join('\n');
  return [
    'Consolidate the following conversation range into the JSON schema described.',
    'Only include facts present in the conversation. Use empty arrays for unknown fields.',
    '',
    formatted,
  ].join('\n');
}

/** Parse the model's output as JSON, tolerating leading/trailing whitespace and
 *  occasional code fences. Returns null on any structural problem. */
export function parseEpisodeJson(raw: string): EpisodeExtraction | null {
  if (!raw) return null;
  let text = raw.trim();
  if (text.startsWith('```')) {
    // Strip fence; keep everything between first and last triple-backtick.
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) text = m[1];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(s => (s as string).trim()).filter(Boolean) : [];
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) return null;
  return {
    summary,
    topics: arr(obj.topics).slice(0, 6),
    entities: arr(obj.entities).slice(0, 8),
    outcome: typeof obj.outcome === 'string' ? obj.outcome.trim().slice(0, 200) : '',
    openLoops: arr(obj.openLoops).slice(0, 5),
  };
}

function getAnthropicClient(opts: EpisodicConsolidationOptions): Pick<Anthropic, 'messages'> | null {
  if (opts.anthropicClient) return opts.anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

/**
 * Consolidate a single candidate session range. Returns the new episode id
 * + chunk id on success, or null on failure (the caller bumps the failure
 * cursor so we don't retry every tick).
 */
export async function consolidateOneSession(
  store: MemoryStore,
  candidate: CandidateRow,
  opts: EpisodicConsolidationOptions = {},
): Promise<{ episodeId: number; chunkId: number | null } | null> {
  const turns = store.getTranscriptsByIdRange(
    candidate.sessionKey,
    candidate.startTranscriptId,
    candidate.endTranscriptId,
  );
  if (turns.length === 0) return null;

  const client = getAnthropicClient(opts);
  if (!client) {
    logger.debug({ sessionKey: candidate.sessionKey }, 'No Anthropic client available — skipping consolidation');
    return null;
  }

  let extraction: EpisodeExtraction | null = null;
  try {
    const response = await client.messages.create({
      model: opts.model ?? MODELS.haiku,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(turns.map(t => ({ role: t.role, content: t.content, createdAt: t.createdAt }))) }],
    });
    const text = (response.content ?? []).map((b: { type: string; text?: string }) => b.type === 'text' ? (b.text ?? '') : '').join('');
    extraction = parseEpisodeJson(text);
  } catch (err) {
    logger.warn({ err, sessionKey: candidate.sessionKey }, 'Episode LLM call failed');
    return null;
  }
  if (!extraction) {
    logger.warn({ sessionKey: candidate.sessionKey }, 'Episode JSON parse failed — skipping');
    return null;
  }

  // Index the summary into chunks so hybrid recall surfaces it. The
  // source_file shape mirrors how internal-derived chunks are stored
  // elsewhere; section is the session key for traceability.
  let chunkId: number | null = null;
  try {
    chunkId = store.insertSummaryChunk(
      `episodes/${candidate.sessionKey}.md`,
      `Episode ${candidate.startedAt}`,
      [
        extraction.summary,
        extraction.topics.length ? `Topics: ${extraction.topics.join(', ')}` : '',
        extraction.entities.length ? `Entities: ${extraction.entities.join(', ')}` : '',
        extraction.outcome ? `Outcome: ${extraction.outcome}` : '',
        extraction.openLoops.length ? `Open: ${extraction.openLoops.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
    );
  } catch (err) {
    logger.debug({ err }, 'insertSummaryChunk failed — episode still persisted');
  }

  const transcriptIds: number[] = turns.map(t => t.id ?? 0).filter(n => n > 0);
  const insert = store.insertEpisode({
    sessionKey: candidate.sessionKey,
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt,
    summary: extraction.summary,
    topics: extraction.topics,
    entities: extraction.entities,
    outcome: extraction.outcome,
    openLoops: extraction.openLoops,
    transcriptIds,
    chunkId,
  });
  store.updateConsolidationCursor(candidate.sessionKey, {
    lastTranscriptId: candidate.endTranscriptId,
    success: true,
  });
  logger.info({
    sessionKey: candidate.sessionKey,
    episodeId: insert.episodeId,
    chunkId,
    turns: turns.length,
  }, 'Consolidated episode');
  return { episodeId: insert.episodeId, chunkId };
}

/**
 * Run one bounded consolidation pass. Designed to be called from the
 * heartbeat tick — quick to no-op when nothing's eligible, capped at
 * `maxSessionsPerPass` LLM calls when work exists.
 */
export async function runEpisodicConsolidationPass(
  store: MemoryStore,
  opts: EpisodicConsolidationOptions = {},
): Promise<ConsolidationPassResult> {
  const idleMinutes = opts.idleMinutes ?? 20;
  const minExchanges = opts.minExchanges ?? 3;
  const maxSessions = Math.max(1, opts.maxSessionsPerPass ?? 3);
  const failBackoffMinutes = opts.failBackoffMinutes ?? 60;

  const candidates = store.getIdleSessionsForEpisodicConsolidation({
    idleMinutes,
    minExchanges,
    maxResults: maxSessions,
    failBackoffMinutes,
  });
  let consolidated = 0;
  let failed = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    try {
      const result = await consolidateOneSession(store, candidate, opts);
      if (result) {
        consolidated++;
      } else {
        store.updateConsolidationCursor(candidate.sessionKey, { success: false });
        failed++;
      }
    } catch (err) {
      logger.warn({ err, sessionKey: candidate.sessionKey }, 'Consolidation pass error');
      try { store.updateConsolidationCursor(candidate.sessionKey, { success: false }); } catch { /* ignore */ }
      failed++;
    }
  }
  return { consolidated, failed, skipped, candidates: candidates.length };
}
