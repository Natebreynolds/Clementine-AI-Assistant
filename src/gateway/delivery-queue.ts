/**
 * Clementine TypeScript — Delivery retry queue.
 *
 * File-backed queue for messages that failed to deliver.
 * Retries up to 3 times on a 5-minute interval, then logs as permanently failed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import type { NotificationContext } from '../types.js';
import { logToDailyNote } from './cron-scheduler.js';

const logger = pino({ name: 'clementine.delivery-queue' });

const QUEUE_FILE = path.join(BASE_DIR, 'delivery-queue.json');
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface QueuedMessage {
  text: string;
  context?: NotificationContext;
  attempts: number;
  firstAttempt: string; // ISO timestamp
  lastAttempt: string;  // ISO timestamp
}

type SendFn = (text: string, context?: NotificationContext) => Promise<{ delivered: boolean }>;

export class DeliveryQueue {
  private queue: QueuedMessage[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendFn: SendFn | null = null;

  constructor() {
    this.load();
  }

  /** Register the send function (from NotificationDispatcher). */
  setSender(fn: SendFn): void {
    this.sendFn = fn;
  }

  /** Start the retry drain loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain(), RETRY_INTERVAL_MS);
    // Also do an immediate drain if there are queued items from a previous run
    if (this.queue.length > 0) {
      setTimeout(() => this.drain(), 10_000); // brief delay to let channels connect
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Enqueue a failed message for retry. */
  enqueue(text: string, context?: NotificationContext): void {
    const now = new Date().toISOString();
    this.queue.push({
      text,
      context,
      attempts: 1, // already tried once (the initial send that failed)
      firstAttempt: now,
      lastAttempt: now,
    });
    this.save();
    logger.info({ queueSize: this.queue.length }, 'Message queued for retry');
  }

  /** Drain the queue: retry each message, remove successes and expired items. */
  private async drain(): Promise<void> {
    if (this.queue.length === 0 || !this.sendFn) return;

    logger.debug({ queueSize: this.queue.length }, 'Draining delivery queue');
    const remaining: QueuedMessage[] = [];

    for (const msg of this.queue) {
      msg.attempts++;
      msg.lastAttempt = new Date().toISOString();

      try {
        const result = await this.sendFn(msg.text, msg.context);
        if (result.delivered) {
          logger.info({ attempts: msg.attempts }, 'Queued message delivered on retry');
          continue; // success — don't keep in queue
        }
      } catch (err) {
        logger.debug({ err }, 'Retry delivery attempt failed');
      }

      if (msg.attempts >= MAX_ATTEMPTS) {
        // Permanently failed — log to daily note so the user can find it
        const preview = msg.text.slice(0, 100).replace(/\n/g, ' ');
        logToDailyNote(`**[Delivery permanently failed]** (${msg.attempts} attempts): ${preview}`);
        logger.warn({ attempts: msg.attempts, preview }, 'Message permanently failed delivery — logged to daily note');
        continue; // drop from queue
      }

      remaining.push(msg);
    }

    this.queue = remaining;
    this.save();
  }

  get size(): number {
    return this.queue.length;
  }

  private load(): void {
    if (!existsSync(QUEUE_FILE)) return;
    try {
      this.queue = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
    } catch {
      logger.warn('Failed to parse delivery queue file — starting fresh');
      this.queue = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(QUEUE_FILE, JSON.stringify(this.queue, null, 2));
    } catch (err) {
      logger.debug({ err }, 'Failed to persist delivery queue');
    }
  }
}
