/**
 * Commitments — first-class promises ("I'll fix the dashboard tomorrow",
 * "remind me to call them Friday"). Lives alongside conversation-learning
 * but tracks durable, actionable items that need surfacing in greetings
 * until they're done or cancelled.
 *
 * Two ingest paths share a fingerprint-based dedupe so the same promise
 * never gets recorded twice:
 *
 *   1. Per-turn regex detector (this file) — runs synchronously on user
 *      and assistant turns. High-precision: matches obvious phrasings only,
 *      to avoid spamming on every "I'll think about it" pleasantry.
 *
 *   2. LLM extraction during episodic consolidation — catches multi-turn
 *      and implicit commitments the regex misses. Runs after the session
 *      has been idle, so it sees the full context.
 *
 * Date parsing is intentionally tiny — we recognize common phrases
 * ("tomorrow", "by Friday", "in 3 days", "next week") without pulling in
 * a chrono dep. Anything we can't parse stays as `dueHint` text and is
 * still surfaceable; it just doesn't drive overdue prioritization.
 */
import { createHash } from 'node:crypto';
import type { MemoryStore } from '../memory/store.js';

export type CommitmentOwner = 'user' | 'clementine';

export interface DetectedCommitment {
  text: string;
  owner: CommitmentOwner;
  dueHint?: string;
  dueAt?: string;
}

export function fingerprintCommitment(sessionKey: string, owner: CommitmentOwner, normalizedText: string): string {
  const key = `${sessionKey}|${owner}|${normalizedText}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a relative date phrase into an ISO datetime. Returns null when the
 * phrase isn't recognized; callers fall back to storing the raw `dueHint`
 * so the model still sees the deadline. Default time-of-day for date-only
 * phrases is 17:00 local (5pm) — close enough for "by Friday" semantics
 * without forcing the user to be precise.
 */
export function parseRelativeDue(phrase: string, now: Date = new Date()): string | null {
  if (!phrase) return null;
  const text = phrase.toLowerCase().trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0, 0);

  if (/^today$/.test(text) || /\bby today\b/.test(text) || /\bend of (?:the )?day\b/.test(text) || /\beod\b/.test(text)) {
    return today.toISOString();
  }
  if (/^tomorrow$|by tomorrow|tomorrow morning|tomorrow night|tomorrow evening/.test(text)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return d.toISOString();
  }
  if (/\bnext week\b/.test(text)) {
    const d = new Date(today); d.setDate(d.getDate() + 7); return d.toISOString();
  }
  if (/\bend of (?:the )?week\b/.test(text)) {
    const d = new Date(today);
    const daysToFri = (5 - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + (daysToFri === 0 ? 0 : daysToFri));
    return d.toISOString();
  }
  const inN = text.match(/\bin (\d+) (day|days|week|weeks|hour|hours)\b/);
  if (inN) {
    const n = parseInt(inN[1], 10);
    const unit = inN[2];
    const d = new Date(now);
    if (unit.startsWith('hour')) d.setHours(d.getHours() + n);
    else if (unit.startsWith('week')) d.setDate(d.getDate() + 7 * n);
    else d.setDate(d.getDate() + n);
    return d.toISOString();
  }
  for (let i = 0; i < DAYS.length; i++) {
    const re = new RegExp(`\\b(?:by |on )?${DAYS[i]}\\b`);
    if (re.test(text)) {
      const d = new Date(today);
      const delta = (i - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + (delta === 0 ? 7 : delta));
      return d.toISOString();
    }
  }
  return null;
}

/**
 * Match phrases that signal a real promise. We're deliberately strict:
 * "I'll think about it", "I'll see what I can do", and other hedges are
 * not commitments. We require an action verb after "I'll/I will" and a
 * recognizable object phrase, OR an explicit "remind me to" / "by [day]".
 */
const STRONG_USER_PATTERNS = [
  // "I'll fix that tomorrow", "I'll send the doc by Friday"
  /\bi(?:'| wi)ll\s+(?!think|see|try)([a-z][a-z'-]*\s+(?:[\w'-]+\s+){0,8}[\w'-]+)/i,
  // "I need to ship this by Friday"
  /\bi need to\s+([\w'-]+(?:\s+[\w'-]+){1,10})/i,
  // "remind me to email them tomorrow"
  /\bremind me to\s+([\w'-]+(?:\s+[\w'-]+){1,10})/i,
  // "I should follow up Friday"
  /\bi should\s+([\w'-]+(?:\s+[\w'-]+){1,10})/i,
];

const STRONG_ASSISTANT_PATTERNS = [
  // "I'll fix that tonight" — Clementine self-committing.
  /\bi(?:'| wi)ll\s+(?!think|see|try|let)([a-z][a-z'-]*\s+(?:[\w'-]+\s+){0,8}[\w'-]+)/i,
];

const DUE_HINT_RE = /\b(today|tomorrow|next week|end of (?:the )?week|end of day|eod|by (?:the )?(?:end of (?:the )?(?:day|week)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (?:day|days|week|weeks|hour|hours))\b/i;

/**
 * Scan a single turn for commitment phrases. Returns at most one commitment
 * per turn — the first strong match wins. Returning multiple per turn is
 * possible but tends to over-fire; we'd rather miss one and let the LLM
 * extractor catch it during consolidation.
 */
export function detectCommitmentInTurn(text: string, role: string): DetectedCommitment | null {
  if (!text || text.length < 8) return null;
  const isAssistant = role === 'assistant';
  const patterns = isAssistant ? STRONG_ASSISTANT_PATTERNS : STRONG_USER_PATTERNS;
  let matchedAction: string | null = null;
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      matchedAction = m[0].trim();
      break;
    }
  }
  if (!matchedAction) return null;

  // Truncate the surrounding sentence so the commitment text stays tight.
  // Strip punctuation noise but keep the original case for the saved text.
  const sentence = (text.match(new RegExp(`[^.!?\\n]*${matchedAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.!?\\n]*`, 'i')) ?? [matchedAction])[0].trim();
  const cleaned = sentence.replace(/\s+/g, ' ').slice(0, 220);

  const hintMatch = cleaned.match(DUE_HINT_RE);
  const dueHint = hintMatch ? hintMatch[0] : undefined;
  const dueAt = dueHint ? parseRelativeDue(dueHint) ?? undefined : undefined;

  return {
    text: cleaned,
    owner: isAssistant ? 'clementine' : 'user',
    dueHint,
    dueAt,
  };
}

/**
 * Persist a detected commitment via the store, deduping on a stable
 * fingerprint. Designed to be called from the chat path; failures are
 * swallowed because commitment recording must never break a turn.
 */
export function recordDetectedCommitment(
  store: MemoryStore,
  sessionKey: string,
  detected: DetectedCommitment,
  meta: { source: string; transcriptId?: number; episodeId?: number },
): { id: number; created: boolean } | null {
  try {
    const fingerprint = fingerprintCommitment(sessionKey, detected.owner, normalizeText(detected.text));
    return store.upsertCommitment({
      fingerprint,
      source: meta.source,
      owner: detected.owner,
      text: detected.text,
      sessionKey,
      transcriptId: meta.transcriptId ?? null,
      episodeId: meta.episodeId ?? null,
      dueAt: detected.dueAt ?? null,
      dueHint: detected.dueHint ?? null,
    });
  } catch {
    return null;
  }
}
