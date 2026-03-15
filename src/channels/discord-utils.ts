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

export class DiscordStreamingMessage {
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
      }
    } else {
      await sendChunked(this.channel, text);
    }
  }

  private async flush(): Promise<void> {
    if (!this.message || !this.pendingText || this.isFinal) return;
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

// ── Webhook-based streaming (team agents post as their own identity) ──

export class WebhookStreamingMessage {
  private webhookUrl: string;
  private agentName: string;
  private avatarUrl?: string;
  private messageId: string | null = null;
  private lastEdit = 0;
  private pendingText = '';
  private lastFlushedText = '';
  private isFinal = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** The message ID of the final bot response (available after finalize). */
  get finalMessageId(): string | null {
    return this.messageId;
  }

  constructor(webhookUrl: string, agentName: string, avatarUrl?: string) {
    this.webhookUrl = webhookUrl;
    this.agentName = agentName;
    this.avatarUrl = avatarUrl;
  }

  async start(): Promise<void> {
    const body: Record<string, unknown> = {
      content: THINKING_INDICATOR,
      username: this.agentName,
      wait: true,
    };
    if (this.avatarUrl) body.avatar_url = this.avatarUrl;

    try {
      const res = await fetch(`${this.webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: string };
        this.messageId = data.id;
      }
    } catch {
      // Non-fatal — finalize will send a fresh message
    }
    this.lastEdit = Date.now();
  }

  async update(text: string): Promise<void> {
    this.pendingText = text;
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
    if (!text) text = '*(no response)*';
    text = sanitizeResponse(text);

    if (this.messageId) {
      if (text.length <= 1900) {
        await this.editWebhookMessage(text);
      } else {
        await this.deleteWebhookMessage();
        await this.sendChunkedViaWebhook(text);
      }
    } else {
      await this.sendChunkedViaWebhook(text);
    }
  }

  private async flush(): Promise<void> {
    if (!this.messageId || !this.pendingText || this.isFinal) return;
    if (this.pendingText === this.lastFlushedText) return;

    let display = this.pendingText;
    if (display.length > 1900) {
      display = display.slice(0, 1900) + '\n\n*...streaming...*';
    } else {
      display = display + '\n\n\u270d\ufe0f *typing...*';
    }
    try {
      await this.editWebhookMessage(display);
      this.lastFlushedText = this.pendingText;
      this.lastEdit = Date.now();
    } catch {
      // Rate limit or message deleted — ignore
    }
  }

  private async editWebhookMessage(content: string): Promise<void> {
    await fetch(`${this.webhookUrl}/messages/${this.messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  }

  private async deleteWebhookMessage(): Promise<void> {
    try {
      await fetch(`${this.webhookUrl}/messages/${this.messageId}`, {
        method: 'DELETE',
      });
    } catch { /* ignore */ }
  }

  private async sendChunkedViaWebhook(text: string): Promise<void> {
    text = sanitizeResponse(text);
    for (const chunk of chunkText(text, 1900)) {
      const body: Record<string, unknown> = {
        content: chunk,
        username: this.agentName,
      };
      if (this.avatarUrl) body.avatar_url = this.avatarUrl;

      await fetch(`${this.webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
  }
}
