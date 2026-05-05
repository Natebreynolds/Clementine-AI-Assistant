import { describe, expect, it, vi } from 'vitest';
import {
  detectConversationLearning,
  persistConversationLearning,
} from '../src/gateway/conversation-learning.js';

describe('conversation learning', () => {
  it('detects no-bandaid and memory-retrieval corrections from short turns', () => {
    const signal = detectConversationLearning(
      'No bandaid fixes. She should use chat history and memory retrieval proactively.',
    );

    expect(signal?.corrections.map((c) => c.category)).toEqual(['workflow', 'proactivity']);
    expect(signal?.preferences.join(' ')).toContain('root-cause');
    expect(signal?.preferences.join(' ')).toContain('proactively retrieve');
  });

  it('persists behavioral corrections and durable preferences without an LLM pass', () => {
    const store = {
      getUserModelBlock: vi.fn(() => ({ content: '' })),
      appendUserModelBlock: vi.fn(),
      logFeedback: vi.fn(),
      saveSessionReflection: vi.fn(),
    };

    const signal = persistConversationLearning(
      'discord:user:123',
      'The immediate replies with useless information are not helpful; use memory across sessions.',
      store,
    );

    expect(signal?.corrections.length).toBeGreaterThan(0);
    expect(store.saveSessionReflection).toHaveBeenCalled();
    expect(store.logFeedback).toHaveBeenCalled();
    expect(store.appendUserModelBlock).toHaveBeenCalled();
  });
});

