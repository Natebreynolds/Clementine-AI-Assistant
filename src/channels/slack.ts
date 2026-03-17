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
  VAULT_DIR,
} from '../config.js';
import type { NotificationDispatcher } from '../gateway/notifications.js';
import type { Gateway } from '../gateway/router.js';
import type { SlackBotManager } from './slack-bot-manager.js';
import { mdToSlack, sendChunkedSlack, SlackStreamingMessage } from './slack-utils.js';
import { friendlyToolName } from './discord-utils.js';

const logger = pino({ name: 'clementine.slack' });

const BOT_MESSAGE_TRACKING_LIMIT = 100;

// ── Bot message tracking for feedback reactions ─────────────────────────

interface SlackBotMessageContext {
  sessionKey: string;
  userMessage: string;
  botResponse: string;
  channel: string;
}

/** Map of bot message ts -> context for reaction feedback. */
const slackBotMessageMap = new Map<string, SlackBotMessageContext>();

function trackSlackBotMessage(ts: string, context: SlackBotMessageContext): void {
  slackBotMessageMap.set(ts, context);
  if (slackBotMessageMap.size > BOT_MESSAGE_TRACKING_LIMIT) {
    const firstKey = slackBotMessageMap.keys().next().value;
    if (firstKey) slackBotMessageMap.delete(firstKey);
  }
}

// ── Lazy memory store for feedback logging ──────────────────────────────

let _slackFeedbackStore: any = null;

async function getSlackFeedbackStore(): Promise<any> {
  if (_slackFeedbackStore) return _slackFeedbackStore;
  try {
    const { MemoryStore } = await import('../memory/store.js');
    const { MEMORY_DB_PATH } = await import('../config.js');
    const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
    store.initialize();
    _slackFeedbackStore = store;
    return _slackFeedbackStore;
  } catch {
    return null;
  }
}

// ── Slack reaction to rating mapping ────────────────────────────────────

function slackReactionToRating(reaction: string): 'positive' | 'negative' | null {
  const positive = ['+1', 'thumbsup', 'heart', 'star', 'tada', 'raised_hands', 'white_check_mark'];
  const negative = ['-1', 'thumbsdown'];
  if (positive.includes(reaction)) return 'positive';
  if (negative.includes(reaction)) return 'negative';
  return null;
}

// ── Entry point ───────────────────────────────────────────────────────

export async function startSlack(
  gateway: Gateway,
  dispatcher: NotificationDispatcher,
  slackBotManager?: SlackBotManager,
): Promise<void> {
  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Catch Socket Mode errors so they don't crash the daemon
  app.error(async (error) => {
    logger.error({ err: error }, 'Slack app error — continuing');
  });

  app.message(async ({ message, client }) => {
    try {
    // Type guard: only handle regular user messages
    if (!('user' in message) || !('text' in message)) return;
    if ('bot_id' in message && message.bot_id) return;
    if ('subtype' in message && message.subtype) return;

    // Skip channels owned by agent bots (they handle their own messages)
    if (slackBotManager?.getOwnedChannelIds().includes(message.channel)) return;

    const userId = message.user;

    // Owner-only check
    if (SLACK_OWNER_USER_ID && userId !== SLACK_OWNER_USER_ID) {
      logger.warn(`Ignored Slack message from non-owner: ${userId}`);
      return;
    }

    let text = message.text ?? '';

    // Extract file attachments (images and files)
    const msgFiles = 'files' in message ? (message as any).files : undefined;
    if (msgFiles && Array.isArray(msgFiles) && msgFiles.length > 0) {
      const fileLines = msgFiles.map((file: any) => {
        if (file.mimetype?.startsWith('image/')) {
          return `[Image attached: ${file.name} (${file.url_private})]`;
        }
        return `[File attached: ${file.name}, ${file.mimetype || 'unknown type'}, ${file.url_private}]`;
      });
      text = fileLines.join('\n') + (text ? '\n' + text : '');
    }

    if (!text) return;

    const channel = message.channel;
    const threadTs = ('thread_ts' in message ? message.thread_ts : undefined) ?? message.ts;
    const sessionKey = `slack:user:${userId}`;

    // ── !stop — abort active query (bypasses session lock) ────────────
    if (text === '!stop' || text === '/stop') {
      const stopped = gateway.stopSession(sessionKey);
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: stopped ? 'Stopping...' : 'Nothing running to stop.' });
      return;
    }

    // ── !verbose command intercept ─────────────────────────────────
    if (text.startsWith('!verbose')) {
      const parts = text.split(/\s+/);
      const level = parts[1]?.toLowerCase();
      if (level === 'quiet' || level === 'normal' || level === 'detailed') {
        gateway.setSessionVerboseLevel(sessionKey, level);
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: `Verbose level set to *${level}*.` });
      } else {
        const current = gateway.getSessionVerboseLevel(sessionKey) ?? 'normal';
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: `Current verbose level: *${current}*\nOptions: \`!verbose quiet\`, \`!verbose normal\`, \`!verbose detailed\`` });
      }
      return;
    }

    const streamer = new SlackStreamingMessage(client, channel, threadTs);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        text,
        (t) => streamer.update(t),
        undefined, // model
        undefined, // maxTurns
        async (toolName, toolInput) => { streamer.setToolStatus(friendlyToolName(toolName, toolInput)); },
      );
      await streamer.finalize(response);

      // Track bot message for feedback reactions
      if (streamer.messageTs) {
        trackSlackBotMessage(streamer.messageTs, {
          sessionKey,
          userMessage: text.slice(0, 500),
          botResponse: response.slice(0, 500),
          channel,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error processing Slack message');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
    } catch (err) {
      logger.error({ err }, 'Unhandled error in Slack message handler');
    }
  });

  // ── Reaction-based feedback handler ─────────────────────────────────

  app.event('reaction_added', async ({ event }) => {
    // Owner-only
    if (SLACK_OWNER_USER_ID && event.user !== SLACK_OWNER_USER_ID) return;

    // Check if reaction is on a tracked bot message
    const itemTs = 'ts' in event.item ? (event.item as any).ts : undefined;
    if (!itemTs) return;

    const context = slackBotMessageMap.get(itemTs);
    if (!context) return;

    // Map reaction to rating
    const rating = slackReactionToRating(event.reaction);
    if (!rating) return;

    // Log feedback
    try {
      const store = await getSlackFeedbackStore();
      if (store) {
        store.logFeedback({
          sessionKey: context.sessionKey,
          channel: 'slack',
          messageSnippet: context.userMessage,
          responseSnippet: context.botResponse,
          rating,
        });
        logger.info({ rating, ts: itemTs }, 'Feedback logged via Slack reaction');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to log Slack reaction feedback');
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
