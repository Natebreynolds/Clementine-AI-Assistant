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

      // Catch connection-level errors so they don't crash the process
      this.db.on?.('error', (err: Error) => {
        logger.error({ err }, 'FalkorDB server error — disabling graph features');
        this.available = false;
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

      // Catch connection-level errors so they don't crash the process
      this.client.on?.('error', (err: Error) => {
        logger.error({ err }, 'FalkorDB client connection lost — disabling graph features');
        this.available = false;
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
  ): Promise<void> {
    if (!this.available) return;
    const fromLabel = from.label.replace(/[^A-Za-z]/g, '');
    const toLabel = to.label.replace(/[^A-Za-z]/g, '');
    const relType = type.replace(/[^A-Za-z_]/g, '');
    const propsStr = props
      ? ', ' + Object.entries(props).map(([k, _v]) => `r.${k} = $r_${k}`).join(', ')
      : '';
    const params: Record<string, any> = { fromId: from.id, toId: to.id };
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        params[`r_${k}`] = v;
      }
    }
    const cypher =
      `MERGE (a:${fromLabel} {id: $fromId}) ` +
      `MERGE (b:${toLabel} {id: $toId}) ` +
      `MERGE (a)-[r:${relType}]->(b) ` +
      `SET r.created_at = timestamp()${propsStr}`;
    try {
      await this.graph.query(cypher, { params });
    } catch (err) {
      logger.debug({ err, from, to, type }, 'createRelationship failed');
    }
  }

  async getRelationships(
    entityId: string,
    direction: 'in' | 'out' | 'both' = 'both',
    relType?: string,
  ): Promise<Array<{ from: string; to: string; type: string; properties: Record<string, any> }>> {
    if (!this.available) return [];
    const relFilter = relType ? `:${relType.replace(/[^A-Za-z_]/g, '')}` : '';
    const queries: string[] = [];
    if (direction === 'out' || direction === 'both') {
      queries.push(
        `MATCH (a {id: $id})-[r${relFilter}]->(b) RETURN a.id AS from, b.id AS to, type(r) AS rel, properties(r) AS props`,
      );
    }
    if (direction === 'in' || direction === 'both') {
      queries.push(
        `MATCH (a {id: $id})<-[r${relFilter}]-(b) RETURN b.id AS from, a.id AS to, type(r) AS rel, properties(r) AS props`,
      );
    }
    const results: Array<{ from: string; to: string; type: string; properties: Record<string, any> }> = [];
    for (const q of queries) {
      try {
        const res = await this.graph.query(q, { params: { id: entityId } });
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
  ): Promise<TraversalResult[]> {
    if (!this.available) return [];
    const relFilter = relTypes?.length
      ? relTypes.map(t => t.replace(/[^A-Za-z_]/g, '')).join('|')
      : '';
    const relPattern = relFilter ? `:${relFilter}` : '';
    const cypher =
      `MATCH path = (start {id: $id})-[${relPattern}*1..${maxDepth}]->(end) ` +
      `RETURN end.id AS id, labels(end)[0] AS label, properties(end) AS props, ` +
      `length(path) AS depth, [r IN relationships(path) | type(r)] AS rels`;
    try {
      const res = await this.graph.query(cypher, { params: { id: startId } });
      if (!res.data) return [];
      const seen = new Set<string>();
      const results: TraversalResult[] = [];
      for (const row of res.data) {
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
}

// ── Shared Client Helper ───────────────────────────────────────────────

/**
 * Get a client-mode GraphStore connected to the daemon's running instance.
 * Returns null if the daemon isn't running or graph isn't available.
 * Callers should cache the result and reuse it.
 */
export async function getSharedGraphStore(persistenceDir: string): Promise<GraphStore | null> {
  try {
    const gs = new GraphStore(persistenceDir);
    const connected = await gs.connectToRunning();
    return connected ? gs : null;
  } catch {
    return null;
  }
}
