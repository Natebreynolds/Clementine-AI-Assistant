/**
 * Seed-user-model — verifies the corpus gathering, prompt response parsing,
 * and the empty-corpus / "no clear signal" edge cases. Uses a mock llmCall
 * so the test never hits the real Anthropic SDK.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/memory/store.js';
import { seedUserModelFromMemory } from '../src/memory/seed-user-model.js';

let testDir: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), 'clem-seed-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'memory.db');
  store = new MemoryStore(dbPath, testDir);
  store.initialize();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function insertChunk(content: string, salience = 0.5): number {
  // gatherCorpus filters chunks shorter than 50 chars — pad short test inputs
  // so they survive the filter. Tests that care about exact content can pass
  // longer strings directly.
  const padded = content.length >= 50 ? content : content + ' ' + '.'.repeat(60);
  const db = new Database(dbPath);
  const info = db.prepare(
    `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, salience)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('test.md', 'sec', padded, 'preamble', 'h-' + Math.random(), salience);
  db.close();
  return info.lastInsertRowid as number;
}

// Pass a non-existent memory file path so tests don't leak data from the
// developer's real ~/.clementine/vault/00-System/MEMORY.md.
const NO_MEM_FILE = { memoryFilePath: '/tmp/clem-test-nonexistent-memory.md' };

describe('seedUserModelFromMemory', () => {
  it('returns zero source count when corpus is empty', async () => {
    const llm = async () => 'should not be called';
    const result = await seedUserModelFromMemory(store as any, llm, NO_MEM_FILE);
    expect(result.sourceCount).toBe(0);
    expect(result.user_facts).toBe('');
    expect(result.goals).toBe('');
  });

  it('parses well-formed Haiku output into the four slots', async () => {
    insertChunk('Nathan works at Breakthrough Coaching as the founder.', 0.9);
    insertChunk('Currently shipping the Clementine memory upgrade.', 0.8);

    const fakeResponse = `## user_facts
- Nathan, founder of Breakthrough Coaching
- Prefers terse responses

## goals
- Ship the Clementine memory upgrade

## relationships
- Sam — collaborator on Project X

## agent_persona
- Personal AI assistant with always-in-context user model`;

    const llm = async () => fakeResponse;
    const result = await seedUserModelFromMemory(store as any, llm, NO_MEM_FILE);

    expect(result.sourceCount).toBeGreaterThan(0);
    expect(result.user_facts).toContain('Nathan');
    expect(result.user_facts).toContain('Breakthrough Coaching');
    expect(result.goals).toContain('Clementine memory upgrade');
    expect(result.relationships).toContain('Sam');
    expect(result.agent_persona).toContain('always-in-context');
  });

  it('treats "(no clear signal)" as empty', async () => {
    insertChunk('Some random content', 0.5);
    const fakeResponse = `## user_facts
- Some real fact

## goals
(no clear signal)

## relationships
(no clear signal)

## agent_persona
(no clear signal)`;

    const llm = async () => fakeResponse;
    const result = await seedUserModelFromMemory(store as any, llm, NO_MEM_FILE);

    expect(result.user_facts).toContain('Some real fact');
    expect(result.goals).toBe('');
    expect(result.relationships).toBe('');
    expect(result.agent_persona).toBe('');
  });

  it('truncates per-slot content to 2000 chars', async () => {
    insertChunk('content', 0.5);
    const longLine = '- very long fact about the user\n'.repeat(100);
    const fakeResponse = `## user_facts
${longLine}

## goals
short

## relationships
short

## agent_persona
short`;
    const llm = async () => fakeResponse;
    const result = await seedUserModelFromMemory(store as any, llm, NO_MEM_FILE);
    expect(result.user_facts.length).toBeLessThanOrEqual(2000);
  });

  it('handles a malformed LLM response gracefully (no slot markers)', async () => {
    insertChunk('content', 0.5);
    const llm = async () => 'I cannot do that. Sorry.';
    const result = await seedUserModelFromMemory(store as any, llm, NO_MEM_FILE);
    expect(result.user_facts).toBe('');
    expect(result.goals).toBe('');
    expect(result.relationships).toBe('');
    expect(result.agent_persona).toBe('');
    expect(result.sourceCount).toBeGreaterThan(0);
  });

  it('returns failure object when llmCall throws', async () => {
    insertChunk('content', 0.5);
    const llm = async () => { throw new Error('rate limited'); };
    const result = await seedUserModelFromMemory(store as any, llm, NO_MEM_FILE);
    expect(result.user_facts).toBe('');
    expect(result.rawResponse).toContain('LLM call failed');
  });

  it('orders chunks by salience for the corpus', async () => {
    // Each chunk needs >50 chars to pass the gatherCorpus length filter.
    insertChunk('LOW priority content here that exists but should rank below the high one', 0.1);
    insertChunk('HIGH priority content here that should be near the top of the corpus', 0.95);

    let capturedPrompt = '';
    const llm = async (prompt: string) => {
      capturedPrompt = prompt;
      return '## user_facts\n- test\n## goals\n## relationships\n## agent_persona';
    };
    await seedUserModelFromMemory(store as any, llm);

    // High-salience content should appear before low-salience in the prompt
    const hi = capturedPrompt.indexOf('HIGH priority');
    const lo = capturedPrompt.indexOf('LOW priority');
    expect(hi).toBeGreaterThan(-1);
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(lo);
  });
});
