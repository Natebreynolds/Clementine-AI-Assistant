/**
 * Clementine TypeScript — Discord channel adapter.
 *
 * DM-only personal assistant bot using discord.js v14.
 * Features: streaming responses, message chunking, model switching,
 * heartbeat/cron commands, and autonomous notifications.
 */

import { Client, Events, GatewayIntentBits, Partials, Message } from 'discord.js';
import pino from 'pino';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DISCORD_TOKEN,
  DISCORD_OWNER_ID,
  MODELS,
  ASSISTANT_NAME,
  PKG_DIR,
} from '../config.js';
import type { HeartbeatScheduler, CronScheduler } from '../gateway/heartbeat.js';
import type { NotificationDispatcher } from '../gateway/notifications.js';
import type { Gateway } from '../gateway/router.js';

const logger = pino({ name: 'clementine.discord' });

const STREAM_EDIT_INTERVAL = 1500; // ms
const THINKING_INDICATOR = '\u2728 *thinking...*';
const DISCORD_MSG_LIMIT = 2000;

// ── Credential sanitisation ───────────────────────────────────────────

function sanitizeResponse(text: string): string {
  // Discord tokens
  text = text.replace(
    /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
    '[REDACTED_TOKEN]',
  );
  // API keys (Anthropic/OpenAI style)
  text = text.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]');
  // GitHub PATs
  text = text.replace(/ghp_[A-Za-z0-9]{36}/g, '[REDACTED_TOKEN]');
  // Slack bot tokens
  text = text.replace(/xoxb-[0-9]+-[A-Za-z0-9-]+/g, '[REDACTED_TOKEN]');
  // Generic key/secret/token/password values
  text = text.replace(
    /((?:token|key|secret|password)[=: ]{1,3})\S{20,}/gi,
    '$1[REDACTED]',
  );
  return text;
}

// ── Chunked sending ───────────────────────────────────────────────────

function chunkText(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  return chunks;
}

async function sendChunked(
  channel: Message['channel'],
  text: string,
): Promise<void> {
  if (!('send' in channel)) return;
  if (!text) {
    await channel.send('*(no response)*');
    return;
  }
  text = sanitizeResponse(text);
  for (const chunk of chunkText(text, 1900)) {
    await channel.send(chunk);
  }
}

// ── Streaming message ─────────────────────────────────────────────────

class DiscordStreamingMessage {
  private message: Message | null = null;
  private lastEdit = 0;
  private pendingText = '';
  private isFinal = false;
  private channel: Message['channel'];

  constructor(channel: Message['channel']) {
    this.channel = channel;
  }

  async start(): Promise<void> {
    if (!('send' in this.channel)) return;
    this.message = await this.channel.send(THINKING_INDICATOR);
    this.lastEdit = Date.now();
  }

  async update(text: string): Promise<void> {
    this.pendingText = text;
    if (Date.now() - this.lastEdit >= STREAM_EDIT_INTERVAL) {
      await this.flush();
    }
  }

  async finalize(text: string): Promise<void> {
    this.isFinal = true;
    if (!text) text = '*(no response)*';
    text = sanitizeResponse(text);

    if (this.message) {
      if (text.length <= 1900) {
        await this.message.edit(text);
      } else {
        await this.message.delete().catch(() => {});
        await sendChunked(this.channel, text);
      }
    } else {
      await sendChunked(this.channel, text);
    }
  }

  private async flush(): Promise<void> {
    if (!this.message || !this.pendingText || this.isFinal) return;
    let display = this.pendingText;
    if (display.length > 1900) {
      display = display.slice(0, 1900) + '\n\n*...streaming...*';
    } else {
      display = display + '\n\n\u270d\ufe0f *typing...*';
    }
    try {
      await this.message.edit(display);
      this.lastEdit = Date.now();
    } catch {
      // Discord rate limit or message deleted — ignore
    }
  }
}

// ── Owner check ───────────────────────────────────────────────────────

function isOwnerDm(message: Message): boolean {
  if (!message.channel.isDMBased()) return false;
  if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) return false;
  return true;
}

// ── Tools listing ─────────────────────────────────────────────────────

function formatToolsList(): string {
  const lines: string[] = ['**Available Tools**\n'];

  // MCP tools (parse from source)
  const mcpSrc = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');
  if (existsSync(mcpSrc)) {
    const src = readFileSync(mcpSrc, 'utf-8');
    const toolPattern = /server\.tool\(\s*'([^']+)',\s*(['"])(.+?)\2/gs;
    const tools: Array<{ name: string; desc: string }> = [];
    let match;
    while ((match = toolPattern.exec(src)) !== null) {
      tools.push({ name: match[1], desc: match[3] });
    }
    if (tools.length > 0) {
      lines.push(`**MCP Tools** (${tools.length})`);
      for (const t of tools) {
        lines.push(`\`${t.name}\` — ${t.desc.slice(0, 80)}${t.desc.length > 80 ? '...' : ''}`);
      }
      lines.push('');
    }
  }

  // SDK tools
  lines.push('**SDK Built-in Tools** (8)');
  lines.push('`Read` `Write` `Edit` `Bash` `Glob` `Grep` `WebSearch` `WebFetch`');
  lines.push('');

  // Claude Code plugins
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const plugins = Object.entries(settings.enabledPlugins ?? {})
        .filter(([, v]) => v)
        .map(([id]) => id.split('@')[0]);
      if (plugins.length > 0) {
        lines.push(`**Claude Code Plugins** (${plugins.length})`);
        lines.push(plugins.map((p) => `\`${p}\``).join(' '));
        lines.push('');
      }
    } catch { /* ignore */ }
  }

  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────

