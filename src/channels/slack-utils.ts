/**
 * Clementine TypeScript — Shared Slack utilities.
 *
 * Extracted from slack.ts so agent bot clients can reuse streaming,
 * markdown conversion, and chunked sending without importing the monolith.
 */

import type { App } from '@slack/bolt';

export const STREAM_UPDATE_INTERVAL = 1500; // ms
export const SLACK_MSG_LIMIT = 3900;

// ── Markdown to Slack mrkdwn ──────────────────────────────────────────

export function mdToSlack(text: string): string {
  // Convert Markdown bold **text** to Slack bold *text*
  return text.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

// ── Chunked sending ───────────────────────────────────────────────────

export async function sendChunkedSlack(
  client: App['client'],
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  let remaining = text;
  while (remaining) {
    if (remaining.length <= SLACK_MSG_LIMIT) {
      await client.chat.postMessage({ channel, text: remaining, thread_ts: threadTs });
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', SLACK_MSG_LIMIT);
    if (splitAt === -1) splitAt = SLACK_MSG_LIMIT;
    await client.chat.postMessage({ channel, text: remaining.slice(0, splitAt), thread_ts: threadTs });
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
}

// ── Streaming message ─────────────────────────────────────────────────

export class SlackStreamingMessage {
  private client: App['client'];
  private channel: string;
  private threadTs?: string;
  private ts: string | null = null;
  private lastEdit = 0;
  private pendingText = '';
  private lastFlushedText = '';
  private isFinal = false;
  private toolStatus = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** The message timestamp (available after start). Used for reaction tracking. */
  get messageTs(): string | null { return this.ts; }

  constructor(client: App['client'], channel: string, threadTs?: string) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
  }

  async start(): Promise<void> {
    const result = await this.client.chat.postMessage({
      channel: this.channel,
      text: ':sparkles: _thinking..._',
      thread_ts: this.threadTs,
    });
    this.ts = result.ts ?? null;
    this.lastEdit = Date.now();
  }

  /** Update the tool activity status line shown during streaming. */
  setToolStatus(status: string): void {
    this.toolStatus = status;
    // Trigger a flush so the status is displayed during long tool chains
    const elapsed = Date.now() - this.lastEdit;
    if (elapsed >= STREAM_UPDATE_INTERVAL) {
      this.flush().catch(() => {});
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, STREAM_UPDATE_INTERVAL - elapsed);
    }
  }

  async update(text: string): Promise<void> {
    this.pendingText = text;
    const elapsed = Date.now() - this.lastEdit;
    if (elapsed >= STREAM_UPDATE_INTERVAL) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, STREAM_UPDATE_INTERVAL - elapsed);
    }
  }

  async finalize(text: string): Promise<void> {
    this.isFinal = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!text) text = '_(no response)_';
    text = mdToSlack(text);

    if (this.ts) {
      if (text.length <= SLACK_MSG_LIMIT) {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.ts,
          text,
        });
      } else {
        await this.client.chat.delete({ channel: this.channel, ts: this.ts }).catch(() => {});
        await sendChunkedSlack(this.client, this.channel, text, this.threadTs);
      }
    } else {
      await sendChunkedSlack(this.client, this.channel, text, this.threadTs);
    }
  }

  private async flush(): Promise<void> {
    if (!this.ts || this.isFinal) return;
    if (!this.pendingText && !this.toolStatus) return;
    if (this.pendingText === this.lastFlushedText && !this.toolStatus) return;
    let display = mdToSlack(this.pendingText);
    const statusLine = this.toolStatus ? `\n\n_${this.toolStatus}_` : '\n\n:writing_hand: _typing..._';
    if (display.length > SLACK_MSG_LIMIT) {
      display = display.slice(0, SLACK_MSG_LIMIT) + '\n\n_...streaming..._';
    } else if (display) {
      display = display + statusLine;
    } else {
      // No text yet — show tool status as the main content
      display = this.toolStatus ? `:sparkles: _${this.toolStatus}_` : ':sparkles: _thinking..._';
    }
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.ts,
        text: display,
      });
      this.lastFlushedText = this.pendingText;
      this.lastEdit = Date.now();
    } catch {
      // Rate limit or message deleted — ignore
    }
  }
}
