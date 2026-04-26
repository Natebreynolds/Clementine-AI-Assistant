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
import { redactSecrets } from '../security/redact.js';

const logger = pino({ name: 'clementine.notifications' });

/** Safety cap — prevent runaway messages, but each channel handles its own chunking/limits. */
const MAX_MESSAGE_LENGTH = 8000;

/** Map a sessionKey prefix to the registered channel name that owns it. */
function channelForSessionKey(sessionKey: string): string | null {
  if (sessionKey.startsWith('discord:')) return 'discord';
  if (sessionKey.startsWith('slack:')) return 'slack';
  if (sessionKey.startsWith('telegram:')) return 'telegram';
  if (sessionKey.startsWith('whatsapp:')) return 'whatsapp';
  if (sessionKey.startsWith('dashboard:')) return 'dashboard';
  return null;
}

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
    // Outbound credential redaction happens HERE, at the public entrypoint,
    // BEFORE any failure could enqueue the message for retry. Otherwise an
    // un-redacted credential would persist to ~/.clementine/.delivery-queue.json
    // for the retry window. Pattern-based + known-value scan; cheap enough to
    // run on every send. See src/security/redact.ts for policy.
    const { text: redacted, stats: redactionStats } = redactSecrets(text);
    if (redactionStats.redactionCount > 0) {
      logger.warn(
        { count: redactionStats.redactionCount, labels: redactionStats.labelsHit, sessionKey: context?.sessionKey },
        `Redacted ${redactionStats.redactionCount} credential-shaped value(s) before delivery`,
      );
    }

    const result = await this.sendDirect(redacted, context);

    // If delivery failed and there were actual senders (not "no channels"), queue for retry.
    // Stored text is already-redacted so disk persistence never holds a credential.
    if (!result.delivered && this.senders.size > 0) {
      this._retryQueue.enqueue(redacted, context);
    }

    return result;
  }

  /** Direct send without retry queueing (used by retry queue itself). */
  private async sendDirect(text: string, context?: NotificationContext): Promise<SendResult> {
    if (this.senders.size === 0) {
      logger.warn('No notification senders registered — message dropped');
      return { delivered: false, channelErrors: { _: 'no channels registered' } };
    }

    // Sanity cap only — each channel sender handles its own chunking/truncation.
    // Redaction happens at send() (public entrypoint) before any retry-enqueue,
    // so anything reaching here is already safe.
    const capped = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n_(truncated)_'
      : text;

    // If sessionKey is set, route only to the channel that owns it.
    // Fan out to all channels only when no originating channel is known.
    const targetChannel = context?.sessionKey ? channelForSessionKey(context.sessionKey) : null;
    const scopedSenders: Array<[string, NotificationSender]> = [];
    if (targetChannel && this.senders.has(targetChannel)) {
      scopedSenders.push([targetChannel, this.senders.get(targetChannel)!]);
    } else {
      for (const entry of this.senders) scopedSenders.push(entry);
    }

    const channelErrors: Record<string, string> = {};
    let anySuccess = false;

    for (const [name, sender] of scopedSenders) {
      try {
        await sender(capped, context);
        anySuccess = true;
      } catch (err) {
        const errMsg = String(err).slice(0, 200);
        channelErrors[name] = errMsg;
        logger.error({ err, channel: name }, `Failed to send notification via ${name}`);
      }
    }

    // Extract and persist claims from successfully-delivered messages.
    // Fire-and-forget — extraction errors never block delivery.
    if (anySuccess) {
      void this._trackClaims(capped, context);
    }

    return { delivered: anySuccess, channelErrors };
  }

  private async _trackClaims(text: string, context?: NotificationContext): Promise<void> {
    try {
      const { extractClaims, recordClaims } = await import('./claim-tracker.js');
      const claims = extractClaims(text, context?.sessionKey ?? null, context?.agentSlug ?? null);
      if (claims.length > 0) await recordClaims(claims);
    } catch (err) {
      logger.debug({ err }, 'Claim extraction failed (non-fatal)');
    }
  }

  /** Stop the retry queue timer (for graceful shutdown). */
  shutdown(): void {
    this._retryQueue.stop();
  }
}
