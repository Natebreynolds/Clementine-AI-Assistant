/**
 * Tests the pre-call interception path introduced in Commit 3 of the
 * orchestrator-first sequence. The same PendingAgentDecision flow the
 * post-hoc classifier produces (clarification-gate.ts) must fire
 * *before* the tool runs when a precondition classifier matches.
 *
 * Coverage:
 *   - `evaluatePreconditionsForToolCall` returns a decision for the
 *     netlify_missing_deployment_target classifier when no link exists
 *   - …and returns null when `.netlify/state.json` is present
 *   - …and returns null when `.clementine/deploy.json` is present
 *   - The PreToolUse hook from `buildPreconditionGuardHooks` captures
 *     the decision and returns permissionDecision='deny'
 *   - The captured decision's continuation prompt round-trips through
 *     `parseAgentDecisionReply` + `buildAgentDecisionContinuationPrompt`
 *     (cross-checking that pre-call and post-hoc paths produce the same
 *     downstream behavior)
 */
import { describe, expect, it } from 'vitest';
import {
  buildAgentDecisionContinuationPrompt,
  evaluatePreconditionsForToolCall,
  parseAgentDecisionReply,
  type PendingAgentDecision,
  type PreconditionEnv,
} from '../src/agent/clarification-gate.js';
import { buildPreconditionGuardHooks } from '../src/agent/precondition-guard.js';
import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const PROJECT_PATH = '/Users/example/Projects/product-site';

function envWithoutLink(): PreconditionEnv {
  return {
    cwd: PROJECT_PATH,
    activeProjectPath: PROJECT_PATH,
    existsSync: () => false,
  };
}

function envWithNetlifyLink(): PreconditionEnv {
  return {
    cwd: PROJECT_PATH,
    activeProjectPath: PROJECT_PATH,
    existsSync: (path: string) => path.endsWith('/.netlify/state.json'),
  };
}

function envWithClementineDeployConfig(): PreconditionEnv {
  return {
    cwd: PROJECT_PATH,
    activeProjectPath: PROJECT_PATH,
    existsSync: (path: string) => path.endsWith('/.clementine/deploy.json'),
  };
}

describe('evaluatePreconditionsForToolCall — netlify deploy missing link', () => {
  it('returns a PendingAgentDecision when no link or deploy config exists', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: `cd "${PROJECT_PATH}" && netlify deploy --prod --dir=dist` },
      envWithoutLink(),
      { originalRequest: 'deploy the product site', runId: 'run-test' },
    );
    expect(decision).not.toBeNull();
    expect(decision!.context.classifierId).toBe('netlify_missing_deployment_target');
    expect(decision!.context.provider).toBe('netlify');
    expect(decision!.context.category).toBe('deployment_target_missing');
    expect(decision!.context.projectPath).toBe(PROJECT_PATH);
    expect(decision!.runIds).toEqual(['run-test']);
    expect(decision!.originalRequest).toBe('deploy the product site');
    // Question must include the actionable options for the owner.
    expect(decision!.question).toMatch(/create target/i);
    expect(decision!.question).toMatch(/use existing/i);
  });

  it('returns null when .netlify/state.json exists (already linked)', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: `cd "${PROJECT_PATH}" && netlify deploy --prod --dir=dist` },
      envWithNetlifyLink(),
    );
    expect(decision).toBeNull();
  });

  it('returns null when .clementine/deploy.json exists (Clementine deploy config)', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: `cd "${PROJECT_PATH}" && netlify deploy --prod --dir=dist` },
      envWithClementineDeployConfig(),
    );
    expect(decision).toBeNull();
  });

  it('returns null when project path cannot be inferred (fail-open to post-hoc)', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: 'netlify deploy --prod' },  // no `cd` prefix
      { cwd: '/', existsSync: () => false },  // no activeProjectPath
    );
    expect(decision).toBeNull();
  });

  it('returns null for unrelated Bash commands', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: 'ls -la' },
      envWithoutLink(),
    );
    expect(decision).toBeNull();
  });

  it('returns null for unrelated tool names', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Write',
      { file_path: '/tmp/foo.txt', content: 'bar' },
      envWithoutLink(),
    );
    expect(decision).toBeNull();
  });
});

