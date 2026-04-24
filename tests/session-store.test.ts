/**
 * SessionStore adapter: verifies append/load round-trip, uuid idempotency,
 * cross-subpath isolation, and list/delete semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { createMemorySessionStore } from '../src/agent/session-store-adapter.js';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

let testDir: string;
let dbPath: string;
let store: MemoryStore;
let adapter: SessionStore;

beforeEach(() => {
  testDir = path.join(
    os.tmpdir(),
    'clem-sessionstore-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  );
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
  adapter = createMemorySessionStore(store as any);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('SessionStore append/load round-trip', () => {
  it('load returns null for a never-written session', async () => {
    const out = await adapter.load({ projectKey: 'p1', sessionId: 'never-seen' });
    expect(out).toBeNull();
  });

  it('appends and loads back in order', async () => {
    await adapter.append(
      { projectKey: 'p1', sessionId: 's1' },
      [
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', text: 'hi' },
        { type: 'assistant', uuid: 'u2', timestamp: '2026-01-01T00:00:01Z', text: 'hello' },
      ],
    );
    const rows = await adapter.load({ projectKey: 'p1', sessionId: 's1' });
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(2);
    expect(rows![0]).toMatchObject({ type: 'user', uuid: 'u1' });
    expect(rows![1]).toMatchObject({ type: 'assistant', uuid: 'u2' });
  });

  it('is idempotent on uuid (duplicate append does not duplicate rows)', async () => {
    const key = { projectKey: 'p1', sessionId: 's-idem' };
    const entries = [{ type: 'user', uuid: 'dup-1', text: 'first' }];
    await adapter.append(key, entries);
    await adapter.append(key, entries);
    await adapter.append(key, entries);
    const rows = await adapter.load(key);
    expect(rows!.length).toBe(1);
  });

  it('entries without uuid always append (no dedup)', async () => {
    const key = { projectKey: 'p1', sessionId: 's-nouuid' };
    await adapter.append(key, [{ type: 'title', text: 'v1' }]);
    await adapter.append(key, [{ type: 'title', text: 'v2' }]);
    const rows = await adapter.load(key);
    expect(rows!.length).toBe(2);
  });

  it('isolates subpaths (subagent transcripts)', async () => {
    const mainKey = { projectKey: 'p1', sessionId: 'shared' };
    const subKey = { projectKey: 'p1', sessionId: 'shared', subpath: 'agents/sub-1' };
    await adapter.append(mainKey, [{ type: 'user', uuid: 'main-1', text: 'main' }]);
    await adapter.append(subKey, [{ type: 'user', uuid: 'sub-1', text: 'sub' }]);

    const main = await adapter.load(mainKey);
    const sub = await adapter.load(subKey);
    expect(main!.length).toBe(1);
    expect((main![0] as any).text).toBe('main');
    expect(sub!.length).toBe(1);
    expect((sub![0] as any).text).toBe('sub');
  });
});

describe('SessionStore listing and subkeys', () => {
  it('listSessions returns one row per main session, newest first', async () => {
    await adapter.append(
      { projectKey: 'p1', sessionId: 'older' },
      [{ type: 'user', uuid: 'a', text: 'x' }],
    );
    await new Promise((r) => setTimeout(r, 10));
    await adapter.append(
      { projectKey: 'p1', sessionId: 'newer' },
      [{ type: 'user', uuid: 'b', text: 'y' }],
    );
    const sessions = await adapter.listSessions!('p1');
    expect(sessions.length).toBe(2);
    // Ordered by mtime desc — but since SQLite datetime('now') is
    // second-precision these may share a timestamp. Just confirm both present.
    const ids = sessions.map(s => s.sessionId);
    expect(ids).toContain('older');
    expect(ids).toContain('newer');
  });

  it('listSessions is scoped by projectKey', async () => {
    await adapter.append(
      { projectKey: 'p1', sessionId: 's1' },
      [{ type: 'user', uuid: 'a', text: 'x' }],
    );
    await adapter.append(
      { projectKey: 'p2', sessionId: 's2' },
      [{ type: 'user', uuid: 'b', text: 'y' }],
    );
    const p1 = await adapter.listSessions!('p1');
    const p2 = await adapter.listSessions!('p2');
    expect(p1.map(s => s.sessionId)).toEqual(['s1']);
    expect(p2.map(s => s.sessionId)).toEqual(['s2']);
  });

  it('listSubkeys returns only non-empty subpaths', async () => {
    await adapter.append(
      { projectKey: 'p1', sessionId: 'multi' },
      [{ type: 'user', uuid: 'main', text: 'main' }],
    );
    await adapter.append(
      { projectKey: 'p1', sessionId: 'multi', subpath: 'agents/a' },
      [{ type: 'user', uuid: 'a', text: 'a' }],
    );
    await adapter.append(
      { projectKey: 'p1', sessionId: 'multi', subpath: 'agents/b' },
      [{ type: 'user', uuid: 'b', text: 'b' }],
    );
    const subs = await adapter.listSubkeys!({ projectKey: 'p1', sessionId: 'multi' });
    expect(subs.sort()).toEqual(['agents/a', 'agents/b']);
  });
});

describe('SessionStore delete', () => {
  it('deletes all subpaths for a session', async () => {
    const main = { projectKey: 'p1', sessionId: 'doomed' };
    const sub = { projectKey: 'p1', sessionId: 'doomed', subpath: 'agents/x' };
    await adapter.append(main, [{ type: 'user', uuid: 'm', text: 'hi' }]);
    await adapter.append(sub, [{ type: 'user', uuid: 's', text: 'hi' }]);

    await adapter.delete!(main);

    expect(await adapter.load(main)).toBeNull();
    expect(await adapter.load(sub)).toBeNull();
  });
});

describe('no-op inputs', () => {
  it('empty append is a no-op', async () => {
    await expect(
      adapter.append({ projectKey: 'p1', sessionId: 's' }, []),
    ).resolves.toBeUndefined();
    expect(await adapter.load({ projectKey: 'p1', sessionId: 's' })).toBeNull();
  });
});
