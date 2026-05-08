/**
 * Per-run event log — PRD §6 / Phase 4a.
 *
 * Stores RunEvent rows as JSONL at ~/.clementine/events/<runId>.jsonl,
 * mirroring the existing CronRunLog pattern (auto-prune at 2MB / 2000 lines).
 * One file per run keeps reads cheap (no scanning unrelated runs) and lets
 * the Run detail page tail a single file for live updates.
 *
 * Writers:
 *   - In-process tap in runAgent (path A) writes session_start, llm_text,
 *     thinking, tool_call, tool_result, session_end during the SDK stream.
 *   - Hook side-channel (path B, Phase 4d) writes hook events.
 *   - Subagent backfill (path C, Phase 4e) synthesizes tool_call/tool_result
 *     for inner SDK calls that don't fire parent-level hooks.
 *
 * Reader: dashboard's Run detail page via /api/runs/:run_id/events.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import type { RunEvent } from '../types.js';

const logger = pino({ name: 'clementine.event-log', level: process.env.LOG_LEVEL ?? 'info' });

export class EventLog {
  private readonly dir: string;
  private static readonly MAX_BYTES = 2_000_000;
  private static readonly MAX_LINES = 2000;

  constructor(baseDir?: string) {
    this.dir = path.join(baseDir ?? BASE_DIR, 'events');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private logPath(runId: string): string {
    // Sanitize runId for filesystem — UUIDs are safe but we defend against
    // accidental non-UUID values flowing in from older callsites.
    const safe = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
    return path.join(this.dir, `${safe}.jsonl`);
  }

  append(event: RunEvent): void {
    if (!event.runId) {
      logger.warn({ event: { kind: event.kind, ts: event.ts } }, 'Event missing runId — dropped');
      return;
    }
    const filePath = this.logPath(event.runId);
    const line = JSON.stringify(event) + '\n';
    try {
      appendFileSync(filePath, line);
      // Prune asynchronously so the SDK stream loop never blocks on disk IO.
      setImmediate(() => this.maybePrune(filePath));
    } catch (err) {
      // Never throw to the caller — telemetry must not break runs.
      logger.warn({ err, runId: event.runId }, 'Failed to write event log');
    }
  }

  /** Read every event for one run, in seq order. */
  readByRun(runId: string): RunEvent[] {
    const filePath = this.logPath(runId);
    if (!existsSync(filePath)) return [];
    try {
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const events = lines
        .map((l) => {
          try { return JSON.parse(l) as RunEvent; }
          catch { return null; }
        })
        .filter((e): e is RunEvent => e !== null);
      // Sort by seq so events with the same ts (sub-millisecond bursts) order
      // deterministically.
      events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      return events;
    } catch {
      return [];
    }
  }

  /** Returns true if any events were captured for the run. Cheap existence check. */
  hasEventsForRun(runId: string): boolean {
    return existsSync(this.logPath(runId));
  }

  /** Drop one run's entire log. Called from cron-delete cascade cleanup. */
  removeRun(runId: string): boolean {
    const filePath = this.logPath(runId);
    if (!existsSync(filePath)) return false;
    try {
      writeFileSync(filePath, ''); // truncate, then unlink — symmetric with cron-runs delete pattern
      const fs = require('node:fs');
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      logger.warn({ err, runId }, 'Failed to remove event log');
      return false;
    }
  }

  /** Total disk size of all event logs in bytes. For diagnostics. */
  totalBytes(): number {
    if (!existsSync(this.dir)) return 0;
    let total = 0;
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.jsonl')) continue;
        try { total += statSync(path.join(this.dir, f)).size; } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return total;
  }

  private maybePrune(filePath: string): void {
    try {
      const { size } = statSync(filePath);
      if (size <= EventLog.MAX_BYTES) return;
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      if (lines.length <= EventLog.MAX_LINES) return;
      const trimmed = lines.slice(-EventLog.MAX_LINES);
      writeFileSync(filePath, trimmed.join('\n') + '\n');
    } catch {
      // non-critical
    }
  }
}
