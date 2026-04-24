/**
 * Clementine — Ingest scheduler.
 *
 * Stands on its own next to the agent cron scheduler. Reads registered
 * sources with kind='poll' + scheduleCron set, subscribes them to
 * node-cron, and invokes runSource() on tick. Enabled/disabled state
 * is re-read every minute so dashboard edits take effect without a
 * daemon restart.
 */

import cron from 'node-cron';
import pino from 'pino';
import { listSources, runSource } from './source-registry.js';
import { parseRest } from './adapters/rest.js';
import type { RestConfig } from './adapters/rest.js';

const logger = pino({ name: 'clementine.brain.scheduler' });

interface ScheduledEntry {
  slug: string;
  expression: string;
  task: ReturnType<typeof cron.schedule>;
}

export class IngestScheduler {
  private scheduled = new Map<string, ScheduledEntry>();
  private rescanTimer: NodeJS.Timeout | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.rescan();
    // Re-scan every minute so dashboard edits (add/disable/change cron)
    // apply without a daemon restart. This is cheap — just a query on
    // a handful of rows.
    this.rescanTimer = setInterval(() => {
      this.rescan().catch((err) => logger.warn({ err }, 'rescan failed'));
    }, 60_000);
    logger.info('Ingest scheduler started');
  }

  stop(): void {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    for (const entry of this.scheduled.values()) entry.task.stop();
    this.scheduled.clear();
    this.started = false;
    logger.info('Ingest scheduler stopped');
  }

  /** Recompute the set of scheduled sources. Add new ones, drop removed, update changed cron expressions. */
  private async rescan(): Promise<void> {
    const sources = await listSources({ enabled: true, kind: 'poll' });
    const seen = new Set<string>();

    for (const src of sources) {
      if (!src.scheduleCron) continue;
      if (!cron.validate(src.scheduleCron)) {
        logger.warn({ slug: src.slug, expr: src.scheduleCron }, 'Invalid cron expression on source');
        continue;
      }
      seen.add(src.slug);
      const existing = this.scheduled.get(src.slug);
      if (existing && existing.expression === src.scheduleCron) continue; // no change

      if (existing) existing.task.stop();

      const task = cron.schedule(src.scheduleCron, () => {
        this.runOne(src.slug).catch((err) =>
          logger.error({ err, slug: src.slug }, 'scheduled ingest failed'),
        );
      });
      this.scheduled.set(src.slug, { slug: src.slug, expression: src.scheduleCron, task });
      logger.info({ slug: src.slug, cron: src.scheduleCron }, 'Scheduled poll source');
    }

    // Drop sources that disappeared or were disabled
    for (const [slug, entry] of this.scheduled) {
      if (!seen.has(slug)) {
        entry.task.stop();
        this.scheduled.delete(slug);
        logger.info({ slug }, 'Unscheduled poll source');
      }
    }
  }

  /** Execute one scheduled source. Builds the REST record iterator, then drives runSource. */
  private async runOne(slug: string): Promise<void> {
    logger.info({ slug }, 'Poll triggered');
    try {
      const records = await buildRestIterator(slug);
      const result = await runSource(slug, { records });
      logger.info({
        slug, runId: result.runId,
        recordsIn: result.recordsIn, recordsWritten: result.recordsWritten,
        recordsFailed: result.recordsFailed, overview: result.overviewNotePath,
      }, 'Poll completed');
    } catch (err) {
      logger.error({ err, slug }, 'Poll failed');
    }
  }

  /** Status snapshot for the dashboard. */
  listScheduled(): Array<{ slug: string; expression: string }> {
    return [...this.scheduled.values()].map((e) => ({ slug: e.slug, expression: e.expression }));
  }
}

/**
 * Build a record iterator from a poll source's config. Extracted so
 * the dashboard "Run Now" button and the scheduler share one code path.
 */
export async function buildRestIterator(slug: string): Promise<AsyncIterable<import('../types.js').RawRecord>> {
  const { getSource } = await import('./source-registry.js');
  const src = await getSource(slug);
  if (!src) throw new Error(`Source not found: ${slug}`);
  if (src.adapter !== 'rest') throw new Error(`Source ${slug} adapter is ${src.adapter}, not rest`);

  let cfg: RestConfig;
  try {
    cfg = JSON.parse(src.configJson || '{}') as RestConfig;
  } catch (err) {
    throw new Error(`Invalid configJson on source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!cfg.url) throw new Error(`Source ${slug} missing url`);

  return parseRest(cfg);
}

// Singleton so daemon + dashboard can share the same scheduler
let _instance: IngestScheduler | null = null;
export function getIngestScheduler(): IngestScheduler {
  if (!_instance) _instance = new IngestScheduler();
  return _instance;
}
