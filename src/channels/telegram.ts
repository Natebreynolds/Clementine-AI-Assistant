/**
 * Clementine TypeScript — Telegram channel adapter.
 *
 * Uses grammY for long polling. Supports streaming message edits,
 * markdown conversion, message chunking, and voice message handling (placeholder).
 */

import { Bot } from 'grammy';
import pino from 'pino';
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
} from '../config.js';
import type { NotificationDispatcher } from '../gateway/notifications.js';
import type { Gateway } from '../gateway/router.js';

const logger = pino({ name: 'clementine.telegram' });

const STREAM_UPDATE_INTERVAL = 1500; // ms
const TELEGRAM_MSG_LIMIT = 4096;

// ── Markdown conversion ───────────────────────────────────────────────

function mdToTelegram(text: string): string {
  // Convert Markdown bold **text** to single-asterisk for plain text mode
  return text.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

// ── Chunked sending ───────────────────────────────────────────────────

async function sendChunked(
  bot: Bot,
  chatId: number | string,
  text: string,
): Promise<void> {
  let remaining = text;
  while (remaining) {
    if (remaining.length <= TELEGRAM_MSG_LIMIT) {
      await bot.api.sendMessage(chatId, remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MSG_LIMIT);
    if (splitAt === -1) splitAt = TELEGRAM_MSG_LIMIT;
    await bot.api.sendMessage(chatId, remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
}

// ── Streaming message ─────────────────────────────────────────────────

class TelegramStreamingMessage {
  private bot: Bot;
  private chatId: number | string;
  private messageId: number | null = null;
  private lastEdit = 0;
  private pendingText = '';
  private isFinal = false;

  constructor(bot: Bot, chatId: number | string) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async start(): Promise<void> {
    const msg = await this.bot.api.sendMessage(
      this.chatId,
      '\u2728 _thinking\\.\\.\\._',
      { parse_mode: 'MarkdownV2' },
    );
    this.messageId = msg.message_id;
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
    text = mdToTelegram(text);

    if (this.messageId) {
      if (text.length <= TELEGRAM_MSG_LIMIT) {
        try {
          await this.bot.api.editMessageText(this.chatId, this.messageId, text);
        } catch {
          // If edit fails (message unchanged), send new
          await sendChunked(this.bot, this.chatId, text);
        }
      } else {
        // Delete placeholder and send in chunks
        try {
          await this.bot.api.deleteMessage(this.chatId, this.messageId);
        } catch {
          // Ignore delete failure
        }
        await sendChunked(this.bot, this.chatId, text);
      }
    } else {
      await sendChunked(this.bot, this.chatId, text);
    }
  }

  private async flush(): Promise<void> {
    if (this.messageId === null || !this.pendingText || this.isFinal) return;
    let display = mdToTelegram(this.pendingText);
    if (display.length > TELEGRAM_MSG_LIMIT - 20) {
      display = display.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n\n...streaming...';
    } else {
      display = display + '\n\n\u270d\ufe0f typing...';
    }
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, display);
      this.lastEdit = Date.now();
    } catch {
      // Rate limit or message unchanged — ignore
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────

export async function startTelegram(
  gateway: Gateway,
  dispatcher: NotificationDispatcher,
): Promise<void> {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  const ownerIdNum = Number(TELEGRAM_OWNER_ID);

  // Catch errors from Grammy so they don't crash the daemon
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'Telegram bot error — continuing');
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Owner-only check
    if (TELEGRAM_OWNER_ID && userId !== ownerIdNum) {
      logger.warn(`Ignored Telegram message from non-owner: ${userId}`);
      return;
    }

    const text = ctx.message.text ?? '';
    if (!text) return;

    const chatId = ctx.chat.id;
    const sessionKey = `telegram:user:${userId}`;

    const streamer = new TelegramStreamingMessage(bot, chatId);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        text,
        (t) => streamer.update(t),
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram message');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  });

  // Photo message handler — extracts image URL and forwards to gateway
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (TELEGRAM_OWNER_ID && userId !== ownerIdNum) return;

    // Get the largest photo size (last in the array)
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const caption = ctx.message.caption || '';
    const text = `[Image attached: photo (${fileUrl})]\n${caption}`.trim();

    const chatId = ctx.chat.id;
    const sessionKey = `telegram:user:${userId}`;

    const streamer = new TelegramStreamingMessage(bot, chatId);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        text,
        (t) => streamer.update(t),
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram photo');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  });

  // Document message handler — extracts file URL and forwards to gateway
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (TELEGRAM_OWNER_ID && userId !== ownerIdNum) return;

    const doc = ctx.message.document;
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const caption = ctx.message.caption || '';
    const isImage = doc.mime_type?.startsWith('image/');
    const prefix = isImage
      ? `[Image attached: ${doc.file_name} (${fileUrl})]`
      : `[File attached: ${doc.file_name}, ${doc.mime_type || 'unknown type'}, ${fileUrl}]`;

    const text = `${prefix}\n${caption}`.trim();

    const chatId = ctx.chat.id;
    const sessionKey = `telegram:user:${userId}`;

    const streamer = new TelegramStreamingMessage(bot, chatId);
    await streamer.start();

    try {
      const response = await gateway.handleMessage(
        sessionKey,
        text,
        (t) => streamer.update(t),
      );
      await streamer.finalize(response);
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram document');
      await streamer.finalize(`Something went wrong: ${err}`);
    }
  });

  // Voice message handler (placeholder — note for future STT integration)
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (TELEGRAM_OWNER_ID && userId !== ownerIdNum) return;

    // TODO: Download voice file, transcribe via Groq Whisper STT
    await ctx.reply('Voice messages are not yet supported in this version.');
  });

  // Register notification sender
  async function telegramNotify(text: string): Promise<void> {
    if (!TELEGRAM_OWNER_ID || ownerIdNum === 0) return;
    try {
      const notifyText = mdToTelegram(text);
      await sendChunked(bot, ownerIdNum, notifyText);
    } catch (err) {
      logger.error({ err }, 'Failed to send Telegram notification');
    }
  }

  dispatcher.register('telegram', telegramNotify);

  logger.info('Starting Telegram bot (long polling)...');
  await bot.start({
    drop_pending_updates: true,
    onStart: () => logger.info('Telegram bot polling started'),
  });
}
