/**
 * Clementine TypeScript — Slack bot manager.
 *
 * Orchestrates the lifecycle of Slack agent bot clients. Agents with both
 * `slackBotToken` AND `slackAppToken` in their profile get their own
 * dedicated @slack/bolt App.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { Gateway } from '../gateway/router.js';
import { SlackAgentBotClient, type SlackAgentBotStatus } from './slack-agent-bot.js';

const logger = pino({ name: 'clementine.slack-bot-manager' });

export interface SlackBotManagerConfig {
  gateway: Gateway;
  ownerId: string;
  statusFilePath?: string;
}

export interface SlackBotStatus {
  slug: string;
  status: SlackAgentBotStatus;
  botUserId?: string;
  channelIds: string[];
  error?: string;
}

export class SlackBotManager {
  private bots = new Map<string, SlackAgentBotClient>();
  private gateway: Gateway;
  private ownerId: string;
  private statusFilePath: string;
  private pollInterval?: ReturnType<typeof setInterval>;
  private statusInterval?: ReturnType<typeof setInterval>;

  constructor(config: SlackBotManagerConfig) {
    this.gateway = config.gateway;
    this.ownerId = config.ownerId;
    this.statusFilePath = config.statusFilePath ??
      path.join(process.env.CLEMENTINE_HOME || path.join(process.env.HOME || '', '.clementine'), '.slack-bot-status.json');
  }

  /**
   * Scan all agents for slackBotToken + slackAppToken, start bots, return owned channel IDs.
   */
  async startAll(): Promise<string[]> {
    const mgr = this.gateway.getAgentManager();
    const allAgents = mgr.listAll();

    logger.info({ agentCount: allAgents.length }, 'Scanning agents for Slack tokens');

    for (const agent of allAgents) {
      if (!agent.slackBotToken || !agent.slackAppToken) continue;

      try {
        await this.startBot(agent.slug);
      } catch (err) {
        logger.error({ err, slug: agent.slug }, 'Failed to start Slack agent bot');
      }
    }

    // Start status file writer
    this.startStatusWriter();

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
    if (!profile.slackBotToken || !profile.slackAppToken) {
      throw new Error(`Agent '${slug}' missing slackBotToken or slackAppToken`);
    }

    // Build channel IDs from explicit config
    const explicitChannelIds = profile.slackChannelId
      ? [profile.slackChannelId]
      : undefined;

    const bot = new SlackAgentBotClient(
      {
        slug,
        botToken: profile.slackBotToken,
        appToken: profile.slackAppToken,
        ownerId: this.ownerId,
        profile,
        channelIds: explicitChannelIds,
      },
      this.gateway,
    );

    await bot.start();
    this.bots.set(slug, bot);
    logger.info({ slug }, 'Slack agent bot started');
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

  getStatuses(): Map<string, SlackBotStatus> {
    const result = new Map<string, SlackBotStatus>();
    for (const [slug, bot] of this.bots) {
      const s = bot.getStatus();
      result.set(slug, {
        slug,
        status: s.status,
        botUserId: s.botUserId,
        channelIds: bot.getChannelIds(),
        error: s.error,
      });
    }
    return result;
  }

  /**
   * Get all channel IDs managed by Slack agent bots.
   * Main Slack bot should NOT watch these.
   */
  getOwnedChannelIds(): string[] {
    const ids: string[] = [];
    for (const bot of this.bots.values()) {
      ids.push(...bot.getChannelIds());
    }
    return ids;
  }

  /** Get channel IDs that are shared team chat channels. */
  getTeamChatChannelIds(): string[] {
    const ids: string[] = [];
    for (const bot of this.bots.values()) {
      if (bot.isTeamChat()) {
        ids.push(...bot.getChannelIds());
      }
    }
    return [...new Set(ids)];
  }

  /** Get the primary channel ID for a specific agent bot. */
  getChannelForAgent(slug: string): string | null {
    const bot = this.bots.get(slug);
    if (!bot) return null;
    const channels = bot.getChannelIds();
    return channels[0] ?? null;
  }

  /** Reverse lookup: which agent slug owns a given Slack channel ID? */
  getAgentForChannel(channelId: string): string | null {
    for (const [slug, bot] of this.bots) {
      if (bot.getChannelIds().includes(channelId)) return slug;
    }
    return null;
  }

  /** Get the owner ID. */
  getOwnerId(): string {
    return this.ownerId;
  }

  /** Check if an agent has a running Slack bot. */
  hasBot(slug: string): boolean {
    return this.bots.has(slug);
  }

  /**
   * Deliver a team message to an agent's Slack bot.
   * Returns the agent's response text, or null if delivery failed.
   */
  async deliverTeamMessage(toSlug: string, fromName: string, fromSlug: string, content: string): Promise<string | null> {
    const bot = this.bots.get(toSlug);
    if (!bot) return null;

    try {
      return await bot.receiveTeamMessage(fromName, fromSlug, content);
    } catch (err) {
      logger.error({ err, toSlug, fromSlug }, 'Failed to deliver Slack team message via bot');
      return null;
    }
  }

  /**
   * Poll for new/removed agents with Slack tokens at the given interval.
   */
  startPolling(intervalMs: number): void {
    if (this.pollInterval) clearInterval(this.pollInterval);

    this.pollInterval = setInterval(async () => {
      try {
        await this.pollForChanges();
      } catch (err) {
        logger.error({ err }, 'Slack bot polling error');
      }
    }, intervalMs);
  }

  private async pollForChanges(): Promise<void> {
    const mgr = this.gateway.getAgentManager();
    mgr.invalidateCache();
    const allAgents = mgr.listAll();

    // Find agents that should have Slack bots (need both tokens)
    const shouldHaveBot = new Set<string>();
    for (const agent of allAgents) {
      if (agent.slackBotToken && agent.slackAppToken) {
        shouldHaveBot.add(agent.slug);
      }
    }

    // Start new bots
    for (const slug of shouldHaveBot) {
      if (!this.bots.has(slug)) {
        logger.info({ slug }, 'Detected new agent with Slack tokens — starting bot');
        try {
          await this.startBot(slug);
        } catch (err) {
          logger.error({ err, slug }, 'Failed to start new Slack agent bot');
        }
      }
    }

    // Stop removed bots
    for (const slug of this.bots.keys()) {
      if (!shouldHaveBot.has(slug)) {
        logger.info({ slug }, 'Agent no longer has Slack tokens — stopping bot');
        await this.stopBot(slug);
      }
    }
  }

  /** Write status to disk so the dashboard can read it. */
  private startStatusWriter(): void {
    if (this.statusInterval) clearInterval(this.statusInterval);

    const writeStatus = () => {
      try {
        const statuses: Record<string, SlackBotStatus> = {};
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
