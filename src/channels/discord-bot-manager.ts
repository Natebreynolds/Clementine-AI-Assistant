/**
 * Clementine TypeScript — Discord bot manager.
 *
 * Orchestrates the lifecycle of agent bot clients. Agents with a
 * `discordToken` in their profile get their own dedicated discord.js Client.
 * Bots discover their channels on connect (by name, explicit ID, or fallback
 * to all visible).
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { Gateway } from '../gateway/router.js';
import type { CronScheduler } from '../gateway/heartbeat.js';
import { AgentBotClient, type AgentBotStatus } from './discord-agent-bot.js';
import { formatCronEmbed } from './discord-utils.js';

const logger = pino({ name: 'clementine.bot-manager' });

export interface BotManagerConfig {
  gateway: Gateway;
  ownerId: string;
  cronScheduler?: CronScheduler;
  statusFilePath?: string;
}

export interface BotStatus {
  slug: string;
  status: AgentBotStatus;
  botTag?: string;
  avatarUrl?: string;
  channelIds: string[];
  error?: string;
}

export class BotManager {
  private bots = new Map<string, AgentBotClient>();
  private gateway: Gateway;
  private ownerId: string;
  private cronScheduler?: CronScheduler;
  private statusFilePath: string;
  private pollInterval?: ReturnType<typeof setInterval>;
  private statusInterval?: ReturnType<typeof setInterval>;

  constructor(config: BotManagerConfig) {
    this.gateway = config.gateway;
    this.ownerId = config.ownerId;
    this.cronScheduler = config.cronScheduler;
    this.statusFilePath = config.statusFilePath ??
      path.join(process.env.CLEMENTINE_HOME || path.join(process.env.HOME || '', '.clementine'), '.bot-status.json');
  }

  /**
   * Scan all agents for discordToken, start bots, return owned channel IDs.
   * Channel IDs are resolved AFTER bots connect (auto-discovery).
   */
  async startAll(): Promise<string[]> {
    const mgr = this.gateway.getAgentManager();
    const allAgents = mgr.listAll();

    logger.info({ agentCount: allAgents.length }, 'Scanning agents for discordToken');

    for (const agent of allAgents) {
      logger.info({ slug: agent.slug, hasToken: Boolean(agent.discordToken) }, 'Checking agent');
      if (!agent.discordToken) continue;

      try {
        await this.startBot(agent.slug);
      } catch (err) {
        logger.error({ err, slug: agent.slug }, 'Failed to start agent bot');
      }
    }

    // Start status file writer
    this.startStatusWriter();

    // Return owned channel IDs (resolved after bot connect)
    return this.getOwnedChannelIds();
  }

  async startBot(slug: string): Promise<void> {
    // If already running, stop first
    if (this.bots.has(slug)) {
      await this.stopBot(slug);
    }

    const mgr = this.gateway.getAgentManager();
    const profile = mgr.get(slug);
    if (!profile) {
      throw new Error(`Agent '${slug}' not found`);
    }
    if (!profile.discordToken) {
      throw new Error(`Agent '${slug}' has no discordToken`);
    }

    // Build channel IDs from explicit config (auto-discovery happens on connect)
    const explicitChannelIds = profile.discordChannelId
      ? [profile.discordChannelId]
      : undefined;

    const bot = new AgentBotClient(
      {
        slug,
        token: profile.discordToken,
        ownerId: this.ownerId,
        profile,
        channelIds: explicitChannelIds,
        cronScheduler: this.cronScheduler,
        allowedUsers: profile.team?.allowedUsers,
      },
      this.gateway,
    );

    await bot.start();
    this.bots.set(slug, bot);
    logger.info({ slug }, 'Agent bot started');
  }

  async stopBot(slug: string): Promise<void> {
    const bot = this.bots.get(slug);
    if (!bot) return;
    await bot.stop();
    this.bots.delete(slug);
  }

  async stopAll(): Promise<void> {
    const slugs = [...this.bots.keys()];
    await Promise.all(slugs.map(slug => this.stopBot(slug)));
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = undefined;
    }
  }

  getStatuses(): Map<string, BotStatus> {
    const result = new Map<string, BotStatus>();
    for (const [slug, bot] of this.bots) {
      const s = bot.getStatus();
      result.set(slug, {
        slug,
        status: s.status,
        botTag: s.botTag,
        avatarUrl: s.avatarUrl,
        channelIds: bot.getChannelIds(),
        error: s.error,
      });
    }
    return result;
  }

  /**
   * Get all channel IDs managed by agent bots (main bot should NOT watch these).
   * Includes both exclusive channels and team chat channels — the main bot
   * should not respond in either type.
   */
  getOwnedChannelIds(): string[] {
    const ids: string[] = [];
    for (const bot of this.bots.values()) {
      ids.push(...bot.getChannelIds());
    }
    return ids;
  }

  /** Get channel IDs that are shared team chat channels (multiple agents listen). */
  getTeamChatChannelIds(): string[] {
    const ids: string[] = [];
    for (const bot of this.bots.values()) {
      if (bot.isTeamChat()) {
        ids.push(...bot.getChannelIds());
      }
    }
    return [...new Set(ids)]; // deduplicate
  }

  /** Get the primary channel ID for a specific agent bot (for team message delivery). */
  getChannelForAgent(slug: string): string | null {
    const bot = this.bots.get(slug);
    if (!bot) return null;
    const channels = bot.getChannelIds();
    return channels[0] ?? null;
  }

  /** Reverse lookup: which agent slug owns a given channel ID? */
  getAgentForChannel(channelId: string): string | null {
    for (const [slug, bot] of this.bots) {
      if (bot.getChannelIds().includes(channelId)) return slug;
    }
    return null;
  }

  /** Get the owner ID (used for building session keys). */
  getOwnerId(): string {
    return this.ownerId;
  }

  /** Check if an agent has a running bot. */
  hasBot(slug: string): boolean {
    return this.bots.has(slug);
  }

  /**
   * Send a notification through an agent's bot (DM to owner).
   * Uses embed formatting for cron-style messages, plain text for others.
   * Throws if the bot is unavailable — callers should fall back to main bot.
   */
  async sendAsAgent(slug: string, text: string): Promise<void> {
    const bot = this.bots.get(slug);
    if (!bot) throw new Error(`No bot for agent '${slug}'`);

    const status = bot.getStatus();
    if (status.status !== 'online') throw new Error(`Bot '${slug}' is ${status.status}`);

    const embed = formatCronEmbed(text);
    await bot.sendNotification(text, embed ?? undefined);
  }

  /**
   * Deliver a team message to an agent's bot — posts the message visibly
   * in the bot's channel and triggers the agent to process and respond.
   * Returns the agent's response text, or null if delivery failed.
   */
  async deliverTeamMessage(toSlug: string, fromName: string, fromSlug: string, content: string): Promise<string | null> {
    const bot = this.bots.get(toSlug);
    if (!bot) return null;

    try {
      return await bot.receiveTeamMessage(fromName, fromSlug, content);
    } catch (err) {
      logger.error({ err, toSlug, fromSlug }, 'Failed to deliver team message via bot');
      return null;
    }
  }

  /**
   * Poll for new/removed agents with discordToken at the given interval.
   */
  startPolling(intervalMs: number): void {
    if (this.pollInterval) clearInterval(this.pollInterval);

    this.pollInterval = setInterval(async () => {
      try {
        await this.pollForChanges();
      } catch (err) {
        logger.error({ err }, 'Bot polling error');
      }
    }, intervalMs);
  }

  private async pollForChanges(): Promise<void> {
    const mgr = this.gateway.getAgentManager();
    mgr.invalidateCache();
    const allAgents = mgr.listAll();

    // Find agents that should have bots (just need a discordToken)
    const shouldHaveBot = new Set<string>();
    for (const agent of allAgents) {
      if (agent.discordToken) {
        shouldHaveBot.add(agent.slug);
      }
    }

    // Start new bots
    for (const slug of shouldHaveBot) {
      if (!this.bots.has(slug)) {
        logger.info({ slug }, 'Detected new agent with discordToken — starting bot');
        try {
          await this.startBot(slug);
        } catch (err) {
          logger.error({ err, slug }, 'Failed to start new agent bot');
        }
      }
    }

    // Stop removed bots
    for (const slug of this.bots.keys()) {
      if (!shouldHaveBot.has(slug)) {
        logger.info({ slug }, 'Agent no longer has discordToken — stopping bot');
        await this.stopBot(slug);
      }
    }
  }

  /** Write status to disk so the dashboard can read it. */
  private startStatusWriter(): void {
    if (this.statusInterval) clearInterval(this.statusInterval);

    const writeStatus = () => {
      try {
        const statuses: Record<string, BotStatus> = {};
        for (const [slug, status] of this.getStatuses()) {
          statuses[slug] = status;
        }
        writeFileSync(this.statusFilePath, JSON.stringify(statuses, null, 2));
      } catch {
        // Non-fatal
      }
    };

    writeStatus();
    this.statusInterval = setInterval(writeStatus, 10_000);
  }
}
