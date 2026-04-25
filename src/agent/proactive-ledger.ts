import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ProactiveDecision } from './proactive-engine.js';

// Mirrors CronRunLog (cron-scheduler.ts) — keep the file bounded so reads
// don't grow linearly forever.
const MAX_BYTES = 2_000_000;
const MAX_LINES = 2000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Per-file dedup cache: idempotencyKey → latest timestamp ms. Built lazily
// on first lookup, kept in sync on every append.
const dedupCache = new Map<string, Map<string, number>>();

export interface ProactiveDecisionContext {
  signalType: string;
  description: string;
  goalId?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface ProactiveDecisionOutcome {
  status:
    | 'advanced'
    | 'queued'
    | 'asked-user'
    | 'snoozed'
    | 'ignored'
    | 'blocked-on-user'
    | 'blocked-on-external'
    | 'needs-different-approach'
    | 'monitoring'
    | 'no-change'
    | 'failed';
  summary: string;
  recordedAt: string;
}

export interface ProactiveDecisionRecord {
  id: string;
  timestamp: string;
  decision: ProactiveDecision;
  context: ProactiveDecisionContext;
  outcome?: ProactiveDecisionOutcome;
}

export interface ProactiveLedgerOptions {
  filePath?: string;
  now?: Date;
}

const DEFAULT_LEDGER_FILE = path.join(BASE_DIR, 'proactive', 'decisions.jsonl');

function ledgerPath(opts?: ProactiveLedgerOptions): string {
  return opts?.filePath ?? DEFAULT_LEDGER_FILE;
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function readRecords(filePath: string): ProactiveDecisionRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProactiveDecisionRecord);
  } catch {
    return [];
  }
}

function getDedupCache(filePath: string): Map<string, number> {
  let cache = dedupCache.get(filePath);
  if (cache) return cache;
  cache = new Map();
  for (const record of readRecords(filePath)) {
    const ts = new Date(record.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const prev = cache.get(record.decision.idempotencyKey) ?? 0;
    if (ts > prev) cache.set(record.decision.idempotencyKey, ts);
  }
  dedupCache.set(filePath, cache);
  return cache;
}

function touchDedupCache(filePath: string, idempotencyKey: string, timestampMs: number): void {
  const cache = dedupCache.get(filePath);
  if (!cache) return; // not yet initialized — will be built fresh on next read
  const prev = cache.get(idempotencyKey) ?? 0;
  if (timestampMs > prev) cache.set(idempotencyKey, timestampMs);
}

function maybePrune(filePath: string): void {
  try {
    const { size } = statSync(filePath);
    if (size <= MAX_BYTES) return;
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;

    const cutoff = Date.now() - MAX_AGE_MS;
    const kept: string[] = [];
    for (const line of lines.slice(-MAX_LINES)) {
      try {
        const record = JSON.parse(line) as ProactiveDecisionRecord;
        const ts = new Date(record.timestamp).getTime();
        if (Number.isFinite(ts) && ts >= cutoff) kept.push(line);
      } catch { /* drop malformed */ }
    }
    writeFileSync(filePath, kept.join('\n') + (kept.length ? '\n' : ''));
    // Cache is now stale w.r.t. dropped entries (older than dedup windows
    // anyway), but rebuild lazily to avoid reading the file twice here.
    dedupCache.delete(filePath);
  } catch {
    // non-fatal
  }
}

export function recordDecision(
  decision: ProactiveDecision,
  context: ProactiveDecisionContext,
  opts?: ProactiveLedgerOptions,
): ProactiveDecisionRecord {
  const now = opts?.now ?? new Date();
  const record: ProactiveDecisionRecord = {
    id: hash(`${decision.idempotencyKey}:${now.toISOString()}:${context.signalType}`),
    timestamp: now.toISOString(),
    decision,
    context,
  };

  const filePath = ledgerPath(opts);
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(record) + '\n');
  touchDedupCache(filePath, decision.idempotencyKey, now.getTime());
  setImmediate(() => maybePrune(filePath));
  return record;
}

/**
 * Append an outcome record. Event-sourced: outcomes are written as a NEW
 * record sharing the original decision's `id`, not as in-place updates.
 *
 * `wasRecentlyDecided` therefore counts outcome records as "decided" — that
 * is intentional. We don't want to re-act on a signal we've already handled,
 * regardless of whether the latest entry is the original decision or its
 * follow-up outcome.
 */
export function recordDecisionOutcome(
  decisionId: string,
  decision: ProactiveDecision,
  context: ProactiveDecisionContext,
  outcome: Omit<ProactiveDecisionOutcome, 'recordedAt'>,
  opts?: ProactiveLedgerOptions,
): ProactiveDecisionRecord {
  const now = opts?.now ?? new Date();
  const record: ProactiveDecisionRecord = {
    id: decisionId,
    timestamp: now.toISOString(),
    decision,
    context,
    outcome: {
      ...outcome,
      recordedAt: now.toISOString(),
    },
  };

  const filePath = ledgerPath(opts);
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(record) + '\n');
  touchDedupCache(filePath, decision.idempotencyKey, now.getTime());
  setImmediate(() => maybePrune(filePath));
  return record;
}

export function recentDecisions(
  filter: Partial<{
    idempotencyKey: string;
    action: ProactiveDecision['action'];
    source: ProactiveDecision['source'];
    sinceMs: number;
  }> = {},
  opts?: ProactiveLedgerOptions,
): ProactiveDecisionRecord[] {
  const filePath = ledgerPath(opts);
  const nowMs = (opts?.now ?? new Date()).getTime();
  return readRecords(filePath)
    .filter((record) => {
      if (filter.idempotencyKey && record.decision.idempotencyKey !== filter.idempotencyKey) return false;
      if (filter.action && record.decision.action !== filter.action) return false;
      if (filter.source && record.decision.source !== filter.source) return false;
      if (filter.sinceMs != null) {
        const ts = new Date(record.timestamp).getTime();
        if (!Number.isFinite(ts) || nowMs - ts > filter.sinceMs) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function wasRecentlyDecided(
  idempotencyKey: string,
  windowMs: number,
  opts?: ProactiveLedgerOptions,
): boolean {
  const filePath = ledgerPath(opts);
  const nowMs = (opts?.now ?? new Date()).getTime();
  const cache = getDedupCache(filePath);
  const latest = cache.get(idempotencyKey);
  if (latest == null) return false;
  return nowMs - latest <= windowMs;
}

export function outcomeStatusFromGoalDisposition(
  disposition: string,
): ProactiveDecisionOutcome['status'] {
  switch (disposition) {
    case 'advanced':
      return 'advanced';
    case 'blocked-on-user':
      return 'blocked-on-user';
    case 'blocked-on-external':
      return 'blocked-on-external';
    case 'needs-different-approach':
      return 'needs-different-approach';
    case 'monitoring':
      return 'monitoring';
    case 'no-change':
      return 'no-change';
    case 'error':
    default:
      return 'failed';
  }
}
