/**
 * Clementine TypeScript — Event Bus.
 *
 * Typed pub/sub system for decoupling gateway lifecycle events from consumers.
 * Plugins, logging, metrics, and UI can subscribe without modifying core code.
 *
 * Events are fire-and-forget (async handlers don't block the emitter).
 * "before" events return a boolean — false cancels the operation.
 */

import pino from 'pino';

const logger = pino({ name: 'clementine.events' });

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;
export type BeforeHandler<T = unknown> = (payload: T) => boolean | Promise<boolean>;

interface Subscription {
  handler: EventHandler | BeforeHandler;
  once: boolean;
}

class EventBus {
  private listeners = new Map<string, Subscription[]>();
  private beforeHandlers = new Map<string, Array<{ handler: BeforeHandler; once: boolean }>>();

  /**
   * Subscribe to an event. Handler is called asynchronously (fire-and-forget).
   * Returns an unsubscribe function.
   */
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const subs = this.listeners.get(event) ?? [];
    const sub: Subscription = { handler: handler as EventHandler, once: false };
    subs.push(sub);
    this.listeners.set(event, subs);
    return () => {
      const list = this.listeners.get(event);
      if (list) {
        const idx = list.indexOf(sub);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /** Subscribe to an event, but only fire once. */
  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const subs = this.listeners.get(event) ?? [];
    const sub: Subscription = { handler: handler as EventHandler, once: true };
    subs.push(sub);
    this.listeners.set(event, subs);
    return () => {
      const list = this.listeners.get(event);
      if (list) {
        const idx = list.indexOf(sub);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /**
   * Register a "before" handler that can cancel an operation.
   * If any before handler returns false, the operation is cancelled.
   */
  before<T = unknown>(event: string, handler: BeforeHandler<T>): () => void {
    const handlers = this.beforeHandlers.get(event) ?? [];
    const entry = { handler: handler as BeforeHandler, once: false };
    handlers.push(entry);
    this.beforeHandlers.set(event, handlers);
    return () => {
      const list = this.beforeHandlers.get(event);
      if (list) {
        const idx = list.findIndex(e => e === entry);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /**
   * Emit an event asynchronously. Handlers run in parallel, errors are logged but don't propagate.
   */
  emit<T = unknown>(event: string, payload: T): void {
    const subs = this.listeners.get(event);
    if (!subs || subs.length === 0) return;

    // Snapshot handlers and remove once-listeners
    const handlers = [...subs];
    for (let i = subs.length - 1; i >= 0; i--) {
      if (subs[i].once) subs.splice(i, 1);
    }

    for (const sub of handlers) {
      try {
        const result = sub.handler(payload);
        if (result instanceof Promise) {
          result.catch(err => logger.warn({ err, event }, 'Event handler error'));
        }
      } catch (err) {
        logger.warn({ err, event }, 'Event handler error (sync)');
      }
    }
  }

  /**
   * Run "before" handlers sequentially. Returns true if all pass, false if any cancels.
   */
  async emitBefore<T = unknown>(event: string, payload: T): Promise<boolean> {
    const handlers = this.beforeHandlers.get(event);
    if (!handlers || handlers.length === 0) return true;

    for (const entry of [...handlers]) {
      try {
        const result = entry.handler(payload);
        const allowed = result instanceof Promise ? await result : result;
        if (!allowed) {
          logger.info({ event }, 'Operation cancelled by before handler');
          return false;
        }
      } catch (err) {
        logger.warn({ err, event }, 'Before handler error — allowing operation');
      }
      if (entry.once) {
        const idx = handlers.indexOf(entry);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    }
    return true;
  }

  /** Remove all listeners for an event, or all events if no event specified. */
  clear(event?: string): void {
    if (event) {
      this.listeners.delete(event);
      this.beforeHandlers.delete(event);
    } else {
      this.listeners.clear();
      this.beforeHandlers.clear();
    }
  }

  /** Get count of listeners for an event (useful for debugging). */
  listenerCount(event: string): number {
    return (this.listeners.get(event)?.length ?? 0) + (this.beforeHandlers.get(event)?.length ?? 0);
  }
}

/** Singleton event bus — shared across the entire process. */
export const events = new EventBus();
