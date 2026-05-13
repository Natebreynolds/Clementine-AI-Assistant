/**
 * Notification routing — agentSlug inference + dispatcher routing.
 *
 * Pins the contract that hired-agent autonomous results never leak
 * out through Clementine's main DM when the originating session key
 * encodes the owning agent. Two layers under test:
 *
 *  1. inferAgentSlugFromSessionKey() — pure pattern matcher,
 *     extracts the slug from heartbeat / team-task / discord-member
 *     session keys.
 *
 *  2. NotificationDispatcher.send() — when the caller forgot to set
 *     `context.agentSlug` but the sessionKey encodes one, the slug
 *     reaches the channel sender. Explicit `agentSlug` always wins
 *     over inference. Unrelated keys (cron, dashboard, plain
 *     discord:user) leave agentSlug undefined so Clementine handles
 *     them.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { NotificationDispatcher, inferAgentSlugFromSessionKey } from '../src/gateway/notifications.js';
import type { NotificationContext } from '../src/types.js';

describe('inferAgentSlugFromSessionKey', () => {
  it('extracts slug from heartbeat:<slug>', () => {
    expect(inferAgentSlugFromSessionKey('heartbeat:sales-agent')).toBe('sales-agent');
    expect(inferAgentSlugFromSessionKey('heartbeat:marketing-agent')).toBe('marketing-agent');
  });

  it('extracts slug from agent-heartbeat:<slug>', () => {
    expect(inferAgentSlugFromSessionKey('agent-heartbeat:research-agent')).toBe('research-agent');
  });

  it('treats heartbeat:clementine as Clementine-owned (no inference)', () => {
    expect(inferAgentSlugFromSessionKey('heartbeat:clementine')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('agent-heartbeat:clementine')).toBeUndefined();
  });

  it('extracts the receiving slug from team-task:<from>-><to>', () => {
    expect(inferAgentSlugFromSessionKey('team-task:clementine->sales-agent')).toBe('sales-agent');
    expect(inferAgentSlugFromSessionKey('team-task:marketing-agent->sales-agent')).toBe('sales-agent');
  });

  it('returns undefined when the receiving slug is clementine', () => {
    expect(inferAgentSlugFromSessionKey('team-task:sales-agent->clementine')).toBeUndefined();
  });

  it('extracts slug from discord:agent:<slug>:<userId>', () => {
    expect(inferAgentSlugFromSessionKey('discord:agent:sales-agent:1234567890')).toBe('sales-agent');
  });

  it('extracts slug from discord:member-dm:<slug>:<userId>', () => {
    expect(inferAgentSlugFromSessionKey('discord:member-dm:marketing-agent:9999')).toBe('marketing-agent');
  });

  it('extracts slug from discord:member:<channelId>:<slug>:<userId>', () => {
    expect(inferAgentSlugFromSessionKey('discord:member:111222:research-agent:333444')).toBe('research-agent');
  });

  it('returns undefined for cron sessionKeys (cron threads agentSlug explicitly)', () => {
    // The cron path always passes agentSlug via dispatchContextForJob;
    // the dispatcher must not try to mine the job name as a slug.
    expect(inferAgentSlugFromSessionKey('cron:sales-agent:reply-detection')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('cron:morning-briefing')).toBeUndefined();
  });

  it('returns undefined for plain discord/slack/dashboard sessions', () => {
    expect(inferAgentSlugFromSessionKey('discord:user:1234567890')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('discord:channel:abc')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('dashboard:web')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('slack:channel:CABC123')).toBeUndefined();
  });

  it('returns undefined for nonsense / empty input', () => {
    expect(inferAgentSlugFromSessionKey('')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('not-a-real-session-key')).toBeUndefined();
    expect(inferAgentSlugFromSessionKey('heartbeat:')).toBeUndefined();
  });
});

describe('NotificationDispatcher routing', () => {
  let dispatcher: NotificationDispatcher;
  let received: Array<{ text: string; context?: NotificationContext }>;

  beforeEach(() => {
    dispatcher = new NotificationDispatcher();
    received = [];
    dispatcher.register('discord', async (text, context) => {
      received.push({ text, context });
    });
  });

  it('threads explicit context.agentSlug through to the channel sender', async () => {
    await dispatcher.send('hello', { agentSlug: 'sales-agent', sessionKey: 'cron:sales-agent:reply-detection' });
    expect(received).toHaveLength(1);
    expect(received[0].context?.agentSlug).toBe('sales-agent');
  });

  it('infers agentSlug from heartbeat sessionKey when caller omitted it', async () => {
    await dispatcher.send('hello', { sessionKey: 'heartbeat:sales-agent' });
    expect(received[0].context?.agentSlug).toBe('sales-agent');
  });

  it('infers agentSlug from team-task sessionKey when caller omitted it', async () => {
    await dispatcher.send('hello', { sessionKey: 'team-task:clementine->marketing-agent' });
    expect(received[0].context?.agentSlug).toBe('marketing-agent');
  });

  it('explicit context.agentSlug wins over an inferable one', async () => {
    // sessionKey points at one agent but caller explicitly set another — caller wins.
    await dispatcher.send('hello', {
      agentSlug: 'sales-agent',
      sessionKey: 'heartbeat:marketing-agent',
    });
    expect(received[0].context?.agentSlug).toBe('sales-agent');
  });

  it('leaves agentSlug undefined for Clementine-owned sessions', async () => {
    await dispatcher.send('hello', { sessionKey: 'heartbeat:clementine' });
    expect(received[0].context?.agentSlug).toBeUndefined();
  });

  it('leaves agentSlug undefined when no context is passed at all', async () => {
    await dispatcher.send('system reminder');
    expect(received[0].context).toBeUndefined();
  });

  it('does not leak hired-agent results to a Clementine-default path when a plain cron sessionKey is passed', async () => {
    // Caller forgot agentSlug; sessionKey is the plain cron form.
    // The inference must NOT try to interpret the job name as a slug
    // (that would break for crons named "morning-briefing", etc.) —
    // it leaves agentSlug undefined and the channel layer falls back
    // to Clementine's main DM. cron-scheduler's dispatchContextForJob
    // is responsible for threading agentSlug for hired-agent crons.
    await dispatcher.send('hello', { sessionKey: 'cron:morning-briefing' });
    expect(received[0].context?.agentSlug).toBeUndefined();
  });
});
