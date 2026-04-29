/**
 * Memory store integrity probes — self-healing checks that run on the
 * janitor's periodic cycle. Each probe is independent and conservative:
 *  - reports what it found,
 *  - repairs only when the fix is non-destructive,
 *  - never throws (logs and continues).
 *
 * Three checks today (the cheap, high-value ones):
 *   1. FTS5 contentless-table integrity → auto-rebuild on failure
 *   2. derived_from references to deleted chunks → nullify the dangling refs
 *   3. chunks with content but no embedding → return count for backfill
 *
 * Graph reachability is intentionally NOT probed here — it lives in
 * graph-store.ts's own health probe, which auto-restarts FalkorDB.
 */

import pino from 'pino';

const logger = pino({ name: 'clementine.integrity' });

export interface IntegrityReport {
  ftsOk: boolean;
  ftsRebuilt: boolean;
  orphanRefsNulled: number;
  missingEmbeddings: number;
}

/**
 * Run all probes and apply safe repairs. Returns a report; never throws.
 * The store argument is typed loose so this module can be called from
 * maintenance.ts without an import cycle.
 */
export function runIntegrityProbes(store: any): IntegrityReport {
  const report: IntegrityReport = {
    ftsOk: true,
    ftsRebuilt: false,
    orphanRefsNulled: 0,
    missingEmbeddings: 0,
  };

  // 1. FTS5 integrity. Contentless tables can corrupt under specific failure
  //    modes (process kill mid-trigger, manual SQL on chunks_fts, etc.).
  //    integrity-check returns 'ok' on success; rebuild is the standard fix.
  try {
    const conn = store.conn;
    if (conn) {
      try {
        const row = conn.prepare(
          `INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check') RETURNING ''`,
        ).get();
        // 'integrity-check' is a no-op insert that throws on failure. If we
        // got a row back, FTS is fine. (Some SQLite builds don't support the
        // RETURNING form on virtual tables — fall back to plain run().)
        void row;
      } catch (innerErr) {
        // Try the plain form before declaring failure.
        try {
          conn.prepare(`INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')`).run();
        } catch {
          report.ftsOk = false;
          logger.warn({ err: innerErr }, 'FTS5 integrity check failed — rebuilding');
          try {
            conn.prepare(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`).run();
            report.ftsRebuilt = true;
          } catch (rebuildErr) {
            logger.warn({ err: rebuildErr }, 'FTS5 rebuild failed');
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'FTS integrity probe error');
  }

  // 2. derived_from dangling references. Phase-2 janitor deletes a chunk
  //    that was a source for a summary; we keep the summary but the JSON
  //    array of source ids may now contain ids that no longer exist. Walk
  //    summary chunks, prune missing ids; fully empty array → null.
  try {
    const conn = store.conn;
    if (conn) {
      const summaries = conn.prepare(
        `SELECT id, derived_from FROM chunks
         WHERE derived_from IS NOT NULL AND derived_from != ''`,
      ).all() as Array<{ id: number; derived_from: string }>;
      const liveCheck = conn.prepare('SELECT 1 FROM chunks WHERE id = ?');
      const updateStmt = conn.prepare('UPDATE chunks SET derived_from = ? WHERE id = ?');
      for (const s of summaries) {
        let ids: unknown[];
        try { ids = JSON.parse(s.derived_from); } catch { continue; }
        if (!Array.isArray(ids)) continue;
        const live = ids.filter((id) => {
          if (typeof id !== 'number') return false;
          return !!liveCheck.get(id);
        });
        if (live.length !== ids.length) {
          updateStmt.run(live.length === 0 ? null : JSON.stringify(live), s.id);
          report.orphanRefsNulled++;
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'derived_from orphan probe failed');
  }

  // 3. Missing dense embeddings — a counter for the dashboard / next backfill
  //    cycle. Doesn't repair (backfill is async + heavy); just surfaces.
  try {
    const conn = store.conn;
    if (conn) {
      const row = conn.prepare(
        `SELECT COUNT(*) AS c FROM chunks c
         LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE sd.chunk_id IS NULL
           AND c.embedding_dense IS NULL
           AND length(c.content) > 0`,
      ).get() as { c: number };
      report.missingEmbeddings = row.c;
    }
  } catch (err) {
    logger.warn({ err }, 'Missing-embedding probe failed');
  }

  return report;
}
