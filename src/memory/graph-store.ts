/**
 * Clementine TypeScript — FalkorDBLite graph memory layer.
 *
 * Adds entity graph, typed relationships, and multi-hop traversal on top
 * of the existing SQLite FTS5 memory store. The vault remains the source
 * of truth; the graph is a derived index that can be rebuilt at any time.
 *
 * Architecture:
 *   - The daemon calls `initialize()` which starts an embedded FalkorDB
 *     server and writes its Unix socket path to SOCKET_FILE.
 *   - MCP tools, dashboard, and assistant.ts call `connectToRunning()`
 *     which reads the socket file and connects as a client (no new server).
 *   - If no running instance is found, all graph features degrade gracefully.
 *
 * Graceful degradation: if FalkorDBLite fails to initialize, `isAvailable()`
 * returns false and all graph features are silently skipped.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import type {
  EntityNode,
  EntityRef,
  GraphSyncStats,
  PathResult,
  RelationshipTriplet,
  TraversalResult,
} from '../types.js';

const logger = pino({ name: 'clementine.graph' });

const GRAPH_NAME = 'clementine';
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** Well-known file where the daemon writes the socket path for other processes. */
const SOCKET_FILE_NAME = '.graph.sock';

export class GraphStore {
  private db: any = null;       // FalkorDBLite instance (only when we own the server)
  private client: any = null;   // falkordb client (both modes)
  private graph: any = null;
  private available = false;
  private persistenceDir: string;
  private ownsServer = false;

  constructor(persistenceDir: string) {
    this.persistenceDir = persistenceDir;
  }

  /** Get the socket file path for this instance's data dir. */
  private get socketFilePath(): string {
    return path.join(this.persistenceDir, SOCKET_FILE_NAME);
  }

  // ── Initialization (daemon — starts the server) ──────────────────────

  /**
   * Start an embedded FalkorDB server. Only the daemon should call this.
   * Writes the socket path to a file so other processes can connect.
   */
  async initialize(): Promise<void> {
    try {
      const { FalkorDB } = await import('falkordblite');
      if (!existsSync(this.persistenceDir)) {
        mkdirSync(this.persistenceDir, { recursive: true });
      }
      this.db = await FalkorDB.open({ path: this.persistenceDir });
      this.graph = this.db.selectGraph(GRAPH_NAME);
      this.available = true;
      this.ownsServer = true;

      // Catch connection-level errors: log once, disable gracefully
      let serverErrorLogged = false;
      this.db.on?.('error', (err: Error) => {
        if (!serverErrorLogged) {
          serverErrorLogged = true;
          logger.warn({ err: err.message }, 'FalkorDB server error — disabling graph features');
          this.available = false;
        }
      });

      // Write socket path so MCP/dashboard/assistant can connect
      writeFileSync(this.socketFilePath, this.db.socketPath, 'utf-8');

      // Create indexes for fast lookups
      const indexes = [
        'CREATE INDEX IF NOT EXISTS FOR (n:Person) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Project) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Topic) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Agent) ON (n.slug)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Task) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Note) ON (n.path)',
      ];
      for (const idx of indexes) {
        try { await this.graph.query(idx); } catch { /* index may already exist */ }
      }
    } catch (err) {
      this.available = false;
      logger.warn({ err }, 'FalkorDB unavailable — graph features disabled');
    }
  }

  // ── Connection (MCP / dashboard / assistant — client only) ───────────

