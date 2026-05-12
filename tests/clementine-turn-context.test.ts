import { describe, it, expect, vi } from 'vitest';
import { buildClementineTurnContext } from '../src/agent/clementine-turn-context.js';
import type { BackgroundTask } from '../src/types.js';

const FIXED_NOW = 1_762_000_000_000; // ~2025-11
const NOW = () => FIXED_NOW;

function makeStore(hits: Array<{ section?: string; source_file?: string; content: string; score?: number }>) {
  return {
    searchContext: vi.fn().mockReturnValue(hits),
  };
}

describe('buildClementineTurnContext — core', () => {
  it('returns an empty block (no envelope) when nothing has content to surface', () => {
    // No memory store, no bg tasks, no identity framing — only live state
    // remains. Live state alone is still useful, so we expect a small block,
    // not totally empty. Verify the envelope is present and the content is
    // minimal.
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'dashboard:web',
      now: NOW,
    });
    expect(result.block).toContain('[Context');
    expect(result.block).toContain('Current time:');
    expect(result.sections.liveState).toBe(true);
    expect(result.sections.retrievedMemory).toBe(0);
    expect(result.sections.recentBgTasks).toBe(0);
  });

  it('injects retrieved memory hits with section labels', () => {
    const store = makeStore([
      { section: 'MEMORY.md', content: 'The owner loves coffee.', score: 0.9 },
      { source_file: '/vault/03-Projects/clementine.md', content: 'Clementine is the assistant.', score: 0.7 },
    ]);
    const result = buildClementineTurnContext({
      userMessage: 'what do I drink',
      sessionKey: 'discord:dm:owner',
      memoryStore: store,
      now: NOW,
    });
    expect(result.block).toContain('Possibly relevant from persistent memory');
    expect(result.block).toContain('The owner loves coffee.');
    expect(result.block).toContain('Clementine is the assistant.');
    expect(result.sections.retrievedMemory).toBe(2);
    expect(store.searchContext).toHaveBeenCalledWith('what do I drink', { limit: expect.any(Number) });
  });

  it('skips memory section when store throws (non-fatal)', () => {
    const store = {
      searchContext: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    };
    const result = buildClementineTurnContext({
      userMessage: 'anything',
      sessionKey: 'chat',
      memoryStore: store,
      now: NOW,
    });
    expect(result.sections.retrievedMemory).toBe(0);
    // Other sections still render.
    expect(result.sections.liveState).toBe(true);
  });

  it('injects recent bg-task headlines (last 24h, terminal-state only)', () => {
    const recent: BackgroundTask = {
      id: 'bg-x',
      fromAgent: 'clementine',
      prompt: 'check inbox and summarize',
      maxMinutes: 5,
      status: 'done',
      createdAt: new Date(FIXED_NOW - 3 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 2 * 3600_000).toISOString(),
      result: 'Found 3 actionable emails, 12 spam.',
    };
    const oldOne: BackgroundTask = {
      id: 'bg-old',
      fromAgent: 'clementine',
      prompt: 'old job',
      maxMinutes: 5,
      status: 'done',
      createdAt: new Date(FIXED_NOW - 30 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 30 * 3600_000).toISOString(),
      result: 'old result',
    };
    const listBg = vi.fn().mockImplementation((filter: { status?: string }) => {
      if (filter.status === 'done') return [recent, oldOne];
      return [];
    });
    const result = buildClementineTurnContext({
      userMessage: 'what happened with the inbox check?',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      now: NOW,
    });
    expect(result.block).toContain('Recently completed background work');
    expect(result.block).toContain('check inbox and summarize');
    expect(result.block).toContain('Found 3 actionable emails');
    // The 30-hour-old task is OUTSIDE the 24h window and must NOT appear.
    expect(result.block).not.toContain('old job');
    expect(result.sections.recentBgTasks).toBe(1);
  });

  it('renders identity framing when ownerName + channel + profileName are provided', () => {
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'discord:dm:owner',
      channel: 'discord-dm',
      ownerName: 'Nathan',
      profileName: 'Sasha',
      now: NOW,
    });
    expect(result.block).toContain('Nathan');
    expect(result.block).toContain('discord-dm');
    expect(result.block).toContain('Sasha');
    expect(result.sections.identityFrame).toBe(true);
  });

  it('hard-caps the total block size for prompt-cache health', () => {
    // Inject huge memory hits — must be truncated at the MAX_BLOCK_CHARS cap.
    const hugeContent = 'x'.repeat(10_000);
    const store = makeStore(
      Array.from({ length: 20 }, (_, i) => ({
        section: `huge-${i}`,
        content: hugeContent,
      })),
    );
    const result = buildClementineTurnContext({
      userMessage: 'anything',
      sessionKey: 'chat',
      memoryStore: store,
      now: NOW,
    });
    // Total block (including envelope) must stay reasonable — well under
    // 5KB so the cacheable prefix stays larger than the volatile delta.
    expect(result.totalChars).toBeLessThan(5_000);
  });

  it('always includes current time in the live-state section (no "what day is it" failures)', () => {
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'chat',
      now: NOW,
    });
    // Date stamp must be present and parseable.
    const match = result.block.match(/Current time: (\S+)/);
    expect(match).toBeTruthy();
    expect(new Date(match![1]).getTime()).toBe(FIXED_NOW);
  });
});
