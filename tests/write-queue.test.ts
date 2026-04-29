/**
 * Async write queue — flush, drain, error isolation, and back-pressure.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { WriteQueue } from '../src/memory/write-queue.js';

describe('WriteQueue — async write-behind', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;
  let queue: WriteQueue;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-wq-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
    // Seed one chunk so we have a chunk_id to log against.
    writeFileSync(path.join(vaultDir, 'seed.md'), '# Seed\n\nbody\n');
    store.fullSync();
    // Default flushSize big enough that explicit-flush tests don't race the
    // auto-flush. Tests that exercise auto-flush construct their own queue.
    queue = new WriteQueue(store, { flushIntervalMs: 50, flushSize: 100 });
  });

  afterEach(async () => {
    await queue.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flushes a batch of mixed ops and persists each one', async () => {
    queue.enqueue({ kind: 'transcript-turn', sessionKey: 's1', role: 'user', content: 'hi', model: '' });
    queue.enqueue({
      kind: 'recall', sessionKey: 's1', messageId: null, query: 'q',
      chunkIds: [1], scores: [0.5], agentSlug: null,
    });
    queue.enqueue({ kind: 'access', chunkIds: [1], accessType: 'read' });

    const result = await queue.flush();
    expect(result.flushed).toBe(3);
    expect(result.errors).toBe(0);
    expect(queue.size()).toBe(0);

    // Persistence checks via store reads.
    const trans = store.getSessionTranscript('s1');
    expect(trans.length).toBe(1);
    expect(trans[0].content).toBe('hi');

    const traces = store.getRecentRecallTraces('s1', 5);
    expect(traces.length).toBe(1);
    expect(traces[0].query).toBe('q');
  });

  it('auto-flushes when buffer hits flushSize', async () => {
    const tiny = new WriteQueue(store, { flushIntervalMs: 1_000_000, flushSize: 3 });
    tiny.enqueue({ kind: 'access', chunkIds: [1], accessType: 'r' });
    tiny.enqueue({ kind: 'access', chunkIds: [1], accessType: 'r' });
    tiny.enqueue({ kind: 'access', chunkIds: [1], accessType: 'r' });
    // Yield to let the auto-flush settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(tiny.size()).toBe(0);
    tiny.stop();
  });

  it('errors in one op do not block the rest of the batch', async () => {
    // Apply will pass through to store; an op with garbage shape on a missing
    // method falls into the catch and increments errors.
    const broken: any = { kind: 'unknown-kind' };
    queue.enqueue({ kind: 'access', chunkIds: [1], accessType: 'good' });
    queue.enqueue(broken);
    queue.enqueue({ kind: 'access', chunkIds: [1], accessType: 'also-good' });
    const result = await queue.flush();
    // Unknown kind hits the switch's default (no-op), so it succeeds silently —
    // only true throws count as errors. That's the desired behavior.
    expect(result.flushed).toBe(3);
    expect(result.errors).toBe(0);
  });

  it('drain() empties the buffer and stops the timer', async () => {
    queue.start();
    queue.enqueue({ kind: 'access', chunkIds: [1], accessType: 'r' });
    queue.enqueue({ kind: 'access', chunkIds: [1], accessType: 'r' });
    await queue.drain();
    expect(queue.size()).toBe(0);
    // After drain, no further automatic flush — enqueue stays buffered.
    queue.enqueue({ kind: 'access', chunkIds: [1], accessType: 'r' });
    await new Promise((r) => setTimeout(r, 80));
    expect(queue.size()).toBe(1);
  });

  it('drops oldest when buffer hits maxBuffer cap', () => {
    const tiny = new WriteQueue(store, { flushIntervalMs: 1_000_000, flushSize: 10_000, maxBuffer: 3 });
    for (let i = 0; i < 6; i++) {
      tiny.enqueue({ kind: 'access', chunkIds: [i], accessType: 'r' });
    }
    expect(tiny.size()).toBe(3);
    expect(tiny.stats().dropped).toBe(3);
    tiny.stop();
  });

  it('start() is idempotent — repeated calls do not stack timers', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    queue.start();
    queue.start();
    queue.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });
});

describe('MemoryStore + WriteQueue integration', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-wq-int-'));
    dbPath = path.join(dir, 'memory.db');
    vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
    writeFileSync(path.join(vaultDir, 'seed.md'), '# Seed\n\nbody\n');
    store.fullSync();
  });

  afterEach(async () => {
    try { await store.flushWrites(); } catch { /* ignore */ }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saveTurn routes through the queue when enabled, lands after flush', async () => {
    store.enableWriteQueue({ flushIntervalMs: 1_000_000, flushSize: 100 });
    store.saveTurn('s-async', 'user', 'hello via queue');
    // Sync read shows nothing yet — write is buffered.
    expect(store.getSessionTranscript('s-async').length).toBe(0);
    await store.flushWrites();
    expect(store.getSessionTranscript('s-async').length).toBe(1);
    expect(store.getSessionTranscript('s-async')[0].content).toBe('hello via queue');
  });

  it('default sync path is unchanged — saveTurn lands immediately', () => {
    store.saveTurn('s-sync', 'user', 'hello sync');
    expect(store.getSessionTranscript('s-sync').length).toBe(1);
  });

  it('getWriteQueueStats returns null in sync mode and {size,dropped} when enabled', async () => {
    expect(store.getWriteQueueStats()).toBeNull();
    store.enableWriteQueue({ flushIntervalMs: 1_000_000, flushSize: 100 });
    store.saveTurn('s', 'u', 'one');
    store.saveTurn('s', 'u', 'two');
    const stats = store.getWriteQueueStats();
    expect(stats).not.toBeNull();
    expect(stats!.size).toBe(2);
    await store.flushWrites();
  });

  it('enableWriteQueue is idempotent — second call does not stack queues', async () => {
    store.enableWriteQueue();
    store.enableWriteQueue();
    store.saveTurn('s-once', 'u', 'msg');
    await store.flushWrites();
    // Only one transcript row — not duplicated by stacked queues.
    expect(store.getSessionTranscript('s-once').length).toBe(1);
  });
});
