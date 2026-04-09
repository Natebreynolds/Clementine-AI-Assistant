/**
 * Clementine TypeScript — Notification dispatcher.
 *
 * Decouples heartbeat/cron DM sending from any specific channel.
 * Each channel adapter registers a sender function on startup;
 * the dispatcher fans out notifications to all registered channels.
 */

import pino from 'pino';
import type { NotificationSender, NotificationContext } from '../types.js';
import { DeliveryQueue } from './delivery-queue.js';

const logger = pino({ name: 'clementine.notifications' });

/** Safety cap — prevent runaway messages, but each channel handles its own chunking/limits. */
const MAX_MESSAGE_LENGTH = 8000;

export interface SendResult {
  delivered: boolean;
  channelErrors: Record<string, string>;
}

export class NotificationDispatcher {
  private senders = new Map<string, NotificationSender>();
  private _retryQueue: DeliveryQueue;

  constructor() {
    this._retryQueue = new DeliveryQueue();
    this._retryQueue.setSender((text, ctx) => this.sendDirect(text, ctx));
    this._retryQueue.start();
  }

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

  /** Get the retry queue size (for dashboard status). */
  get pendingRetries(): number {
    return this._retryQueue.size;
  }

  /** Send a notification; automatically queues for retry on total failure. */
  async send(text: string, context?: NotificationContext): Promise<SendResult> {
    const result = await this.sendDirect(text, context);

    // If delivery failed and there were actual senders (not "no channels"), queue for retry
    if (!result.delivered && this.senders.size > 0) {
      this._retryQueue.enqueue(text, context);
    }

    return result;
  }

  /** Direct send without retry queueing (used by retry queue itself). */
  private async sendDirect(text: string, context?: NotificationContext): Promise<SendResult> {
    if (this.senders.size === 0) {
      logger.warn('No notification senders registered — message dropped');
      return { delivered: false, channelErrors: { _: 'no channels registered' } };
    }

    // Sanity cap only — each channel sender handles its own chunking/truncation
    const capped = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n_(truncated)_'
      : text;

    const channelErrors: Record<string, string> = {};
    let anySuccess = false;

    for (const [name, sender] of this.senders) {
      try {
        await sender(capped, context);
        anySuccess = true;
      } catch (err) {
        const errMsg = String(err).slice(0, 200);
        channelErrors[name] = errMsg;
        logger.error({ err, channel: name }, `Failed to send notification via ${name}`);
      }
    }

    return { delivered: anySuccess, channelErrors };
  }

  /** Stop the retry queue timer (for graceful shutdown). */
  shutdown(): void {
    this._retryQueue.stop();
  }
}
