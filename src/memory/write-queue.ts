/**
 * Async write queue for non-critical memory writes.
 *
 * Pattern: 2026-frontier agent memory layers (Mem0, Zep) defer audit and
 * observability writes off the request thread to keep p95 retrieval latency
 * low. Mem0 reports ~91% p95 latency reduction with this pattern; voice
 * agents in particular need it since there's no scrollback to recover.
 *
 * Scope: only non-user-visible writes (transcripts, recall traces, outcomes,
 * access log). User-driven mutations (memory_write, user_model, pinChunk,
 * updateFile) stay synchronous so the user sees immediate persistence.
 *
 * Trade-offs:
 *  - `recordOutcome` updates `last_outcome_score` which feeds retrieval
 *    ranking. Async-deferring it means up to one flush interval (~250ms) of
 *    EMA staleness — acceptable for ranking signal that already smooths.
 *  - On hard process kill (SIGKILL, OOM) the in-flight queue is lost. Audit
 *    writes are best-effort by design; existing call sites already swallow
 *    errors. Drain on SIGTERM/SIGUSR1 covers planned shutdowns.
 */

import pino from 'pino';

const logger = pino({ name: 'clementine.write-queue' });

export type QueueOp =
  | {
      kind: 'transcript-turn';
      sessionKey: string;
      role: string;
      content: string;
      model: string;
    }
  | {
      kind: 'recall';
      sessionKey: string;
      messageId: string | null;
      query: string;
      chunkIds: number[];
      scores: number[];
      agentSlug: string | null;
      matchTypes?: string[];
    }
  | {
      kind: 'outcome';
      outcomes: Array<{ chunkId: number; referenced: boolean }>;
      sessionKey: string | null;
    }
  | {
      kind: 'access';
      chunkIds: number[];
      accessType: string;
    };

export interface WriteQueueOpts {
  flushIntervalMs?: number;
  flushSize?: number;
  /** Hard cap on the buffer to bound memory under write storms. */
  maxBuffer?: number;
}

/**
 * Minimal write-behind queue for the memory store. Not concurrent-safe at
 * the JS level — assumes the single-process daemon model that Clementine
 * already uses for all memory writes.
 */
export class WriteQueue {
  private store: any;
  private buffer: QueueOp[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushSize: number;
  private readonly maxBuffer: number;
  private flushing = false;
  private dropped = 0;

  constructor(store: any, opts: WriteQueueOpts = {}) {
    this.store = store;
    this.flushIntervalMs = opts.flushIntervalMs ?? 250;
    this.flushSize = opts.flushSize ?? 50;
    this.maxBuffer = opts.maxBuffer ?? 5000;
  }

  /** Begin periodic flushing. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive just for the queue.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the periodic timer (does not drain). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  enqueue(op: QueueOp): void {
    if (this.buffer.length >= this.maxBuffer) {
      // Hard cap — drop oldest to bound memory. Surfaces in stats().
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(op);
    if (this.buffer.length >= this.flushSize) {
      void this.flush();
    }
  }

  size(): number {
    return this.buffer.length;
  }

  stats(): { size: number; dropped: number } {
    return { size: this.buffer.length, dropped: this.dropped };
  }

  /**
   * Apply all queued ops to the store. Ops that fail are logged and skipped;
   * they don't block the rest of the batch. Concurrent calls collapse — the
   * second caller exits immediately if a flush is in progress.
   */
  async flush(): Promise<{ flushed: number; errors: number }> {
    if (this.flushing) return { flushed: 0, errors: 0 };
    if (this.buffer.length === 0) return { flushed: 0, errors: 0 };
    this.flushing = true;
    const batch = this.buffer.splice(0);
    let flushed = 0;
    let errors = 0;
    try {
      for (const op of batch) {
        try {
          this.apply(op);
          flushed++;
        } catch (err) {
          errors++;
          logger.warn({ err, kind: op.kind }, 'Write op failed');
        }
      }
    } finally {
      this.flushing = false;
    }
    return { flushed, errors };
  }

  /**
   * Stop the timer and flush everything currently buffered. Loops until
   * the buffer is empty so any ops enqueued during a flush also drain.
   */
  async drain(): Promise<void> {
    this.stop();
    // Yield to let any in-flight flush finish, then keep flushing until empty.
    while (this.buffer.length > 0 || this.flushing) {
      if (this.flushing) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      await this.flush();
    }
  }

  private apply(op: QueueOp): void {
    // Call the sync variants directly. The public methods route through this
    // queue when enabled — calling them here would re-enqueue and infinite-loop.
    switch (op.kind) {
      case 'transcript-turn':
        this.store._saveTurnSync?.(op.sessionKey, op.role, op.content, op.model);
        break;
      case 'recall':
        this.store._logRecallTraceSync?.({
          sessionKey: op.sessionKey,
          messageId: op.messageId,
          query: op.query,
          chunkIds: op.chunkIds,
          scores: op.scores,
          agentSlug: op.agentSlug,
          matchTypes: op.matchTypes,
        });
        break;
      case 'outcome':
        this.store._recordOutcomeSync?.(op.outcomes, op.sessionKey);
        break;
      case 'access':
        this.store._recordAccessSync?.(op.chunkIds, op.accessType);
        break;
    }
  }
}

/** Convenience: install SIGTERM/SIGUSR1 drain hooks on the process. */
export function installShutdownDrain(queue: WriteQueue): void {
  const drainAndExit = (signal: string) => {
    logger.info({ signal, pending: queue.size() }, 'Draining write queue on shutdown');
    queue
      .drain()
      .catch((err) => logger.warn({ err }, 'Drain failed'))
      .finally(() => {
        // Don't exit here — caller's signal handler may have other cleanup.
        // We just guarantee the queue is empty before the process tears down.
      });
  };
  process.on('SIGTERM', () => drainAndExit('SIGTERM'));
  process.on('SIGUSR1', () => drainAndExit('SIGUSR1'));
}
