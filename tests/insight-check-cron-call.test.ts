import { describe, expect, it } from 'vitest';
import { buildConsolidationCronCall, buildInsightCheckCronCall } from '../src/gateway/heartbeat-scheduler.js';

describe('insight check cron call', () => {
  it('runs as a no-tool classifier job', () => {
    const call = buildInsightCheckCronCall('rate these signals');

    expect(call).toMatchObject({
      jobName: 'insight-check',
      jobPrompt: 'rate these signals',
      tier: 1,
      maxTurns: 1,
      model: 'haiku',
      opts: { disableAllTools: true },
    });
  });

  it('runs consolidation synthesis without loading MCP tool schemas', () => {
    const call = buildConsolidationCronCall('summarize memory chunks');

    expect(call).toMatchObject({
      jobName: 'consolidation-llm',
      jobPrompt: 'summarize memory chunks',
      tier: 1,
      maxTurns: 1,
      model: 'haiku',
      opts: { disableAllTools: true },
    });
  });
});
