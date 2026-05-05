import { describe, expect, it } from 'vitest';
import { buildOperationsSnapshot } from '../src/dashboard/build-operations.js';

describe('buildOperationsSnapshot', () => {
  it('separates scheduled tasks, scheduled workflows, attention items, and running work', () => {
    const snapshot = buildOperationsSnapshot({
      cronJobs: [
        {
          name: 'daily-send',
          schedule: '0 9 * * *',
          prompt: 'send the daily summary',
          enabled: true,
          recentRuns: [{ status: 'ok', startedAt: '2026-05-04T16:00:00.000Z', finishedAt: '2026-05-04T16:01:00.000Z' }],
        },
        {
          name: 'sdr:lead-review',
          agent: 'sdr',
          schedule: '0 10 * * *',
          prompt: 'review leads',
          enabled: true,
          recentRuns: [{ status: 'error', startedAt: '2026-05-04T17:00:00.000Z', finishedAt: '2026-05-04T17:01:00.000Z' }],
        },
      ],
      workflowSummaries: [
        {
          id: 'workflow:research-send',
          origin: 'workflow',
          scope: 'global',
          name: 'research-send',
          description: 'Research, draft, and send',
          enabled: true,
          schedule: '0 12 * * 1',
          stepCount: 3,
          sourceFile: '/tmp/research-send.md',
        },
      ],
      brokenJobs: [
        {
          jobName: 'sdr:lead-review',
          agentSlug: 'sdr',
          errorCount48h: 3,
          totalRuns48h: 3,
          lastErrorAt: '2026-05-04T17:00:00.000Z',
          lastErrors: ['Claude Code returned an error result'],
          circuitBreakerEngagedAt: null,
          lastAdvisorOpinion: null,
          diagnosis: {
            generatedAt: '2026-05-04T17:05:00.000Z',
            rootCause: 'Prompt is too vague',
            confidence: 'high',
            riskLevel: 'low',
            proposedFix: {
              type: 'prompt_override',
              details: 'Narrow the task',
              autoApply: { operations: [{ op: 'set', path: 'prompt', value: 'review only new leads' }] },
            },
          },
        },
      ],
      unleashedTasks: [
        {
          runtimeName: 'lead-review-run',
          jobName: 'sdr:lead-review',
          agentSlug: 'sdr',
          live: true,
          runtimeState: 'active',
          status: 'running',
          startedAt: '2026-05-04T17:10:00.000Z',
          updatedAt: '2026-05-04T17:12:00.000Z',
        },
        {
          runtimeName: 'old-run',
          jobName: 'weekly-report',
          status: 'failed',
          runtimeState: 'terminal',
          updatedAt: '2026-05-04T15:00:00.000Z',
          error: 'phase failed',
        },
      ],
      backgroundTasks: [
        {
          id: 'bg-1',
          fromAgent: 'sdr',
          status: 'failed',
          createdAt: '2026-05-04T14:00:00.000Z',
          completedAt: '2026-05-04T14:15:00.000Z',
          error: 'aborted after retries',
        },
      ],
      usageTasks: [
        {
          taskKey: 'sdr:lead-review',
          kind: 'scheduled task',
          agentSlug: 'sdr',
          totalInput: 1200,
          totalOutput: 300,
          totalTokens: 1500,
          queries: 2,
        },
        {
          taskKey: 'research-send',
          kind: 'workflow step',
          totalInput: 2000,
          totalOutput: 500,
          totalTokens: 2500,
          queries: 1,
        },
      ],
      usageSummary: {
        totalTokens: 5000,
        totalInput: 4000,
        totalOutput: 1000,
        taskTotals: { totalTokens: 4000, totalInput: 3200, totalOutput: 800, costCents: 0, queries: 3 },
      },
    });

    expect(snapshot.summary.scheduledTasks).toBe(2);
    expect(snapshot.summary.scheduledWorkflows).toBe(1);
    expect(snapshot.summary.runningNow).toBe(1);
    expect(snapshot.summary.needsAttention).toBe(3);
    expect(snapshot.summary.brokenScheduledTasks).toBe(1);
    expect(snapshot.summary.failedRuntime).toBe(2);

    const broken = snapshot.scheduledTasks.find(t => t.name === 'sdr:lead-review');
    expect(broken?.health).toBe('broken');
    expect(broken?.actions.applyFix).toBe(true);
    expect(broken?.usage?.totalTokens).toBe(1500);

    expect(snapshot.scheduledWorkflows[0]?.limitations[0]).toContain('Canvas mock tests');
    expect(snapshot.needsAttention.filter(i => i.type === 'broken_scheduled_task')).toHaveLength(1);
    expect(snapshot.needsAttention.filter(i => i.type === 'failed_runtime')).toHaveLength(2);
  });

  it('keeps orphaned broken history visible when the definition is missing', () => {
    const snapshot = buildOperationsSnapshot({
      cronJobs: [],
      workflowSummaries: [],
      brokenJobs: [{
        jobName: 'removed-job',
        errorCount48h: 2,
        totalRuns48h: 2,
        lastErrorAt: '2026-05-04T12:00:00.000Z',
        lastErrors: ['monthly usage limit'],
        circuitBreakerEngagedAt: null,
        lastAdvisorOpinion: null,
      }],
      unleashedTasks: [],
      backgroundTasks: [],
    });

    expect(snapshot.needsAttention).toHaveLength(1);
    expect(snapshot.needsAttention[0]?.type).toBe('orphaned_broken_job');
    expect(snapshot.needsAttention[0]?.reason).toBe('usage or provider limit');
  });
});
