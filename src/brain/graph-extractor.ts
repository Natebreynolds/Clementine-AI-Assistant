/**
 * Clementine — Graph extractor.
 *
 * Writes entities and relationships surfaced during per-record
 * distillation into the shared knowledge graph. Best-effort: if the
 * graph backend isn't available (daemon not running), silently no-ops.
 * Nothing here is a parallel store — it's the same graph chat uses.
 */

import { GRAPH_DB_DIR } from '../config.js';
import type { IngestedRecord } from '../types.js';

let _gsPromise: Promise<any | null> | null = null;

async function getGraph(): Promise<any | null> {
  if (_gsPromise) return _gsPromise;
  _gsPromise = (async () => {
    try {
      const { getSharedGraphStore } = await import('../memory/graph-store.js');
      return await getSharedGraphStore(GRAPH_DB_DIR);
    } catch {
      return null;
    }
  })();
  return _gsPromise;
}

/** Write a record's extracted entities + relationships to the graph. */
export async function writeGraphForRecord(record: IngestedRecord): Promise<{
  entitiesWritten: number;
  relationshipsWritten: number;
}> {
  const gs = await getGraph();
  if (!gs || !gs.isAvailable?.()) {
    return { entitiesWritten: 0, relationshipsWritten: 0 };
  }

  let entitiesWritten = 0;
  let relationshipsWritten = 0;

  // Upsert entities
  for (const e of record.graphEntities ?? []) {
    try {
      await gs.upsertEntity(e.label, e.id, {
        id: e.id,
        source_slug: record.sourceSlug,
        ...(e.properties ?? {}),
      });
      entitiesWritten += 1;
    } catch { /* best-effort */ }
  }

  // Create relationships — link by id only, so we must already have both endpoints
  // as entities. The graph store's createRelationship does MERGE on both ends,
  // so endpoints appear with default label "Entity" if not previously upserted.
  for (const r of record.graphRelationships ?? []) {
    try {
      await gs.createRelationship(
        { label: labelFor(r.from, record.graphEntities), id: r.from },
        { label: labelFor(r.to, record.graphEntities), id: r.to },
        r.rel,
        { source_slug: record.sourceSlug, external_id: record.externalId, context: r.context ?? '' },
      );
      relationshipsWritten += 1;
    } catch { /* best-effort */ }
  }

  return { entitiesWritten, relationshipsWritten };
}

function labelFor(id: string, entities?: Array<{ label: string; id: string }>): string {
  const match = entities?.find((e) => e.id === id);
  return match?.label ?? 'Entity';
}
