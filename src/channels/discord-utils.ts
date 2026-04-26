/**
 * Clementine TypeScript — Shared Discord utilities.
 *
 * Extracted from discord.ts so agent bot clients can reuse streaming,
 * chunking, and sanitization without importing the monolith.
 */

import { EmbedBuilder, type Client, type Message } from 'discord.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';

const utilsLogger = pino({ name: 'clementine.discord-utils' });

// ── Persistent status-embed state ─────────────────────────────────────
//
// When the daemon restarts, in-memory references to status-embed messages
// are lost, so the bots used to post a fresh pinned embed every time.
// Persist (channelId, messageId) per slug so the next boot can fetch the
// existing message and edit it in place — no restart ping spam.

const STATUS_EMBED_STATE_FILE = path.join(BASE_DIR, '.agent-status-embeds.json');

type StatusEmbedStateMap = Record<string, { channelId: string; messageId: string }>;

function loadStatusEmbedState(): StatusEmbedStateMap {
  try {
    if (!existsSync(STATUS_EMBED_STATE_FILE)) return {};
    return JSON.parse(readFileSync(STATUS_EMBED_STATE_FILE, 'utf-8')) as StatusEmbedStateMap;
  } catch {
    return {};
  }
}

function saveStatusEmbedState(state: StatusEmbedStateMap): void {
  try {
    writeFileSync(STATUS_EMBED_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    utilsLogger.debug({ err }, 'Failed to save status embed state (non-fatal)');
  }
}

export function getSavedStatusEmbed(slug: string): { channelId: string; messageId: string } | null {
  const s = loadStatusEmbedState()[slug];
  return s ?? null;
}

export function setSavedStatusEmbed(slug: string, channelId: string, messageId: string): void {
  const state = loadStatusEmbedState();
  state[slug] = { channelId, messageId };
  saveStatusEmbedState(state);
}

export function clearSavedStatusEmbed(slug: string): void {
  const state = loadStatusEmbedState();
  delete state[slug];
  saveStatusEmbedState(state);
}

/**
 * Try to re-hydrate a previously-saved status embed message so that on
 * restart the bot edits it in place instead of posting a fresh one.
 * Returns the Message if still reachable, else null.
 */
export async function rehydrateStatusEmbed(
  client: Client,
  slug: string,
): Promise<Message | null> {
  const saved = getSavedStatusEmbed(slug);
  if (!saved) return null;
  try {
    const channel = await client.channels.fetch(saved.channelId).catch(() => null);
    if (!channel || !('messages' in channel)) return null;
    const msg = await (channel as any).messages.fetch(saved.messageId).catch(() => null);
    return msg ?? null;
  } catch {
    return null;
  }
}

export const STREAM_EDIT_INTERVAL = 400;
export const THINKING_INDICATOR = '\u2728 *thinking...*';
export const DISCORD_MSG_LIMIT = 2000;

// ── Credential sanitisation ───────────────────────────────────────────

export function sanitizeResponse(text: string): string {
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

export function chunkText(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^[\n ]+/, '');
  }
  return chunks;
}

export async function sendChunked(
  channel: Message['channel'],
  text: string,
): Promise<void> {
  if (!('send' in channel)) return;
  if (!text) {
    await channel.send('*(no response)*');
    return;
  }
  text = sanitizeResponse(text);
  // Last-line outbound credential redaction. Dispatcher-level redaction
  // (gateway/notifications.ts) covers cron/heartbeat sends, but chat
  // replies bypass the dispatcher and arrive here directly. Idempotent:
  // re-redacting an already-redacted string is a no-op since the
  // [REDACTED:label] markers don't match any pattern or known value.
  const { redactSecrets } = await import('../security/redact.js');
  const { text: redacted, stats } = redactSecrets(text);
  if (stats.redactionCount > 0) {
    // Log via console — pino isn't imported here and adding an import would
    // bloat this lightweight utility module.
    console.warn(
      `[clementine] sendChunked: redacted ${stats.redactionCount} credential-shaped value(s) [${stats.labelsHit.join(',')}]`,
    );
  }
  for (const chunk of chunkText(redacted, 1900)) {
    await channel.send(chunk);
  }
}

