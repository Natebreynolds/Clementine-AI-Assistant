/**
 * Clementine TypeScript — Automatic Memory Maintenance.
 *
 * Runs startup and periodic maintenance so the memory store stays healthy
 * without manual intervention. New users get this out of the box.
 *
 * Startup: decay salience, prune stale data, backfill embeddings, run janitor
 * Periodic (every 6h): full consolidation cycle + embedding rebuild + janitor
 *                      + idle-gated VACUUM at most once per week
 */

import pino from 'pino';
import { MEMORY_JANITOR } from '../config.js';
import { runIntegrityProbes } from './integrity.js';

const logger = pino({ name: 'clementine.maintenance' });

const PERIODIC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const VACUUM_META_KEY = 'last_vacuum_at';

/**
 * Number of chunks to dense-embed per periodic cycle. With 4 cycles/day
 * that's 400 chunks/day — fast enough to cover a 3,500-chunk vault in
 * ~9 days, slow enough that the GPU/CPU load barely registers. Override
 * via env for power users with very large vaults.
 */
const PERIODIC_DENSE_BATCH = (() => {
  const raw = parseInt(process.env.CLEMENTINE_DENSE_BATCH ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();

/**
 * Janitor pass — keeps the store bounded. Safe to call repeatedly.
 * Idempotent within a single run; surfaces totals for logging.
 */
export function runJanitor(store: any): {
  softDeleted: number;
  physicallyDeleted: number;
  outcomesPruned: number;
  extractionsCapped: number;
} {
  let softDeleted = 0;
  let physicallyDeleted = 0;
  try {
    const result = store.expireConsolidated?.({
      expireDays: MEMORY_JANITOR.consolidatedExpireDays,
      salienceFloor: MEMORY_JANITOR.consolidatedSalienceFloor,
      graceDays: MEMORY_JANITOR.softDeleteGraceDays,
    });
    if (result) {
      softDeleted = result.softDeleted;
      physicallyDeleted = result.physicallyDeleted;
    }
  } catch (err) {
    logger.warn({ err }, 'expireConsolidated failed');
  }

  let outcomesPruned = 0;
  try {
    outcomesPruned = store.pruneOutcomes?.(MEMORY_JANITOR.auxRetentionDays) ?? 0;
  } catch (err) {
    logger.warn({ err }, 'pruneOutcomes failed');
  }

  let extractionsCapped = 0;
  try {
    extractionsCapped = store.capExtractions?.(MEMORY_JANITOR.extractionsMaxRows) ?? 0;
  } catch (err) {
    logger.warn({ err }, 'capExtractions failed');
  }

  return { softDeleted, physicallyDeleted, outcomesPruned, extractionsCapped };
}

/**
 * Run VACUUM if (a) it's been more than vacuumIntervalDays since the last
 * one and (b) the store has been idle for at least vacuumIdleSeconds.
 * Returns null when skipped, otherwise the size delta.
 */
export function maybeVacuum(store: any): {
  sizeBeforeBytes: number;
  sizeAfterBytes: number;
  durationMs: number;
} | null {
  try {
    const lastIso = store.getMaintenanceMeta?.(VACUUM_META_KEY) as string | null;
    if (lastIso) {
      const last = new Date(lastIso).getTime();
      const ageMs = Date.now() - last;
      if (ageMs < MEMORY_JANITOR.vacuumIntervalDays * 86_400_000) return null;
    }

    const lastActivity = store.lastActivityAt?.() as number | null;
    if (lastActivity !== null && lastActivity !== undefined) {
      const idleMs = Date.now() - lastActivity;
      if (idleMs < MEMORY_JANITOR.vacuumIdleSeconds * 1000) return null;
    }

    const result = store.vacuum?.();
    store.setMaintenanceMeta?.(VACUUM_META_KEY, new Date().toISOString());
    return result ?? null;
  } catch (err) {
    logger.warn({ err }, 'VACUUM failed');
    return null;
  }
}

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

  // Janitor — bounded growth pass.
  try {
    const result = runJanitor(store);
    if (result.softDeleted || result.physicallyDeleted || result.outcomesPruned || result.extractionsCapped) {
      logger.info(result, 'Janitor pass complete');
    }
  } catch (err) {
    logger.warn({ err }, 'Startup janitor failed');
  }

  // Embedding warm-up — pre-embed the most-cited chunks in the background so
  // the first retrievals after startup don't pay cold-start latency. Fire
  // and forget; never blocks startup.
  if (typeof store.warmDenseEmbeddings === 'function') {
    void (async () => {
      try {
        const result = await store.warmDenseEmbeddings(200);
        if (result.warmed > 0) {
          logger.info(result, 'Embedding warm-up complete');
        }
      } catch (err) {
        logger.warn({ err }, 'Embedding warm-up failed');
      }
    })();
  }

  logger.info({ durationMs: Date.now() - start }, 'Startup maintenance complete');
}

/**
 * Run one full periodic-maintenance cycle. Exported so tests can drive it
 * without waiting on setInterval. `startPeriodicMaintenance` schedules
 * this on the 6h cadence.
 */
export async function runPeriodicCycle(
  store: any,
  llmCall?: (prompt: string) => Promise<string>,
): Promise<void> {
    const start = Date.now();
    logger.info('Starting periodic memory maintenance');

    // 1. Decay + prune
    try { store.decaySalience?.(); } catch (err) { logger.warn({ err }, 'Periodic decay failed'); }
    try { store.pruneStaleData?.(); } catch (err) { logger.warn({ err }, 'Periodic prune failed'); }

    // 2. Rebuild vocab + backfill embeddings
    try { store.buildEmbeddings?.(); } catch (err) { logger.warn({ err }, 'Periodic embedding build failed'); }

    // 2b. Idle dense-embedding backfill — process up to PERIODIC_DENSE_BATCH
    // chunks per cycle so coverage drifts toward 100% without anyone running
    // the CLI. The first time the dense model loads inside this process it
    // pulls ~440MB; subsequent cycles reuse the loaded model. Failures
    // (network, missing model dir, etc.) fall through silently because the
    // backfill is best-effort — query-time still has TF-IDF as fallback.
    if (typeof store.backfillDenseEmbeddings === 'function') {
      try {
        const result = await store.backfillDenseEmbeddings({ limit: PERIODIC_DENSE_BATCH });
        if (result.embedded > 0) {
          logger.info(result, 'Periodic dense embedding backfill');
        }
      } catch (err) {
        logger.warn({ err }, 'Periodic dense embedding backfill failed');
      }
    }

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

    // 5. Extraction log pruning (legacy 90-day rule retained alongside cap)
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

    // 6. Janitor — bounded growth.
    try {
      const result = runJanitor(store);
      if (result.softDeleted || result.physicallyDeleted || result.outcomesPruned || result.extractionsCapped) {
        logger.info(result, 'Janitor pass complete');
      }
    } catch (err) {
      logger.warn({ err }, 'Periodic janitor failed');
    }

    // 6b. Integrity probes — FTS health, orphan derived_from, embedding gaps.
    try {
      const report = runIntegrityProbes(store);
      // Persist for the dashboard so the "last integrity check" surface
      // doesn't depend on log scraping.
      try {
        store.setMaintenanceMeta?.(
          'last_integrity_report',
          JSON.stringify({ ...report, ranAt: new Date().toISOString() }),
        );
      } catch { /* meta write is best-effort */ }
      if (!report.ftsOk || report.ftsRebuilt || report.orphanRefsNulled > 0 || report.missingEmbeddings > 0) {
        logger.info(report, 'Integrity probes complete');
      }
    } catch (err) {
      logger.warn({ err }, 'Integrity probes failed');
    }

    // 7. VACUUM — idle-gated, at most once per vacuumIntervalDays.
    try {
      const vac = maybeVacuum(store);
      if (vac) {
        logger.info(
          {
            sizeBeforeBytes: vac.sizeBeforeBytes,
            sizeAfterBytes: vac.sizeAfterBytes,
            reclaimedBytes: vac.sizeBeforeBytes - vac.sizeAfterBytes,
            durationMs: vac.durationMs,
          },
          'VACUUM complete',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Periodic VACUUM failed');
    }

    logger.info({ durationMs: Date.now() - start }, 'Periodic maintenance complete');
}

/**
 * Start periodic maintenance on a 6-hour interval. Returns the interval
 * handle for cleanup on shutdown.
 */
export function startPeriodicMaintenance(
  store: any,
  llmCall?: (prompt: string) => Promise<string>,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    runPeriodicCycle(store, llmCall).catch(err =>
      logger.warn({ err }, 'Periodic maintenance cycle threw — continuing'),
    );
  }, PERIODIC_INTERVAL_MS);
}
