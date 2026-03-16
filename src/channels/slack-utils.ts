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
  private isFinal = false;

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

  async update(text: string): Promise<void> {
    this.pendingText = text;
    if (Date.now() - this.lastEdit >= STREAM_UPDATE_INTERVAL) {
      await this.flush();
    }
  }

  async finalize(text: string): Promise<void> {
    this.isFinal = true;
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
    if (!this.ts || !this.pendingText || this.isFinal) return;
    let display = mdToSlack(this.pendingText);
    if (display.length > SLACK_MSG_LIMIT) {
      display = display.slice(0, SLACK_MSG_LIMIT) + '\n\n_...streaming..._';
    } else {
      display = display + '\n\n:writing_hand: _typing..._';
    }
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.ts,
        text: display,
      });
      this.lastEdit = Date.now();
    } catch {
      // Rate limit or message deleted — ignore
    }
  }
}
