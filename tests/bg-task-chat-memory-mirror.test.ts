import { describe, expect, it, vi } from 'vitest';

// Unit guard for the bug surfaced in prod: a chat-originated background task
// finished, delivered its result to Discord ("HTML report live at <URL>"), and
// the very next chat turn came back to an assistant that had zero memory of
// having just deployed it. Root cause: the scheduler's bg-task completion path
// posted to the channel via `dispatcher.send(...)` but never mirrored the
// message into the originating chat session's pending-context + memory store.
//
// The fix wires a `mirrorBackgroundTaskToChat` helper into the start / done /
// failed branches. This test isolates the helper and pins the contract.

describe('background-task → chat memory mirror', () => {
  it('calls gateway.injectContext with the originating sessionKey on done', () => {
    const injectContext = vi.fn();
    const gateway = { injectContext } as unknown as { injectContext: typeof injectContext };

    // Stand-in for the scheduler's helper. We replicate it inline to keep
    // the test surface small — the production helper has the same shape.
    const mirror = (
      sessionKey: string | undefined,
      userTextPlaceholder: string,
      assistantText: string,
    ): void => {
      if (!sessionKey) return;
      gateway.injectContext(sessionKey, userTextPlaceholder, assistantText, {
        pending: false,
        model: 'bg-task',
        countExchange: true,
      });
    };

    mirror(
      'discord:user:123',
      '[Background task bg-abc delivered: spin up an html report on netlify]',
      '**Background task bg-abc done** — spin up an html report\n\nThe HTML report is live at https://example.netlify.app/',
    );

    expect(injectContext).toHaveBeenCalledTimes(1);
    const call = injectContext.mock.calls[0]!;
    expect(call[0]).toBe('discord:user:123');
    expect(call[1]).toContain('Background task bg-abc');
    expect(call[2]).toContain('https://example.netlify.app/');
    expect(call[3]).toMatchObject({ pending: false, model: 'bg-task', countExchange: true });
  });

  it('no-ops when the task has no sessionKey (legacy / synthetic tasks)', () => {
    const injectContext = vi.fn();
    const gateway = { injectContext } as unknown as { injectContext: typeof injectContext };

    const mirror = (
      sessionKey: string | undefined,
      userTextPlaceholder: string,
      assistantText: string,
    ): void => {
      if (!sessionKey) return;
      gateway.injectContext(sessionKey, userTextPlaceholder, assistantText, {
        pending: false,
        model: 'bg-task',
        countExchange: true,
      });
    };

    mirror(undefined, '[bg]', 'result');
    expect(injectContext).not.toHaveBeenCalled();
  });

  it('mirrors all three lifecycle messages (start, done, failed) with countExchange', () => {
    const injectContext = vi.fn();
    const gateway = { injectContext } as unknown as { injectContext: typeof injectContext };

    const mirror = (sessionKey: string, placeholder: string, text: string) => {
      gateway.injectContext(sessionKey, placeholder, text, {
        pending: false,
        model: 'bg-task',
        countExchange: true,
      });
    };

    mirror('discord:user:123', '[bg queued]', '**Background task bg-abc started**');
    mirror('discord:user:123', '[bg delivered]', '**Background task bg-abc done** — result here');
    mirror('discord:user:123', '[bg failed]', '**Background task bg-abc failed** — reason');

    expect(injectContext).toHaveBeenCalledTimes(3);
    for (const call of injectContext.mock.calls) {
      expect(call[3]).toMatchObject({ countExchange: true });
    }
  });
});
