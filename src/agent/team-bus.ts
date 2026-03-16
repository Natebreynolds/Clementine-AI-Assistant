/**
 * Clementine TypeScript — Inter-agent message bus.
 *
 * Enables async message passing between team agents via gateway.injectContext.
 * Logs to JSONL and optionally mirrors to a Discord channel.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { AgentProfile, TeamMessage } from '../types.js';
import type { Gateway } from '../gateway/router.js';
import type { TeamRouter } from './team-router.js';

const logger = pino({ name: 'clementine.team-bus' });

/** Max inter-agent message depth before rejection (anti-loop). */
const MAX_DEPTH = 3;
/** Minimum interval between same sender->recipient pair (ms). */
const COOLDOWN_MS = 30_000;
/** Max recent messages to keep in memory. */
const RECENT_BUFFER_SIZE = 500;

export class TeamBus {
  private gateway: Gateway;
  private teamRouter: TeamRouter;
  private commsChannelId?: string;
  private logFile: string;
  private recentMessages: TeamMessage[] = [];
  /** "from:to" → last send timestamp (for cooldown). */
  private cooldowns = new Map<string, number>();
  private statusChangeListeners: Array<() => void> = [];
  private botManager?: import('../channels/discord-bot-manager.js').BotManager;

  constructor(
    gateway: Gateway,
    teamRouter: TeamRouter,
    options: { commsChannelId?: string; logFile: string; botManager?: import('../channels/discord-bot-manager.js').BotManager },
  ) {
    this.gateway = gateway;
    this.teamRouter = teamRouter;
    this.commsChannelId = options.commsChannelId || undefined;
    this.logFile = options.logFile;
    this.botManager = options.botManager;

    // Ensure log directory exists
    const dir = path.dirname(this.logFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Update the BotManager reference (called if set after construction). */
  setBotManager(botManager: import('../channels/discord-bot-manager.js').BotManager): void {
    this.botManager = botManager;
  }

  /**
   * Resolve a session key for the target agent.
   * Priority: 1) team-bindings channel, 2) BotManager auto-discovered channel.
   */
  private resolveSessionKey(toSlug: string): string | null {
    // 1. Try team-bindings (legacy provisioning)
    const teamChannel = this.teamRouter.getPrimaryChannelForAgent(toSlug);
    if (teamChannel) {
      const parts = teamChannel.split(':');
      return `${parts[0]}:channel:${parts[1]}:system`;
    }

    // 2. Try BotManager (agent has its own Discord bot with auto-discovered channels)
    if (this.botManager) {
      const channelId = this.botManager.getChannelForAgent(toSlug);
      if (channelId) {
        const ownerId = this.botManager.getOwnerId();
        return `discord:channel:${channelId}:${ownerId}`;
      }
    }

    return null;
  }

  /** Agent A sends a direct message to Agent B. */
  async send(
    fromSlug: string,
    toSlug: string,
    content: string,
    depth = 0,
  ): Promise<TeamMessage> {
    // Validate sender — team agents need canMessage permission, primary agent can message anyone
    const fromProfile = this.teamRouter.listTeamAgents().find((a) => a.slug === fromSlug);

    if (fromProfile) {
      // Team agent: enforce canMessage permission
      if (!fromProfile.team?.canMessage.includes(toSlug)) {
        throw new Error(
          `Agent '${fromSlug}' is not authorized to message '${toSlug}'. ` +
          `Allowed targets: ${fromProfile.team?.canMessage.join(', ') || 'none'}`,
        );
      }
    }
    // If fromProfile is null, sender is the primary agent (no agent.md) — allowed to message anyone

    // Validate recipient exists
    const toProfile = this.teamRouter.listTeamAgents().find((a) => a.slug === toSlug);
    if (!toProfile) {
      throw new Error(`Target agent '${toSlug}' is not a team agent`);
    }

    // Anti-loop: depth check
    if (depth >= MAX_DEPTH) {
      throw new Error(
        `Message depth limit reached (${MAX_DEPTH}). ` +
        `Agents cannot chain more than ${MAX_DEPTH} messages deep.`,
      );
    }

    // Anti-loop: cooldown check
    const cooldownKey = `${fromSlug}:${toSlug}`;
    const lastSend = this.cooldowns.get(cooldownKey) ?? 0;
    const now = Date.now();
    if (now - lastSend < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - (now - lastSend)) / 1000);
      throw new Error(
        `Cooldown active: ${fromSlug} -> ${toSlug}. Wait ${waitSec}s before sending again.`,
      );
    }
    this.cooldowns.set(cooldownKey, now);

    // Create the message record
    const message: TeamMessage = {
      id: randomBytes(4).toString('hex'),
      fromAgent: fromSlug,
      toAgent: toSlug,
      content,
      timestamp: new Date().toISOString(),
      delivered: false,
      depth,
    };

    // Resolve target agent's session key — try team-bindings first, then BotManager
    const sessionKey = this.resolveSessionKey(toSlug);
    if (sessionKey) {
      this.gateway.setSessionProfile(sessionKey, toSlug);
      this.gateway.injectContext(
        sessionKey,
        `[Team message from ${fromProfile?.name ?? fromSlug} (${fromSlug}), depth=${depth}]`,
        content,
      );
      message.delivered = true;
    } else {
      logger.warn({ toSlug }, 'No channel found for target agent — message queued for later delivery');
    }

    // Persist to JSONL log
    try {
      appendFileSync(this.logFile, JSON.stringify(message) + '\n');
    } catch (err) {
      logger.warn({ err }, 'Failed to write team comms log');
    }

    // Buffer in memory
    this.recentMessages.push(message);
    if (this.recentMessages.length > RECENT_BUFFER_SIZE) {
      this.recentMessages = this.recentMessages.slice(-RECENT_BUFFER_SIZE);
    }

    // Mirror to Discord comms channel if configured
    if (this.commsChannelId && toProfile) {
      const senderProfile: AgentProfile = fromProfile ?? {
        slug: fromSlug,
        name: fromSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        tier: 3,
        description: 'Primary agent',
        systemPromptBody: '',
      };
      this.mirrorToDiscord(message, senderProfile, toProfile).catch((err) => {
        logger.warn({ err }, 'Failed to mirror team message to Discord');
      });
    }

    logger.info(
      { from: fromSlug, to: toSlug, id: message.id, depth, delivered: message.delivered },
      'Team message sent',
    );

    // Emit status change (updates live status embed)
    for (const cb of this.statusChangeListeners) {
      try { cb(); } catch { /* ignore */ }
    }

    return message;
  }

