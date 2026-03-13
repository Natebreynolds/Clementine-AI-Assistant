/**
 * Clementine TypeScript — Discord channel adapter.
 *
 * DM-only personal assistant bot using discord.js v14.
 * Features: streaming responses, message chunking, model switching,
 * heartbeat/cron commands, slash commands, and autonomous notifications.
 */

import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type Interaction,
  type ButtonInteraction,
} from 'discord.js';
import pino from 'pino';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DISCORD_TOKEN,
  DISCORD_OWNER_ID,
  DISCORD_WATCHED_CHANNELS,
  MODELS,
  ASSISTANT_NAME,
  PKG_DIR,
  VAULT_DIR,
} from '../config.js';
import type { HeartbeatScheduler, CronScheduler } from '../gateway/heartbeat.js';
import type { NotificationDispatcher } from '../gateway/notifications.js';
import type { Gateway } from '../gateway/router.js';
import { findProjectByName, getLinkedProjects } from '../agent/assistant.js';

const logger = pino({ name: 'clementine.discord' });

const STREAM_EDIT_INTERVAL = 400; // ms — lower = faster perceived response, higher = fewer Discord API calls
const THINKING_INDICATOR = '\u2728 *thinking...*';
const DISCORD_MSG_LIMIT = 2000;
const BOT_MESSAGE_TRACKING_LIMIT = 100;

// ── Slash command definitions ──────────────────────────────────────────

const slashCommands = [
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
  new SlashCommandBuilder().setName('cron').setDescription('Manage scheduled tasks')
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true)
      .addChoices(
        { name: 'List jobs', value: 'list' },
        { name: 'Run a job', value: 'run' },
        { name: 'Enable a job', value: 'enable' },
        { name: 'Disable a job', value: 'disable' },
      ))
    .addStringOption(o => o.setName('job').setDescription('Job name (for run/enable/disable)')),
  new SlashCommandBuilder().setName('heartbeat').setDescription('Run heartbeat check manually'),
  new SlashCommandBuilder().setName('tools').setDescription('List available MCP tools'),
  new SlashCommandBuilder().setName('project').setDescription('Set active project context')
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true)
      .addChoices(
        { name: 'List projects', value: 'list' },
        { name: 'Set active project', value: 'set' },
        { name: 'Clear active project', value: 'clear' },
        { name: 'Show current', value: 'status' },
      ))
    .addStringOption(o => o.setName('name').setDescription('Project name (for set)')),
  new SlashCommandBuilder().setName('clear').setDescription('Reset conversation session'),
  new SlashCommandBuilder().setName('help').setDescription('Show all available commands'),
];

// ── Bot message tracking for feedback reactions ─────────────────────────

interface BotMessageContext {
  sessionKey: string;
  userMessage: string;
  botResponse: string;
}

const botMessageMap = new Map<string, BotMessageContext>();

function trackBotMessage(messageId: string, context: BotMessageContext): void {
  botMessageMap.set(messageId, context);
  // Evict oldest entries to prevent memory leak
  if (botMessageMap.size > BOT_MESSAGE_TRACKING_LIMIT) {
    const firstKey = botMessageMap.keys().next().value;
    if (firstKey) botMessageMap.delete(firstKey);
  }
}

// ── Lazy memory store for feedback logging ──────────────────────────────

let _feedbackStore: any = null;

async function getFeedbackStore(): Promise<any> {
  if (_feedbackStore) return _feedbackStore;
  try {
    const { MemoryStore } = await import('../memory/store.js');
    const { MEMORY_DB_PATH } = await import('../config.js');
    const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
    store.initialize();
    _feedbackStore = store;
    return _feedbackStore;
  } catch {
    return null;
  }
}

// ── Emoji to feedback rating mapping ────────────────────────────────────

