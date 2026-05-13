import { describe, expect, it } from 'vitest';
import {
  buildRunStateHooks,
  clearRunState,
  getRunState,
  hasCompletedManifest,
  summarizeRunStateForManifest,
} from '../src/agent/run-state.js';

function post(hooks: ReturnType<typeof buildRunStateHooks>['hooks']) {
  return hooks.PostToolUse![0]!.hooks[0]!;
}

function sessionEnd(hooks: ReturnType<typeof buildRunStateHooks>['hooks']) {
  return hooks.SessionEnd![0]!.hooks[0]!;
}

describe('run-state hooks', () => {
  it('records successful and failed side effects from PostToolUse', async () => {
    const state = buildRunStateHooks({ runId: 'run-state-1', now: () => Date.parse('2026-05-12T21:00:00Z') });
    const cb = post(state.hooks);

    await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
      tool_input: { to: 'kevin@example.com', subject: 'Hi', body: 'Body' },
      tool_response: { successful: true, data: { status_code: 202 } },
      tool_use_id: 'send-1',
    } as never, undefined, {} as never);
    await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__salesforce__UPDATE_RECORD',
      tool_input: { object: 'Contact', recordId: '003abc', fields: { Status__c: 'Sent' } },
      tool_response: { successful: false, error: 'bad', data: { status_code: 500 } },
      tool_use_id: 'sf-1',
    } as never, undefined, {} as never);

    expect(state.state.successfulSideEffects).toHaveLength(1);
    expect(state.state.successfulSideEffects[0]!.summary).toContain('email send to kevin@example.com');
    expect(state.state.failedSideEffects).toHaveLength(1);
    expect(state.stats.sideEffects).toBe(2);
  });

  it('tracks TodoWrite unfinished counts separately from read-only tools', async () => {
    const state = buildRunStateHooks({ runId: 'run-state-2' });
    const cb = post(state.hooks);

    await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'send email', status: 'completed' },
          { content: 'stamp SF', status: 'in_progress' },
          { content: 'create task', status: 'pending' },
        ],
      },
      tool_response: { ok: true },
      tool_use_id: 'todo-1',
    } as never, undefined, {} as never);
    await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_response: 'contents',
      tool_use_id: 'read-1',
    } as never, undefined, {} as never);

    expect(state.state.todo).toMatchObject({ total: 3, completed: 1, inProgress: 1, pending: 1 });
    expect(state.state.readOnlyToolCalls).toBe(1);
    expect(state.stats.todosUpdated).toBe(1);
  });

  it('indexes active runs and clears the global index on SessionEnd', async () => {
    const state = buildRunStateHooks({ runId: 'run-state-3' });
    expect(getRunState('run-state-3')).toBe(state.state);

    await sessionEnd(state.hooks)({
      hook_event_name: 'SessionEnd',
      reason: 'success',
    } as never, undefined, {} as never);

    expect(getRunState('run-state-3')).toBeUndefined();
    expect(state.state.ended?.reason).toBe('success');
    clearRunState('run-state-3');
  });

  it('detects and formats the Completed manifest contract', async () => {
    const state = buildRunStateHooks({ runId: 'run-state-4' });
    await post(state.hooks)({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__gmail__GMAIL_SEND_EMAIL',
      tool_input: { to: 'kevin@example.com', subject: 'Hi', body: 'Body' },
      tool_response: { successful: true, data: { status_code: 202 } },
      tool_use_id: 'send-1',
    } as never, undefined, {} as never);

    expect(hasCompletedManifest('✅ **Completed**\n- Outlook sends: 1 accepted')).toBe(true);
    expect(hasCompletedManifest('Done.')).toBe(false);
    expect(summarizeRunStateForManifest(state.state)).toContain('✅ **Completed**');
    expect(summarizeRunStateForManifest(state.state)).toContain('kevin@example.com');
  });
});
