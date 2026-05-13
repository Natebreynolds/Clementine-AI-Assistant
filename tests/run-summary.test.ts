import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/gateway/event-log.js';
import type { RunEvent } from '../src/types.js';
import {
  buildContinuationPrompt,
  formatOverflowRecoveryMessage,
  summarizeRunSideEffects,
} from '../src/agent/run-summary.js';

function ev(over: Partial<RunEvent>): RunEvent {
  return {
    runId: 'run-a',
    seq: 0,
    ts: '2026-05-12T21:08:00.000Z',
    kind: 'llm_text',
    ...over,
  } as RunEvent;
}

describe('run summary', () => {
  it('pairs tool calls and results across multiple runIds', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clem-run-summary-'));
    try {
      const log = new EventLog(dir);
      log.append(ev({
        runId: 'run-a',
        seq: 0,
        kind: 'tool_call',
        toolName: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
        toolUseId: 'send-1',
        toolInput: { to: 'kevin@example.com', subject: 'Denver legal search', body: 'hello' },
      }));
      log.append(ev({
        runId: 'run-a',
        seq: 1,
        kind: 'tool_result',
        toolUseId: 'send-1',
        toolResult: { successful: true, error: null, data: { status_code: 202 }, logId: 'log_123' },
      }));
      log.append(ev({
        runId: 'run-b',
        seq: 0,
        kind: 'tool_call',
        toolName: 'mcp__dataforseo__SEARCH',
        toolUseId: 'read-1',
      }));
      log.append(ev({
        runId: 'run-b',
        seq: 1,
        kind: 'tool_result',
        toolUseId: 'read-1',
        toolResult: { successful: true, data: [] },
      }));
      log.append(ev({
        runId: 'run-b',
        seq: 2,
        kind: 'tool_call',
        toolName: 'Bash',
        toolUseId: 'unknown-1',
        toolInput: { command: 'node scripts/custom-workflow.js' },
      }));
      log.append(ev({
        runId: 'run-b',
        seq: 3,
        kind: 'tool_call',
        toolName: 'Agent',
        toolUseId: 'agent-1',
        toolInput: { subagent_type: 'discovery', description: 'Map Track Coaches project' },
      }));
      log.append(ev({
        runId: 'run-b',
        seq: 4,
        kind: 'tool_result',
        toolUseId: 'agent-1',
        toolResult: [
          {
            type: 'text',
            text: [
              '[Clementine compacted this Agent result to protect the parent chat context.]',
              'Subagent: discovery',
              'Task: Map Track Coaches project',
              'agentId: abc123',
              'Full payload archived at `/tmp/full-agent-result.json` — call `Read` on that path for the full Agent result.',
              '',
              'Decision-grade handoff:',
              'Found: 1 matching project',
            ].join('\n'),
          },
        ],
      }));

      const summary = summarizeRunSideEffects(['run-a', 'run-b'], log);
      expect(summary.successfulSideEffects).toHaveLength(1);
      expect(summary.successfulSideEffects[0].result?.statusCode).toBe(202);
      expect(summary.successfulDelegations).toHaveLength(1);
      expect(summary.readOnlyCount).toBe(1);
      expect(summary.unknownEffectCalls).toHaveLength(1);

      const message = formatOverflowRecoveryMessage(summary);
      expect(message).toContain('1 email sends completed');
      expect(message).toContain('kevin@example.com');
      expect(message).toContain('Delegated work completed');
      expect(message).toContain('/tmp/full-agent-result.json');
      expect(message).toContain('unknown external effect');

      const prompt = buildContinuationPrompt(summary, 'fire off those emails');
      expect(prompt).toContain('DO NOT re-run completed side effects');
      expect(prompt).toContain('kevin@example.com');
      expect(prompt).toContain('Denver legal search');
      expect(prompt).toContain('logId log_123');
      expect(prompt).toContain('Do not repeat discovery/research');
      expect(prompt).toContain('Map Track Coaches project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
