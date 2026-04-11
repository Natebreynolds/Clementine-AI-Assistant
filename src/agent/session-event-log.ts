/**
 * Structured Session Event Log — Append-only JSONL event log for agent sessions.
 *
 * Inspired by Anthropic's managed agents architecture: durable state stored
 * outside the context window, enabling crash recovery and session replay.
 *
 * Events: tool_call, tool_result, checkpoint, phase_start, phase_end,
 * error, decision, compaction, query_start, query_end.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.event-log' });

const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per session log

// ── Event Types ────────────────────────────────────────────────────

export type SessionEventType =
  | 'query_start'
  | 'query_end'
  | 'tool_call'
  | 'tool_result'
  | 'checkpoint'
  | 'phase_start'
  | 'phase_end'
  | 'error'
  | 'decision'
  | 'compaction';

export interface SessionEvent {
  type: SessionEventType;
  timestamp: string;
  sessionKey: string;
  data: Record<string, unknown>;
}

export interface QueryStartEvent extends SessionEvent {
  type: 'query_start';
  data: { prompt: string; model?: string; source?: string };
}

export interface QueryEndEvent extends SessionEvent {
  type: 'query_end';
  data: { responseLength: number; sessionId?: string; terminalReason?: string; durationMs: number };
}

export interface ToolCallEvent extends SessionEvent {
  type: 'tool_call';
  data: { tool: string; input: Record<string, unknown>; toolUseId?: string };
}

export interface CheckpointEvent extends SessionEvent {
  type: 'checkpoint';
  data: { summary: string; completed?: string[]; remaining?: string[]; artifacts?: string[] };
}

export interface PhaseEvent extends SessionEvent {
  type: 'phase_start' | 'phase_end';
  data: { phase: number; jobName?: string; [key: string]: unknown };
}

export interface ErrorEvent extends SessionEvent {
  type: 'error';
  data: { message: string; code?: string; recoverable?: boolean };
}

// ── EventLog Class ─────────────────────────────────────────────────

export class EventLog {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? SESSIONS_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Sanitize session key for use as a filename. */
  private keyToFile(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120);
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /** Append an event to the session log. */
  emit(sessionKey: string, type: SessionEventType, data: Record<string, unknown>): void {
    try {
      const event: SessionEvent = {
        type,
        timestamp: new Date().toISOString(),
        sessionKey,
        data,
      };
      const filePath = this.keyToFile(sessionKey);

      // Size guard — rotate if too large
      if (existsSync(filePath)) {
        try {
          const { statSync } = require('node:fs');
          const stat = statSync(filePath);
          if (stat.size > MAX_LOG_SIZE) {
            const bakPath = filePath + '.bak';
            if (existsSync(bakPath)) unlinkSync(bakPath);
            require('node:fs').renameSync(filePath, bakPath);
          }
        } catch { /* non-fatal */ }
      }

      appendFileSync(filePath, JSON.stringify(event) + '\n');
    } catch (err) {
      logger.debug({ err, sessionKey, type }, 'Failed to emit event');
    }
  }

  // ── Convenience emitters ─────────────────────────────────────────

  emitQueryStart(sessionKey: string, prompt: string, opts?: { model?: string; source?: string }): void {
    this.emit(sessionKey, 'query_start', {
      prompt: prompt.slice(0, 500),
      model: opts?.model,
      source: opts?.source,
    });
  }

  emitQueryEnd(sessionKey: string, opts: { responseLength: number; sessionId?: string; terminalReason?: string; durationMs: number }): void {
    this.emit(sessionKey, 'query_end', opts);
  }

  emitToolCall(sessionKey: string, tool: string, input: Record<string, unknown>, toolUseId?: string): void {
    // Truncate large inputs to keep log manageable
    const truncatedInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const val = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '...' : v;
      truncatedInput[k] = val;
    }
    this.emit(sessionKey, 'tool_call', { tool, input: truncatedInput, toolUseId });
  }

  emitCheckpoint(sessionKey: string, summary: string, opts?: { completed?: string[]; remaining?: string[]; artifacts?: string[] }): void {
    this.emit(sessionKey, 'checkpoint', { summary, ...opts });
  }

  emitPhaseStart(sessionKey: string, phase: number, jobName?: string): void {
    this.emit(sessionKey, 'phase_start', { phase, jobName });
  }

  emitPhaseEnd(sessionKey: string, phase: number, opts?: Record<string, unknown>): void {
    this.emit(sessionKey, 'phase_end', { phase, ...opts });
  }

  emitError(sessionKey: string, message: string, opts?: { code?: string; recoverable?: boolean }): void {
    this.emit(sessionKey, 'error', { message: message.slice(0, 1000), ...opts });
  }

  // ── Readers ──────────────────────────────────────────────────────

  /** Get all events for a session. */
  getEvents(sessionKey: string, opts?: { type?: SessionEventType; limit?: number; since?: string }): SessionEvent[] {
    const filePath = this.keyToFile(sessionKey);
    if (!existsSync(filePath)) return [];

    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      let events: SessionEvent[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as SessionEvent;
          if (opts?.type && event.type !== opts.type) continue;
          if (opts?.since && event.timestamp < opts.since) continue;
          events.push(event);
        } catch { /* skip malformed lines */ }
      }

      if (opts?.limit) {
        events = events.slice(-opts.limit);
      }

      return events;
    } catch {
      return [];
    }
  }

  /** Get the last checkpoint for a session. */
  getLastCheckpoint(sessionKey: string): CheckpointEvent | null {
    const events = this.getEvents(sessionKey, { type: 'checkpoint' });
    return events.length > 0 ? (events[events.length - 1] as CheckpointEvent) : null;
  }

  /** Get recovery context for a crashed session — summarize what happened. */
  getRecoveryContext(sessionKey: string): string | null {
    const events = this.getEvents(sessionKey);
    if (events.length === 0) return null;

    // Find the last query_start without a matching query_end
    let lastQueryStart: SessionEvent | null = null;
    let lastQueryEnd: SessionEvent | null = null;

    for (const evt of events) {
      if (evt.type === 'query_start') lastQueryStart = evt;
      if (evt.type === 'query_end') lastQueryEnd = evt;
    }

    // If the last query completed, no recovery needed
    if (lastQueryEnd && lastQueryStart && lastQueryEnd.timestamp >= lastQueryStart.timestamp) {
      return null;
    }

    if (!lastQueryStart) return null;

    // Build recovery summary from events after the last query_start
    const afterStart = events.filter(e => e.timestamp >= lastQueryStart!.timestamp);
    const toolCalls = afterStart.filter(e => e.type === 'tool_call');
    const checkpoints = afterStart.filter(e => e.type === 'checkpoint');
    const errors = afterStart.filter(e => e.type === 'error');

    const parts: string[] = [];
    parts.push(`[Session Recovery: Your previous query was interrupted]`);
    parts.push(`Original prompt: ${(lastQueryStart.data.prompt as string || '').slice(0, 300)}`);

    if (toolCalls.length > 0) {
      const toolNames = toolCalls.map(t => t.data.tool as string).filter(Boolean);
      parts.push(`Tools used before interruption: ${toolNames.join(', ')}`);
    }

    if (checkpoints.length > 0) {
      const lastCp = checkpoints[checkpoints.length - 1];
      parts.push(`Last checkpoint: ${lastCp.data.summary as string || 'unknown'}`);
      if (Array.isArray(lastCp.data.completed) && (lastCp.data.completed as string[]).length > 0) {
        parts.push(`Completed: ${(lastCp.data.completed as string[]).join(', ')}`);
      }
      if (Array.isArray(lastCp.data.remaining) && (lastCp.data.remaining as string[]).length > 0) {
        parts.push(`Remaining: ${(lastCp.data.remaining as string[]).join(', ')}`);
      }
    }

    if (errors.length > 0) {
      parts.push(`Errors: ${errors.map(e => e.data.message as string).join('; ')}`);
    }

    parts.push(`Please pick up where you left off.`);

    return parts.join('\n');
  }

  /** Check if a session has an unfinished query (for crash recovery). */
  hasOrphanedQuery(sessionKey: string): boolean {
    const events = this.getEvents(sessionKey);
    let lastStart: string | null = null;
    let lastEnd: string | null = null;

    for (const evt of events) {
      if (evt.type === 'query_start') lastStart = evt.timestamp;
      if (evt.type === 'query_end') lastEnd = evt.timestamp;
    }

    return lastStart !== null && (lastEnd === null || lastEnd < lastStart);
  }

  /** Get tool usage stats for a session. */
  getToolStats(sessionKey: string): Record<string, number> {
    const events = this.getEvents(sessionKey, { type: 'tool_call' });
    const stats: Record<string, number> = {};
    for (const evt of events) {
      const tool = evt.data.tool as string;
      if (tool) stats[tool] = (stats[tool] ?? 0) + 1;
    }
    return stats;
  }

  /** Clean up old session logs (older than maxAge days). */
  cleanup(maxAgeDays = 30): number {
    if (!existsSync(this.dir)) return 0;
    const { readdirSync, statSync } = require('node:fs');
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    try {
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(this.dir, file);
        try {
          if (statSync(filePath).mtimeMs < cutoff) {
            unlinkSync(filePath);
            cleaned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }

    if (cleaned > 0) logger.info({ cleaned }, 'Cleaned up old session logs');
    return cleaned;
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _instance: EventLog | null = null;

export function getEventLog(): EventLog {
  if (!_instance) _instance = new EventLog();
  return _instance;
}