// ── Streaming message (posts as the bot user) ─────────────────────────

// ── Human-friendly tool names ──────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  Read: '\ud83d\udcd6 Reading',
  Write: '\ud83d\udcdd Writing',
  Edit: '\u270f\ufe0f Editing',
  Bash: '\u2699\ufe0f Running command',
  Grep: '\ud83d\udd0d Searching',
  Glob: '\ud83d\udcc2 Finding files',
  Agent: '\ud83e\udd16 Delegating',
  WebSearch: '\ud83c\udf10 Web search',
  WebFetch: '\ud83c\udf10 Fetching',
};

export function friendlyToolName(name: string, input?: Record<string, unknown>): string {
  // Check direct match first
  if (TOOL_LABELS[name]) {
    // Add context from input where helpful
    if (name === 'Read' && input?.file_path) {
      const fp = String(input.file_path);
      const short = fp.length > 40 ? '...' + fp.slice(-37) : fp;
      return `${TOOL_LABELS[name]} ${short}`;
    }
    if (name === 'Bash' && input?.command) {
      const cmd = String(input.command).slice(0, 40);
      return `${TOOL_LABELS[name]}: ${cmd}`;
    }
    if (name === 'Grep' && input?.pattern) {
      return `${TOOL_LABELS[name]} for "${String(input.pattern).slice(0, 30)}"`;
    }
    return TOOL_LABELS[name];
  }
  // MCP tools: strip prefix (e.g., "mcp__clementine__memory_search" → "memory_search")
  const short = name.includes('__') ? name.split('__').pop()! : name;
  return `\ud83d\udd27 ${short.replace(/_/g, ' ')}`;
}

export class DiscordStreamingMessage {
  private message: Message | null = null;
  private lastEdit = 0;
  private pendingText = '';
  private lastFlushedText = '';
  private isFinal = false;
  private channel: Message['channel'];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private toolStatus = '';
  private startTime = Date.now();
  private toolCallCount = 0;
  private lastTextTime = 0;

  /** The message ID of the final bot response (available after finalize). */
  messageId: string | null = null;

  constructor(channel: Message['channel']) {
    this.channel = channel;
  }

  async start(): Promise<void> {
    if (!('send' in this.channel)) return;
    this.message = await this.channel.send(THINKING_INDICATOR);
    this.lastEdit = Date.now();
    // Periodic refresh keeps elapsed time display current during long silent stretches
    this.progressTimer = setInterval(() => {
      if (!this.isFinal && this.toolCallCount > 3) this.flush().catch(() => {});
    }, 30_000);
  }

