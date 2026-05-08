/**
 * PRD §6 / Phase 4e — Path C: subagent transcript backfill.
 *
 * The Claude Agent SDK persists every subagent's full message stream to
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl
 *
 * The parent run's in-process tap (path A in `run-agent.ts`) only sees the
 * top-level Task tool_use + tool_result, so subagent-internal LLM/tool calls
 * are invisible in the Run detail waterfall. After the parent run ends, this
 * module reads any matching agent-*.jsonl files for the run's sessionId and
 * appends synthesized Event rows so the waterfall can render nested subagent
 * activity.
 *
 * Best-effort by design — never throws back to the caller. Missing dir / parse
 * errors / timing skew are all acceptable; the worst case is the parent run
 * looks the same as before the backfill.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { EventLog } from '../gateway/event-log.js';
import type { RunEvent } from '../types.js';

const logger = pino({ name: 'clementine.subagent-backfill' });

/**
 * Encode a cwd path the way the SDK does for `~/.claude/projects/<encoded>`:
 * every slash, backslash, and whitespace character becomes `-`. Confirmed
 * against existing on-disk dirs (e.g. paths containing spaces and `..`).
 */
export function encodeProjectCwd(cwd: string): string {
  return cwd.replace(/[/\\\s.]/g, '-');
}

/** One JSONL line out of agent-*.jsonl. Loose typing — the SDK can add fields. */
interface SubagentJsonlLine {
  parentUuid?: string | null;
  isSidechain?: boolean;
  sessionId?: string;
  agentId?: string;
  slug?: string;
  type?: 'user' | 'assistant' | string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'thinking'; thinking?: string }
      | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
      | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
    >;
  };
}

interface BackfillResult {
  /** Number of synthesized RunEvent rows appended to the run's event log. */
  backfilled: number;
  /** Number of agent-*.jsonl files parsed. */
  agents: number;
  /** Resolved subagents directory (helpful in audit logs when nothing matches). */
  scannedDir: string | null;
}

interface BackfillOpts {
  runId: string;
  sessionId: string;
  cwd: string;
  /** Pass the parent run's EventLog so we can append in-place. */
  eventLog: EventLog;
  /** Sequence number to start at. The caller already wrote N events; we
   *  continue from there to keep the file ordered. */
  startSeq: number;
}

/**
 * Walk a single agent-*.jsonl file and synthesize RunEvent rows.
 * Returns the events as a flat array; the caller appends them to the
 * shared event log so we can offset their `seq` correctly.
 */
function synthesizeFromFile(filePath: string, runId: string): RunEvent[] {
  const out: RunEvent[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.debug({ err, filePath }, 'subagent-backfill: read failed');
    return out;
  }

  const lines = raw.split('\n');
  // The agentId in the filename (agent-<id>.jsonl) is the stable handle for
  // this subagent; we tag every synthesized event with it so the waterfall
  // can group them under one swimlane.
  const baseName = path.basename(filePath, '.jsonl'); // "agent-a333f70"
  const agentId = baseName.replace(/^agent-/, '');

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: SubagentJsonlLine;
    try {
      parsed = JSON.parse(line) as SubagentJsonlLine;
    } catch {
      // Tolerate the rare half-flushed line at EOF.
      continue;
    }
    const ts = parsed.timestamp || new Date().toISOString();
    const slug = parsed.slug;
    const subagentId = parsed.agentId || agentId;
    const blocks = parsed.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      // Build the same RunEvent kinds the parent run uses, but tagged with
      // agentId/subagentSlug + source='backfill' so the Run detail viewer
      // can render them in a nested swimlane. seq is filled in by the
      // caller; common fields go through to match path A's shape.
      const common: Partial<RunEvent> = {
        runId,
        ts,
        agentId: subagentId,
        subagentSlug: slug,
        source: 'backfill',
      };
      if (block.type === 'text' && block.text) {
        out.push({ ...common, kind: 'llm_text', text: block.text, seq: -1 } as RunEvent);
      } else if (block.type === 'thinking' && block.thinking) {
        out.push({ ...common, kind: 'thinking', thinking: block.thinking, seq: -1 } as RunEvent);
      } else if (block.type === 'tool_use') {
        out.push({
          ...common,
          kind: 'tool_call',
          toolName: block.name || 'unknown',
          toolUseId: block.id,
          toolInput: block.input,
          seq: -1,
        } as RunEvent);
      } else if (block.type === 'tool_result') {
        const previewSrc = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content ?? '');
        out.push({
          ...common,
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          // truncate huge tool_results to keep event-log size sane
          toolResult: previewSrc.slice(0, 4000),
          ...(block.is_error ? { toolError: previewSrc.slice(0, 1000) } : {}),
          seq: -1,
        } as RunEvent);
      }
    }
  }

  return out;
}

/**
 * Scan ~/.claude/projects/<encoded(cwd)>/<sessionId>/subagents/agent-*.jsonl
 * and append synthesized RunEvent rows to the parent run's event log.
 *
 * The function is fire-and-forget from runAgent's POV — it never rejects.
 */
export async function backfillSubagentEvents(opts: BackfillOpts): Promise<BackfillResult> {
  const { runId, sessionId, cwd, eventLog, startSeq } = opts;

  const result: BackfillResult = { backfilled: 0, agents: 0, scannedDir: null };

  if (!sessionId || !cwd) return result;

  let projectsRoot: string;
  try {
    projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    if (!existsSync(projectsRoot)) return result;
  } catch {
    return result;
  }

  const encoded = encodeProjectCwd(cwd);
  const subDir = path.join(projectsRoot, encoded, sessionId, 'subagents');
  result.scannedDir = subDir;

  if (!existsSync(subDir)) return result;

  let files: string[];
  try {
    files = readdirSync(subDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch (err) {
    logger.debug({ err, subDir }, 'subagent-backfill: readdir failed');
    return result;
  }
  if (files.length === 0) return result;

  // Aggregate across all subagent files, then sort by ts so the waterfall
  // renders in chronological order regardless of which agent file we read first.
  const all: RunEvent[] = [];
  for (const f of files) {
    const fp = path.join(subDir, f);
    const synthesized = synthesizeFromFile(fp, runId);
    if (synthesized.length > 0) {
      all.push(...synthesized);
      result.agents += 1;
    }
  }
  all.sort((a, b) => {
    const ta = (a as { ts?: string }).ts ?? '';
    const tb = (b as { ts?: string }).ts ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  // Stamp seq + append. EventLog.append swallows its own errors so we just
  // call it in a loop. The starting seq comes from the caller (the parent
  // run's last writeEvent counter) so backfill rows sort after live rows.
  let seq = startSeq;
  for (const ev of all) {
    (ev as { seq: number }).seq = seq++;
    eventLog.append(ev);
    result.backfilled += 1;
  }

  return result;
}