  /**
   * Connect to an already-running FalkorDB instance via its socket file.
   * Does NOT start a new server. Returns false if no running instance.
   */
  async connectToRunning(): Promise<boolean> {
    try {
      if (!existsSync(this.socketFilePath)) return false;
      const socketPath = readFileSync(this.socketFilePath, 'utf-8').trim();
      if (!socketPath) return false;

      // Use the falkordb client library to connect to the existing socket
      const { FalkorDB: FalkorDBClient } = await import('falkordb');
      this.client = await FalkorDBClient.connect({ socket: { path: socketPath } });
      this.graph = this.client.selectGraph(GRAPH_NAME);
      this.available = true;
      this.ownsServer = false;

      // Catch connection-level errors: disable and start reconnect loop
      let errorHandled = false;
      this.client.on?.('error', (err: Error) => {
        if (errorHandled) return;
        errorHandled = true;
        logger.warn({ err: err.message }, 'FalkorDB connection lost — starting reconnect loop');
        this.available = false;
        try { this.client?.disconnect?.(); } catch { /* ignore */ }

        // Reconnect loop: try every 30s up to 5 times, then back off to 5 min
        let attempts = 0;
        const reconnectLoop = async () => {
          attempts++;
          try {
            const reconnected = await this.connectToRunning();
            if (reconnected) {
              logger.info({ attempts }, 'FalkorDB reconnected');
              return; // Success — stop the loop
            }
          } catch { /* retry */ }

          if (attempts < 5) {
            setTimeout(reconnectLoop, 30_000);       // Retry in 30s
          } else if (attempts < 10) {
            setTimeout(reconnectLoop, 5 * 60_000);   // Back off to 5 min
          } else {
            // Keep a slow background probe instead of giving up entirely
            logger.warn({ attempts }, 'FalkorDB reconnect entering slow probe (every 30 min)');
            setTimeout(reconnectLoop, 30 * 60_000);
          }
        };
        setTimeout(reconnectLoop, 30_000);
      });

      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async close(): Promise<void> {
    if (this.ownsServer && this.db) {
      // Clean up socket file
      try { unlinkSync(this.socketFilePath); } catch { /* ignore */ }
      try { await this.db.close(); } catch { /* ignore */ }
      // Unregister from FalkorDBLite's cleanup module — its uncaughtException
      // handler re-throws errors, which crashes the daemon on socket drops.
      try {
        const { unregisterServer } = await import('falkordblite/dist/cleanup.js');
        unregisterServer(this.db);
      } catch { /* cleanup module may not be accessible */ }
      this.db = null;
    } else if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this.graph = null;
    this.available = false;
  }

  // ── Entity CRUD ──────────────────────────────────────────────────────

  async upsertEntity(label: string, id: string, props: Record<string, any>): Promise<void> {
    if (!this.available) return;
    const safeLabel = label.replace(/[^A-Za-z]/g, '');
    const propsStr = Object.entries(props)
      .map(([k, _v]) => `n.${k} = $${k}`)
      .join(', ');
    const params: Record<string, any> = { id, ...props };
    const cypher = `MERGE (n:${safeLabel} {id: $id}) SET ${propsStr || 'n.id = $id'}`;
    try {
      await this.graph.query(cypher, { params });
    } catch (err) {
      logger.debug({ err, label, id }, 'upsertEntity failed');
    }
  }

  async getEntity(label: string, id: string): Promise<EntityNode | null> {
    if (!this.available) return null;
    const safeLabel = label.replace(/[^A-Za-z]/g, '');
    try {
      const result = await this.graph.query(
        `MATCH (n:${safeLabel} {id: $id}) RETURN n`,
        { params: { id } },
      );
      if (result.data && result.data.length > 0) {
        const row = result.data[0];
        const node = row.n ?? row;
        return { label: safeLabel, id, properties: node?.properties ?? {} };
      }
    } catch { /* not found */ }
    return null;
  }

  // ── Relationship CRUD ────────────────────────────────────────────────

  async createRelationship(
    from: EntityRef,
    to: EntityRef,
    type: string,
    props?: Record<string, any>,
    temporal?: { validFrom?: string; validTo?: string },
  ): Promise<void> {
    if (!this.available) return;
    const fromLabel = from.label.replace(/[^A-Za-z]/g, '');
    const toLabel = to.label.replace(/[^A-Za-z]/g, '');
    const relType = type.replace(/[^A-Za-z_]/g, '');
    const propsStr = props
      ? ', ' + Object.entries(props).map(([k, _v]) => `r.${k} = $r_${k}`).join(', ')
      : '';
    const params: Record<string, any> = {
      fromId: from.id,
      toId: to.id,
      valid_from: temporal?.validFrom ?? new Date().toISOString(),
      valid_to: temporal?.validTo ?? null,
    };
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        params[`r_${k}`] = v;
      }
    }
    const cypher =
      `MERGE (a:${fromLabel} {id: $fromId}) ` +
      `MERGE (b:${toLabel} {id: $toId}) ` +
      `MERGE (a)-[r:${relType}]->(b) ` +
      `SET r.created_at = timestamp(), r.valid_from = $valid_from, r.valid_to = $valid_to${propsStr}`;
    try {
      await this.graph.query(cypher, { params });
    } catch (err) {
      logger.debug({ err, from, to, type }, 'createRelationship failed');
    }
  }

