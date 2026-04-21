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
const DLQ_FILE = path.join(BASE_DIR, 'delivery-dlq.json');
const DLQ_MAX_ENTRIES = 500;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface QueuedMessage {
  text: string;
  context?: NotificationContext;
  attempts: number;
  firstAttempt: string; // ISO timestamp
  lastAttempt: string;  // ISO timestamp
}

interface DlqEntry extends QueuedMessage {
  failedAt: string;
  reason: string;
}

type SendFn = (text: string, context?: NotificationContext) => Promise<{ delivered: boolean }>;
type PermanentFailureFn = (entry: DlqEntry) => void | Promise<void>;

export class DeliveryQueue {
  private queue: QueuedMessage[] = [];
  private dlq: DlqEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendFn: SendFn | null = null;
  private onPermanentFailure: PermanentFailureFn | null = null;

  constructor() {
    this.load();
    this.loadDlq();
  }

  /** Register the send function (from NotificationDispatcher). */
  setSender(fn: SendFn): void {
    this.sendFn = fn;
  }

  /**
   * Register a callback invoked once per permanent failure (after MAX_ATTEMPTS).
   * Wire this to an owner-alerting channel (Discord DM, email, etc.) so drops
   * don't stay hidden in daily notes.
   */
  setOnPermanentFailure(fn: PermanentFailureFn): void {
    this.onPermanentFailure = fn;
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
        // Permanently failed — persist to DLQ for dashboard replay + surface to owner
        const preview = msg.text.slice(0, 100).replace(/\n/g, ' ');
        const entry: DlqEntry = {
          ...msg,
          failedAt: new Date().toISOString(),
          reason: 'max_attempts_exceeded',
        };
        this.dlq.push(entry);
        if (this.dlq.length > DLQ_MAX_ENTRIES) this.dlq = this.dlq.slice(-DLQ_MAX_ENTRIES);
        this.saveDlq();
        logToDailyNote(`**[Delivery permanently failed]** (${msg.attempts} attempts): ${preview}`);
        logger.warn({ attempts: msg.attempts, preview, dlqSize: this.dlq.length }, 'Message permanently failed delivery — moved to DLQ');
        if (this.onPermanentFailure) {
          try { await this.onPermanentFailure(entry); }
          catch (err) { logger.debug({ err }, 'Permanent-failure hook threw'); }
        }
        continue; // drop from retry queue
      }

      remaining.push(msg);
    }

    this.queue = remaining;
    this.save();
  }

  get size(): number {
    return this.queue.length;
  }

  /** Read-only snapshot of the DLQ (most recent first). */
  getDlq(): DlqEntry[] {
    return [...this.dlq].reverse();
  }

  get dlqSize(): number {
    return this.dlq.length;
  }

  /**
   * Move DLQ entries back to the retry queue for another attempt. Returns the
   * number of entries requeued. Intended for a dashboard "replay" button.
   */
  replayDlq(filter?: (entry: DlqEntry) => boolean): number {
    if (this.dlq.length === 0) return 0;
    const now = new Date().toISOString();
    const toReplay = filter ? this.dlq.filter(filter) : [...this.dlq];
    for (const entry of toReplay) {
      this.queue.push({
        text: entry.text,
        context: entry.context,
        attempts: 0,
        firstAttempt: now,
        lastAttempt: now,
      });
    }
    this.dlq = filter ? this.dlq.filter(e => !filter(e)) : [];
    this.save();
    this.saveDlq();
    logger.info({ replayed: toReplay.length, queueSize: this.queue.length }, 'DLQ entries replayed');
    return toReplay.length;
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

  private loadDlq(): void {
    if (!existsSync(DLQ_FILE)) return;
    try {
      this.dlq = JSON.parse(readFileSync(DLQ_FILE, 'utf-8'));
    } catch {
      logger.warn('Failed to parse DLQ file — starting fresh');
      this.dlq = [];
    }
  }

  private saveDlq(): void {
    try {
      writeFileSync(DLQ_FILE, JSON.stringify(this.dlq, null, 2));
    } catch (err) {
      logger.debug({ err }, 'Failed to persist DLQ');
    }
  }
}
