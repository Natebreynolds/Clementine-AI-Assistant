/**
 * Clementine TypeScript — Notification dispatcher.
 *
 * Decouples heartbeat/cron DM sending from any specific channel.
 * Each channel adapter registers a sender function on startup;
 * the dispatcher fans out notifications to all registered channels.
 */

import pino from 'pino';
import type { NotificationSender } from '../types.js';

const logger = pino({ name: 'clementine.notifications' });

/** Message size limits for common platforms. */
const MAX_MESSAGE_LENGTH = 1900; // Discord limit is 2000; leave margin

export interface SendResult {
  delivered: boolean;
  channelErrors: Record<string, string>;
}

export class NotificationDispatcher {
  private senders = new Map<string, NotificationSender>();

  register(channelName: string, senderFn: NotificationSender): void {
    this.senders.set(channelName, senderFn);
    logger.info(`Notification sender registered: ${channelName}`);
  }

  unregister(channelName: string): void {
    this.senders.delete(channelName);
    logger.info(`Notification sender unregistered: ${channelName}`);
  }

  get hasChannels(): boolean {
    return this.senders.size > 0;
  }

  async send(text: string): Promise<SendResult> {
    if (this.senders.size === 0) {
      logger.warn('No notification senders registered — message dropped');
      return { delivered: false, channelErrors: { _: 'no channels registered' } };
    }

    // Truncate oversized messages to avoid platform rejections
    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n_(truncated)_'
      : text;

    const channelErrors: Record<string, string> = {};
    let anySuccess = false;

    for (const [name, sender] of this.senders) {
      try {
        await sender(truncated);
        anySuccess = true;
      } catch (err) {
        const errMsg = String(err).slice(0, 200);
        channelErrors[name] = errMsg;
        logger.error({ err, channel: name }, `Failed to send notification via ${name}`);
      }
    }

    return { delivered: anySuccess, channelErrors };
  }
}
