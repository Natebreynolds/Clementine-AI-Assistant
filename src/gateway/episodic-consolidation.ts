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
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { query, type SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';

import { MODELS, BASE_DIR, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY } from '../config.js';
import type { MemoryStore } from '../memory/store.js';
import {
  fingerprintCommitment,
  parseRelativeDue,
  type CommitmentOwner,
} from './commitments.js';

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

export interface ExtractedCommitment {
  text: string;
  owner: CommitmentOwner;
  dueHint?: string;
}

export interface ExtractedLearnedFact {
  kind: 'preference' | 'fact' | 'goal' | 'workflow';
  text: string;
  /** Optional phrase that this fact supersedes — caller resolves to a
   *  stored row id by fuzzy match against active learned_facts. */
  supersedes?: string;
}

export interface EpisodeExtraction {
  summary: string;
  topics: string[];
  entities: string[];
  outcome: string;
  openLoops: string[];
  commitments: ExtractedCommitment[];
  learnedFacts: ExtractedLearnedFact[];
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
  '  "openLoops": string[] (unresolved follow-ups; empty array if none, max 5),',
  '  "commitments": Array<{ text: string, owner: "user" | "clementine", dueHint?: string }>',
  '      (explicit promises only — "I\'ll do X", "remind me to Y", "by Friday".',
  '       owner = whoever committed: user vs the assistant. Empty array if none, max 5.)',
  '  "learnedFacts": Array<{ kind: "preference"|"fact"|"goal"|"workflow", text: string, supersedes?: string }>',
  '      (durable beliefs that should outlive this session — the user\'s preferences,',
  '       stated goals, stable facts about their work / setup, and procedural patterns',
  '       like "deploy steps are X then Y". Skip ephemeral status. If a new fact contradicts',
  '       one in the existing-facts context below, set supersedes to a phrase from the old',
  '       fact so we can mark it superseded. Empty array if none, max 6.)',
  '}',
].join('\n');

function buildUserPrompt(
  turns: Array<{ role: string; content: string; createdAt: string }>,
  existingFacts: Array<{ kind: string; text: string }>,
): string {
  const formatted = turns
    .map(t => `[${t.createdAt}] ${t.role}: ${t.content.replace(/\s+/g, ' ').slice(0, 1200)}`)
    .join('\n');
  const factBlock = existingFacts.length
    ? [
        'Existing facts already learned (use to detect contradictions for `supersedes`):',
        ...existingFacts.slice(0, 30).map(f => `- [${f.kind}] ${f.text}`),
        '',
      ].join('\n')
    : '';
  return [
    'Consolidate the following conversation range into the JSON schema described.',
    'Only include facts present in the conversation. Use empty arrays for unknown fields.',
    '',
    factBlock,
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

  const rawCommitments = Array.isArray(obj.commitments) ? obj.commitments : [];
  const commitments: ExtractedCommitment[] = [];
  for (const raw of rawCommitments) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    const owner = c.owner === 'clementine' || c.owner === 'user' ? c.owner : null;
    if (!text || !owner) continue;
    const dueHint = typeof c.dueHint === 'string' && c.dueHint.trim() ? c.dueHint.trim() : undefined;
    commitments.push({ text: text.slice(0, 220), owner, dueHint });
    if (commitments.length >= 5) break;
  }

  const VALID_KINDS = new Set(['preference', 'fact', 'goal', 'workflow']);
  const rawFacts = Array.isArray(obj.learnedFacts) ? obj.learnedFacts : [];
  const learnedFacts: ExtractedLearnedFact[] = [];
  for (const raw of rawFacts) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const text = typeof f.text === 'string' ? f.text.trim() : '';
    const kind = typeof f.kind === 'string' && VALID_KINDS.has(f.kind) ? f.kind as ExtractedLearnedFact['kind'] : null;
    if (!text || !kind) continue;
    const supersedes = typeof f.supersedes === 'string' && f.supersedes.trim() ? f.supersedes.trim() : undefined;
    learnedFacts.push({ kind, text: text.slice(0, 280), supersedes });
    if (learnedFacts.length >= 6) break;
  }

  return {
    summary,
    topics: arr(obj.topics).slice(0, 6),
    entities: arr(obj.entities).slice(0, 8),
    outcome: typeof obj.outcome === 'string' ? obj.outcome.trim().slice(0, 200) : '',
    openLoops: arr(obj.openLoops).slice(0, 5),
    commitments,
    learnedFacts,
  };
}

/** Stable fingerprint for a learned fact — matches the regex-detector
 *  pattern so future ingest sources can dedupe through the same upsert. */
export function fingerprintLearnedFact(kind: string, text: string): string {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return createHash('sha1').update(`${kind}|${normalized}`).digest('hex').slice(0, 16);
}

