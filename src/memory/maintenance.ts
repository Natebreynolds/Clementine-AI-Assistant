/**
 * Clementine TypeScript — Automatic Memory Maintenance.
 *
 * Runs startup and periodic maintenance so the memory store stays healthy
 * without manual intervention. New users get this out of the box.
 *
 * Startup: decay salience, prune stale data, backfill embeddings
 * Periodic (every 6h): full consolidation cycle + embedding rebuild
 */

import pino from 'pino';

const logger = pino({ name: 'clementine.maintenance' });

const PERIODIC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Run one-time maintenance at daemon startup.
 * Non-blocking — errors are logged but never thrown.
 */
export async function runStartupMaintenance(store: any): Promise<void> {
  const start = Date.now();
  logger.info('Starting memory maintenance (startup)');

  try {
    const decayed = store.decaySalience?.();
    if (decayed) logger.info({ decayed }, 'Salience decay applied');
  } catch (err) {
    logger.warn({ err }, 'Salience decay failed');
  }

  try {
    const pruned = store.pruneStaleData?.();
    if (pruned) logger.info(pruned, 'Stale data pruned');
  } catch (err) {
    logger.warn({ err }, 'Stale data pruning failed');
  }

  try {
    const embedded = store.buildEmbeddings?.();
    if (embedded) logger.info(embedded, 'Embeddings built/backfilled');
  } catch (err) {
    logger.warn({ err }, 'Embedding backfill failed');
  }

  // Prune old extraction logs (keep active extractions regardless of age)
  try {
    const conn = store.conn;
    if (conn) {
      const result = conn.prepare(
        `DELETE FROM memory_extractions
         WHERE extracted_at < datetime('now', '-90 days')
         AND status != 'active'`,
      ).run();
      if (result.changes > 0) {
        logger.info({ pruned: result.changes }, 'Old extraction logs pruned');
      }
    }
  } catch {
    // Table may not exist yet — non-fatal
  }

  logger.info({ durationMs: Date.now() - start }, 'Startup maintenance complete');
}

/**
 * Start periodic maintenance on a 6-hour interval.
 * Returns the interval handle for cleanup on shutdown.
 */
export function startPeriodicMaintenance(
  store: any,
  llmCall?: (prompt: string) => Promise<string>,
): ReturnType<typeof setInterval> {
  const runCycle = async () => {
    const start = Date.now();
    logger.info('Starting periodic memory maintenance');

    // 1. Decay + prune
    try { store.decaySalience?.(); } catch (err) { logger.warn({ err }, 'Periodic decay failed'); }
    try { store.pruneStaleData?.(); } catch (err) { logger.warn({ err }, 'Periodic prune failed'); }

    // 2. Rebuild vocab + backfill embeddings
    try { store.buildEmbeddings?.(); } catch (err) { logger.warn({ err }, 'Periodic embedding build failed'); }

    // 3. Consolidation (dedup, summarize, extract principles)
    if (llmCall) {
      try {
        const { runConsolidation } = await import('./consolidation.js');
        const result = await runConsolidation(store, llmCall);
        logger.info(result, 'Consolidation cycle complete');
      } catch (err) {
        logger.warn({ err }, 'Consolidation failed');
      }

      // 4. Re-backfill embeddings for any new summary chunks from consolidation
      try { store.buildEmbeddings?.(); } catch (err) { logger.warn({ err }, 'Post-consolidation embedding build failed'); }
    }

    // 5. Extraction log pruning
    try {
      const conn = store.conn;
      if (conn) {
        conn.prepare(
          `DELETE FROM memory_extractions
           WHERE extracted_at < datetime('now', '-90 days')
           AND status != 'active'`,
        ).run();
      }
    } catch { /* non-fatal */ }

    logger.info({ durationMs: Date.now() - start }, 'Periodic maintenance complete');
  };

  return setInterval(runCycle, PERIODIC_INTERVAL_MS);
}
