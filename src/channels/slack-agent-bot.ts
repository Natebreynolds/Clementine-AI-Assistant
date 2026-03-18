/**
 * Clementine TypeScript — Slack agent bot client.
 *
 * A @slack/bolt App wrapper for a single agent.
 * Handles: DMs + channel messages → gateway → stream response.
 * Uses Socket Mode (requires both bot token + app token).
 *
 * Channel discovery (in priority order):
 *   1. Explicit `slackChannelId` from agent config
 *   2. Auto-discover by matching `channelName` via conversations.list
 *   3. Falls back to listening in ALL channels the bot is in
 *
 * DMs are always enabled for the owner.
 */

import { App } from '@slack/bolt';
import pino from 'pino';
import type { AgentProfile } from '../types.js';
import type { Gateway } from '../gateway/router.js';
import { mdToSlack, sendChunkedSlack, SlackStreamingMessage } from './slack-utils.js';
import { friendlyToolName } from './discord-utils.js';

const logger = pino({ name: 'clementine.slack-agent-bot' });

export interface SlackAgentBotConfig {
  slug: string;
  botToken: string;
  appToken: string;
  ownerId: string;
  profile: AgentProfile;
  /** Explicit channel IDs to listen in. If empty, auto-discovered on connect. */
  channelIds?: string[];
}

export type SlackAgentBotStatus = 'offline' | 'connecting' | 'online' | 'error';

export class SlackAgentBotClient {
  private app: App;
  private config: SlackAgentBotConfig;
  private gateway: Gateway;
  private status: SlackAgentBotStatus = 'offline';
  private errorMessage?: string;
  /** Bot's own user ID (set after auth.test). */
  private botUserId?: string;
  /** Resolved channel IDs (set on connect, after auto-discovery). */
  private resolvedChannelIds: string[] = [];

  constructor(config: SlackAgentBotConfig, gateway: Gateway) {
    this.config = config;
    this.gateway = gateway;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    // Catch Socket Mode errors so they don't crash the daemon
    this.app.error(async (error) => {
      this.status = 'error';
      this.errorMessage = String(error);
      logger.error({ err: error, slug: config.slug }, 'Slack agent bot error — continuing');
    });
  }

  async start(): Promise<void> {
    this.status = 'connecting';

    try {
      // Get bot identity
      const authResult = await this.app.client.auth.test({ token: this.config.botToken });
      this.botUserId = authResult.user_id as string;

      // Discover channels
      this.resolvedChannelIds = await this.discoverChannels();

      // Register message handler
      this.app.message(async ({ message, client }) => {
        try {
          await this.handleMessage(message as any, client);
        } catch (err) {
          logger.error({ err, slug: this.config.slug }, 'Unhandled error in Slack agent bot message handler');
        }
      });

      await this.app.start();
      this.status = 'online';
      this.errorMessage = undefined;

      logger.info(
        { slug: this.config.slug, botUserId: this.botUserId, channels: this.resolvedChannelIds },
        `Slack agent bot online: ${this.config.profile.name}`,
      );
    } catch (err) {
      this.status = 'error';
      this.errorMessage = String(err);
      logger.error({ err, slug: this.config.slug }, 'Slack agent bot start failed');
      throw err;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.app.stop();
    } catch {
      // ignore
    }
    this.status = 'offline';
    logger.info({ slug: this.config.slug }, 'Slack agent bot stopped');
  }

  getStatus(): { status: SlackAgentBotStatus; botUserId?: string; error?: string } {
    return {
      status: this.status,
      botUserId: this.botUserId,
      error: this.errorMessage,
    };
  }

  getChannelIds(): string[] {
    return this.resolvedChannelIds;
  }

