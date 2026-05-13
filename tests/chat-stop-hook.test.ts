import { describe, it, expect, vi } from 'vitest';
import { buildChatStopHook } from '../src/agent/chat-stop-hook.js';
import { buildRunStateHooks } from '../src/agent/run-state.js';
import type { StopHookInput } from '@anthropic-ai/claude-agent-sdk';

const FAKE_SIGNAL: AbortSignal = new AbortController().signal;

function makeStopEvt(opts: {
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}): StopHookInput {
  return {
    hook_event_name: 'Stop',
    stop_hook_active: opts.stop_hook_active ?? false,
    last_assistant_message: opts.last_assistant_message ?? '',
    session_id: 'sess-test',
    transcript_path: '/tmp/test-transcript.jsonl',
    cwd: '/tmp',
  } as unknown as StopHookInput;
}

describe('buildChatStopHook — pass-through (no continuation signal)', () => {
  it('passes through when last message is a clean completion', async () => {
    const { hooks, stats } = buildChatStopHook({ runId: 'r1' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({ last_assistant_message: 'Done. Let me know if you need anything else.' }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBeUndefined();
    expect(stats.passed).toBe(1);
    expect(stats.continued).toBe(0);
  });

  it('passes through when last message is empty', async () => {
    const { hooks, stats } = buildChatStopHook({ runId: 'r2' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({ last_assistant_message: '' }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBeUndefined();
    expect(stats.passed).toBe(1);
  });
});

describe('buildChatStopHook — continuation detection', () => {
  it('re-prompts when model said "next, I\'ll draft email 2"', async () => {
    const { hooks, stats } = buildChatStopHook({ runId: 'r3' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: 'Drafted email 1 to client X. Next, I\'ll draft email 2 to client Y.',
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string; reason?: string };
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('continue');
    expect(stats.continued).toBe(1);
  });

  it('re-prompts on "step 2:" pattern', async () => {
    const { hooks, stats } = buildChatStopHook({ runId: 'r4' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: 'Finished gathering data. Step 2: synthesize the findings.',
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBe('block');
    expect(stats.continued).toBe(1);
  });

  it('re-prompts on "continuing with X" pattern', async () => {
    const { hooks, stats } = buildChatStopHook({ runId: 'r5' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: 'First draft complete. Continuing with the second.',
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBe('block');
    expect(stats.continued).toBe(1);
  });

  it('does NOT re-prompt on vague endings like "let me know if you need anything else"', async () => {
    const { hooks, stats } = buildChatStopHook({ runId: 'r6' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: 'All three emails are drafted. Let me know if you need anything else.',
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBeUndefined();
    expect(stats.passed).toBe(1);
  });
});

describe('buildChatStopHook — guards', () => {
  it('passes through when stop_hook_active=true (anti-infinite-loop)', async () => {
    // The SDK sets stop_hook_active=true if Stop hooks already fired this
    // run. We MUST honor this — otherwise we loop forever re-prompting.
    const { hooks, stats } = buildChatStopHook({ runId: 'r7' });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: 'Next, I will continue with the second part.',
        stop_hook_active: true,
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBeUndefined();
    expect(stats.passed).toBe(1);
    expect(stats.continued).toBe(0);
  });

  it('passes through when abortSignal has fired (user-initiated stop wins)', async () => {
    const ac = new AbortController();
    ac.abort();
    const { hooks, stats } = buildChatStopHook({
      runId: 'r8',
      abortSignal: ac.signal,
    });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: 'Next, I will keep going.',
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };
    expect(result.decision).toBeUndefined();
    expect(stats.passed).toBe(1);
    expect(stats.continued).toBe(0);
  });
});

describe('buildChatStopHook — live RunState enforcement', () => {
  it('re-prompts when TodoWrite still has unfinished items', async () => {
    const runState = buildRunStateHooks({ runId: 'r10' }).state;
    runState.todo = { total: 3, completed: 1, inProgress: 1, pending: 1 };
    const { hooks, stats } = buildChatStopHook({ runId: 'r10', runState });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({ last_assistant_message: 'I made progress.' }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string; reason?: string };

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('unfinished item');
    expect(stats.todoContinued).toBe(1);
  });

  it('requires a Completed/Pending manifest after successful side effects', async () => {
    const runState = buildRunStateHooks({ runId: 'r11' }).state;
    runState.successfulSideEffects.push({
      toolName: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
      toolUseId: 'send-1',
      summary: 'email send to kevin@example.com ("Hi")',
      kind: 'side_effect',
      successful: true,
      successReason: 'status-2xx',
      statusCode: 202,
      ts: '2026-05-12T21:00:00.000Z',
    });
    const { hooks, stats } = buildChatStopHook({ runId: 'r11', runState });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({ last_assistant_message: 'Done.' }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string; reason?: string };

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('✅ **Completed**');
    expect(result.reason).toContain('kevin@example.com');
    expect(stats.manifestRequired).toBe(1);
  });

  it('passes when successful side effects are acknowledged with the manifest header', async () => {
    const runState = buildRunStateHooks({ runId: 'r12' }).state;
    runState.successfulSideEffects.push({
      toolName: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
      summary: 'email send to kevin@example.com ("Hi")',
      kind: 'side_effect',
      successful: true,
      ts: '2026-05-12T21:00:00.000Z',
    });
    const { hooks, stats } = buildChatStopHook({ runId: 'r12', runState });
    const cb = hooks.Stop![0].hooks[0];
    const result = await cb(
      makeStopEvt({
        last_assistant_message: '✅ **Completed**\n- Outlook sends: 1 accepted\n\n⚠️ **Pending**\n- None',
      }),
      'tu_unused',
      FAKE_SIGNAL,
    ) as { decision?: string };

    expect(result.decision).toBeUndefined();
    expect(stats.passed).toBe(1);
    expect(stats.manifestRequired).toBe(0);
  });
});

describe('buildChatStopHook — onDecision telemetry', () => {
  it('reports decision + lastMessagePreview on every inspection', async () => {
    const decisions: Array<{ decision: string; reason?: string }> = [];
    const { hooks } = buildChatStopHook({
      runId: 'r9',
      onDecision: (info) => {
        decisions.push({ decision: info.decision, reason: info.reason });
      },
    });
    const cb = hooks.Stop![0].hooks[0];
    // Clean finish.
    await cb(makeStopEvt({ last_assistant_message: 'All done.' }), 'tu_1', FAKE_SIGNAL);
    // Continuation signal.
    await cb(makeStopEvt({ last_assistant_message: 'Next, I will do X.' }), 'tu_2', FAKE_SIGNAL);
    expect(decisions[0]?.decision).toBe('pass');
    expect(decisions[1]?.decision).toBe('continue');
  });
});
