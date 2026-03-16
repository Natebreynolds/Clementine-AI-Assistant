/**
 * Clementine TypeScript — Discord agent bot client.
 *
 * A lightweight discord.js Client wrapper for a single agent.
 * Handles: DMs + guild channel messages → gateway → stream response.
 * No slash commands, no approval flows, no cron notifications.
 *
 * Channel discovery (in priority order):
 *   1. Explicit `discordChannelId` from agent config
 *   2. Auto-discover by matching `channelName` in the guild
 *   3. Falls back to listening in ALL text channels the bot can see
 *
 * DMs are always enabled for the owner.
 */

import {
  ActivityType,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';
import pino from 'pino';
import type { AgentProfile } from '../types.js';
import type { Gateway } from '../gateway/router.js';
import { DiscordStreamingMessage, sanitizeResponse } from './discord-utils.js';

const logger = pino({ name: 'clementine.agent-bot' });

export interface AgentBotConfig {
  slug: string;
  token: string;
  ownerId: string;
  profile: AgentProfile;
  /** Explicit channel IDs to listen in. If empty, auto-discovered on connect. */
  channelIds?: string[];
}

export type AgentBotStatus = 'offline' | 'connecting' | 'online' | 'error';

export class AgentBotClient {
  private client: Client;
  private config: AgentBotConfig;
  private gateway: Gateway;
  private status: AgentBotStatus = 'offline';
  private errorMessage?: string;
  /** Resolved channel IDs (set on ready, after auto-discovery). */
  private resolvedChannelIds: string[] = [];

  constructor(config: AgentBotConfig, gateway: Gateway) {
    this.config = config;
    this.gateway = gateway;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // Required for DM events
    });
  }

  async start(): Promise<void> {
    this.status = 'connecting';

    this.client.once(Events.ClientReady, async (readyClient) => {
      this.status = 'online';
      this.errorMessage = undefined;

      // Resolve channels
      this.resolvedChannelIds = this.discoverChannels();

      logger.info(
        { slug: this.config.slug, botTag: readyClient.user.tag, channels: this.resolvedChannelIds },
        `Agent bot online: ${this.config.profile.name}`,
      );

      // Set presence to show the agent's role
      readyClient.user.setPresence({
        status: 'online',
        activities: [{
          name: this.config.profile.description.slice(0, 128),
          type: ActivityType.Custom,
        }],
      });

      // Send startup status to owner's DMs
      await this.sendStartupStatus();
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      await this.handleMessage(message);
    });

    this.client.on(Events.Error, (err) => {
      this.status = 'error';
      this.errorMessage = String(err);
      logger.error({ err, slug: this.config.slug }, 'Agent bot error');
    });

    try {
      await this.client.login(this.config.token);
    } catch (err) {
      this.status = 'error';
      this.errorMessage = String(err);
      logger.error({ err, slug: this.config.slug }, 'Agent bot login failed');
      throw err;
    }
  }

  async stop(): Promise<void> {
    try {
      this.client.destroy();
    } catch {
      // ignore
    }
    this.status = 'offline';
    logger.info({ slug: this.config.slug }, 'Agent bot stopped');
  }

  getStatus(): { status: AgentBotStatus; botTag?: string; avatarUrl?: string; error?: string } {
    return {
      status: this.status,
      botTag: this.client.user?.tag,
      avatarUrl: this.client.user?.displayAvatarURL({ size: 128, extension: 'png' }),
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
   * 1. Explicit channelIds from config (e.g. discordChannelId in agent.md)
   * 2. Match by channelName in any guild the bot is in
   * 3. All text channels the bot can see (fallback for simple setups)
   */
  private discoverChannels(): string[] {
    // 1. Explicit IDs
    if (this.config.channelIds && this.config.channelIds.length > 0) {
      logger.info(
        { slug: this.config.slug, channelIds: this.config.channelIds },
        'Using explicit channel IDs',
      );
      return this.config.channelIds;
    }

    // 2. Match by channelName
    const channelName = this.config.profile.team?.channelName;
    if (channelName) {
      const matched: string[] = [];
      for (const guild of this.client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (channel.type === ChannelType.GuildText && channel.name === channelName) {
            matched.push(channel.id);
          }
        }
      }
      if (matched.length > 0) {
        logger.info(
          { slug: this.config.slug, channelName, matched },
          'Auto-discovered channels by name',
        );
        return matched;
      }
      logger.warn(
        { slug: this.config.slug, channelName },
        'No channels found matching channelName — falling back to all visible text channels',
      );
    }

    // 3. Fallback: all text channels the bot can see
    const all: string[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildText) {
          all.push(channel.id);
        }
      }
    }
    logger.info(
      { slug: this.config.slug, count: all.length },
      'Fallback: listening in all visible text channels',
    );
    return all;
  }

  /** Send a startup status embed to the owner's DMs. */
  private async sendStartupStatus(): Promise<void> {
    if (!this.config.ownerId) return;

    try {
      const owner = await this.client.users.fetch(this.config.ownerId, { force: true });
      const dmChannel = await owner.createDM();

      const channelList = this.resolvedChannelIds.length > 0
        ? this.resolvedChannelIds.map(id => `<#${id}>`).join(', ')
        : 'none (DMs only)';

      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle(`${this.config.profile.name} is online`)
        .setDescription(this.config.profile.description)
        .addFields(
          { name: 'Channels', value: channelList, inline: true },
          { name: 'Model', value: this.config.profile.model || 'sonnet', inline: true },
          { name: 'Tier', value: String(this.config.profile.tier), inline: true },
        )
        .setFooter({ text: `Agent bot \u00b7 ${this.client.user?.tag ?? 'unknown'}` })
        .setTimestamp();

      if (this.config.profile.avatar) {
        embed.setThumbnail(this.config.profile.avatar);
      }

      await dmChannel.send({ embeds: [embed] });
      logger.info({ slug: this.config.slug }, 'Sent startup status embed to owner DMs');
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Failed to send startup status embed');
    }
  }

  /**
   * Receive an inter-agent team message. Posts an embed showing the incoming
   * message, then triggers the agent to process and respond in-channel.
   */
  async receiveTeamMessage(fromName: string, fromSlug: string, content: string): Promise<string> {
    if (this.resolvedChannelIds.length === 0) {
      logger.warn({ slug: this.config.slug }, 'No channels to deliver team message to');
      return '(no channels available)';
    }

    const channelId = this.resolvedChannelIds[0];
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.warn({ slug: this.config.slug, channelId }, 'Channel not found for team message delivery');
      return '(channel not found)';
    }

    // Post the incoming message as an embed so it's visible in the channel
    const embed = new EmbedBuilder()
      .setColor(0x5865F2) // Discord blurple
      .setAuthor({ name: `${fromName} via team message` })
      .setDescription(content.length > 4096 ? content.slice(0, 4093) + '...' : content)
      .setTimestamp();

    await channel.send({ embeds: [embed] });

    // Now trigger the agent to process the message and respond
    const sessionKey = `discord:channel:${channelId}:${this.config.ownerId}`;
    this.gateway.setSessionProfile(sessionKey, this.config.slug);

    const streamer = new DiscordStreamingMessage(channel);
    await streamer.start();

    try {
      const wrappedContent = `[Team message from ${fromName} (${fromSlug})]: ${content}`;
      const response = await this.gateway.handleMessage(
        sessionKey,
        wrappedContent,
        async (token: string) => {
          await streamer.update(token);
        },
      );
      await streamer.finalize(response);
      logger.info({ slug: this.config.slug, from: fromSlug }, 'Processed team message');
      return response;
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Failed to process team message');
      const errMsg = `Something went wrong processing a team message: ${sanitizeResponse(String(err))}`;
      await streamer.finalize(errMsg);
      return errMsg;
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;
    // Ignore bots
    if (message.author.bot) return;

    const isDm = message.channel.isDMBased();
    const isWatchedChannel = !isDm && this.resolvedChannelIds.includes(message.channelId);

    // Respond in DMs or watched channels
    if (!isDm && !isWatchedChannel) return;

    // Owner-only check
    if (this.config.ownerId && message.author.id !== this.config.ownerId) {
      logger.warn(
        { slug: this.config.slug, author: message.author.tag },
        'Ignored message from non-owner',
      );
      return;
    }

    // Extract attachments
    let text = message.content;
    if (message.attachments.size > 0) {
      const attachmentLines = message.attachments.map(att => {
        if (att.contentType?.startsWith('image/')) {
          return `[Image attached: ${att.name} (${att.url})]`;
        }
        return `[File attached: ${att.name}, ${att.contentType || 'unknown type'}, ${att.url}]`;
      });
      text = attachmentLines.join('\n') + (text ? '\n' + text : '');
    }

    if (!text) return;

    // !clear command
    if (text === '!clear') {
      const sessionKey = isDm
        ? `discord:agent:${this.config.slug}:${message.author.id}`
        : `discord:channel:${message.channelId}:${message.author.id}`;
      this.gateway.clearSession(sessionKey);
      await message.reply('Session cleared.');
      return;
    }

    const sessionKey = isDm
      ? `discord:agent:${this.config.slug}:${message.author.id}`
      : `discord:channel:${message.channelId}:${message.author.id}`;

    // Set the agent profile for this session
    this.gateway.setSessionProfile(sessionKey, this.config.slug);

    // Show queued indicator if session is busy
    if (this.gateway.isSessionBusy(sessionKey)) {
      await message.react('\u23f3'); // hourglass
    }

    // Stream response as the bot's own identity
    const streamer = new DiscordStreamingMessage(message.channel);
    await streamer.start();

    try {
      const response = await this.gateway.handleMessage(
        sessionKey,
        text,
        async (token: string) => {
          await streamer.update(token);
        },
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Agent bot message handling error');
      await streamer.finalize(`Something went wrong: ${sanitizeResponse(String(err))}`);
    }
  }
}