  /**
   * Mark a relationship as no longer active by setting its valid_to timestamp.
   */
  async invalidateRelationship(
    fromId: string,
    toId: string,
    relType: string,
    asOf?: string,
  ): Promise<boolean> {
    if (!this.available) return false;
    const safeRelType = relType.replace(/[^A-Za-z_]/g, '');
    const cypher =
      `MATCH (a {id: $fromId})-[r:${safeRelType}]->(b {id: $toId}) ` +
      `WHERE r.valid_to IS NULL ` +
      `SET r.valid_to = $validTo ` +
      `RETURN count(r) AS updated`;
    try {
      const res = await this.graph.query(cypher, {
        params: { fromId, toId, validTo: asOf ?? new Date().toISOString() },
      });
      return (res.data?.[0]?.updated ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async getRelationships(
    entityId: string,
    direction: 'in' | 'out' | 'both' = 'both',
    relType?: string,
    asOf?: string,
  ): Promise<Array<{ from: string; to: string; type: string; properties: Record<string, any> }>> {
    if (!this.available) return [];
    const relFilter = relType ? `:${relType.replace(/[^A-Za-z_]/g, '')}` : '';

    // Build temporal WHERE clause
    let temporalWhere = '';
    const params: Record<string, any> = { id: entityId };
    if (asOf) {
      temporalWhere = ' WHERE (r.valid_from IS NULL OR r.valid_from <= $asOf) AND (r.valid_to IS NULL OR r.valid_to > $asOf)';
      params.asOf = asOf;
    } else {
      // By default show only active relationships (valid_to is null or not set)
      temporalWhere = ' WHERE r.valid_to IS NULL';
    }

    const queries: string[] = [];
    if (direction === 'out' || direction === 'both') {
      queries.push(
        `MATCH (a {id: $id})-[r${relFilter}]->(b)${temporalWhere} RETURN a.id AS from, b.id AS to, type(r) AS rel, properties(r) AS props`,
      );
    }
    if (direction === 'in' || direction === 'both') {
      queries.push(
        `MATCH (a {id: $id})<-[r${relFilter}]-(b)${temporalWhere} RETURN b.id AS from, a.id AS to, type(r) AS rel, properties(r) AS props`,
      );
    }
    const results: Array<{ from: string; to: string; type: string; properties: Record<string, any> }> = [];
    for (const q of queries) {
      try {
        const res = await this.graph.query(q, { params });
        if (res.data) {
          for (const row of res.data) {
            results.push({
              from: row.from,
              to: row.to,
              type: row.rel,
              properties: row.props ?? {},
            });
          }
        }
      } catch { /* ignore query errors */ }
    }
    return results;
  }

  // ── Graph Queries ────────────────────────────────────────────────────

  async traverse(
    startId: string,
    maxDepth: number = 3,
    relTypes?: string[],
    asOf?: string,
  ): Promise<TraversalResult[]> {
    if (!this.available) return [];
    const relFilter = relTypes?.length
      ? relTypes.map(t => t.replace(/[^A-Za-z_]/g, '')).join('|')
      : '';
    const relPattern = relFilter ? `:${relFilter}` : '';

    // When asOf is specified, include relationship properties for post-filtering
    const cypher =
      `MATCH path = (start {id: $id})-[${relPattern}*1..${maxDepth}]->(end) ` +
      `RETURN end.id AS id, labels(end)[0] AS label, properties(end) AS props, ` +
      `length(path) AS depth, [r IN relationships(path) | type(r)] AS rels` +
      (asOf ? `, [r IN relationships(path) | properties(r)] AS relProps` : '');
    try {
      const res = await this.graph.query(cypher, { params: { id: startId } });
      if (!res.data) return [];
      const seen = new Set<string>();
      const results: TraversalResult[] = [];
      for (const row of res.data) {
        // If asOf specified, filter out paths with temporally invalid relationships
        if (asOf && row.relProps) {
          const allValid = (row.relProps as Array<Record<string, any>>).every((rp) => {
            const from = rp.valid_from;
            const to = rp.valid_to;
            return (!from || from <= asOf) && (!to || to > asOf);
          });
          if (!allValid) continue;
        }

        const eid = row.id;
        if (seen.has(eid)) continue;
        seen.add(eid);
        results.push({
          entity: { label: row.label ?? 'Unknown', id: eid, properties: row.props ?? {} },
          depth: row.depth,
          path: row.rels ?? [],
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  async shortestPath(fromId: string, toId: string): Promise<PathResult | null> {
    if (!this.available) return null;
    const cypher =
      `MATCH path = shortestPath((a {id: $from})-[*..10]->(b {id: $to})) ` +
      `RETURN [n IN nodes(path) | {id: n.id, label: labels(n)[0], props: properties(n)}] AS nodes, ` +
      `[r IN relationships(path) | type(r)] AS rels`;
    try {
      const res = await this.graph.query(cypher, { params: { from: fromId, to: toId } });
      if (!res.data || res.data.length === 0) return null;
      const row = res.data[0];
      const nodes: EntityNode[] = (row.nodes ?? []).map((n: any) => ({
        label: n.label ?? 'Unknown',
        id: n.id,
        properties: n.props ?? {},
      }));
      const relationships: string[] = row.rels ?? [];
      return { nodes, relationships, length: relationships.length };
    } catch {
      return null;
    }
  }

  async findConnected(entityId: string, targetLabel: string, maxHops: number = 3): Promise<EntityNode[]> {
    if (!this.available) return [];
    const safeLabel = targetLabel.replace(/[^A-Za-z]/g, '');
    const cypher =
      `MATCH (start {id: $id})-[*1..${maxHops}]->(end:${safeLabel}) ` +
      `RETURN DISTINCT end.id AS id, properties(end) AS props`;
    try {
      const res = await this.graph.query(cypher, { params: { id: entityId } });
      if (!res.data) return [];
      return res.data.map((row: any) => ({
        label: safeLabel,
        id: row.id,
        properties: row.props ?? {},
      }));
    } catch {
      return [];
    }
  }

  async query(cypher: string, params?: Record<string, any>): Promise<any[]> {
    if (!this.available) return [];
    try {
      const res = await this.graph.query(cypher, params ? { params } : undefined);
      return res.data ?? [];
    } catch {
      return [];
    }
  }

  // ── Bulk Sync from Vault ─────────────────────────────────────────────

  async syncFromVault(vaultDir: string, agentsDir: string): Promise<GraphSyncStats> {
    const start = Date.now();
    let nodesCreated = 0;
    let relationshipsCreated = 0;

    if (!this.available) return { nodesCreated: 0, relationshipsCreated: 0, duration: 0 };

    // Check if graph already has data (skip full sync if so)
    try {
      const countRes = await this.graph.query('MATCH (n) RETURN count(n) AS c');
      const count = countRes.data?.[0]?.c ?? 0;
      if (count > 0) {
        logger.info({ existingNodes: count }, 'Graph already populated — skipping full sync');
        return { nodesCreated: 0, relationshipsCreated: 0, duration: Date.now() - start };
      }
    } catch { /* empty graph — proceed */ }

    // 1. People notes
    const peopleDir = path.join(vaultDir, '02-People');
    if (existsSync(peopleDir)) {
      for (const file of readdirSync(peopleDir).filter(f => f.endsWith('.md'))) {
        try {
          const content = readFileSync(path.join(peopleDir, file), 'utf-8');
          const { data: fm } = matter(content);
          const slug = path.basename(file, '.md').toLowerCase().replace(/\s+/g, '-');
          await this.upsertEntity('Person', slug, {
            name: fm.name || path.basename(file, '.md'),
            role: fm.role || '',
            company: fm.company || '',
            email: fm.email || '',
          });
          nodesCreated++;

          // Extract wikilinks as relationships
          let match: RegExpExecArray | null;
          while ((match = WIKILINK_RE.exec(content)) !== null) {
            const target = match[1].toLowerCase().replace(/\s+/g, '-');
            await this.createRelationship(
              { label: 'Person', id: slug },
              { label: 'Note', id: target },
              'MENTIONS',
            );
            relationshipsCreated++;
          }

          // Extract relationships from frontmatter
          if (fm.company) {
            const companySlug = fm.company.toLowerCase().replace(/\s+/g, '-');
            await this.upsertEntity('Project', companySlug, { name: fm.company, type: 'company' });
            await this.createRelationship(
              { label: 'Person', id: slug },
              { label: 'Project', id: companySlug },
              'WORKS_AT',
            );
            nodesCreated++;
            relationshipsCreated++;
          }
        } catch { /* skip broken files */ }
      }
    }

    // 2. Project notes
    const projectsDir = path.join(vaultDir, '03-Projects');
    if (existsSync(projectsDir)) {
      for (const file of readdirSync(projectsDir).filter(f => f.endsWith('.md'))) {
        try {
          const content = readFileSync(path.join(projectsDir, file), 'utf-8');
          const { data: fm } = matter(content);
          const slug = path.basename(file, '.md').toLowerCase().replace(/\s+/g, '-');
          await this.upsertEntity('Project', slug, {
            name: fm.name || path.basename(file, '.md'),
            type: fm.type || 'project',
            description: (fm.description || '').slice(0, 200),
          });
          nodesCreated++;
        } catch { /* skip */ }
      }
    }

    // 3. Topic notes
    const topicsDir = path.join(vaultDir, '04-Topics');
    if (existsSync(topicsDir)) {
      for (const file of readdirSync(topicsDir).filter(f => f.endsWith('.md'))) {
        try {
          const content = readFileSync(path.join(topicsDir, file), 'utf-8');
          const { data: fm } = matter(content);
          const slug = path.basename(file, '.md').toLowerCase().replace(/\s+/g, '-');
          await this.upsertEntity('Topic', slug, {
            name: fm.name || path.basename(file, '.md'),
            description: (fm.description || '').slice(0, 200),
          });
          nodesCreated++;
        } catch { /* skip */ }
      }
    }

    // 4. Agent configs
    if (existsSync(agentsDir)) {
      for (const dir of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const agentFile = path.join(agentsDir, dir.name, 'agent.md');
        if (!existsSync(agentFile)) continue;
        try {
          const content = readFileSync(agentFile, 'utf-8');
          const { data: fm } = matter(content);
          const slug = dir.name;
          await this.upsertEntity('Agent', slug, {
            slug,
            name: fm.name || slug,
            role: fm.role || '',
            model: fm.model || '',
          });
          nodesCreated++;

          // canMessage edges
          if (Array.isArray(fm.canMessage)) {
            for (const target of fm.canMessage) {
              await this.createRelationship(
                { label: 'Agent', id: slug },
                { label: 'Agent', id: target },
                'CAN_MESSAGE',
              );
              relationshipsCreated++;
            }
          }

          // project binding
          if (fm.project) {
            const projSlug = String(fm.project).toLowerCase().replace(/\s+/g, '-');
            await this.createRelationship(
              { label: 'Agent', id: slug },
              { label: 'Project', id: projSlug },
              'MANAGES',
            );
            relationshipsCreated++;
          }
        } catch { /* skip */ }
      }
    }

    // 5. Tasks from TASKS.md
    const tasksFile = path.join(vaultDir, '05-Tasks', 'TASKS.md');
    if (existsSync(tasksFile)) {
      try {
        const content = readFileSync(tasksFile, 'utf-8');
        const taskRe = /^[-*]\s+\[([x ])\]\s+\*?\*?(T-\d+)\*?\*?\s*[—–-]\s*(.*)/gm;
        let m: RegExpExecArray | null;
        while ((m = taskRe.exec(content)) !== null) {
          const status = m[1] === 'x' ? 'done' : 'open';
          const taskId = m[2];
          const title = m[3].trim();
          await this.upsertEntity('Task', taskId, { title, status });
          nodesCreated++;
        }
      } catch { /* skip */ }
    }

    const duration = Date.now() - start;
    logger.info({ nodesCreated, relationshipsCreated, duration }, 'Graph sync complete');
    return { nodesCreated, relationshipsCreated, duration };
  }

  // ── Extract & Store Relationships ────────────────────────────────────

  async extractAndStoreRelationships(triplets: RelationshipTriplet[]): Promise<void> {
    if (!this.available) return;
    for (const t of triplets) {
      await this.upsertEntity(t.from.label, t.from.id, {});
      await this.upsertEntity(t.to.label, t.to.id, {});
      await this.createRelationship(t.from, t.to, t.rel, t.context ? { context: t.context } : undefined);
    }
  }

  // ── Graph-enhanced Context Enrichment ────────────────────────────────

  async enrichWithGraphContext(entityIds: string[], _maxHops: number = 1): Promise<string> {
    if (!this.available || entityIds.length === 0) return '';
    const lines: string[] = [];
    const seen = new Set<string>();

    for (const id of entityIds.slice(0, 5)) {
      const rels = await this.getRelationships(id, 'both');
      for (const r of rels.slice(0, 8)) {
        const key = `${r.from}-${r.type}-${r.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${r.from} ${r.type} ${r.to}`);
      }
    }

    if (lines.length === 0) return '';
    return '\n## Relationship Context\n' + lines.join('\n');
  }

  /**
   * Drop Note nodes whose slug isn't in the caller-provided set of valid IDs.
   * Wikilinks into deleted vault files leave dangling Note nodes with
   * MENTIONS edges pointing at them — this cleans those up.
   *
   * Deliberately NOT auto-scheduled: blast radius is significant, and the
   * caller (dashboard action, MCP tool, manual script) should supply the
   * authoritative valid-IDs set. Runs DETACH DELETE so incoming edges go
   * with the node.
   *
   * Returns counts of what was removed.
   */
  async invalidateOrphanedNotes(validIds: Set<string>): Promise<{ scanned: number; deleted: number }> {
    if (!this.available) return { scanned: 0, deleted: 0 };
    if (validIds.size === 0) {
      // Defense: refuse to run with an empty set — would delete every Note.
      logger.warn('invalidateOrphanedNotes called with empty validIds — refusing to run');
      return { scanned: 0, deleted: 0 };
    }

    let scanned = 0;
    let deleted = 0;
    try {
      const res = await this.graph.query('MATCH (n:Note) RETURN n.id AS id');
      const rows = (res.data ?? []) as Array<{ id: string | null }>;
      scanned = rows.length;
      for (const row of rows) {
        const id = row.id;
        if (!id || validIds.has(id)) continue;
        try {
          await this.graph.query('MATCH (n:Note {id: $id}) DETACH DELETE n', { params: { id } });
          deleted++;
        } catch (err) {
          logger.debug({ err, id }, 'Orphan Note deletion failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'invalidateOrphanedNotes query failed');
    }

    if (deleted > 0) {
      logger.info({ scanned, deleted, validIdsSize: validIds.size }, 'Invalidated orphan Note nodes');
    }
    return { scanned, deleted };
  }
}

// ── Shared Client Helper ───────────────────────────────────────────────

/**
 * Get a client-mode GraphStore connected to the daemon's running instance.
 * Returns null if the daemon isn't running or graph isn't available.
 * Callers should cache the result and reuse it.
 */
let _sharedInstance: GraphStore | null = null;
let _sharedConnecting = false;

export async function getSharedGraphStore(persistenceDir: string): Promise<GraphStore | null> {
  // Return existing instance if available
  if (_sharedInstance?.isAvailable()) return _sharedInstance;

  // Prevent multiple callers from racing to connect
  if (_sharedConnecting) return _sharedInstance;
  _sharedConnecting = true;

  try {
    const gs = _sharedInstance ?? new GraphStore(persistenceDir);
    const connected = await gs.connectToRunning();
    _sharedInstance = connected ? gs : null;
    return _sharedInstance;
  } catch {
    return null;
  } finally {
    _sharedConnecting = false;
  }
}