function getAnthropicClient(opts: EpisodicConsolidationOptions): Pick<Anthropic, 'messages'> | null {
  if (opts.anthropicClient) return opts.anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

/**
 * One-shot LLM call via the SDK's `query()`. OAuth-aware (uses
 * CLAUDE_CODE_OAUTH_TOKEN when no API key is set), so works on
 * installs that haven't configured ANTHROPIC_API_KEY. Returns the
 * concatenated assistant text — empty string on failure.
 *
 * Used as a fallback when no Anthropic SDK client is available
 * (i.e. the prior path returned null and the entire consolidation
 * pass silently no-op'd).
 */
async function runConsolidationViaSdk(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CLEMENTINE_HOME: BASE_DIR,
  };
  const oauth = CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
  else if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

  let text = '';
  try {
    const stream = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: [],
        cwd: BASE_DIR,
        env,
        maxTurns: 1,
        maxBudgetUsd: 0.10,
      },
    });
    for await (const message of stream) {
      if (message.type === 'assistant') {
        const blocks = ((message as SDKAssistantMessage).message?.content ?? []) as Array<{ type: string; text?: string }>;
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') text += block.text;
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'SDK consolidation call failed');
    return '';
  }
  return text;
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
  // No client means no API key. We still try via the SDK's query()
  // which uses OAuth when available — that's the canonical path for
  // installs that haven't configured ANTHROPIC_API_KEY. Tests that
  // pass an explicit anthropicClient will still hit the direct path.

  // Pull a small snapshot of existing learned facts so the LLM can
  // detect contradictions and emit supersedes hints. Best-effort —
  // empty list is fine for first-ever consolidation.
  let existingFactsForPrompt: Array<{ kind: string; text: string }> = [];
  try {
    if (typeof (store as { listActiveLearnedFacts?: unknown }).listActiveLearnedFacts === 'function') {
      existingFactsForPrompt = (store as {
        listActiveLearnedFacts: (o: { limit: number }) => Array<{ kind: string; text: string }>;
      }).listActiveLearnedFacts({ limit: 30 });
    }
  } catch { /* fact snapshot is best-effort */ }

  const userPrompt = buildUserPrompt(
    turns.map(t => ({ role: t.role, content: t.content, createdAt: t.createdAt })),
    existingFactsForPrompt,
  );
  const model = opts.model ?? MODELS.haiku;
  let extraction: EpisodeExtraction | null = null;
  try {
    let text = '';
    if (client) {
      const response = await client.messages.create({
        model,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      text = (response.content ?? []).map((b: { type: string; text?: string }) => b.type === 'text' ? (b.text ?? '') : '').join('');
    } else {
      // No API client — fall through to the SDK (OAuth-aware).
      text = await runConsolidationViaSdk(SYSTEM_PROMPT, userPrompt, model);
    }
    if (!text) {
      logger.debug({ sessionKey: candidate.sessionKey }, 'Empty consolidation response — skipping');
      return null;
    }
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

  // Lift extracted commitments into first-class rows. Fingerprint dedupe
  // keeps these from colliding with regex-detected commitments captured
  // in real time on the same turns.
  let commitmentsCreated = 0;
  for (const c of extraction.commitments) {
    try {
      const normalized = c.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!normalized) continue;
      const fp = fingerprintCommitment(candidate.sessionKey, c.owner, normalized);
      const dueAt = c.dueHint ? parseRelativeDue(c.dueHint) ?? null : null;
      const result = store.upsertCommitment({
        fingerprint: fp,
        source: 'episode-extractor',
        owner: c.owner,
        text: c.text,
        sessionKey: candidate.sessionKey,
        episodeId: insert.episodeId,
        dueAt,
        dueHint: c.dueHint ?? null,
      });
      if (result.created) commitmentsCreated++;
    } catch (err) {
      logger.debug({ err }, 'Failed to persist extracted commitment');
    }
  }

  // Lift extracted learned facts into durable, supersession-aware rows.
  // For each fact: insert (idempotent on fingerprint). If the LLM emitted
  // a `supersedes` phrase that fuzzy-matches an active fact, mark the old
  // one superseded by the new one — that's how memory becomes learning.
  let factsCreated = 0;
  let factsSuperseded = 0;
  if (typeof (store as { upsertLearnedFact?: unknown }).upsertLearnedFact === 'function') {
    for (const fact of extraction.learnedFacts) {
      try {
        const fp = fingerprintLearnedFact(fact.kind, fact.text);
        const upserted = (store as {
          upsertLearnedFact: (e: {
            fingerprint: string; kind: string; text: string; sourceEpisodeId?: number;
          }) => { id: number; created: boolean };
        }).upsertLearnedFact({
          fingerprint: fp, kind: fact.kind, text: fact.text, sourceEpisodeId: insert.episodeId,
        });
        if (upserted.created) factsCreated++;
        if (fact.supersedes && upserted.created
          && typeof (store as { findActiveLearnedFactByPhrase?: unknown }).findActiveLearnedFactByPhrase === 'function'
        ) {
          const old = (store as {
            findActiveLearnedFactByPhrase: (p: string) => { id: number; text: string; kind: string } | null;
          }).findActiveLearnedFactByPhrase(fact.supersedes);
          if (old && old.id !== upserted.id) {
            const ok = (store as { supersedeLearnedFact: (oldId: number, newId: number) => boolean }).supersedeLearnedFact(old.id, upserted.id);
            if (ok) factsSuperseded++;
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Failed to persist learned fact');
      }
    }
  }

  store.updateConsolidationCursor(candidate.sessionKey, {
    lastTranscriptId: candidate.endTranscriptId,
    success: true,
  });
  logger.info({
    sessionKey: candidate.sessionKey,
    episodeId: insert.episodeId,
    chunkId,
    turns: turns.length,
    commitmentsCreated,
    factsCreated,
    factsSuperseded,
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
