/**
 * Clementine TypeScript — Claim tracking.
 *
 * Every outbound DM passes through the notification dispatcher. This
 * module parses those messages for claims Clementine makes (promises,
 * fixes, scheduled actions) and persists them to a SQLite table so we
 * can verify them later and compute a rolling trust score.
 *
 * The bluntest answer to "you told me you fixed it twice and it wasn't
 * fixed" — every claim is now recorded, some auto-verified, all
 * reviewable in the dashboard.
 *
 * Extraction is regex-only to keep cost at $0 per DM. For nuanced
 * claims the dashboard's manual verify/fail path covers the gap.
 */

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR, MEMORY_DB_PATH, VAULT_DIR } from '../config.js';
import type { Gateway } from './router.js';

const logger = pino({ name: 'clementine.claim-tracker' });

export type ClaimType = 'scheduled' | 'fixed' | 'will_do' | 'sent' | 'added' | 'unknown';
export type VerifyStrategy = 'cron_run_check' | 'config_inspect' | 'manual';
export type ClaimStatus = 'pending' | 'verified' | 'failed' | 'expired' | 'dismissed';

export interface Claim {
  id: string;
  sessionKey: string | null;
  messageSnippet: string;
  claimType: ClaimType;
  subject: string;
  dueAt: string | null;
  verifyStrategy: VerifyStrategy;
  status: ClaimStatus;
  verdict: string | null;
  extractedAt: string;
  verifiedAt: string | null;
  agentSlug: string | null;
}

/**
 * Regex patterns for claim extraction. Deliberately conservative —
 * matches obvious shapes, returns null for ambiguous text. False
 * positives degrade trust-score signal, so we prefer to miss rather
 * than over-flag.
 *
 * Order matters — more specific patterns first.
 */
interface Pattern {
  type: ClaimType;
  re: RegExp;
  /** Extract { subject, dueAt? } from match groups. */
  extract: (m: RegExpMatchArray) => { subject: string; dueAt?: string } | null;
  verifyStrategy: VerifyStrategy;
}

/**
 * Parse common time expressions into an absolute ISO timestamp.
 * Intentionally narrow — only handles shapes we're confident about.
 * Returns null for "soon", "later", "in a bit" type phrases.
 */
function parseDueAt(expr: string, now = new Date()): string | null {
  const s = expr.trim().toLowerCase();

  // "tomorrow at 8am" / "tomorrow at 8:30 am" / "tomorrow at 5pm"
  const tomorrowRe = /^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/;
  const tm = s.match(tomorrowRe);
  if (tm) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (tm[1]) {
      let h = Number(tm[1]);
      const min = Number(tm[2] ?? '0');
      if (tm[3] === 'pm' && h < 12) h += 12;
      if (tm[3] === 'am' && h === 12) h = 0;
      d.setHours(h, min, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0); // default to 9am if no specific time
    }
    return d.toISOString();
  }

  // "at 8am" / "at 4:30pm" / "8am" — today, roll to tomorrow if past
  const todayRe = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/;
  const today = s.match(todayRe);
  if (today) {
    const d = new Date(now);
    let h = Number(today[1]);
    const min = Number(today[2] ?? '0');
    if (today[3] === 'pm' && h < 12) h += 12;
    if (today[3] === 'am' && h === 12) h = 0;
    d.setHours(h, min, 0, 0);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1); // next occurrence
    return d.toISOString();
  }

  // "in 30 minutes" / "in 2 hours"
  const relRe = /^in\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?)$/;
  const rel = s.match(relRe);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!;
    const ms = unit.startsWith('min') ? n * 60_000 : n * 3_600_000;
    return new Date(now.getTime() + ms).toISOString();
  }

  return null;
}

