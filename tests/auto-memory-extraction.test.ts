import { describe, expect, it, vi } from 'vitest';
import { PersonalAssistant } from '../src/agent/assistant.js';

function makeAssistant(): any {
  const assistant: any = Object.create(PersonalAssistant.prototype);
  assistant.memoryStore = { logExtraction: vi.fn() };
  assistant.lastExtractionTimes = new Map<string, number>();
  return assistant;
}

describe('auto-memory extraction routing', () => {
  const substantivePrompt = 'Please remember that my current Clementine priority is reducing latency while preserving persistent memory.';
  const substantiveResponse = 'Got it. I will keep that priority in mind and preserve the memory behavior while optimizing latency. '.repeat(3);

  it('rate-limits per session/agent instead of globally', () => {
    const assistant = makeAssistant();

    expect(assistant.assessMemoryExtraction(substantivePrompt, substantiveResponse, 's1', { slug: 'clementine' }).ok).toBe(true);
    const sameSession = assistant.assessMemoryExtraction(substantivePrompt, substantiveResponse, 's1', { slug: 'clementine' });
    expect(sameSession).toEqual({ ok: false, reason: 'rate_limited' });

    expect(assistant.assessMemoryExtraction(substantivePrompt, substantiveResponse, 's2', { slug: 'clementine' }).ok).toBe(true);
    expect(assistant.assessMemoryExtraction(substantivePrompt, substantiveResponse, 's1', { slug: 'ross-the-sdr' }).ok).toBe(true);
  });

  it('classifies pure greetings before generic shortness', () => {
    const assistant = makeAssistant();
    expect(assistant.assessMemoryExtraction('hey', 'hello there'.repeat(20), 's1')).toEqual({
      ok: false,
      reason: 'pure_greeting',
    });
  });

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
