/**
 * PRD §6 Phase 4d / 1.18.101 — Path B (hook side-channel) session registry.
 *
 * The Claude Agent SDK's hook mechanism (PreToolUse, PostToolUse, SubagentStart,
 * SubagentStop, Stop, Notification, etc.) lets command-type hooks defined in
 * `.claude/settings.json` POST event JSON to an external endpoint. Path B is
 * how the dashboard receives those events and merges them into the per-run
 * event log so the Run detail viewer + Latency dashboard see real per-tool
 * durations (not the path A heuristic).
 *
 * The challenge: hook events arrive with the SDK `session_id`, but the
 * dashboard's RunEvent rows key off the dashboard-assigned `runId` UUID. This
 * registry bridges the two — `runAgent` registers a `(sessionId, runId,
 * eventLog)` tuple on the SystemMessage init, the hook ingest endpoint looks
 * up by sessionId, and the entry clears on session_end so memory doesn't leak.
 *
 * Design notes:
 * - In-memory only (Map). Reboot clears all sessions; that's correct because
 *   any in-flight runs are abandoned by the daemon restart sweep anyway.
 * - Multiple concurrent runs are supported (one entry per active SDK session).
 * - Best-effort: if a hook arrives after session_end (race), we silently drop
 *   the event rather than replay onto a closed run. The dashboard's run
 *   detail can show a "stale hook event" diagnostic if this becomes common.
 */

import type { EventLog } from '../gateway/event-log.js';

export interface HookSessionEntry {
  /** Dashboard-assigned UUID linking back to CronRunEntry.id. */
  runId: string;
  /** EventLog instance owning the run's JSONL file. Reused so path B writes
   *  go to the same file as path A live events. */
  eventLog: EventLog;
  /** Wall-clock when the registration happened. Used for janitor cleanup
   *  if a session_end never fires (SDK crash / network blip). */
  registeredAt: number;
  /** Atomic counter used so path B writes get monotonically increasing seqs
   *  even when interleaved with path A. The registry hands out seq numbers
   *  via `nextSeq()` below; path A uses its own closure-local counter and
   *  the EventLog dedupes on disk via append-only ordering. */
  seqCounter: number;
}

const sessions = new Map<string, HookSessionEntry>();

/** Janitor sweep: clear sessions that have been registered for more than this
 *  many ms without a session_end. Keeps the map bounded if the daemon stays
 *  up but a run dies in a way that bypasses our session_end handler. */
const STALE_SESSION_MS = 6 * 60 * 60 * 1000; // 6h — matches longest cron wall cap

export function registerRunSession(sessionId: string, runId: string, eventLog: EventLog, seqStart = 0): void {
  if (!sessionId || !runId) return;
  sessions.set(sessionId, { runId, eventLog, registeredAt: Date.now(), seqCounter: seqStart });
}

export function unregisterRunSession(sessionId: string): void {
  if (!sessionId) return;
  sessions.delete(sessionId);
}

export function getRunSession(sessionId: string): HookSessionEntry | null {
  return sessions.get(sessionId) ?? null;
}

/** Hand out the next monotonic seq for path B writes on this session. The
 *  caller is responsible for actually appending the event; this function
 *  just bumps the counter and returns the prior value so writes are stable
 *  under concurrent calls. */
export function nextSeqForSession(sessionId: string): number | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  // Path B seqs start at 1_000_000 to keep them visually distinct from
  // path A in the event log + so a sort by seq groups them after path A
  // writes that share the same timestamp. Multi-million seq numbers are
  // fine — the field is plain JSON number, no overflow risk for the
  // forseeable future.
  const seq = 1_000_000 + entry.seqCounter;
  entry.seqCounter += 1;
  return seq;
}

/** Best-effort sweep — call from a periodic timer or before each lookup
 *  to keep stale entries from accumulating. Currently called from the
 *  ingest endpoint on every POST so we don't need a dedicated timer. */
export function sweepStaleSessions(): number {
  const now = Date.now();
  let removed = 0;
  for (const [sid, entry] of sessions.entries()) {
    if (now - entry.registeredAt > STALE_SESSION_MS) {
      sessions.delete(sid);
      removed += 1;
    }
  }
  return removed;
}

/** Test-only: snapshot of the live map size + age distribution. Useful for
 *  janitor diagnostics in the dashboard. */
export function getRegistryStats(): { count: number; oldestAgeMs: number | null } {
  if (sessions.size === 0) return { count: 0, oldestAgeMs: null };
  const now = Date.now();
  let oldest = 0;
  for (const entry of sessions.values()) {
    const age = now - entry.registeredAt;
    if (age > oldest) oldest = age;
  }
  return { count: sessions.size, oldestAgeMs: oldest };
}

/** Test-only: clear the registry between tests. Never call from production. */
export function _resetRegistryForTests(): void {
  sessions.clear();
}
