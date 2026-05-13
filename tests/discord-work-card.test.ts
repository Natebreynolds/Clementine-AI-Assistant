import { describe, expect, it } from 'vitest';
import {
  buildDiscordWorkCard,
  classifyDiscordWorkActivity,
  type DiscordWorkCardState,
} from '../src/channels/discord-utils.js';

function state(overrides: Partial<DiscordWorkCardState> = {}): DiscordWorkCardState {
  return {
    startedAt: 1_000,
    status: 'thinking...',
    toolCallCount: 0,
    counts: {
      read: 0,
      write: 0,
      command: 0,
      delegate: 0,
      external: 0,
      memory: 0,
      other: 0,
    },
    recentActivities: [],
    ...overrides,
  };
}

describe('Discord live work card', () => {
  it('renders an initial compact work card', () => {
    expect(buildDiscordWorkCard(state(), 3_500)).toContain('Status: thinking...');
    expect(buildDiscordWorkCard(state(), 3_500)).toContain('Elapsed: 2s | Steps: 0');
    expect(buildDiscordWorkCard(state(), 3_500)).toContain('Tools: no tools yet');
  });

  it('summarizes tool counts and recent activity without raw tool output', () => {
    const card = buildDiscordWorkCard(state({
      status: 'Running command: npm test',
      toolCallCount: 4,
      counts: {
        read: 2,
        write: 0,
        command: 1,
        delegate: 1,
        external: 0,
        memory: 0,
        other: 0,
      },
      recentActivities: [
        'Searching memory',
        'Delegating',
        'Running command: npm test',
      ],
    }), 62_000);

    expect(card).toContain('Elapsed: 1m 1s | Steps: 4');
    expect(card).toContain('reads: 2 | commands: 1 | delegations: 1');
    expect(card).toContain('- Running command: npm test');
  });

  it('redacts credential-shaped values in live status text', () => {
    const card = buildDiscordWorkCard(state({
      status: 'Running command with sk-abcdefghijklmnopqrstuvwxyz123456',
      recentActivities: ['Running command with sk-abcdefghijklmnopqrstuvwxyz123456'],
    }), 2_000);

    expect(card).toContain('[REDACTED_KEY]');
    expect(card).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('classifies common Discord-visible work buckets', () => {
    expect(classifyDiscordWorkActivity('Agent')).toBe('delegate');
    expect(classifyDiscordWorkActivity('Bash')).toBe('command');
    expect(classifyDiscordWorkActivity('Read')).toBe('read');
    expect(classifyDiscordWorkActivity('mcp__composio__OUTLOOK_SEND_EMAIL')).toBe('external');
    expect(classifyDiscordWorkActivity('mcp__clementine-tools__memory_search')).toBe('memory');
  });
});