describe('buildPreconditionGuardHooks PreToolUse hook', () => {
  function fireHook(handles: ReturnType<typeof buildPreconditionGuardHooks>, toolName: string, toolInput: Record<string, unknown>): Promise<HookJSONOutput> {
    const matchers = handles.hooks.PreToolUse!;
    const callback = matchers[0]!.hooks[0] as HookCallback;
    const input: PreToolUseHookInput = {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'tu-test',
      session_id: 'sdk-test',
      transcript_path: '',
      cwd: PROJECT_PATH,
      permission_mode: 'dontAsk' as any,
    } as any;
    return callback(input, 'tu-test', { signal: new AbortController().signal });
  }

  it('denies the tool call and captures the decision when classifier fires', async () => {
    // Mock the SDK's existsSync indirectly by relying on the project's
    // actual filesystem state — neither .netlify/state.json nor
    // .clementine/deploy.json exists in this test path.
    const handles = buildPreconditionGuardHooks({
      runId: 'run-test',
      cwd: '/nonexistent/test/project',
      activeProjectPath: '/nonexistent/test/project',
      originalRequest: 'deploy the test project',
    });

    expect(handles.getCapturedDecision()).toBeNull();

    const output = await fireHook(handles, 'Bash', {
      command: 'cd "/nonexistent/test/project" && netlify deploy --prod',
    });

    expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/create target/i);

    const captured = handles.getCapturedDecision();
    expect(captured).not.toBeNull();
    expect(captured!.context.classifierId).toBe('netlify_missing_deployment_target');
    expect(captured!.runIds).toEqual(['run-test']);
  });

  it('passes through unrelated tool calls', async () => {
    const handles = buildPreconditionGuardHooks({
      runId: 'run-test',
      cwd: '/nonexistent/test/project',
      activeProjectPath: '/nonexistent/test/project',
    });

    const output = await fireHook(handles, 'Read', {
      file_path: '/tmp/anything.txt',
    });

    expect(output.hookSpecificOutput).toBeUndefined();
    expect(handles.getCapturedDecision()).toBeNull();
  });

  it('only captures the first decision per run (subsequent calls pass through)', async () => {
    const handles = buildPreconditionGuardHooks({
      runId: 'run-test',
      cwd: '/nonexistent/test/project',
      activeProjectPath: '/nonexistent/test/project',
    });

    const first = await fireHook(handles, 'Bash', {
      command: 'cd "/nonexistent/test/project" && netlify deploy --prod',
    });
    expect(first.hookSpecificOutput?.permissionDecision).toBe('deny');
    const firstDecision = handles.getCapturedDecision();
    expect(firstDecision).not.toBeNull();

    const second = await fireHook(handles, 'Bash', {
      command: 'cd "/nonexistent/test/project" && netlify deploy --prod',
    });
    expect(second.hookSpecificOutput).toBeUndefined();
    // Captured decision should be unchanged — first match wins.
    expect(handles.getCapturedDecision()).toBe(firstDecision);
  });
});

describe('pre-call decision round-trips through reply parsing', () => {
  it('parses "create target" reply and builds a continuation prompt', () => {
    const decision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: `cd "${PROJECT_PATH}" && netlify deploy --prod --dir=dist` },
      envWithoutLink(),
      { originalRequest: 'deploy the product site', runId: 'run-test' },
    )!;
    expect(decision).not.toBeNull();

    const reply = parseAgentDecisionReply(decision, 'yes create the target please');
    expect(reply.kind).toBe('answer');
    if (reply.kind === 'answer') {
      expect(reply.action).toBe('create_new_target');
      const continuation = buildAgentDecisionContinuationPrompt(decision, reply);
      expect(continuation).toMatch(/Create\/link a new deployment target/);
      expect(continuation).toMatch(/needs_user_decision -> executing/);
    }
  });

  it('parses "use existing <target>" reply and embeds the target in the prompt', () => {
    const decision: PendingAgentDecision = evaluatePreconditionsForToolCall(
      'Bash',
      { command: `cd "${PROJECT_PATH}" && netlify deploy --prod --dir=dist` },
      envWithoutLink(),
      { originalRequest: 'deploy the product site', runId: 'run-test' },
    )!;

    const reply = parseAgentDecisionReply(decision, 'use existing example-product-site');
    expect(reply.kind).toBe('answer');
    if (reply.kind === 'answer' && reply.action === 'use_existing_target') {
      expect(reply.target).toBe('example-product-site');
      const continuation = buildAgentDecisionContinuationPrompt(decision, reply);
      expect(continuation).toMatch(/Use existing deployment target: example-product-site/);
    }
  });
});
