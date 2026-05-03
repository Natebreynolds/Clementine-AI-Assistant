import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';

describe('memory promotion candidates', () => {
  let baseDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-memory-promote-'));
    store = new MemoryStore(path.join(baseDir, 'memory.db'), path.join(baseDir, 'vault'));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('queues high-signal active memory writes for later promotion', () => {
    store.logExtraction({
      sessionKey: 'discord:user:1',
      userMessage: 'Remember I prefer concise Discord updates.',
      toolName: 'memory_write',
      toolInput: JSON.stringify({
        content: 'Nate prefers concise Discord updates when background jobs are running.',
        confidence: 0.9,
        salience_hint: 0.8,
        reason: 'explicit user preference',
      }),
      extractedAt: new Date().toISOString(),
      status: 'active',
      agentSlug: 'clementine',
    });

    const candidates = store.listMemoryPromotionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateKind).toBe('preference');
    expect(candidates[0].contentPreview).toMatch(/concise Discord updates/);
    expect(candidates[0].confidence).toBe(0.9);
    expect(candidates[0].salience).toBe(0.8);
  });

  it('does not queue skipped extractions', () => {
    store.logExtraction({
      sessionKey: 'discord:user:1',
      userMessage: 'hi',
      toolName: 'memory_write',
      toolInput: JSON.stringify({ content: 'short skipped memory candidate' }),
      extractedAt: new Date().toISOString(),
      status: 'dedup_skipped',
    });

    expect(store.listMemoryPromotionCandidates()).toHaveLength(0);
  });

  it('records promotion decisions', () => {
    const id = store.recordMemoryPromotionCandidate({
      candidateKind: 'fact',
      contentPreview: 'Ross owns the market leader follow-up workflow.',
      confidence: 0.7,
      salience: 0.6,
    });

    store.decideMemoryPromotionCandidate(id, 'rejected', 'too specific for long-term memory');

    expect(store.listMemoryPromotionCandidates()).toHaveLength(0);
    const rejected = store.listMemoryPromotionCandidates(10, 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('too specific for long-term memory');
  });
});
