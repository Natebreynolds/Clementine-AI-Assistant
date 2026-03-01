/**
 * Clementine TypeScript — Slack channel adapter.
 *
 * Uses @slack/bolt with Socket Mode (no public URL required).
 * Supports streaming message updates, markdown conversion, and chunked sending.
 */

import { App } from '@slack/bolt';
import pino from 'pino';
import {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_OWNER_USER_ID,
} from '../config.js';
import type { NotificationDispatcher } from '../gateway/notifications.js';
import type { Gateway } from '../gateway/router.js';

const logger = pino({ name: 'clementine.slack' });

const STREAM_UPDATE_INTERVAL = 1500; // ms
const SLACK_MSG_LIMIT = 3900;

// ── Markdown to Slack mrkdwn ──────────────────────────────────────────

function mdToSlack(text: string): string {
  // Convert Markdown bold **text** to Slack bold *text*
  return text.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

// ── Chunked sending ───────────────────────────────────────────────────

async function sendChunkedSlack(
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

class SlackStreamingMessage {
  private client: App['client'];
  private channel: string;
  private threadTs?: string;
  private ts: string | null = null;
  private lastEdit = 0;
  private pendingText = '';
  private isFinal = false;

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

// ── Entry point ───────────────────────────────────────────────────────

export async function startSlack(
  gateway: Gateway,
  dispatcher: NotificationDispatcher,
): Promise<void> {
  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  });

  app.message(async ({ message, client }) => {
    // Type guard: only handle regular user messages
    if (!('user' in message) || !('text' in message)) return;
    if ('bot_id' in message && message.bot_id) return;
    if ('subtype' in message && message.subtype) return;

    const userId = message.user;

    // Owner-only check
    if (SLACK_OWNER_USER_ID && userId !== SLACK_OWNER_USER_ID) {
      logger.warn(`Ignored Slack message from non-owner: ${userId}`);
      return;
    }

    const text = message.text ?? '';
    if (!text) return;

    const channel = message.channel;
    const threadTs = ('thread_ts' in message ? message.thread_ts : undefined) ?? message.ts;
    const sessionKey = `slack:user:${userId}`;

    const streamer = new SlackStreamingMessage(client, channel, threadTs);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        text,
        (t) => streamer.update(t),
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err }, 'Error processing Slack message');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  });

  // Register notification sender
  async function slackNotify(text: string): Promise<void> {
    if (!SLACK_OWNER_USER_ID) return;
    try {
      const dm = await app.client.conversations.open({ users: SLACK_OWNER_USER_ID });
      const channelId = (dm.channel as { id: string })?.id;
      if (channelId) {
        await sendChunkedSlack(app.client, channelId, mdToSlack(text));
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send Slack notification');
    }
  }

  dispatcher.register('slack', slackNotify);

  logger.info('Starting Slack bot (Socket Mode)...');
  await app.start();
}
