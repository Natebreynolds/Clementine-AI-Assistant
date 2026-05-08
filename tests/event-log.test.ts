/**
 * EventLog: append + readByRun roundtrip, ordering, removeRun.
 * Uses a tmpdir per test for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/gateway/event-log.js';
import type { RunEvent } from '../src/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'clem-evt-'));
});
afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function ev(over: Partial<RunEvent>): RunEvent {
  return {
    runId: 'run-1',
    seq: 0,
    ts: new Date().toISOString(),
    kind: 'llm_text',
    ...over,
  } as RunEvent;
}

describe('EventLog', () => {
  it('appends and reads back events for a run in seq order', () => {
    const log = new EventLog(dir);
    log.append(ev({ runId: 'r-a', seq: 2, kind: 'tool_call', toolName: 'Bash', toolUseId: 't2' }));
    log.append(ev({ runId: 'r-a', seq: 0, kind: 'session_start' }));
    log.append(ev({ runId: 'r-a', seq: 1, kind: 'llm_text', text: 'hello' }));
    log.append(ev({ runId: 'r-a', seq: 3, kind: 'session_end', costUsd: 0.05 }));

    const read = log.readByRun('r-a');
    expect(read).toHaveLength(4);
    expect(read.map(e => e.seq)).toEqual([0, 1, 2, 3]);
    expect(read[0].kind).toBe('session_start');
    expect(read[2].toolName).toBe('Bash');
    expect(read[3].costUsd).toBe(0.05);
  });

  it('isolates events between runs', () => {
    const log = new EventLog(dir);
    log.append(ev({ runId: 'run-A', seq: 0, kind: 'session_start' }));
    log.append(ev({ runId: 'run-B', seq: 0, kind: 'session_start' }));
    log.append(ev({ runId: 'run-A', seq: 1, kind: 'llm_text', text: 'A only' }));

    expect(log.readByRun('run-A')).toHaveLength(2);
    expect(log.readByRun('run-B')).toHaveLength(1);
    expect(log.readByRun('run-C')).toEqual([]);
  });

  it('drops malformed JSON lines and keeps valid ones', () => {
    const log = new EventLog(dir);
    log.append(ev({ runId: 'r-junk', seq: 0, kind: 'session_start' }));
    // Manually corrupt the file with a bad line in the middle.
    const fs = require('node:fs');
    const file = path.join(dir, 'events', 'r-junk.jsonl');
    fs.appendFileSync(file, '{not json}\n');
    log.append(ev({ runId: 'r-junk', seq: 1, kind: 'session_end' }));

    const read = log.readByRun('r-junk');
    expect(read).toHaveLength(2);
  });

  it('hasEventsForRun returns true after first append', () => {
    const log = new EventLog(dir);
    expect(log.hasEventsForRun('r-h')).toBe(false);
    log.append(ev({ runId: 'r-h', seq: 0, kind: 'session_start' }));
    expect(log.hasEventsForRun('r-h')).toBe(true);
  });

  it('removeRun deletes the file', () => {
    const log = new EventLog(dir);
    log.append(ev({ runId: 'r-rm', seq: 0, kind: 'session_start' }));
    expect(log.hasEventsForRun('r-rm')).toBe(true);
    expect(log.removeRun('r-rm')).toBe(true);
    expect(log.hasEventsForRun('r-rm')).toBe(false);
  });

  it('drops events with no runId silently', () => {
    const log = new EventLog(dir);
    log.append({ runId: '', seq: 0, kind: 'session_start', ts: new Date().toISOString() } as RunEvent);
    expect(log.totalBytes()).toBe(0);
  });
});