  /**
   * Discover which channels this bot should listen in.
   *
   * Priority:
   * 1. Explicit channelIds from config (e.g. slackChannelId in agent.md)
   * 2. Match by channelName via conversations.list
   * 3. All channels the bot is a member of (fallback)
   */
  private async discoverChannels(): Promise<string[]> {
    // 1. Explicit IDs
    if (this.config.channelIds && this.config.channelIds.length > 0) {
      logger.info(
        { slug: this.config.slug, channelIds: this.config.channelIds },
        'Using explicit channel IDs',
      );
      return this.config.channelIds;
    }

    // Fetch all channels the bot is a member of (paginate fully)
    const allBotChannels: Array<{ id: string; name: string }> = [];
    let cursor: string | undefined;
    do {
      const result = await this.app.client.conversations.list({
        token: this.config.botToken,
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const ch of result.channels ?? []) {
        if (ch.is_member && ch.id && ch.name) {
          allBotChannels.push({ id: ch.id, name: ch.name });
        }
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // 2. Match by channelName
    const channelNameConfig = this.config.profile.team?.channelName;
    if (channelNameConfig) {
      const channelNames = Array.isArray(channelNameConfig) ? channelNameConfig : [channelNameConfig];
      const matched = allBotChannels
        .filter(ch => channelNames.includes(ch.name))
        .map(ch => ch.id);

      if (matched.length > 0) {
        logger.info(
          { slug: this.config.slug, channelNames, matched },
          'Auto-discovered Slack channels by name',
        );
        return matched;
      }
      logger.warn(
        { slug: this.config.slug, channelNames },
        'No Slack channels found matching channelName(s) — falling back to all bot channels',
      );
    }

    // 3. Fallback: all channels the bot is a member of
    const all = allBotChannels.map(ch => ch.id);
    logger.info(
      { slug: this.config.slug, count: all.length },
      'Fallback: listening in all Slack channels bot is a member of',
    );
    return all;
  }

  /** Check if this bot participates in a shared team chat channel. */
  isTeamChat(): boolean {
    return this.config.profile.team?.teamChat === true;
  }

  /**
   * Check if this agent is being addressed in a team chat message.
   * Matches: @mention (Slack format <@UXXXXXX>), agent name, agent slug, or broadcast keywords.
   */
  private isAddressedInTeamChat(text: string): boolean {
    // Direct @mention of this bot
    if (this.botUserId && text.includes(`<@${this.botUserId}>`)) {
      return true;
    }

    const lower = text.toLowerCase();

    // Broadcast keywords
    const broadcastPatterns = [
      /\b@?team\b/,
      /\beveryone\b/,
      /\ball\s+agents?\b/,
      /\bthe\s+team\b/,
    ];
    if (broadcastPatterns.some(p => p.test(lower))) {
      return true;
    }

    // Individual agent name or slug at word boundaries
    const name = this.config.profile.name.toLowerCase();
    const slug = this.config.slug.toLowerCase();
    const namePattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const slugPattern = new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

    return namePattern.test(lower) || slugPattern.test(lower);
  }

  /**
   * Collect recent messages from the channel for team chat context.
   */
  private async gatherTeamChatContext(channel: string, beforeTs: string, limit = 10): Promise<string> {
    try {
      const result = await this.app.client.conversations.history({
        token: this.config.botToken,
        channel,
        latest: beforeTs,
        limit: limit + 1,
        inclusive: false,
      });

      const contextLines: string[] = [];
      for (const msg of (result.messages ?? []).reverse()) {
        const authorName = msg.bot_id ? (msg.username ?? 'Bot') : 'Owner';
        const preview = (msg.text ?? '').slice(0, 300);
        if (preview) {
          contextLines.push(`[${authorName}]: ${preview}`);
        }
      }

      if (contextLines.length === 0) return '';
      return `\n\n[Recent team chat context]\n${contextLines.join('\n')}\n[End context]`;
    } catch {
      return '';
    }
  }

  /**
   * Receive an inter-agent team message. Posts a formatted message showing
   * the incoming content, then triggers the agent to process and respond.
   */
  async receiveTeamMessage(fromName: string, fromSlug: string, content: string): Promise<string> {
    if (this.resolvedChannelIds.length === 0) {
      logger.warn({ slug: this.config.slug }, 'No Slack channels to deliver team message to');
      return '(no channels available)';
    }

    const channelId = this.resolvedChannelIds[0];

    // Post the incoming message so it's visible in the channel
    await this.app.client.chat.postMessage({
      token: this.config.botToken,
      channel: channelId,
      text: `*${fromName}* via team message:\n${content.slice(0, 3000)}`,
    });

    // Run the task through the unleashed pipeline — gives the agent full
    // multi-phase autonomous execution instead of the 5-minute chat timeout.
    const streamer = new SlackStreamingMessage(this.app.client, channelId);
    await streamer.start();

    try {
      const response = await this.gateway.handleTeamTask(
        fromName,
        fromSlug,
        content,
        this.config.profile,
        async (token: string) => {
          await streamer.update(token);
        },
      );
      await streamer.finalize(response);
      logger.info({ slug: this.config.slug, from: fromSlug }, 'Processed Slack team message');
      return response;
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Failed to process Slack team message');
      const errMsg = `Something went wrong processing a team message: ${err}`;
      await streamer.finalize(errMsg);
      return errMsg;
    }
  }

  private async handleMessage(message: any, client: App['client']): Promise<void> {
    // Ignore own messages
    if (message.user === this.botUserId) return;
    // Ignore bot messages
    if (message.bot_id) return;
    // Ignore subtypes (joins, leaves, etc.)
    if (message.subtype) return;

    const channel = message.channel;
    const isDm = message.channel_type === 'im';
    const isWatchedChannel = !isDm && this.resolvedChannelIds.includes(channel);

    // Respond in DMs or watched channels
    if (!isDm && !isWatchedChannel) return;

    const isTeamChatChannel = isWatchedChannel && this.isTeamChat();

    // Owner-only check
    if (this.config.ownerId && message.user !== this.config.ownerId) {
      logger.warn(
        { slug: this.config.slug, author: message.user },
        'Ignored Slack message from non-owner',
      );
      return;
    }

    // In team chat: respond to all if respondToAll is set, otherwise only when addressed
    const respondToAll = this.config.profile.team?.respondToAll === true;
    if (isTeamChatChannel && !respondToAll && !this.isAddressedInTeamChat(message.text ?? '')) {
      return;
    }

    let text = message.text ?? '';

    // Extract file attachments
    if (message.files && Array.isArray(message.files) && message.files.length > 0) {
      const fileLines = message.files.map((file: any) => {
        if (file.mimetype?.startsWith('image/')) {
          return `[Image attached: ${file.name} (${file.url_private})]`;
        }
        return `[File attached: ${file.name}, ${file.mimetype || 'unknown type'}, ${file.url_private}]`;
      });
      text = fileLines.join('\n') + (text ? '\n' + text : '');
    }

    if (!text) return;

    // !clear command
    if (text === '!clear') {
      const sessionKey = isDm
        ? `slack:agent:${this.config.slug}:${message.user}`
        : `slack:channel:${channel}:${this.config.slug}:${message.user}`;
      this.gateway.clearSession(sessionKey);
      await client.chat.postMessage({ channel, text: 'Session cleared.', thread_ts: message.ts });
      return;
    }

    // In team chat, use agent-scoped session key
    const sessionKey = isDm
      ? `slack:agent:${this.config.slug}:${message.user}`
      : isTeamChatChannel
        ? `slack:channel:${channel}:${this.config.slug}:${message.user}`
        : `slack:channel:${channel}:${message.user}`;

    // Set the agent profile for this session
    this.gateway.setSessionProfile(sessionKey, this.config.slug);

    // In team chat, gather recent messages for context
    if (isTeamChatChannel) {
      const teamContext = await this.gatherTeamChatContext(channel, message.ts, 10);
      if (teamContext) {
        text += teamContext;
      }
    }

    // Stream response
    const threadTs = message.thread_ts ?? message.ts;
    const streamer = new SlackStreamingMessage(client, channel, threadTs);
    await streamer.start();

    try {
      const response = await this.gateway.handleMessage(
        sessionKey,
        text,
        async (token: string) => {
          await streamer.update(token);
        },
        undefined, // model
        undefined, // maxTurns
        async (toolName, toolInput) => { streamer.setToolStatus(friendlyToolName(toolName, toolInput)); },
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Slack agent bot message handling error');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  }
}