  /** Update the tool activity status line shown during streaming. */
  setToolStatus(status: string): void {
    this.toolStatus = status;
    this.toolCallCount++;
    // Trigger a flush so the status is actually displayed during long tool chains
    // where no text tokens are being emitted
    const elapsed = Date.now() - this.lastEdit;
    if (elapsed >= STREAM_EDIT_INTERVAL) {
      this.flush().catch(() => {});
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, STREAM_EDIT_INTERVAL - elapsed);
    }
  }

  async update(text: string): Promise<void> {
    this.pendingText = text;
    this.lastTextTime = Date.now();
    const elapsed = Date.now() - this.lastEdit;
    if (elapsed >= STREAM_EDIT_INTERVAL) {
      await this.flush();
    } else if (!this.flushTimer) {
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
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (!text) text = "*(I didn't have anything to respond with — try rephrasing or giving me more context.)*";
    text = sanitizeResponse(text);

    try {
      if (this.message) {
        if (text.length <= 1900) {
          await this.message.edit(text);
          this.messageId = this.message.id;
        } else {
          await this.message.delete().catch(() => {});
          await sendChunked(this.channel, text);
        }
      } else {
        await sendChunked(this.channel, text);
      }
    } catch (err) {
      // Delivery failed after the agent already generated a response.
      // Log loudly + persist the response text to the daily note so it isn't
      // lost silently. Don't re-throw — the callers don't have try/catch
      // around finalize() and we don't want to introduce crashes.
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        const pino = (await import('pino')).default;
        pino({ name: 'clementine.discord' }).warn(
          { err: errMsg, channelId: (this.channel as { id?: string }).id },
          'Discord delivery failed — response text saved to daily note',
        );
        const { logToDailyNote } = await import('../gateway/cron-scheduler.js');
        const preview = text.slice(0, 1500);
        logToDailyNote(`**[Discord delivery failed]** Channel \`${(this.channel as { id?: string }).id ?? 'unknown'}\` — response was:\n\n${preview}`);
      } catch { /* best-effort */ }
    }
  }

  /** Format elapsed milliseconds as human-readable duration. */
  private formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }

  private async flush(): Promise<void> {
    if (!this.message || this.isFinal) return;

    // Enhanced status when tools have been running 60s+ with no text output
    const silenceDuration = Date.now() - (this.lastTextTime || this.startTime);
    const showProgress = this.toolCallCount > 3 && silenceDuration > 60_000;

    // Skip flush if nothing changed — but always allow when showing progress (elapsed time updates)
    if (!showProgress) {
      if (!this.pendingText && !this.toolStatus) return;
      if (this.pendingText === this.lastFlushedText && !this.toolStatus) return;
    }
    let display = this.pendingText;
    let statusLine: string;
    if (showProgress) {
      const elapsed = this.formatElapsed(Date.now() - this.startTime);
      const current = this.toolStatus ? ` \u2014 ${this.toolStatus}` : '';
      statusLine = `\n\n*\ud83d\udd27 Working... (${this.toolCallCount} steps, ${elapsed})${current}*`;
    } else {
      statusLine = this.toolStatus ? `\n\n*${this.toolStatus}*` : '\n\n\u270d\ufe0f *typing...*';
    }

    if (display.length > 1900) {
      display = display.slice(0, 1900) + '\n\n*...streaming...*';
    } else if (display) {
      display = display + statusLine;
    } else {
      // No text yet — show tool status or progress as the main content
      if (showProgress) {
        const elapsed = this.formatElapsed(Date.now() - this.startTime);
        const current = this.toolStatus ? ` \u2014 ${this.toolStatus}` : '';
        display = `\u2728 *Working... (${this.toolCallCount} steps, ${elapsed})${current}*`;
      } else {
        display = this.toolStatus ? `\u2728 *${this.toolStatus}*` : THINKING_INDICATOR;
      }
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

// ── Cron embed formatting ─────────────────────────────────────────────

const CRON_PREFIX_RE = /^(✅|⏳|❌)\s/;

export type CronEmbedType = 'success' | 'progress' | 'error';

/**
 * Detect whether a notification message looks like a cron result.
 * Returns the embed type if so, or null for non-cron messages.
 */
export function detectCronType(text: string): CronEmbedType | null {
  if (text.startsWith('✅')) return 'success';
  if (text.startsWith('⏳')) return 'progress';
  if (text.includes('failed:') || text.startsWith('❌')) return 'error';
  return null;
}

const EMBED_COLORS: Record<CronEmbedType, number> = {
  success: 0x2ecc71,  // green
  progress: 0x3498db, // blue
  error: 0xe74c3c,    // red
};

/**
 * Format a cron notification as a Discord embed.
 * Returns null if the text doesn't look like a cron message.
 */
export function formatCronEmbed(text: string): EmbedBuilder | null {
  const type = detectCronType(text);
  if (!type) return null;

  // Extract job name from patterns like "✅ Unleashed task **jobName** completed:"
  // or "⏳ **jobName** — phase N complete:" or "jobName failed: ..."
  let title = 'Cron Result';
  const boldMatch = text.match(/\*\*([^*]+)\*\*/);
  if (boldMatch) {
    title = boldMatch[1];
  } else {
    // "jobName failed: ..." pattern
    const failMatch = text.match(/^(.+?)\s+failed:/);
    if (failMatch) title = failMatch[1];
  }

  // Strip the emoji prefix and job name prefix for the description body
  let description = text.replace(CRON_PREFIX_RE, '').trim();
  // Truncate to Discord embed limit
  if (description.length > 4096) {
    description = description.slice(0, 4080) + '\n\n_(truncated)_';
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(EMBED_COLORS[type])
    .setTimestamp();

  return embed;
}

