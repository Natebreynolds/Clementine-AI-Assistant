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

  async send(text: string): Promise<void> {
    if (this.senders.size === 0) {
      logger.warn('No notification senders registered — message dropped');
      return;
    }

    for (const [name, sender] of this.senders) {
      try {
        await sender(text);
      } catch (err) {
        logger.error({ err, channel: name }, `Failed to send notification via ${name}`);
      }
    }
  }
}