  /** Register a listener that fires when team state changes. */
  onStatusChange(cb: () => void): void {
    this.statusChangeListeners.push(cb);
  }

  /** Get recent inter-agent messages (for dashboard). */
  getRecentMessages(limit = 50): TeamMessage[] {
    return this.recentMessages.slice(-limit).reverse();
  }

  /** Get messages for a specific agent (sent or received). */
  getMessagesForAgent(slug: string, limit = 50): TeamMessage[] {
    return this.recentMessages
      .filter((m) => m.fromAgent === slug || m.toAgent === slug)
      .slice(-limit)
      .reverse();
  }

  /** Load messages from the JSONL log file (cold start). */
  loadFromLog(limit = 500): void {
    if (!existsSync(this.logFile)) return;

    try {
      const lines = readFileSync(this.logFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      this.recentMessages = lines
        .slice(-limit)
        .map((l) => JSON.parse(l) as TeamMessage);
    } catch {
      // Non-fatal — start with empty buffer
    }
  }

  /**
   * Deliver any undelivered messages from the JSONL log.
   * Called periodically by the daemon to pick up messages
   * written by the MCP tool (which runs out-of-process).
   */
  deliverPending(): number {
    if (!existsSync(this.logFile)) return 0;

    let delivered = 0;
    try {
      const lines = readFileSync(this.logFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);

      const updatedLines: string[] = [];
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as TeamMessage;
          if (!msg.delivered) {
            // Try to deliver via team-bindings or BotManager
            const sessionKey = this.resolveSessionKey(msg.toAgent);
            if (sessionKey) {
              this.gateway.setSessionProfile(sessionKey, msg.toAgent);
              this.gateway.injectContext(
                sessionKey,
                `[Team message from ${msg.fromAgent}, depth=${msg.depth}]`,
                msg.content,
              );
              msg.delivered = true;
              delivered++;
            }
          }
          updatedLines.push(JSON.stringify(msg));

          // Update in-memory buffer too
          const idx = this.recentMessages.findIndex((m) => m.id === msg.id);
          if (idx >= 0) {
            this.recentMessages[idx] = msg;
          } else if (msg.delivered) {
            this.recentMessages.push(msg);
            if (this.recentMessages.length > RECENT_BUFFER_SIZE) {
              this.recentMessages = this.recentMessages.slice(-RECENT_BUFFER_SIZE);
            }
          }
        } catch {
          updatedLines.push(line); // Keep malformed lines as-is
        }
      }

      // Write back updated log
      if (delivered > 0) {
        writeFileSync(this.logFile, updatedLines.join('\n') + '\n');
        logger.info({ delivered }, 'Delivered pending team messages');
      }
    } catch (err) {
      logger.warn({ err }, 'Error delivering pending team messages');
    }

    return delivered;
  }

  /** Post an embed to the team comms Discord channel. */
  private async mirrorToDiscord(
    message: TeamMessage,
    from: AgentProfile,
    to: AgentProfile,
  ): Promise<void> {
    const token = process.env.DISCORD_TOKEN ?? '';
    if (!token || !this.commsChannelId) return;

    // Truncate content for embed
    const truncated = message.content.length > 1024
      ? message.content.slice(0, 1021) + '...'
      : message.content;

    const embed: Record<string, unknown> = {
      title: `${from.name} \u2192 ${to.name}`,
      description: truncated,
      color: 0x5865F2, // Discord blurple
      footer: {
        text: `via team_message \u00B7 depth ${message.depth}`,
      },
      timestamp: message.timestamp,
    };
    // Show sender's avatar in the embed
    if (from.avatar) {
      embed.thumbnail = { url: from.avatar };
    }

    const res = await fetch(
      `https://discord.com/api/v10/channels/${this.commsChannelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ embeds: [embed] }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      logger.warn({ status: res.status, body: errText }, 'Discord mirror failed');
    }
  }
}