const PATTERNS: Pattern[] = [
  // "I scheduled market-leader-followup for tomorrow at 8:30am"
  // "I've scheduled the reply-detection job for 8am tomorrow"
  // "Scheduled the X for tomorrow at 9am"
  {
    type: 'scheduled',
    re: /(?:I(?:'ve|\s+have)?\s+)?scheduled\s+(?:the\s+)?(\S[^,.!?\n]+?)(?:\s+job)?\s+(?:for|at|on)\s+([^,.!?\n]+)/i,
    extract: (m) => {
      const subject = m[1]!.trim().slice(0, 200);
      const due = parseDueAt(m[2]!.trim());
      return due ? { subject, dueAt: due } : { subject };
    },
    verifyStrategy: 'cron_run_check',
  },

  // "I fixed X" / "Fixed Y" / "I've applied the fix"
  // Ambiguous. We look for short, declarative "fixed <noun phrase>" at the
  // start of a sentence or after a period.
  {
    type: 'fixed',
    re: /(?:^|[.!?]\s+)(?:I(?:'ve|\s+have)?\s+)?(?:fixed|resolved|applied\s+the\s+fix\s+for)\s+([\w-][\w\s:-]{2,80})/i,
    extract: (m) => ({ subject: m[1]!.trim().slice(0, 200) }),
    verifyStrategy: 'config_inspect',
  },

  // "I'll send the email at 4pm" / "I will run X tomorrow morning"
  // Must have a time anchor to be meaningful.
  {
    type: 'will_do',
    re: /\bI(?:'ll|\s+will)\s+(\w+\s+\S[^,.!?\n]{0,80}?)\s+(?:at|by|in|on|tomorrow|today)\s+([^,.!?\n]+)/i,
    extract: (m) => {
      const subject = m[1]!.trim().slice(0, 200);
      const due = parseDueAt(m[2]!.trim());
      return due ? { subject, dueAt: due } : { subject };
    },
    verifyStrategy: 'manual',
  },

  // "Sent email to X" / "I sent the email to..."
  {
    type: 'sent',
    re: /(?:^|[.!?]\s+)(?:I(?:'ve|\s+have)?\s+)?sent\s+(?:an?\s+|the\s+)?(email|message|DM|notification)\s+to\s+([^,.!?\n]{2,80})/i,
    extract: (m) => ({ subject: `${m[1]} to ${m[2]!.trim()}`.slice(0, 200) }),
    verifyStrategy: 'manual',
  },
];

/**
 * In-memory queue of DMs that regex-extraction missed but that look like
 * they might contain claims (long enough, user-facing session). The
 * heartbeat sweep drains this queue and runs the LLM fallback.
 *
 * Bounded to prevent memory growth — oldest entries are evicted.
 */
const MAX_PENDING_LLM = 20;
const pendingLLMExtraction: Array<{
  text: string;
  sessionKey: string | null;
  agentSlug: string | null;
  queuedAt: number;
}> = [];

function enqueueForLLM(text: string, sessionKey: string | null, agentSlug: string | null): void {
  // De-dup by text hash within the queue — don't re-enqueue the same DM.
  const hash = sha1(text);
  if (pendingLLMExtraction.some(e => sha1(e.text) === hash)) return;
  pendingLLMExtraction.push({ text, sessionKey, agentSlug, queuedAt: Date.now() });
  while (pendingLLMExtraction.length > MAX_PENDING_LLM) pendingLLMExtraction.shift();
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Should a non-matching DM be considered for LLM fallback? */
function isLLMFallbackCandidate(text: string, sessionKey: string | null): boolean {
  if (!sessionKey) return false;
  if (text.length < 100) return false;
  // Owner-facing DMs only. Skip heartbeat check-ins (they have their own
  // gate) and skip cron notification messages that are the system talking
  // about itself.
  if (!sessionKey.startsWith('discord:') && !sessionKey.startsWith('slack:') && !sessionKey.startsWith('telegram:')) return false;
  if (text.startsWith('**[') && text.includes('check-in]')) return false;
  return true;
}

/**
 * Extract claims from a message. Returns empty array if nothing matched.
 * Caller supplies sessionKey for traceability. Never throws.
 */
export function extractClaims(text: string, sessionKey?: string | null, agentSlug?: string | null): Omit<Claim, 'status' | 'extractedAt' | 'verifiedAt' | 'verdict'>[] {
  if (!text || typeof text !== 'string') return [];

  // Skip fix-verification DMs we emit ourselves — those are meta-claims that
  // would re-enter this pipeline and create infinite loops.
  if (text.startsWith('**[Fix verification]**')) return [];
  if (text.startsWith('🚨 **') && text.includes('cron job') && text.includes('failing')) return [];
  if (text.startsWith('⚡ **Circuit breaker') || text.startsWith('✅ **Circuit breaker')) return [];
  if (text.startsWith('🛑 **Cron auto-disabled**')) return [];

  const out: Omit<Claim, 'status' | 'extractedAt' | 'verifiedAt' | 'verdict'>[] = [];
  const seenSubjects = new Set<string>();

  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const extracted = p.extract(m);
    if (!extracted) continue;

    // De-dup within a single message (two patterns hitting the same text)
    const key = `${p.type}:${extracted.subject.toLowerCase()}`;
    if (seenSubjects.has(key)) continue;
    seenSubjects.add(key);

    out.push({
      id: randomBytes(6).toString('hex'),
      sessionKey: sessionKey ?? null,
      messageSnippet: text.slice(0, 400),
      claimType: p.type,
      subject: extracted.subject,
      dueAt: extracted.dueAt ?? null,
      verifyStrategy: p.verifyStrategy,
      agentSlug: agentSlug ?? null,
    });
  }

  // Regex missed this DM but it looks like it could contain a claim the
  // regex patterns can't catch ("Got that done", "Sent it, you should see
  // it in a minute"). Queue for LLM fallback on the next heartbeat.
  if (out.length === 0 && isLLMFallbackCandidate(text, sessionKey ?? null)) {
    enqueueForLLM(text, sessionKey ?? null, agentSlug ?? null);
  }

  return out;
}

/**
 * Drain the LLM-fallback queue: pick up to N enqueued DMs, ask Haiku
 * to extract claims via the same shape the regex patterns use, persist
 * any found. Best-effort — errors just leave the queue unchanged for
 * the next sweep.
 */
export async function drainLLMFallback(gateway: Gateway, maxPerSweep = 3): Promise<number> {
  let drained = 0;
  const batch = pendingLLMExtraction.splice(0, Math.min(maxPerSweep, pendingLLMExtraction.length));

  for (const item of batch) {
    try {
      const claims = await llmExtractClaims(item.text, gateway);
      if (claims.length === 0) continue;
      const toRecord = claims.map(c => ({
        id: randomBytes(6).toString('hex'),
        sessionKey: item.sessionKey,
        messageSnippet: item.text.slice(0, 400),
        claimType: c.claimType,
        subject: c.subject,
        dueAt: c.dueAt,
        verifyStrategy: c.verifyStrategy,
        agentSlug: item.agentSlug,
      }));
      await recordClaims(toRecord);
      drained += claims.length;
    } catch (err) {
      logger.debug({ err }, 'LLM fallback extraction failed for one DM');
    }
  }

  return drained;
}

async function llmExtractClaims(text: string, gateway: Gateway): Promise<Array<{
  claimType: ClaimType;
  subject: string;
  dueAt: string | null;
  verifyStrategy: VerifyStrategy;
}>> {
  const prompt = [
    'You are analyzing a chat message Clementine (an AI assistant) just sent to her owner. Did Clementine make any commitments, promises, or claims about something she did or will do?',
    '',
    'Only extract claims where there\'s a clear, concrete action. Do NOT extract:',
    '- Status updates ("inbox has 5 messages")',
    '- Questions ("Should I proceed?")',
    '- Suggestions ("You might want to check X")',
    '- Routine check-ins or greetings',
    '',
    'DO extract:',
    '- "I scheduled X" / "I added Y to your tasks" / "I fixed Z"',
    '- "I\'ll send X at Ypm" / "Will run Y tomorrow"',
    '- "Sent email to X" / "Posted to #channel"',
    '',
    '## Message:',
    text.slice(0, 1500),
    '',
    'Output a JSON object only (no fences):',
    '{',
    '  "claims": [',
    '    {',
    '      "claimType": "scheduled|fixed|will_do|sent|added",',
    '      "subject": "short description of what (the noun phrase)",',
    '      "dueAt": "ISO timestamp if a specific time was mentioned, else null"',
    '    }',
    '  ]',
    '}',
    'Empty array if no real commitments.',
  ].join('\n');

  let raw: string;
  try {
    raw = await gateway.handleCronJob(
      'llm-claim-extract',
      prompt,
      1, // tier 1
      3, // tight maxTurns
      'haiku',
    );
  } catch {
    return [];
  }

  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as { claims?: Array<{ claimType?: unknown; subject?: unknown; dueAt?: unknown }> };
    const claims = parsed.claims ?? [];
    const out: Array<{ claimType: ClaimType; subject: string; dueAt: string | null; verifyStrategy: VerifyStrategy }> = [];
    const validTypes: ClaimType[] = ['scheduled', 'fixed', 'will_do', 'sent', 'added'];

    for (const c of claims) {
      if (typeof c.subject !== 'string' || !c.subject.trim()) continue;
      const type = typeof c.claimType === 'string' && validTypes.includes(c.claimType as ClaimType)
        ? (c.claimType as ClaimType)
        : 'unknown';
      if (type === 'unknown') continue;
      const dueAt = typeof c.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(c.dueAt) ? c.dueAt : null;
      out.push({
        claimType: type,
        subject: c.subject.trim().slice(0, 200),
        dueAt,
        verifyStrategy: type === 'scheduled' ? 'cron_run_check' : 'manual',
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Persistence ──────────────────────────────────────────────────────

async function getStore() {
  const { MemoryStore } = await import('../memory/store.js');
  const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
  store.initialize();
  return store;
}

export async function recordClaims(claims: Omit<Claim, 'status' | 'extractedAt' | 'verifiedAt' | 'verdict'>[]): Promise<void> {
  if (claims.length === 0) return;
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO claims
       (id, session_key, message_snippet, claim_type, subject, due_at, verify_strategy, status, agent_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    const tx = db.transaction((rows: typeof claims) => {
      for (const c of rows) {
        stmt.run(c.id, c.sessionKey, c.messageSnippet, c.claimType, c.subject, c.dueAt, c.verifyStrategy, c.agentSlug);
      }
    });
    tx(claims);
    store.close();
    logger.info({ count: claims.length, types: claims.map(c => c.claimType) }, 'Recorded claims');
  } catch (err) {
    logger.warn({ err }, 'Failed to record claims');
  }
}

export async function listClaims(opts: {
  status?: ClaimStatus;
  limit?: number;
  sinceHours?: number;
} = {}): Promise<Claim[]> {
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.sinceHours) {
      where.push(`extracted_at >= datetime('now', ?)`);
      params.push(`-${opts.sinceHours} hours`);
    }
    const sql = `SELECT id, session_key AS sessionKey, message_snippet AS messageSnippet, claim_type AS claimType,
                        subject, due_at AS dueAt, verify_strategy AS verifyStrategy, status, verdict,
                        extracted_at AS extractedAt, verified_at AS verifiedAt, agent_slug AS agentSlug
                 FROM claims
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY extracted_at DESC
                 LIMIT ?`;
    params.push(opts.limit ?? 50);
    const rows = db.prepare(sql).all(...params) as Claim[];
    store.close();
    return rows;
  } catch (err) {
    logger.warn({ err }, 'Failed to list claims');
    return [];
  }
}

export async function setClaimStatus(id: string, status: ClaimStatus, verdict?: string): Promise<boolean> {
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    const result = db.prepare(
      `UPDATE claims SET status = ?, verdict = ?, verified_at = datetime('now') WHERE id = ?`,
    ).run(status, verdict ?? null, id);
    store.close();
    return result.changes > 0;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to set claim status');
    return false;
  }
}

/**
 * Rolling trust score over the last N verified-or-failed claims.
 * Ignores 'pending', 'expired', and 'dismissed' — only signal from
 * actual verdicts. Returns null when there's not enough data (<3
 * judged claims) to be meaningful.
 */
export async function trustScore(lastN = 30): Promise<{
  score: number | null;
  verified: number;
  failed: number;
  total: number;
} | null> {
  try {
    const store = await getStore();
    const db = (store as any).conn as import('better-sqlite3').Database;
    const rows = db.prepare(
      `SELECT status FROM claims
       WHERE status IN ('verified', 'failed')
       ORDER BY extracted_at DESC
       LIMIT ?`,
    ).all(lastN) as Array<{ status: ClaimStatus }>;
    store.close();
    const verified = rows.filter(r => r.status === 'verified').length;
    const failed = rows.filter(r => r.status === 'failed').length;
    const total = verified + failed;
    if (total < 3) return { score: null, verified, failed, total };
    return { score: verified / total, verified, failed, total };
  } catch (err) {
    logger.warn({ err }, 'Failed to compute trust score');
    return null;
  }
}

// ── Auto-verification ────────────────────────────────────────────────

/**
 * Sweep pending claims whose due_at has passed and try to verify them.
 * Returns count of claims verified/failed. Safe to call repeatedly —
 * only processes pending claims.
 */
export async function verifyDueClaims(now = Date.now()): Promise<{ verified: number; failed: number; expired: number }> {
  const pending = await listClaims({ status: 'pending', limit: 100 });
  let verified = 0;
  let failed = 0;
  let expired = 0;

  for (const c of pending) {
    // Only verify claims whose due time has passed
    if (c.dueAt) {
      const dueMs = Date.parse(c.dueAt);
      if (Number.isFinite(dueMs) && dueMs > now) continue;
    } else {
      // Claims without due_at: give them 24h grace period then mark expired
      const extractedMs = Date.parse(c.extractedAt);
      if (Number.isFinite(extractedMs) && now - extractedMs > 24 * 3600_000 && c.verifyStrategy === 'manual') {
        await setClaimStatus(c.id, 'expired', 'No due time set and 24h elapsed — no automatic verification available.');
        expired++;
        continue;
      }
      continue; // still in grace period
    }

    if (c.verifyStrategy === 'cron_run_check') {
      const verdict = await verifyCronScheduledClaim(c, now);
      if (verdict === 'verified') { await setClaimStatus(c.id, 'verified', 'Run observed at or after due time.'); verified++; }
      else if (verdict === 'failed') { await setClaimStatus(c.id, 'failed', 'No run observed after due time (gave 1h grace).'); failed++; }
      // null = not ready yet, leave pending
    }
    // Other strategies: left pending for manual verification
  }

  return { verified, failed, expired };
}

/**
 * For a "scheduled" claim, check the cron run log. If an entry exists
 * at or after due_at, claim is verified. If >1h past due with no run,
 * it's failed. If not yet time or within grace, null.
 */
async function verifyCronScheduledClaim(claim: Claim, now: number): Promise<'verified' | 'failed' | null> {
  if (!claim.dueAt) return null;
  const dueMs = Date.parse(claim.dueAt);
  if (!Number.isFinite(dueMs)) return null;

  const graceMs = 60 * 60 * 1000; // 1h grace window
  if (now < dueMs + 60_000) return null; // not yet time

  // Derive the job name from the subject. The subject is free-text from the
  // DM, so we match permissively against known job names in cron/runs/.
  const { existsSync, readdirSync, readFileSync } = await import('node:fs');
  const runsDir = path.join(BASE_DIR, 'cron', 'runs');
  if (!existsSync(runsDir)) return now > dueMs + graceMs ? 'failed' : null;

  const subjectLower = claim.subject.toLowerCase();
  const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    const bare = file.replace(/\.jsonl$/, '').replace(/_/g, '-').toLowerCase();
    // Match if subject contains the job name or vice versa
    if (!subjectLower.includes(bare) && !bare.includes(subjectLower.split(/\s+/)[0]!)) continue;

    try {
      const lines = readFileSync(path.join(runsDir, file), 'utf-8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]!) as { startedAt: string; status: string };
        const ms = Date.parse(entry.startedAt);
        if (Number.isFinite(ms) && ms >= dueMs && ms <= dueMs + graceMs) {
          // Found a run in the due window
          return entry.status === 'ok' ? 'verified' : 'failed';
        }
        if (ms < dueMs) break; // older than due — no point scanning further back
      }
    } catch { /* skip malformed */ }
  }

  // No matching run found within grace window
  return now > dueMs + graceMs ? 'failed' : null;
}
