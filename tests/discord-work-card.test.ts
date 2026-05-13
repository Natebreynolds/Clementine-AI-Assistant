import { describe, expect, it } from 'vitest';
import { Collection } from 'discord.js';
import {
  buildDiscordMessageText,
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

  it('normalizes text and attachments with name, type, size, and URL', () => {
    const attachments = new Collection<string, any>();
    attachments.set('img', {
      name: 'coach board.png',
      contentType: 'image/png',
      size: 2048,
      url: 'https://cdn.discordapp.com/attachments/1/coach-board.png',
    });
    attachments.set('csv', {
      name: 'prospects.csv',
      contentType: 'text/csv',
      size: 1536,
      url: 'https://cdn.discordapp.com/attachments/1/prospects.csv',
    });

    const text = buildDiscordMessageText({
      content: 'Please review these.',
      attachments,
    } as any);

    expect(text).toContain('[Image attached: coach board.png; type=image/png; size=2 KB; url=https://cdn.discordapp.com/attachments/1/coach-board.png]');
    expect(text).toContain('[File attached: prospects.csv; type=text/csv; size=2 KB; url=https://cdn.discordapp.com/attachments/1/prospects.csv]');
    expect(text.endsWith('Please review these.')).toBe(true);
  });
});