export async function startDiscord(
  gateway: Gateway,
  heartbeat: HeartbeatScheduler,
  cronScheduler: CronScheduler,
  dispatcher: NotificationDispatcher,
): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`${ASSISTANT_NAME} online as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore own messages
    if (message.author.id === client.user?.id) return;

    // DM-only
    if (!message.channel.isDMBased()) return;

    // Owner-only
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      logger.warn(`Ignored message from non-owner: ${message.author.tag} (${message.author.id})`);
      return;
    }

    const text = message.content;
    const sessionKey = `discord:user:${message.author.id}`;

    // ── Commands ────────────────────────────────────────────────────

    if (text === '!clear') {
      gateway.clearSession(sessionKey);
      await message.reply('Session cleared.');
      return;
    }

    if (text.startsWith('!model')) {
      const parts = text.split(/\s+/);
      const tier = parts[1]?.toLowerCase() as keyof typeof MODELS | undefined;
      if (tier && tier in MODELS) {
        gateway.setSessionModel(sessionKey, MODELS[tier]);
        await message.reply(`Model switched to **${tier}** (\`${MODELS[tier]}\`).`);
      } else {
        const current = gateway.getSessionModel(sessionKey) ?? 'default';
        await message.reply(
          `Current model: \`${current}\`\nOptions: \`!model haiku\`, \`!model sonnet\`, \`!model opus\``,
        );
      }
      return;
    }

    if (text === '!tools') {
      await message.reply(formatToolsList());
      return;
    }

    if (text === '!heartbeat') {
      const streamer = new DiscordStreamingMessage(message.channel);
      await streamer.start();
      const response = await heartbeat.runManual();
      await streamer.finalize(response);
      return;
    }

    if (text.startsWith('!cron')) {
      const parts = text.split(/\s+/);
      const subCmd = parts[1]?.toLowerCase();
      const jobName = parts.slice(2).join(' ');

      if (subCmd === 'list' || !subCmd) {
        await message.reply(cronScheduler.listJobs());
      } else if (subCmd === 'run' && jobName) {
        const streamer = new DiscordStreamingMessage(message.channel);
        await streamer.start();
        const response = await cronScheduler.runManual(jobName);
        await streamer.finalize(response);
      } else if (subCmd === 'disable' && jobName) {
        await message.reply(cronScheduler.disableJob(jobName));
      } else if (subCmd === 'enable' && jobName) {
        await message.reply(cronScheduler.enableJob(jobName));
      } else {
        await message.reply('Usage: `!cron list|run|disable|enable <job>`');
      }
      return;
    }

    // ── Approval responses ──────────────────────────────────────────

    const lower = text.toLowerCase();
    if (['yes', 'no', 'approve', 'deny'].includes(lower)) {
      const approvals = gateway.getPendingApprovals();
      if (approvals.length > 0) {
        const approved = lower === 'yes' || lower === 'approve';
        gateway.resolveApproval(approvals[approvals.length - 1], approved);
        await message.react(approved ? '\u2705' : '\u274c');
        return;
      }
    }

    // ── Per-message model prefix ────────────────────────────────────

    let effectiveText = text;
    let oneOffModel: string | undefined;
    if (text.startsWith('!q ')) {
      oneOffModel = MODELS.haiku;
      effectiveText = text.slice(3);
    } else if (text.startsWith('!d ')) {
      oneOffModel = MODELS.opus;
      effectiveText = text.slice(3);
    }

    // ── Show queued indicator if session is busy ─────────────────────

    if (gateway.isSessionBusy(sessionKey)) {
      await message.react('\u23f3'); // hourglass
    }

    // ── Stream response ─────────────────────────────────────────────

    const streamer = new DiscordStreamingMessage(message.channel);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        effectiveText,
        (t) => streamer.update(t),
        oneOffModel,
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err }, 'Error processing Discord message');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  });

  // ── Register notification sender ──────────────────────────────────

  async function discordNotify(text: string): Promise<void> {
    try {
      const user = await client.users.fetch(DISCORD_OWNER_ID);
      const dm = await user.createDM();
      for (const chunk of chunkText(text, 1900)) {
        await dm.send(chunk);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send Discord notification');
    }
  }

  dispatcher.register('discord', discordNotify);

  logger.info('Starting Discord bot...');
  await client.login(DISCORD_TOKEN);
}
