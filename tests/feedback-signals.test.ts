/**
 * Feedback → behavior loop: getRecentFeedbackSignals returns actionable
 * signals for system-prompt injection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';

describe('MemoryStore.getRecentFeedbackSignals', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-fb-'));
    const dbPath = path.join(dir, 'memory.db');
    const vaultDir = path.join(dir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    store = new MemoryStore(dbPath, vaultDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns zeros when feedback table is empty', () => {
    const sig = store.getRecentFeedbackSignals();
    expect(sig.negative).toBe(0);
    expect(sig.positive).toBe(0);
    expect(sig.negativesWithComments).toEqual([]);
  });

  it('counts positives and negatives in window, returns most-recent commented negatives', () => {
    store.logFeedback({ channel: 'discord', rating: 'positive' });
    store.logFeedback({ channel: 'discord', rating: 'positive' });
    store.logFeedback({ channel: 'discord', rating: 'negative' });
    store.logFeedback({ channel: 'verbal', rating: 'negative', comment: 'too verbose' });
    store.logFeedback({ channel: 'verbal', rating: 'negative', comment: 'wrong tone' });

    const sig = store.getRecentFeedbackSignals({ days: 14, limit: 3 });
    expect(sig.positive).toBe(2);
    expect(sig.negative).toBe(3);
    expect(sig.negativesWithComments.length).toBe(2);
    // Newest first
    expect(sig.negativesWithComments[0].comment).toBe('wrong tone');
    expect(sig.negativesWithComments[1].comment).toBe('too verbose');
  });

  it('excludes behavioral-correction and preference-learned synthetic feedback', () => {
    // These are auto-generated from session reflections and already routed
    // through hotCorrections — they should not double-count in user-facing signals
    store.logFeedback({ channel: 'behavioral-correction', rating: 'negative', comment: '[tone] be terser' });
    store.logFeedback({ channel: 'preference-learned', rating: 'positive', comment: '[high] likes bullet lists' });
    store.logFeedback({ channel: 'verbal', rating: 'negative', comment: 'real complaint' });

    const sig = store.getRecentFeedbackSignals();
    expect(sig.negative).toBe(1);
    expect(sig.positive).toBe(0);
    expect(sig.negativesWithComments.length).toBe(1);
    expect(sig.negativesWithComments[0].comment).toBe('real complaint');
  });

  it('respects the days window', () => {
    // Insert with explicit old timestamp (raw SQL — bypass logFeedback's NOW default)
    const conn = (store as unknown as { conn: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).conn;
    conn.prepare(
      `INSERT INTO feedback (channel, rating, comment, created_at)
       VALUES ('verbal', 'negative', 'old gripe', datetime('now', '-30 days'))`,
    ).run();
    store.logFeedback({ channel: 'verbal', rating: 'negative', comment: 'fresh gripe' });

    const sig = store.getRecentFeedbackSignals({ days: 14 });
    expect(sig.negative).toBe(1);
    expect(sig.negativesWithComments[0].comment).toBe('fresh gripe');
  });

  it('skips negatives with empty / whitespace-only comments', () => {
    store.logFeedback({ channel: 'discord', rating: 'negative' }); // no comment
    store.logFeedback({ channel: 'discord', rating: 'negative', comment: '   ' });
    store.logFeedback({ channel: 'verbal', rating: 'negative', comment: 'actionable' });

    const sig = store.getRecentFeedbackSignals();
    expect(sig.negative).toBe(3); // count includes silent thumbs-down
    expect(sig.negativesWithComments.length).toBe(1);
    expect(sig.negativesWithComments[0].comment).toBe('actionable');
  });

  it('respects limit on commented negatives', () => {
    for (let i = 0; i < 5; i++) {
      store.logFeedback({ channel: 'verbal', rating: 'negative', comment: `complaint ${i}` });
    }
    const sig = store.getRecentFeedbackSignals({ limit: 2 });
    expect(sig.negative).toBe(5);
    expect(sig.negativesWithComments.length).toBe(2);
  });
});
