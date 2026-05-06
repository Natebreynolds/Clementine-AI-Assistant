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

/**
 * Recover the owning hired-agent slug from a session key when the
 * caller forgot to set `context.agentSlug` explicitly. Pure pattern
 * matching — no I/O, no registry lookups — so it's cheap to run on
 * every send. Catches the most common autonomous-path key shapes:
 *
 *   heartbeat:<slug>            → <slug>
 *   agent-heartbeat:<slug>      → <slug>
 *   team-task:<from>-><to>      → <to>   (the receiving agent owns the result)
 *   discord:agent:<slug>:*      → <slug>
 *   discord:member:*:<slug>:*   → <slug>
 *   discord:member-dm:<slug>:*  → <slug>
 *
 * The cron path uses `cron:<jobName>` which deliberately does NOT
 * encode the agent slug — cron-scheduler.ts threads `agentSlug`
 * explicitly via `dispatchContextForJob()` instead.
 *
 * Returns undefined for keys that look like a Clementine-owned path
 * (slug === 'clementine', no slug encoded, etc.) — the channel layer
 * then routes through Clementine's main bot, which is correct.
 *
 * Exported so tests can pin the contract.
 */
export function inferAgentSlugFromSessionKey(sessionKey: string): string | undefined {
  const heartbeatMatch = /^(?:agent-)?heartbeat:([^:]+)$/.exec(sessionKey);
  if (heartbeatMatch && heartbeatMatch[1] !== 'clementine') {
    return heartbeatMatch[1];
  }
  const teamTaskMatch = /^team-task:[^:]+->([^:]+)$/.exec(sessionKey);
  if (teamTaskMatch && teamTaskMatch[1] !== 'clementine') {
    return teamTaskMatch[1];
  }
  const discordAgentMatch = /^discord:agent:([^:]+):/.exec(sessionKey);
  if (discordAgentMatch && discordAgentMatch[1] !== 'clementine') {
    return discordAgentMatch[1];
  }
  const memberDmMatch = /^discord:member-dm:([^:]+):/.exec(sessionKey);
  if (memberDmMatch && memberDmMatch[1] !== 'clementine') {
    return memberDmMatch[1];
  }
  // discord:member:<channelId>:<slug>:<userId>
  const memberMatch = /^discord:member:[^:]+:([^:]+):/.exec(sessionKey);
  if (memberMatch && memberMatch[1] !== 'clementine') {
    return memberMatch[1];
  }
  return undefined;
}

export interface SendResult {
  delivered: boolean;
  channelErrors: Record<string, string>;
}

/**
 * Fill in `context.agentSlug` from `context.sessionKey` when the
 * caller didn't set it. Pure, side-effect-free; returns the original
 * context unchanged when nothing can be inferred.
 *
 * Centralised so both the public `send()` entrypoint AND the retry
 * queue's `sendDirect` go through it — a request that falls into the
 * retry queue without an explicit agentSlug must not lose its routing
 * the second time around either.
 */
function enrichContext(context?: NotificationContext): NotificationContext | undefined {
  if (!context) return context;
  if (context.agentSlug) return context;
  if (!context.sessionKey) return context;
  const inferred = inferAgentSlugFromSessionKey(context.sessionKey);
  if (!inferred) return context;
  return { ...context, agentSlug: inferred };
}

export class NotificationDispatcher {
  private senders = new Map<string, NotificationSender>();
  private _retryQueue: DeliveryQueue;

  constructor() {
    this._retryQueue = new DeliveryQueue();
    this._retryQueue.setSender((text, ctx) => this.sendDirect(text, enrichContext(ctx)));
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

    // Defense-in-depth: if a caller forgot `agentSlug` but their
    // sessionKey encodes a hired agent (heartbeat/team-task/discord
    // member sessions), recover it here so the channel layer routes
    // through that agent's bot instead of leaking out via Clementine's
    // main DM. Explicit `agentSlug` always wins.
    const enriched = enrichContext(context);
    if (!context?.agentSlug && enriched?.agentSlug) {
      logger.debug(
        { sessionKey: context?.sessionKey, inferredAgentSlug: enriched.agentSlug },
        'Inferred agentSlug from sessionKey for routing',
      );
    }

    const result = await this.sendDirect(redacted, enriched);

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
