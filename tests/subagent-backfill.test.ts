/**
 * PRD §6 Phase 4e — subagent transcript backfill (Path C).
 *
 * Covers: cwd encoding, missing-dir tolerance, JSONL parsing, per-block
 * synthesis (text / thinking / tool_use / tool_result), seq stamping, slug
 * carry-through. The "agentId" + "subagentSlug" + "source='backfill'" tags
 * are what the dashboard waterfall uses to render nested swimlanes, so
 * they're asserted explicitly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { encodeProjectCwd, backfillSubagentEvents } from '../src/agent/subagent-backfill.js';
import { EventLog } from '../src/gateway/event-log.js';

describe('encodeProjectCwd', () => {
  it('replaces / with -', () => {
    expect(encodeProjectCwd('/Users/foo/bar')).toBe('-Users-foo-bar');
  });
  it('replaces spaces with -', () => {
    expect(encodeProjectCwd('/Users/Has Space/baz')).toBe('-Users-Has-Space-baz');
  });
  it('replaces . with -', () => {
    expect(encodeProjectCwd('/Users/foo/.clementine')).toBe('-Users-foo--clementine');
  });
  it('matches a known on-disk path shape', () => {
    expect(encodeProjectCwd('/Users/x/Library/CloudStorage/OneDrive-Y/Z'))
      .toBe('-Users-x-Library-CloudStorage-OneDrive-Y-Z');
  });
});

describe('backfillSubagentEvents', () => {
  let tmpHome: string;
  let clemHome: string;
  let prevHome: string | undefined;
  let prevClem: string | undefined;
  let cwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'clem-backfill-'));
    clemHome = path.join(tmpHome, '.clementine');
    mkdirSync(clemHome, { recursive: true });
    mkdirSync(path.join(clemHome, 'events'), { recursive: true });
    prevHome = process.env.HOME;
    prevClem = process.env.CLEMENTINE_HOME;
    process.env.HOME = tmpHome;
    process.env.CLEMENTINE_HOME = clemHome;
    cwd = '/cron/test';
  });

  afterEach(() => {
    if (prevHome) process.env.HOME = prevHome; else delete process.env.HOME;
    if (prevClem) process.env.CLEMENTINE_HOME = prevClem; else delete process.env.CLEMENTINE_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeAgentJsonl(sessionId: string, agentId: string, lines: object[]): void {
    const encoded = encodeProjectCwd(cwd);
    const subDir = path.join(tmpHome, '.claude', 'projects', encoded, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('returns 0 backfilled when subagents dir is missing', async () => {
    // os.homedir() reads HOME on Linux/macOS but on darwin it falls back to the
    // real OS user's home before HOME is consulted. To make this test resilient
    // across platforms, simulate a path that won't exist by using a sessionId
    // we never wrote.
    const log = new EventLog(clemHome);
    const result = await backfillSubagentEvents({
      runId: 'run-1',
      sessionId: 'never-existed',
      cwd,
      eventLog: log,
      startSeq: 0,
    });
    expect(result.backfilled).toBe(0);
  });

  it('synthesizes llm_text + tool_use + tool_result events with correct tagging', async () => {
    const sessionId = 'sess-A';
    const agentId = 'a333f70';
    const slug = 'bright-petting-kahn';
    writeAgentJsonl(sessionId, agentId, [
      {
        sessionId,
        agentId,
        slug,
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello from the subagent.' },
            { type: 'tool_use', id: 'use_xyz', name: 'Read', input: { file: '/x' } },
          ],
        },
      },
      {
        sessionId,
        agentId,
        slug,
        type: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'use_xyz', content: 'file content here', is_error: false },
          ],
        },
      },
    ]);

    const log = new EventLog(clemHome);
    const result = await backfillSubagentEvents({
      runId: 'run-1',
      sessionId,
      cwd,
      eventLog: log,
      startSeq: 5,
    });

    expect(result.backfilled).toBeGreaterThan(0);
    expect(result.agents).toBe(1);

    // Read back what got appended.
    const raw = readFileSync(path.join(clemHome, 'events', 'run-1.jsonl'), 'utf-8');
    const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));

    // Three events synthesized: 1 text, 1 tool_use, 1 tool_result.
    expect(events).toHaveLength(3);
    const text = events.find((e) => e.kind === 'llm_text');
    expect(text).toBeDefined();
    expect(text.text).toContain('Hello from');
    expect(text.agentId).toBe(agentId);
    expect(text.subagentSlug).toBe(slug);
    expect(text.source).toBe('backfill');

    const call = events.find((e) => e.kind === 'tool_call');
    expect(call.toolName).toBe('Read');
    expect(call.toolUseId).toBe('use_xyz');

    const res = events.find((e) => e.kind === 'tool_result');
    expect(res.toolUseId).toBe('use_xyz');
    expect(res.toolResult).toBe('file content here');

    // seq starts at startSeq and increments.
    expect(events[0].seq).toBe(5);
    expect(events[1].seq).toBe(6);
    expect(events[2].seq).toBe(7);
  });

  it('synthesizes thinking blocks', async () => {
    const sessionId = 'sess-B';
    writeAgentJsonl(sessionId, 'b001', [
      {
        sessionId,
        agentId: 'b001',
        slug: 'thinker',
        type: 'assistant',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Reasoning step…' }] },
      },
    ]);
    const log = new EventLog(clemHome);
    const result = await backfillSubagentEvents({ runId: 'run-2', sessionId, cwd, eventLog: log, startSeq: 0 });
    expect(result.backfilled).toBe(1);
    const events = readFileSync(path.join(clemHome, 'events', 'run-2.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(events[0].kind).toBe('thinking');
    expect(events[0].thinking).toBe('Reasoning step…');
  });

  it('marks tool_result events with toolError when is_error is true', async () => {
    const sessionId = 'sess-C';
    writeAgentJsonl(sessionId, 'c001', [
      {
        sessionId,
        agentId: 'c001',
        slug: 'failing',
        type: 'user',
        timestamp: '2026-01-03T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'use_q', content: 'bad input', is_error: true }],
        },
      },
    ]);
    const log = new EventLog(clemHome);
    await backfillSubagentEvents({ runId: 'run-3', sessionId, cwd, eventLog: log, startSeq: 0 });
    const events = readFileSync(path.join(clemHome, 'events', 'run-3.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(events[0].toolError).toBe('bad input');
  });

  it('aggregates and sorts events from multiple agent files by timestamp', async () => {
    const sessionId = 'sess-D';
    writeAgentJsonl(sessionId, 'd001', [
      {
        sessionId, agentId: 'd001', slug: 'first',
        type: 'assistant', timestamp: '2026-01-04T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second-in-time' }] },
      },
    ]);
    writeAgentJsonl(sessionId, 'd002', [
      {
        sessionId, agentId: 'd002', slug: 'second',
        type: 'assistant', timestamp: '2026-01-04T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first-in-time' }] },
      },
    ]);
    const log = new EventLog(clemHome);
    const result = await backfillSubagentEvents({ runId: 'run-4', sessionId, cwd, eventLog: log, startSeq: 0 });
    expect(result.agents).toBe(2);
    const events = readFileSync(path.join(clemHome, 'events', 'run-4.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(events[0].text).toBe('first-in-time');
    expect(events[1].text).toBe('second-in-time');
  });

  it('tolerates malformed JSONL lines without crashing', async () => {
    const sessionId = 'sess-E';
    const encoded = encodeProjectCwd(cwd);
    const subDir = path.join(tmpHome, '.claude', 'projects', encoded, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      path.join(subDir, 'agent-eee.jsonl'),
      'not valid json\n' +
      JSON.stringify({
        sessionId, agentId: 'eee', slug: 'tolerant',
        type: 'assistant', timestamp: '2026-01-05T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }) + '\n',
    );
    const log = new EventLog(clemHome);
    const result = await backfillSubagentEvents({ runId: 'run-5', sessionId, cwd, eventLog: log, startSeq: 0 });
    expect(result.backfilled).toBe(1);
  });
});
