import { describe, expect, it } from 'vitest';
import {
  buildAgentDecisionContinuationPrompt,
  buildBlockedActionDecisionFromRunSummary,
  parseAgentDecisionReply,
} from '../src/agent/clarification-gate.js';
import type { RunSummary } from '../src/agent/run-summary.js';

function deploymentTargetSummary(): RunSummary {
  return {
    runIds: ['run-deploy'],
    sessionIds: ['sdk-1'],
    totalEvents: 8,
    successfulSideEffects: [
      {
        runId: 'run-deploy',
        toolName: 'Write',
        toolUseId: 'write-artifact',
        timestamp: '2026-05-13T09:15:00.000Z',
        verdict: { kind: 'side_effect', reason: 'known-mutating-builtin' },
        input: {
          file_path: '/Users/example/Projects/product-site/dist/index.html',
        },
        result: {
          successful: true,
          reason: 'no-error-signal',
          raw: 'File created successfully at: /Users/example/Projects/product-site/dist/index.html',
        },
      },
    ],
    failedSideEffects: [
      {
        runId: 'run-deploy',
        toolName: 'Bash',
        toolUseId: 'deploy-fail',
        timestamp: '2026-05-13T09:16:07.941Z',
        verdict: { kind: 'side_effect', reason: 'bash-mutation-pattern' },
        input: {
          command: 'cd "/Users/example/Projects/product-site" && netlify deploy --prod --dir=dist 2>&1 | tail -40',
        },
        result: {
          successful: false,
          reason: 'tool-result-error-string',
          error: 'Project not found. Please rerun "netlify link"',
          raw: 'Error: Project not found. Please rerun "netlify link"',
        },
      },
    ],
    pendingSideEffects: [],
    unknownEffectCalls: [],
    successfulDelegations: [
      {
        runId: 'run-deploy',
        toolName: 'Agent',
        toolUseId: 'agent-discovery',
        timestamp: '2026-05-13T09:13:26.002Z',
        verdict: { kind: 'read_only', reason: 'known-readonly-builtin' },
        input: { description: 'Find product site project' },
        result: {
          successful: true,
          reason: 'no-error-signal',
          raw: [{ type: 'text', text: 'Found project.\nagentId: agent-discovery-1' }],
        },
      },
    ],
    failedDelegations: [],
    pendingDelegations: [],
    readOnlyCount: 7,
    errors: [],
    ended: 'session_end',
  };
}

describe('clarification gate', () => {
  it('turns a provider-specific deployment failure into a generic owner decision', () => {
    const decision = buildBlockedActionDecisionFromRunSummary(
      deploymentTargetSummary(),
      'finish the product landing page and deploy it',
      Date.parse('2026-05-13T09:17:00.000Z'),
    );

    expect(decision).not.toBeNull();
    expect(decision?.kind).toBe('blocked_external_action');
    expect(decision?.context.category).toBe('deployment_target_missing');
    expect(decision?.context.provider).toBe('netlify');
    expect(decision?.question).toContain('I need one decision');
    expect(decision?.question).toContain('Provider: Netlify');
    expect(decision?.question).toContain('create target');
    expect(decision?.question).toContain('use existing <target-slug-or-id>');
    expect(decision?.question).toContain('Project not found. Please rerun "netlify link"');
    expect(decision?.context.projectPath).toBe('/Users/example/Projects/product-site');
    expect(decision?.context.agentId).toBe('agent-discovery-1');
  });

  it('does not treat vague continue as an answer', () => {
    const decision = buildBlockedActionDecisionFromRunSummary(deploymentTargetSummary(), 'deploy this')!;
    expect(parseAgentDecisionReply(decision, 'continue')).toEqual({
      kind: 'unclear',
      message: 'I need a specific decision: reply `create target`, `use existing <target-slug-or-id>`, or `done`.',
    });
  });

  it('accepts natural but still explicit deploy decisions', () => {
    const decision = buildBlockedActionDecisionFromRunSummary(deploymentTargetSummary(), 'deploy this')!;
    expect(parseAgentDecisionReply(decision, 'yes create the target please')).toEqual({
      kind: 'answer',
      action: 'create_new_target',
    });
    expect(parseAgentDecisionReply(decision, 'use existing example-product-site')).toEqual({
      kind: 'answer',
      action: 'use_existing_target',
      target: 'example-product-site',
    });
    expect(parseAgentDecisionReply(decision, 'use existing <target-slug-or-id>')).toEqual({
      kind: 'unclear',
      message: 'Please replace `<target-slug-or-id>` with the actual deployment target identifier or URL.',
    });
  });

  it('builds a continuation prompt from the owner decision', () => {
    const decision = buildBlockedActionDecisionFromRunSummary(deploymentTargetSummary(), 'deploy this')!;
    const reply = parseAgentDecisionReply(decision, 'use existing example-product-site');
    expect(reply).toEqual({
      kind: 'answer',
      action: 'use_existing_target',
      target: 'example-product-site',
    });
    if (reply.kind !== 'answer') throw new Error('expected answer');

    const prompt = buildAgentDecisionContinuationPrompt(decision, reply);
    expect(prompt).toContain('needs_user_decision -> executing');
    expect(prompt).toContain('Decision kind: blocked_external_action');
    expect(prompt).toContain('Blocker category: deployment_target_missing');
    expect(prompt).toContain('Provider: Netlify');
    expect(prompt).toContain('Previous run(s): run-deploy');
    expect(prompt).toContain('example-product-site');
    expect(prompt).toContain('Completed before the block');
    expect(prompt).toContain('dist/index.html');
    expect(prompt).toContain('Do not restart project discovery');
    expect(prompt).toContain('Prefer `project_deploy`');
  });
});