function emojiToRating(emoji: string): 'positive' | 'negative' | null {
  const positiveEmoji = ['\u{1F44D}', 'thumbsup', '\u{2764}\ufe0f', 'heart', '\u{2B50}', 'star'];
  const negativeEmoji = ['\u{1F44E}', 'thumbsdown'];
  if (positiveEmoji.includes(emoji)) return 'positive';
  if (negativeEmoji.includes(emoji)) return 'negative';
  return null;
}

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
  private lastFlushedText = '';
  private isFinal = false;
  private channel: Message['channel'];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** The message ID of the final bot response (available after finalize). */
  messageId: string | null = null;

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
    const elapsed = Date.now() - this.lastEdit;
    if (elapsed >= STREAM_EDIT_INTERVAL) {
      await this.flush();
    } else if (!this.flushTimer) {
      // Schedule a flush so buffered text always gets pushed out,
      // even if no new tokens arrive for a while (e.g. during tool use)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, STREAM_EDIT_INTERVAL - elapsed);
    }
  }

  async finalize(text: string): Promise<void> {
    this.isFinal = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!text) text = '*(no response)*';
    text = sanitizeResponse(text);

    if (this.message) {
      if (text.length <= 1900) {
        await this.message.edit(text);
        this.messageId = this.message.id;
      } else {
        await this.message.delete().catch(() => {});
        await sendChunked(this.channel, text);
        // messageId not tracked for chunked responses
      }
    } else {
      await sendChunked(this.channel, text);
    }
  }

  private async flush(): Promise<void> {
    if (!this.message || !this.pendingText || this.isFinal) return;
    // Skip edit if text hasn't changed since last flush
    if (this.pendingText === this.lastFlushedText) return;
    let display = this.pendingText;
    if (display.length > 1900) {
      display = display.slice(0, 1900) + '\n\n*...streaming...*';
    } else {
      display = display + '\n\n\u270d\ufe0f *typing...*';
    }
    try {
      await this.message.edit(display);
      this.lastFlushedText = this.pendingText;
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

// ── Shared command helpers ────────────────────────────────────────────

function handleHelp(): string {
  return [
    '**Commands** \u2014 also available as /slash commands',
    '`!plan <task>` \u2014 Break a task into parallel steps',
    '`!deep <msg>` \u2014 Extended mode (100 turns)',
    '`!q <msg>` \u2014 Quick reply (Haiku) \u00b7 `!d <msg>` \u2014 Deep reply (Opus)',
    '`!model [haiku|sonnet|opus]` \u2014 Switch default model',
    '`!project <name>` \u2014 Set active project \u00b7 `!project list|clear|status`',
    '`!cron list|run|enable|disable` \u2014 Manage scheduled tasks',
    '`!heartbeat` \u2014 Run heartbeat \u00b7 `!tools` \u2014 List tools \u00b7 `!clear` \u2014 Reset',
    '`!help` \u2014 This message',
  ].join('\n');
}

function handleModelSwitch(
  gateway: Gateway,
  sessionKey: string,
  tier: string | undefined,
): string {
  const t = tier?.toLowerCase() as keyof typeof MODELS | undefined;
  if (t && t in MODELS) {
    gateway.setSessionModel(sessionKey, MODELS[t]);
    return `Model switched to **${t}** (\`${MODELS[t]}\`).`;
  }
  const current = gateway.getSessionModel(sessionKey) ?? 'default';
  return `Current model: \`${current}\`\nOptions: \`!model haiku\`, \`!model sonnet\`, \`!model opus\``;
}

function handleProjectCommand(
  gateway: Gateway,
  sessionKey: string,
  action: string | undefined,
  projectName: string | undefined,
): string {
  if (action === 'list' || !action) {
    const projects = getLinkedProjects();
    if (projects.length === 0) return 'No linked projects. Link projects from the dashboard.';
    const current = gateway.getSessionProject(sessionKey);
    const lines = projects.map(p => {
      const name = path.basename(p.path);
      const desc = p.description ? ` — ${p.description}` : '';
      const active = current && p.path === current.path ? ' **(active)**' : '';
      return `\`${name}\`${desc}${active}`;
    });
    return `**Linked Projects**\n${lines.join('\n')}`;
  }

  if (action === 'clear') {
    gateway.clearSessionProject(sessionKey);
    return 'Project context cleared. Auto-matching is back on.';
  }

  if (action === 'status') {
    const current = gateway.getSessionProject(sessionKey);
    if (!current) return 'No active project. Using auto-matching.';
    const name = path.basename(current.path);
    const desc = current.description ? ` — ${current.description}` : '';
    return `Active project: **${name}**${desc}\n\`${current.path}\``;
  }

  // action === 'set'
  if (!projectName) {
    const projects = getLinkedProjects();
    if (projects.length === 0) return 'No linked projects. Link projects from the dashboard.';
    const names = projects.map(p => `\`${path.basename(p.path)}\``).join(', ');
    return `Usage: \`!project <name>\`\nAvailable: ${names}`;
  }

  const project = findProjectByName(projectName);
  if (!project) {
    const projects = getLinkedProjects();
    const names = projects.map(p => `\`${path.basename(p.path)}\``).join(', ');
    return `Project "${projectName}" not found.\nAvailable: ${names}`;
  }

  // Clear the session so it starts fresh with the project's cwd/tools, then set the project
  gateway.clearSession(sessionKey);
  gateway.setSessionProject(sessionKey, project);
  const name = path.basename(project.path);
  const desc = project.description ? ` — ${project.description}` : '';
  return `Switched to **${name}**${desc}\nWorking in \`${project.path}\`. Session cleared for fresh context.`;
}

function handleCronCommand(
  cronScheduler: CronScheduler,
  action: string | undefined,
  jobName: string,
): string | null {
  // Returns a string for immediate replies, or null when async handling is needed (run)
  if (action === 'list' || !action) {
    return cronScheduler.listJobs();
  }
  if (action === 'disable' && jobName) {
    return cronScheduler.disableJob(jobName);
  }
  if (action === 'enable' && jobName) {
    return cronScheduler.enableJob(jobName);
  }
  if (!jobName) {
    return 'Usage: `!cron list|run|disable|enable <job>`';
  }
  return null; // caller handles 'run' async
}

// ── Entry point ───────────────────────────────────────────────────────

export async function startDiscord(
  gateway: Gateway,
  heartbeat: HeartbeatScheduler,
  cronScheduler: CronScheduler,
  dispatcher: NotificationDispatcher,
): Promise<void> {
  const watchedChannels = new Set(DISCORD_WATCHED_CHANNELS);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
      ...(watchedChannels.size > 0 ? [GatewayIntentBits.GuildMessages] : []),
    ],
    partials: [Partials.Channel, Partials.Reaction, Partials.Message],
  });

  // ── Presence updater ─────────────────────────────────────────────
  function updatePresence(sessionKey?: string): void {
    if (!client.user) return;
    const info = gateway.getPresenceInfo(
      sessionKey ?? `discord:user:${DISCORD_OWNER_ID}`,
    );
    const parts = [
      info.model,
      info.project ?? 'No project',
      `${info.exchanges}/${info.maxExchanges}`,
      `${info.memoryCount}m`,
    ];
    client.user.setPresence({
      activities: [{ name: parts.join(' · '), type: ActivityType.Custom, state: parts.join(' · ') }],
      status: 'online',
    });
  }

  // Prevent unhandled 'error' events from crashing the process
  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error — will attempt to reconnect');
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`${ASSISTANT_NAME} online as ${readyClient.user.tag}`);

    // Register slash commands (global — takes up to 1hr to propagate, but works in DMs)
    try {
      const rest = new REST().setToken(DISCORD_TOKEN!);
      await rest.put(Routes.applicationCommands(readyClient.user.id),
        { body: slashCommands.map(c => c.toJSON()) });
      logger.info(`Registered ${slashCommands.length} slash commands`);
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }

    updatePresence();
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore own messages
    if (message.author.id === client.user?.id) return;

    // DM or watched guild channel
    const isDm = message.channel.isDMBased();
    const isWatchedChannel = !isDm && watchedChannels.has(message.channelId);
    if (!isDm && !isWatchedChannel) return;

    // Cache the DM channel for cron/heartbeat notifications
    if (isDm) cachedDmChannel = message.channel;

    // Owner-only (applies to both DM and watched channels)
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      logger.warn(`Ignored message from non-owner: ${message.author.tag} (${message.author.id})`);
      return;
    }

    // Extract attachments (images and files)
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

    const sessionKey = isWatchedChannel
      ? `discord:channel:${message.channelId}:${message.author.id}`
      : `discord:user:${message.author.id}`;

    // ── Commands (DM only) ──────────────────────────────────────────

    if (isDm && text === '!clear') {
      gateway.clearSession(sessionKey);
      await message.reply('Session cleared.');
      updatePresence(sessionKey);
      return;
    }

    if (isDm && (text === '!help' || text === '!h')) {
      await message.reply(handleHelp());
      return;
    }

    if (isDm && text.startsWith('!model')) {
      const parts = text.split(/\s+/);
      await message.reply(handleModelSwitch(gateway, sessionKey, parts[1]));
      updatePresence(sessionKey);
      return;
    }

    if (isDm && text === '!tools') {
      await message.reply(formatToolsList());
      return;
    }

    if (isDm && text === '!heartbeat') {
      const streamer = new DiscordStreamingMessage(message.channel);
      await streamer.start();
      const response = await heartbeat.runManual();
      await streamer.finalize(response);
      // Inject into DM session so follow-up conversation has context
      gateway.injectContext(sessionKey, '!heartbeat', response);
      return;
    }

    if (isDm && text.startsWith('!project')) {
      const parts = text.split(/\s+/);
      const subCmd = parts[1]?.toLowerCase();
      if (subCmd === 'list' || subCmd === 'clear' || subCmd === 'status') {
        await message.reply(handleProjectCommand(gateway, sessionKey, subCmd, undefined));
      } else {
        // !project <name> → set project
        const projectName = parts.slice(1).join(' ');
        await message.reply(handleProjectCommand(gateway, sessionKey, 'set', projectName || undefined));
      }
      updatePresence(sessionKey);
      return;
    }

    if (isDm && text.startsWith('!cron')) {
      const parts = text.split(/\s+/);
      const subCmd = parts[1]?.toLowerCase();
      const jobName = parts.slice(2).join(' ');

      const immediateResult = handleCronCommand(cronScheduler, subCmd, jobName);
      if (immediateResult !== null) {
        await message.reply(immediateResult);
        return;
      }

      // Handle 'run' — async with streaming
      const job = cronScheduler.getJob(jobName);
      if (!job) {
        await message.reply(`Cron job '${jobName}' not found. Use \`!cron list\` to see available jobs.`);
      } else if (cronScheduler.isJobRunning(jobName)) {
        await message.reply(`Cron job '${jobName}' is already running.`);
      } else if (job.mode === 'unleashed') {
        // Unleashed tasks run in background — don't block the channel
        await message.reply(`Unleashed task "${jobName}" started in background (max ${job.maxHours ?? 6}h). Check the dashboard for progress.`);
        cronScheduler.runManual(jobName).then((result) => {
          message.reply(`**[Unleashed: ${jobName} — done]**\n\n${result.slice(0, 1800)}`).catch(() => {});
          gateway.injectContext(sessionKey, `!cron run ${jobName}`, result);
        }).catch((err) => {
          message.reply(`**[Unleashed: ${jobName} — error]**\n\n${err}`).catch(() => {});
        });
      } else {
        const streamer = new DiscordStreamingMessage(message.channel);
        await streamer.start();
        const response = await cronScheduler.runManual(jobName);
        await streamer.finalize(response);
        // Inject into DM session so follow-up conversation has context
        gateway.injectContext(sessionKey, `!cron run ${jobName}`, response);
      }
      return;
    }

    // ── Plan orchestration (DM only) ─────────────────────────────────

    if (isDm && text.startsWith('!plan ')) {
      const taskDescription = text.slice(6).trim();
      if (!taskDescription) {
        await message.reply('Usage: `!plan <task description>`');
        return;
      }

      await handlePlanCommand(gateway, sessionKey, taskDescription, message.channel);
      return;
    }

    // ── Approval responses (DM only) ────────────────────────────────

    if (isDm) {
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
    }

    // ── Per-message model/mode prefix ──────────────────────────────

    let effectiveText = text;
    let oneOffModel: string | undefined;
    let oneOffMaxTurns: number | undefined;
    if (text.startsWith('!q ')) {
      oneOffModel = MODELS.haiku;
      effectiveText = text.slice(3);
    } else if (text.startsWith('!d ')) {
      oneOffModel = MODELS.opus;
      effectiveText = text.slice(3);
    } else if (text.startsWith('!deep ')) {
      oneOffMaxTurns = 100;
      effectiveText = text.slice(6);
    }

    // ── Reply context for watched channels ─────────────────────────

    if (isWatchedChannel && message.reference?.messageId) {
      try {
        const referenced = await message.channel.messages.fetch(message.reference.messageId);
        if (referenced.author.id === client.user?.id) {
          const refContent = referenced.content.slice(0, 1500);
          effectiveText = `[Replying to bot message:\n${refContent}]\n\n${effectiveText}`;
        }
      } catch { /* referenced message may be deleted */ }
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
        oneOffMaxTurns,
      );
      await streamer.finalize(response);
      updatePresence(sessionKey);

      // Track bot message for feedback reactions
      if (streamer.messageId) {
        trackBotMessage(streamer.messageId, {
          sessionKey,
          userMessage: effectiveText.slice(0, 500),
          botResponse: response.slice(0, 500),
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error processing Discord message');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  });

  // ── Slash command + button interaction handler ──────────────────────

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // ── Slash commands ───────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const cmd = interaction as ChatInputCommandInteraction;

      // Owner-only guard
      if (DISCORD_OWNER_ID && cmd.user.id !== DISCORD_OWNER_ID) {
        await cmd.reply({ content: 'Owner only.', ephemeral: true });
        return;
      }

      // Cache DM channel for notifications
      if (cmd.channel?.isDMBased()) cachedDmChannel = cmd.channel as any;

      const sessionKey = cmd.channel?.isDMBased()
        ? `discord:user:${cmd.user.id}`
        : `discord:channel:${cmd.channelId}:${cmd.user.id}`;

      const name = cmd.commandName;

      // Simple immediate-response commands
      if (name === 'help') {
        await cmd.reply(handleHelp());
        return;
      }
      if (name === 'clear') {
        gateway.clearSession(sessionKey);
        await cmd.reply('Session cleared.');
        return;
      }
      if (name === 'tools') {
        await cmd.reply(formatToolsList());
        return;
      }
      if (name === 'model') {
        const tier = cmd.options.getString('tier', true);
        await cmd.reply(handleModelSwitch(gateway, sessionKey, tier));
        return;
      }
      if (name === 'project') {
        const action = cmd.options.getString('action', true);
        const projName = cmd.options.getString('name') ?? undefined;
        await cmd.reply(handleProjectCommand(gateway, sessionKey, action, projName));
        return;
      }

      // Cron command
      if (name === 'cron') {
        const action = cmd.options.getString('action', true);
        const jobName = cmd.options.getString('job') ?? '';

        const immediateResult = handleCronCommand(cronScheduler, action, jobName);
        if (immediateResult !== null) {
          await cmd.reply(immediateResult);
          return;
        }

        // Handle 'run' — async with deferred reply
        const job = cronScheduler.getJob(jobName);
        if (!job) {
          await cmd.reply(`Cron job '${jobName}' not found. Use \`/cron list\` to see available jobs.`);
          return;
        }
        if (cronScheduler.isJobRunning(jobName)) {
          await cmd.reply(`Cron job '${jobName}' is already running.`);
          return;
        }
        if (job.mode === 'unleashed') {
          await cmd.reply(`Unleashed task "${jobName}" started in background (max ${job.maxHours ?? 6}h). Check the dashboard for progress.`);
          cronScheduler.runManual(jobName).then((result) => {
            cmd.followUp(`**[Unleashed: ${jobName} — done]**\n\n${result.slice(0, 1800)}`).catch(() => {});
            gateway.injectContext(sessionKey, `!cron run ${jobName}`, result);
          }).catch((err) => {
            cmd.followUp(`**[Unleashed: ${jobName} — error]**\n\n${err}`).catch(() => {});
          });
          return;
        }

        await cmd.deferReply();
        const response = await cronScheduler.runManual(jobName);
        const chunks = chunkText(response || `*(cron job '${jobName}' completed — no output)*`, 1900);
        await cmd.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await cmd.followUp(chunks[i]);
        }
        gateway.injectContext(sessionKey, `!cron run ${jobName}`, response);
        return;
      }

      // Heartbeat command
      if (name === 'heartbeat') {
        await cmd.deferReply();
        const response = await heartbeat.runManual();
        const chunks = chunkText(response, 1900);
        await cmd.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await cmd.followUp(chunks[i]);
        }
        gateway.injectContext(sessionKey, '!heartbeat', response);
        return;
      }

      // Plan command
      if (name === 'plan') {
        const task = cmd.options.getString('task', true);
        await cmd.deferReply();
        try {
          const result = await gateway.handlePlan(sessionKey, task, async () => {});
          const chunks = chunkText(result, 1900);
          await cmd.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await cmd.followUp(chunks[i]);
          }
        } catch (err) {
          logger.error({ err }, 'Plan execution failed (slash)');
          await cmd.editReply(`Plan failed: ${err}`);
        }
        return;
      }

      // Chat commands: /deep, /quick, /opus — route through gateway
      if (name === 'deep' || name === 'quick' || name === 'opus') {
        const msg = cmd.options.getString('message', true);
        await cmd.deferReply();
        const oneOffModel = name === 'quick' ? MODELS.haiku : name === 'opus' ? MODELS.opus : undefined;
        const oneOffMaxTurns = name === 'deep' ? 100 : undefined;
        try {
          const response = await gateway.handleMessage(
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
          logger.error({ err }, `/${name} command failed`);
          await cmd.editReply(`Something went wrong: ${err}`);
        }
        return;
      }

      return;
    }

    // ── Button interactions ──────────────────────────────────────────
    if (!interaction.isButton()) return;

    const button = interaction as ButtonInteraction;

    // Owner-only
    if (DISCORD_OWNER_ID && button.user.id !== DISCORD_OWNER_ID) {
      await button.reply({ content: 'Only the owner can use these buttons.', ephemeral: true });
      return;
    }

    const customId = button.customId; // e.g. "audit_approve" or "audit_deny"
    const isApprove = customId.endsWith('_approve');
    const isDeny = customId.endsWith('_deny');

    if (!isApprove && !isDeny) return;

    const action = isApprove ? 'approved' : 'denied';
    const emoji = isApprove ? '✅' : '❌';

    // Acknowledge immediately — Discord requires response within 3 seconds
    await button.deferUpdate();

    // Update the original message: disable buttons and show decision
    try {
      const originalContent = button.message.content ?? '';
      const updatedContent = originalContent + `\n\n${emoji} **${action.toUpperCase()}** by ${button.user.username}`;

      // Disable buttons via raw API data — avoids discord.js component type issues
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
        content: updatedContent.slice(0, 2000),
        components: rawComponents as any,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to update button message');
    }

    // Route the decision to the agent as a message in the channel's session
    const sessionKey = `discord:channel:${button.channelId}:${button.user.id}`;
    const originalContent = button.message.content ?? '';

    // Build context message for the agent
    const agentMessage = `[Button clicked: ${action}]\n\nOriginal request:\n${originalContent}\n\nNate ${action} this request. ${isApprove ? 'Proceed with building the audit brief, deploying to Netlify, and drafting the response email.' : 'Skip this request and log that it was denied.'}`;

    // Process through gateway
    const streamer = new DiscordStreamingMessage(button.channel!);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        agentMessage,
        (t) => streamer.update(t),
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err }, 'Error processing button interaction');
      await streamer.finalize(`Something went wrong processing the ${action}: ${err}`);
    }
  });

  // ── Reaction-based feedback handler ─────────────────────────────────

  client.on(Events.MessageReactionAdd, async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ) => {
    // Ignore bot's own reactions
    if (user.id === client.user?.id) return;

    // Owner-only
    if (DISCORD_OWNER_ID && user.id !== DISCORD_OWNER_ID) return;

    // Fetch partial reaction if needed
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return; // Message may have been deleted
      }
    }

    // Check if this is a tracked bot message
    const messageId = reaction.message.id;
    const context = botMessageMap.get(messageId);
    if (!context) return;

    // Map emoji to rating
    const emojiName = reaction.emoji.name ?? '';
    const rating = emojiToRating(emojiName);
    if (!rating) return;

    // Log feedback
    try {
      const store = await getFeedbackStore();
      if (store) {
        store.logFeedback({
          sessionKey: context.sessionKey,
          channel: 'discord',
          messageSnippet: context.userMessage,
          responseSnippet: context.botResponse,
          rating,
        });
        logger.info({ rating, messageId }, 'Feedback logged via Discord reaction');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to log reaction feedback');
    }
  });

  // ── Register notification sender ──────────────────────────────────

  // Cache the owner's DM channel from successful interactions so
  // cron/heartbeat notifications don't depend on a fresh API fetch.
  let cachedDmChannel: Message['channel'] | null = null;

  async function discordNotify(text: string): Promise<void> {
    // Try cached channel first (populated on every owner DM interaction)
    let channel = cachedDmChannel;
    if (!channel || !('send' in channel)) {
      // Fallback: fetch from API with force flag
      try {
        const user = await client.users.fetch(DISCORD_OWNER_ID, { force: true });
        channel = await user.createDM();
        cachedDmChannel = channel;
      } catch (err) {
        logger.error({ err }, 'Failed to open DM channel for notification');
        throw err;
      }
    }

    try {
      for (const chunk of chunkText(text, 1900)) {
        await (channel as any).send(chunk);
      }
    } catch (err) {
      // Channel might be stale — clear cache, wait briefly, retry once
      cachedDmChannel = null;
      logger.warn({ err }, 'Discord notification failed — retrying once');
      try {
        await new Promise(r => setTimeout(r, 2000));
        const user = await client.users.fetch(DISCORD_OWNER_ID, { force: true });
        channel = await user.createDM();
        cachedDmChannel = channel;
        for (const chunk of chunkText(text, 1900)) {
          await (channel as any).send(chunk);
        }
      } catch (retryErr) {
        logger.error({ err: retryErr }, 'Discord notification retry failed');
        throw retryErr;
      }
    }
  }

  // Register sender only after Discord client is ready
  client.once(Events.ClientReady, () => {
    dispatcher.register('discord', discordNotify);
  });

  logger.info('Starting Discord bot...');
  await client.login(DISCORD_TOKEN);
}

// ── Plan orchestration helper ─────────────────────────────────────────

async function handlePlanCommand(
  gateway: Gateway,
  sessionKey: string,
  taskDescription: string,
  channel: Message['channel'],
): Promise<void> {
  const streamer = new DiscordStreamingMessage(channel);
  await streamer.start();
  await streamer.update('Planning...');

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  try {
    const result = await gateway.handlePlan(
      sessionKey,
      taskDescription,
      async (updates) => {
        // Build progress display (truncate descriptions to fit Discord limit)
        const lines = [
          `**Plan:** ${taskDescription.slice(0, 100)}`,
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

        // Start progress timer on first running step
        if (!progressTimer && updates.some(u => u.status === 'running')) {
          progressTimer = setInterval(async () => {
            // Re-render with live elapsed times (static snapshot — no orchestrator ref needed)
            await streamer.update(lines.join('\n').slice(0, 1800));
          }, 5000);
        }
      },
    );

    await streamer.finalize(result);
  } catch (err) {
    logger.error({ err }, 'Plan execution failed');
    await streamer.finalize(`Plan failed: ${err}`);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}
