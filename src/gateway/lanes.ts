/**
 * Clementine TypeScript — Lane-based concurrency control.
 *
 * Separates work into independent concurrency pools so cron jobs
 * can't starve chat responses and vice versa.
 */

import pino from 'pino';

const logger = pino({ name: 'clementine.lanes' });

export type Lane = 'chat' | 'cron' | 'heartbeat';

class LaneController {
  private limits: Record<Lane, number> = {
    chat: 3,      // Up to 3 concurrent chat sessions
    cron: 2,      // Up to 2 concurrent cron jobs
    heartbeat: 1, // Only 1 heartbeat at a time
  };

  private active: Record<Lane, number> = {
    chat: 0,
    cron: 0,
    heartbeat: 0,
  };

  private waiters: Record<Lane, Array<() => void>> = {
    chat: [],
    cron: [],
    heartbeat: [],
  };

  /** Acquire a slot in a lane. Resolves when a slot is available. */
  async acquire(lane: Lane): Promise<() => void> {
    if (this.active[lane] < this.limits[lane]) {
      this.active[lane]++;
      logger.debug({ lane, active: this.active[lane], limit: this.limits[lane] }, 'Lane slot acquired');
      return this.createRelease(lane);
    }

    // Lane is full — queue a waiter
    logger.info(
      { lane, active: this.active[lane], limit: this.limits[lane], queued: this.waiters[lane].length },
      'Lane full — queuing',
    );

    await new Promise<void>((resolve) => {
      this.waiters[lane].push(resolve);
    });

    // Slot was handed to us by a release — already incremented
    return this.createRelease(lane);
  }

  /** Get current lane utilization for monitoring. */
  status(): Record<Lane, { active: number; limit: number; queued: number }> {
    return {
      chat: { active: this.active.chat, limit: this.limits.chat, queued: this.waiters.chat.length },
      cron: { active: this.active.cron, limit: this.limits.cron, queued: this.waiters.cron.length },
      heartbeat: { active: this.active.heartbeat, limit: this.limits.heartbeat, queued: this.waiters.heartbeat.length },
    };
  }

  private createRelease(lane: Lane): () => void {
    let released = false;
    return () => {
      if (released) return; // guard against double-release
      released = true;

      const next = this.waiters[lane].shift();
      if (next) {
        // Hand the slot directly to the next waiter (active count stays the same)
        logger.debug({ lane, queued: this.waiters[lane].length }, 'Lane slot handed to next waiter');
        next();
      } else {
        this.active[lane]--;
        logger.debug({ lane, active: this.active[lane] }, 'Lane slot released');
      }
    };
  }
}

export const lanes = new LaneController();
