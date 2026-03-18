/**
 * Clementine TypeScript — Discord agent bot client.
 *
 * A discord.js Client wrapper for a single agent.
 * Handles: DMs + guild channel messages → gateway → stream response.
 * Slash commands: /plan, /deep, /quick, /opus, /model, /clear, /help.
 *
 * Channel discovery (in priority order):
 *   1. Explicit `discordChannelId` from agent config
 *   2. Auto-discover by matching `channelName` in the guild
 *   3. Falls back to listening in ALL text channels the bot can see
 *
 * DMs are always enabled for the owner.
 */

import {
  ActionRowBuilder,
  ActivityType,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from 'discord.js';
import pino from 'pino';
import type { AgentProfile } from '../types.js';
import type { Gateway } from '../gateway/router.js';
import { chunkText, DiscordStreamingMessage, friendlyToolName, sanitizeResponse } from './discord-utils.js';
import { MODELS } from '../config.js';

const logger = pino({ name: 'clementine.agent-bot' });

// ── Slash commands shared by all agent bots ──────────────────────────

const agentSlashCommands = [
  new SlashCommandBuilder().setName('plan').setDescription('Break a task into parallel steps')
    .addStringOption(o => o.setName('task').setDescription('What to plan').setRequired(true)),
  new SlashCommandBuilder().setName('deep').setDescription('Extended mode (100 turns) for heavy tasks')
    .addStringOption(o => o.setName('message').setDescription('Your message').setRequired(true)),
  new SlashCommandBuilder().setName('quick').setDescription('Quick reply using Haiku model')
    .addStringOption(o => o.setName('message').setDescription('Your message').setRequired(true)),
  new SlashCommandBuilder().setName('opus').setDescription('Deep reply using Opus model')
    .addStringOption(o => o.setName('message').setDescription('Your message').setRequired(true)),
  new SlashCommandBuilder().setName('model').setDescription('Switch default model')
    .addStringOption(o => o.setName('tier').setDescription('Model tier').setRequired(true)
      .addChoices(
        { name: 'Haiku', value: 'haiku' },
        { name: 'Sonnet', value: 'sonnet' },
        { name: 'Opus', value: 'opus' },
      )),
  new SlashCommandBuilder().setName('clear').setDescription('Reset conversation session'),
  new SlashCommandBuilder().setName('help').setDescription('Show all available commands'),
];

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

      // Register slash commands for this bot
      try {
        const rest = new REST().setToken(this.config.token);
        await rest.put(Routes.applicationCommands(readyClient.user.id), {
          body: agentSlashCommands.map(c => c.toJSON()),
        });
        logger.info(
          { slug: this.config.slug, count: agentSlashCommands.length },
          `Registered ${agentSlashCommands.length} slash commands`,
        );
      } catch (err) {
        logger.error({ err, slug: this.config.slug }, 'Failed to register slash commands');
      }

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

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (err) {
        logger.error({ err, slug: this.config.slug }, 'Unhandled error in agent bot interaction handler');
      }
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      try {
        await this.handleMessage(message);
      } catch (err) {
        logger.error({ err, slug: this.config.slug }, 'Unhandled error in agent bot message handler');
      }
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

    // 2. Match by channelName (supports single string or array of names)
    const channelNameConfig = this.config.profile.team?.channelName;
    if (channelNameConfig) {
      const channelNames = Array.isArray(channelNameConfig) ? channelNameConfig : [channelNameConfig];
      const matched: string[] = [];
      for (const guild of this.client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (channel.type === ChannelType.GuildText && channelNames.includes(channel.name)) {
            matched.push(channel.id);
          }
        }
      }
      if (matched.length > 0) {
        logger.info(
          { slug: this.config.slug, channelNames, matched },
          'Auto-discovered channels by name',
        );
        return matched;
      }
      logger.warn(
        { slug: this.config.slug, channelNames },
        'No channels found matching channelName(s) — falling back to all visible text channels',
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
  /** Track recent team message content hashes to prevent duplicate embeds. */
  private recentTeamMessageHashes = new Map<string, number>();

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

    // Dedup: reject identical messages within 5 minutes (prevents embed spam)
    const { createHash } = await import('node:crypto');
    const contentHash = createHash('sha256').update(`${fromSlug}:${content.trim()}`).digest('hex').slice(0, 12);
    const now = Date.now();
    const lastSeen = this.recentTeamMessageHashes.get(contentHash) ?? 0;
    if (now - lastSeen < 300_000) {
      logger.info({ slug: this.config.slug, from: fromSlug }, 'Duplicate team message suppressed (already posted)');
      return '(duplicate message suppressed — already delivered recently)';
    }
    this.recentTeamMessageHashes.set(contentHash, now);
    // Prune old entries
    if (this.recentTeamMessageHashes.size > 50) {
      for (const [key, ts] of this.recentTeamMessageHashes) {
        if (now - ts > 300_000) this.recentTeamMessageHashes.delete(key);
      }
    }

    // Post the incoming message as an embed so it's visible in the channel
    const embed = new EmbedBuilder()
      .setColor(0x5865F2) // Discord blurple
      .setAuthor({ name: `${fromName} via team message` })
      .setDescription(content.length > 4096 ? content.slice(0, 4093) + '...' : content)
      .setTimestamp();

    await channel.send({ embeds: [embed] });

    // Run the task through the unleashed pipeline — gives the agent full
    // multi-phase autonomous execution instead of the 5-minute chat timeout.
    const streamer = new DiscordStreamingMessage(channel);
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
      logger.info({ slug: this.config.slug, from: fromSlug }, 'Processed team message');
      return response;
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Failed to process team message');
      const errMsg = `Something went wrong processing a team message: ${sanitizeResponse(String(err))}`;
      await streamer.finalize(errMsg);
      return errMsg;
    }
  }

  // ── Slash command + button interaction handler ──────────────────────

  private async handleInteraction(interaction: Interaction): Promise<void> {
    // ── Slash commands ──────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const cmd = interaction as ChatInputCommandInteraction;

      // Owner-only guard
      if (this.config.ownerId && cmd.user.id !== this.config.ownerId) {
        await cmd.reply({ content: 'Owner only.', ephemeral: true });
        return;
      }

      const sessionKey = cmd.channel?.isDMBased()
        ? `discord:agent:${this.config.slug}:${cmd.user.id}`
        : `discord:channel:${cmd.channelId}:${cmd.user.id}`;

      // Set agent profile for this session
      this.gateway.setSessionProfile(sessionKey, this.config.slug);

      const name = cmd.commandName;

      // /help
      if (name === 'help') {
        const agentName = this.config.profile.name;
        await cmd.reply([
          `**${agentName} Commands**`,
          '`/plan <task>` — Break a task into parallel steps',
          '`/deep <msg>` — Extended mode (100 turns)',
          '`/quick <msg>` — Quick reply (Haiku) · `/opus <msg>` — Deep reply (Opus)',
          '`/model [haiku|sonnet|opus]` — Switch default model',
          '`/clear` — Reset conversation · `/help` — This message',
        ].join('\n'));
        return;
      }

      // /clear
      if (name === 'clear') {
        this.gateway.clearSession(sessionKey);
        await cmd.reply('Session cleared.');
        return;
      }

      // /model
      if (name === 'model') {
        const tier = cmd.options.getString('tier', true);
        const t = tier.toLowerCase() as keyof typeof MODELS;
        if (t in MODELS) {
          this.gateway.setSessionModel(sessionKey, MODELS[t]);
          await cmd.reply(`Model switched to **${t}** (\`${MODELS[t]}\`).`);
        } else {
          const current = this.gateway.getSessionModel(sessionKey) ?? 'default';
          await cmd.reply(`Current model: \`${current}\`\nOptions: /model haiku, /model sonnet, /model opus`);
        }
        return;
      }

      // /plan — with approval buttons
      if (name === 'plan') {
        const task = cmd.options.getString('task', true);
        await cmd.deferReply();
        await cmd.editReply(`Planning: _${task.slice(0, 100)}_...`);

        if (!cmd.channel) {
          await cmd.editReply('Could not access channel for plan.');
          return;
        }

        const streamer = new DiscordStreamingMessage(cmd.channel);
        await streamer.start();
        await streamer.update('Planning...');

        try {
          const result = await this.gateway.handlePlan(
            sessionKey,
            task,
            async (updates) => {
              const lines = [
                `**Plan:** ${task.slice(0, 100)}`,
                '',
                ...updates.map((u, i) => {
                  const num = `[${i + 1}/${updates.length}]`;
                  const desc = u.description.slice(0, 60);
                  switch (u.status) {
                    case 'done': return `${num} ${desc} \u2713 (${Math.round((u.durationMs ?? 0) / 1000)}s)`;
                    case 'running': return `${num} ${desc} \u23f3 running...`;
                    case 'failed': return `${num} ${desc} \u2717 failed`;
                    default: return `${num} ${desc} \u25cb waiting`;
                  }
                }),
              ];
              await streamer.update(lines.join('\n').slice(0, 1800));
            },
            async (planSummary, steps) => {
              const planPreview = `**Plan:** ${task.slice(0, 100)}\n\n` +
                steps.map((s, i) => `${i + 1}. **${s.id}** — ${s.description.slice(0, 60)}`).join('\n');
              if ('send' in cmd.channel!) {
                await cmd.channel!.send(planPreview.slice(0, 2000));
              }

              // Send approval buttons
              const requestId = `plan-${Date.now()}`;
              const buttons = [
                { type: 2, style: 3, label: 'Approve', custom_id: `plan_${requestId}_approve` },
                { type: 2, style: 1, label: 'Revise', custom_id: `plan_${requestId}_revise` },
                { type: 2, style: 4, label: 'Cancel', custom_id: `plan_${requestId}_deny` },
              ];
              if ('send' in cmd.channel!) {
                await cmd.channel!.send({
                  content: 'Approve this plan?',
                  components: [{ type: 1, components: buttons }] as any,
                });
              }

              const approvalResult = await this.gateway.requestApproval('Pending approval', requestId);
              if (typeof approvalResult === 'string') {
                if ('send' in cmd.channel!) {
                  await cmd.channel!.send('\u2728 *Revising plan...*');
                }
                return approvalResult;
              }
              if (approvalResult) {
                const newStreamer = new DiscordStreamingMessage(cmd.channel!);
                await newStreamer.start();
                await newStreamer.update('Executing plan...');
                Object.assign(streamer, {
                  message: (newStreamer as any).message,
                  lastEdit: (newStreamer as any).lastEdit,
                  pendingText: '',
                  lastFlushedText: '',
                  isFinal: false,
                });
              }
              return approvalResult;
            },
          );

          await streamer.finalize(result);
        } catch (err) {
          logger.error({ err, slug: this.config.slug }, '/plan command failed');
          await streamer.finalize(`Plan failed: ${err}`);
        }
        return;
      }

      // /deep, /quick, /opus — chat with model override
      if (name === 'deep' || name === 'quick' || name === 'opus') {
        const msg = cmd.options.getString('message', true);
        const oneOffModel = name === 'quick' ? MODELS.haiku : name === 'opus' ? MODELS.opus : undefined;
        const oneOffMaxTurns = name === 'deep' ? 100 : undefined;

        await cmd.deferReply();

        try {
          const response = await this.gateway.handleMessage(
            sessionKey,
            msg,
            async () => {},
            oneOffModel,
            oneOffMaxTurns,
          );
          const chunks = chunkText(response || '*(no response)*', 1900);
          await cmd.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await cmd.followUp(chunks[i]);
          }
        } catch (err) {
          logger.error({ err, slug: this.config.slug }, `/${name} command failed`);
          await cmd.editReply(`Something went wrong: ${err}`);
        }
        return;
      }

      return;
    }

    // ── Button interactions (plan approve/deny/revise) ──────────
    if (interaction.isButton()) {
      const button = interaction;
      const customId = button.customId;

      // Owner-only guard
      if (this.config.ownerId && button.user.id !== this.config.ownerId) {
        await button.reply({ content: 'Owner only.', ephemeral: true });
        return;
      }

      // Plan approval buttons: plan_{requestId}_{action}
      const planMatch = customId.match(/^plan_(.+)_(approve|deny|revise)$/);
      if (planMatch) {
        const [, requestId, action] = planMatch;

        if (action === 'approve') {
          await button.deferUpdate();
          this.gateway.resolveApproval(requestId, true);
        } else if (action === 'deny') {
          await button.deferUpdate();
          this.gateway.resolveApproval(requestId, false);
        } else if (action === 'revise') {
          // Show modal for revision feedback
          const modal = new ModalBuilder()
            .setCustomId(`revise_modal_${requestId}`)
            .setTitle('Revise Plan');
          const input = new TextInputBuilder()
            .setCustomId('revision_feedback')
            .setLabel('What should be changed?')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
          await button.showModal(modal);
        }

        // Disable buttons after click
        try {
          if (button.message) {
            const rawComponents = (button.message.components as any[]).map((row: any) => ({
              type: 1,
              components: (row.components ?? []).map((comp: any) => ({
                type: comp.type ?? 2,
                style: comp.style,
                label: comp.label,
                custom_id: comp.customId ?? comp.custom_id,
                disabled: true,
              })),
            }));
            await button.editReply({
              content: button.message.content + `\n\n${action === 'approve' ? '\u2705 Approved' : action === 'deny' ? '\u274c Cancelled' : '\u270f\ufe0f Revising'}`,
              components: rawComponents as any,
            });
          }
        } catch { /* non-fatal */ }
        return;
      }
    }

    // ── Modal submissions (revision feedback) ────────────────────
    if (interaction.isModalSubmit()) {
      const modal = interaction;
      if (modal.customId.startsWith('revise_modal_')) {
        const requestId = modal.customId.replace('revise_modal_', '');
        const feedback = modal.fields.getTextInputValue('revision_feedback');
        await modal.deferUpdate();
        this.gateway.resolveApproval(requestId, feedback);
      }
    }
  }

  /** Check if this bot participates in a shared team chat channel. */
  isTeamChat(): boolean {
    return this.config.profile.team?.teamChat === true;
  }

  /**
   * Check if this agent is being addressed in a team chat message.
   * Matches: @mention, agent name, agent slug, or broadcast keywords.
   */
  private isAddressedInTeamChat(message: Message): boolean {
    // Direct @mention of this bot
    if (this.client.user && message.mentions.users.has(this.client.user.id)) {
      return true;
    }

    // @everyone and @here Discord mentions address all agents
    if (message.mentions.everyone) {
      return true;
    }

    const content = message.content.toLowerCase();

    // Broadcast keywords — address all agents at once
    const broadcastPatterns = [
      /\b@?team\b/,
      /\beveryone\b/,
      /\ball\s+agents?\b/,
      /\bthe\s+team\b/,
    ];
    if (broadcastPatterns.some(p => p.test(content))) {
      return true;
    }

    // Individual agent name or slug at word boundaries
    const name = this.config.profile.name.toLowerCase();
    const slug = this.config.slug.toLowerCase();
    const namePattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const slugPattern = new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

    return namePattern.test(content) || slugPattern.test(content);
  }

  /**
   * Collect recent messages from other bots in the same channel for context.
   * Returns a formatted string of the last N messages from other agents.
   */
  private async gatherTeamChatContext(message: Message, limit = 10): Promise<string> {
    try {
      const channel = message.channel;
      if (channel.isDMBased()) return '';

      const recent = await channel.messages.fetch({ limit: limit + 1, before: message.id });
      const contextLines: string[] = [];

      for (const msg of recent.sort((a, b) => a.createdTimestamp - b.createdTimestamp).values()) {
        const authorName = msg.author.bot ? msg.author.username : 'Owner';
        const preview = msg.content.slice(0, 300);
        if (preview) {
          contextLines.push(`[${authorName}]: ${preview}`);
        }
      }

      if (contextLines.length === 0) return '';
      return `\n\n[Recent team chat context]\n${contextLines.join('\n')}\n[End context]`;
    } catch {
      return ''; // Non-fatal — proceed without context
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;

    const isDm = message.channel.isDMBased();
    const isWatchedChannel = !isDm && this.resolvedChannelIds.includes(message.channelId);

    // Respond in DMs or watched channels
    if (!isDm && !isWatchedChannel) return;

    const isTeamChatChannel = isWatchedChannel && this.isTeamChat();

    // In team chat: ignore all bot messages (prevents loops).
    // In solo channels: ignore all bot messages (original behavior).
    if (message.author.bot) return;

    // Owner-only check
    if (this.config.ownerId && message.author.id !== this.config.ownerId) {
      logger.warn(
        { slug: this.config.slug, author: message.author.tag },
        'Ignored message from non-owner',
      );
      return;
    }

    // In team chat: respond to all if respondToAll is set, otherwise only when addressed
    const respondToAll = this.config.profile.team?.respondToAll === true;
    if (isTeamChatChannel && !respondToAll && !this.isAddressedInTeamChat(message)) {
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

    // In team chat, use agent-scoped session key so each agent has its own
    // conversation memory in the shared channel
    const sessionKey = isDm
      ? `discord:agent:${this.config.slug}:${message.author.id}`
      : isTeamChatChannel
        ? `discord:channel:${message.channelId}:${this.config.slug}:${message.author.id}`
        : `discord:channel:${message.channelId}:${message.author.id}`;

    // Set the agent profile for this session
    this.gateway.setSessionProfile(sessionKey, this.config.slug);

    // Show queued indicator if session is busy
    if (this.gateway.isSessionBusy(sessionKey)) {
      await message.react('\u23f3'); // hourglass
    }

    // In team chat, gather recent messages from other agents as context
    if (isTeamChatChannel) {
      const teamContext = await this.gatherTeamChatContext(message);
      if (teamContext) {
        text += teamContext;
      }
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
        undefined, // model
        undefined, // maxTurns
        async (toolName: string, toolInput: Record<string, unknown>) => {
          streamer.setToolStatus(friendlyToolName(toolName, toolInput));
        },
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err, slug: this.config.slug }, 'Agent bot message handling error');
      await streamer.finalize(`Something went wrong: ${sanitizeResponse(String(err))}`);
    }
  }
}
