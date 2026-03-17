/**
 * Clementine TypeScript — Shared Discord utilities.
 *
 * Extracted from discord.ts so agent bot clients can reuse streaming,
 * chunking, and sanitization without importing the monolith.
 */

import type { Message } from 'discord.js';

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
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
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
  for (const chunk of chunkText(text, 1900)) {
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
    if (!text) text = '*(no response)*';
    text = sanitizeResponse(text);

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

