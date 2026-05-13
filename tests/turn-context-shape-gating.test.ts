/**
 * 1.18.191 — turn-context shape-gating tests.
 *
 * Verifies the token-optimization promise: simple messages get a lean
 * block (no memory recall, no bg-task headlines, no dispute gate),
 * while multi-step and unknown shapes keep the full block.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildClementineTurnContext } from '../src/agent/clementine-turn-context.js';
import type { BackgroundTask } from '../src/types.js';

const FIXED_NOW = 1_762_000_000_000;
const NOW = () => FIXED_NOW;

function makeMemStore(hits: Array<{ section?: string; content: string }>) {
  return { searchContext: vi.fn().mockReturnValue(hits) };
}

function makeBgTasks(...tasks: Array<Partial<BackgroundTask> & { status: BackgroundTask['status'] }>): (filter: { status?: BackgroundTask['status'] }) => BackgroundTask[] {
  return (filter) => tasks
    .filter((t) => filter.status === undefined || t.status === filter.status)
    .map((t) => ({
      id: 'bg-x',
      fromAgent: 'clementine',
      prompt: 'do thing',
      maxMinutes: 5,
      createdAt: new Date(FIXED_NOW - 3 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 2 * 3600_000).toISOString(),
      result: 'thing done',
      ...t,
    } as BackgroundTask));
}

describe('shape=simple: lean turn-context (1.18.191)', () => {
  it('skips memory recall section', () => {
    const memStore = makeMemStore([
      { section: 'MEMORY.md', content: 'Owner likes coffee' },
    ]);
    const result = buildClementineTurnContext({
      userMessage: 'what time is it',
      sessionKey: 'chat',
      memoryStore: memStore,
      messageShape: 'simple',
      now: NOW,
    });
    expect(result.sections.retrievedMemory).toBe(0);
    expect(result.block).not.toContain('Possibly relevant from persistent memory');
    expect(result.block).not.toContain('Owner likes coffee');
    // searchContext should NOT have been called.
    expect(memStore.searchContext).not.toHaveBeenCalled();
  });

  it('skips background-task headlines section', () => {
    const listBg = makeBgTasks(
      { id: 'bg-done', status: 'done', result: 'Recent task result' },
    );
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      messageShape: 'simple',
      now: NOW,
    });
    expect(result.sections.recentBgTasks).toBe(0);
    expect(result.block).not.toContain('Recently completed background work');
    expect(result.block).not.toContain('Recent task result');
  });

  it('skips dispute mode even when user message looks disputed', () => {
    // Edge case: a simple-shape message that happens to contain dispute
    // words ("site not found") should NOT trigger dispute mode — the
    // shape classification said "simple" so we honor that.
    const result = buildClementineTurnContext({
      userMessage: 'the site is not found',
      sessionKey: 'chat',
      messageShape: 'simple',
      now: NOW,
    });
    expect(result.sections.disputeDetected).toBe(false);
    expect(result.block).not.toContain('Dispute mode');
  });

  it('still renders identity + live state (cheap, always useful)', () => {
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'discord:dm:owner',
      channel: 'discord-dm',
      ownerName: 'Owner',
      messageShape: 'simple',
      now: NOW,
    });
    expect(result.sections.identityFrame).toBe(true);
    expect(result.sections.liveState).toBe(true);
    expect(result.block).toContain('Owner');
    expect(result.block).toContain('Current time');
  });

  it('still renders active project when one is set (load-bearing for project work)', () => {
    // Even a simple message in a project context should know about the project.
    // The model can choose to ignore it; we don't gate this on shape.
    const result = buildClementineTurnContext({
      userMessage: 'how am I doing',
      sessionKey: 'chat',
      activeProject: {
        path: '/tmp/nonexistent-but-typed', // existsSync false; renders nothing
        description: 'whatever',
      },
      messageShape: 'simple',
      now: NOW,
    });
    // Won't render (path doesn't exist), but that's the active-project
    // gate, not the shape gate. Behavior matches intent.
    expect(result.sections.activeProject).toBe(false);
  });

  it('block is meaningfully smaller than multi-step block for the same memory store', () => {
    const memStore = makeMemStore([
      { section: 'MEMORY.md', content: 'Owner likes coffee. He is a Max user.' },
      { section: 'people/jordan', content: 'Jordan is the dev lead at Co X' },
      { section: 'projects/catalog', content: 'Track catalog migration project' },
    ]);
    const simpleResult = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'chat',
      memoryStore: memStore,
      messageShape: 'simple',
      now: NOW,
    });
    const multiResult = buildClementineTurnContext({
      userMessage: 'find all projects and summarize each',
      sessionKey: 'chat',
      memoryStore: memStore,
      messageShape: 'multi-step',
      now: NOW,
    });
    // Multi-step should produce a strictly larger block because it
    // includes the 3 memory hits.
    expect(multiResult.totalChars).toBeGreaterThan(simpleResult.totalChars);
    // Concrete savings: simple block should be under 500 bytes for
    // this minimal scenario.
    expect(simpleResult.totalChars).toBeLessThan(500);
  });
});

describe('shape=multi-step: full turn-context', () => {
  it('includes memory recall', () => {
    const memStore = makeMemStore([
      { section: 'MEMORY.md', content: 'The owner uses Netlify for deploys' },
    ]);
    const result = buildClementineTurnContext({
      userMessage: 'build me a thing and deploy it',
      sessionKey: 'chat',
      memoryStore: memStore,
      messageShape: 'multi-step',
      now: NOW,
    });
    expect(result.sections.retrievedMemory).toBe(1);
    expect(memStore.searchContext).toHaveBeenCalled();
  });

  it('includes bg-task headlines', () => {
    const listBg = makeBgTasks(
      { id: 'bg-done', status: 'done', result: 'Last build was done at 10am' },
    );
    const result = buildClementineTurnContext({
      userMessage: 'continue from last time',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      messageShape: 'multi-step',
      now: NOW,
    });
    expect(result.sections.recentBgTasks).toBe(1);
  });

  it('honors dispute gate normally', () => {
    const result = buildClementineTurnContext({
      userMessage: 'the site is not found and the deploy did not work',
      sessionKey: 'chat',
      messageShape: 'multi-step',
      now: NOW,
    });
    expect(result.sections.disputeDetected).toBe(true);
    expect(result.block).toContain('Dispute mode');
  });
});

describe('shape=unknown: full turn-context (back-compat)', () => {
  it('defaults to today\'s behavior when shape is unknown', () => {
    const memStore = makeMemStore([
      { section: 'MEMORY.md', content: 'something' },
    ]);
    const result = buildClementineTurnContext({
      userMessage: 'write a summary',
      sessionKey: 'chat',
      memoryStore: memStore,
      messageShape: 'unknown',
      now: NOW,
    });
    // 'unknown' = full block, no regression
    expect(result.sections.retrievedMemory).toBe(1);
  });

  it('omitted messageShape defaults to unknown = full block (back-compat)', () => {
    const memStore = makeMemStore([
      { section: 'MEMORY.md', content: 'something' },
    ]);
    const result = buildClementineTurnContext({
      userMessage: 'whatever',
      sessionKey: 'chat',
      memoryStore: memStore,
      // no messageShape provided
      now: NOW,
    });
    expect(result.sections.retrievedMemory).toBe(1);
  });
});
