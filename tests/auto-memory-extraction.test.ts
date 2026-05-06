import { describe, expect, it, vi } from 'vitest';
import { PersonalAssistant } from '../src/agent/assistant.js';

function makeAssistant(): any {
  const assistant: any = Object.create(PersonalAssistant.prototype);
  assistant.memoryStore = { logExtraction: vi.fn() };
  assistant.lastExtractionTimes = new Map<string, number>();
  return assistant;
}

describe('auto-memory extraction routing', () => {
  it('logs structured skip telemetry', () => {
    const assistant = makeAssistant();
    assistant.logMemoryExtractionSkip('too_short', 'short', 'brief', 's1', { slug: 'agent-a' });

    expect(assistant.memoryStore.logExtraction).toHaveBeenCalledTimes(1);
    const row = assistant.memoryStore.logExtraction.mock.calls[0][0];
    expect(row.toolName).toBe('auto_memory_skip');
    expect(row.status).toBe('skipped:too_short');
    expect(row.agentSlug).toBe('agent-a');
    expect(JSON.parse(row.toolInput).reason).toBe('too_short');
  });
});
