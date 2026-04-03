/**
 * Clementine TypeScript — SQLite FTS5 memory store.
 *
 * Mirrors the Obsidian vault as a search-optimized index. The vault remains
 * the source of truth; this is a read-optimized cache.
 *
 * FTS5 = full-text search built into SQLite. Zero cost. Zero latency.
 *
 * Concurrency: WAL mode allows concurrent readers. Writes are serialized
 * (single-user, one MCP subprocess handles all writes).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  Feedback,
  MemoryExtraction,
  SearchResult,
  SessionSummary,
  SyncStats,
  TranscriptTurn,
  WikilinkConnection,
} from '../types.js';
import * as embeddingsModule from './embeddings.js';
import { chunkFile } from './chunker.js';
import { mmrRerank } from './mmr.js';
import { deduplicateResults } from './search.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export class MemoryStore {
  private dbPath: string;
  private vaultDir: string;
  private db: Database.Database | null = null;

  // Cached prepared statements for hot-path queries
  private _stmtChunkCount: Database.Statement | null = null;
  private _stmtInsertTranscript: Database.Statement | null = null;
  private _stmtInsertUsage: Database.Statement | null = null;

  constructor(dbPath: string, vaultDir: string) {
    this.dbPath = dbPath;
    this.vaultDir = vaultDir;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Create the database and schema if needed.
   */
  initialize(): void {
    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        section TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_type TEXT NOT NULL,
        frontmatter_json TEXT DEFAULT '',
        embedding BLOB,
        content_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS file_hashes (
        rel_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        last_synced TEXT DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        source_file, section, content,
        content='chunks', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, source_file, section, content)
        VALUES (new.id, new.source_file, new.section, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, source_file, section, content)
        VALUES ('delete', old.id, old.source_file, old.section, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, source_file, section, content)
        VALUES ('delete', old.id, old.source_file, old.section, old.content);
        INSERT INTO chunks_fts(rowid, source_file, section, content)
        VALUES (new.id, new.source_file, new.section, new.content);
      END;

      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_file);

      CREATE TABLE IF NOT EXISTS wikilinks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        context TEXT DEFAULT '',
        link_type TEXT DEFAULT 'wikilink'
      );

      CREATE INDEX IF NOT EXISTS idx_wikilinks_source ON wikilinks(source_file);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target_file);

      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_key);
      CREATE INDEX IF NOT EXISTS idx_transcripts_created ON transcripts(created_at);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY,
        session_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        exchange_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_key ON session_summaries(session_key);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at);
    `);

    // ── Migrations ────────────────────────────────────────────────
    // Add salience column to chunks
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN salience REAL DEFAULT 0.0');
    } catch {
      // Column already exists
    }

    // Add sector column to chunks (for episodic memory)
    try {
      this.conn.exec("ALTER TABLE chunks ADD COLUMN sector TEXT DEFAULT 'semantic'");
    } catch {
      // Column already exists
    }

    // Add agent_slug column to chunks (for agent-scoped memory)
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN agent_slug TEXT DEFAULT NULL');
    } catch {
      // Column already exists
    }

    // Index for agent-scoped queries
    try {
      this.conn.exec('CREATE INDEX idx_chunks_agent ON chunks(agent_slug)');
    } catch {
      // Index already exists
    }

    // Add consolidated flag to chunks (for memory consolidation)
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN consolidated INTEGER DEFAULT 0');
    } catch {
      // Column already exists
    }

    // Access log table for salience tracking
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL,
        access_type TEXT NOT NULL,
        accessed_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_access_log_chunk ON access_log(chunk_id);
    `);

    // Memory extractions table for transparency
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS memory_extractions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        user_message TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'active',
        correction TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_extractions_session ON memory_extractions(session_key);
      CREATE INDEX IF NOT EXISTS idx_extractions_status ON memory_extractions(status);
    `);

    // Add agent_slug column to memory_extractions
    try {
      this.conn.exec('ALTER TABLE memory_extractions ADD COLUMN agent_slug TEXT DEFAULT NULL');
    } catch {
      // Column already exists
    }

    // Add metacognitive_summary column to session_reflections
    try {
      this.conn.exec('ALTER TABLE session_reflections ADD COLUMN metacognitive_summary TEXT DEFAULT NULL');
    } catch {
      // Column already exists
    }

    // Feedback table for response quality tracking
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT,
        channel TEXT NOT NULL,
        message_snippet TEXT,
        response_snippet TEXT,
        rating TEXT NOT NULL CHECK(rating IN ('positive', 'negative', 'mixed')),
        comment TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
      CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
    `);

    // Session reflections for conversational learning
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS session_reflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        exchange_count INTEGER DEFAULT 0,
        friction_signals TEXT DEFAULT '[]',
        quality_score INTEGER DEFAULT 3,
        behavioral_corrections TEXT DEFAULT '[]',
        preferences_learned TEXT DEFAULT '[]',
        metacognitive_summary TEXT DEFAULT NULL,
        agent_slug TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_reflections_created ON session_reflections(created_at);
      CREATE INDEX IF NOT EXISTS idx_reflections_agent ON session_reflections(agent_slug);
    `);

    // Usage log table for token tracking
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        num_turns INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log(session_key);
      CREATE INDEX IF NOT EXISTS idx_usage_source ON usage_log(source);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
    `);

    // ── SDR Operational Tables ───────────────────────────────────────

    // Leads — structured prospect records for SDR workflows
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_slug TEXT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        company TEXT,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        source TEXT,
        sf_id TEXT,
        metadata JSON DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads(agent_slug);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company);
      CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
    `);

    // Sequence enrollments — tracks each lead's position in an outbound cadence
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS sequence_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id),
        sequence_name TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        next_step_due_at TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_seq_lead ON sequence_enrollments(lead_id);
      CREATE INDEX IF NOT EXISTS idx_seq_status ON sequence_enrollments(status);
      CREATE INDEX IF NOT EXISTS idx_seq_due ON sequence_enrollments(next_step_due_at);
    `);

    // Activities — log of all SDR actions (emails sent, meetings booked, etc.)
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER REFERENCES leads(id),
        agent_slug TEXT,
        type TEXT NOT NULL,
        subject TEXT,
        detail TEXT,
        template_used TEXT,
        performed_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
      CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_slug);
      CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
      CREATE INDEX IF NOT EXISTS idx_activities_performed ON activities(performed_at);
    `);

    // Suppression list — emails that must never be contacted (opt-out, bounce, complaint)
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS suppression_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        added_at TEXT DEFAULT (datetime('now')),
        added_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_suppression_email ON suppression_list(email);
    `);

    // Send log — tracks every outbound email for daily cap enforcement and audit
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_slug TEXT,
        recipient TEXT NOT NULL,
        subject TEXT,
        template_used TEXT,
        sent_at TEXT DEFAULT (datetime('now')),
        policy_ref TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sendlog_agent ON send_log(agent_slug);
      CREATE INDEX IF NOT EXISTS idx_sendlog_sent ON send_log(sent_at);
    `);

    // Approval queue — pending actions awaiting human review
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS approval_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_slug TEXT,
        action_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail JSON DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_agent ON approval_queue(agent_slug);
      CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_queue(status);
    `);

    // Config revisions — versioned snapshots of agent config files
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS config_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_slug TEXT NOT NULL,
        file_name TEXT NOT NULL,
        content TEXT NOT NULL,
        changed_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_configrev_agent ON config_revisions(agent_slug);
      CREATE INDEX IF NOT EXISTS idx_configrev_file ON config_revisions(agent_slug, file_name);
    `);

    // Salesforce sync log — audit trail for CRM sync operations
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS sf_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_table TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        sf_object_type TEXT NOT NULL,
        sf_id TEXT NOT NULL,
        sync_direction TEXT NOT NULL,
        synced_at TEXT DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'success',
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sf_sync_local ON sf_sync_log(local_table, local_id);
      CREATE INDEX IF NOT EXISTS idx_sf_sync_sfid ON sf_sync_log(sf_id);
      CREATE INDEX IF NOT EXISTS idx_sf_sync_status ON sf_sync_log(sync_status);
    `);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Lazily-initializing accessor for the database connection. */
  private get conn(): Database.Database {
    if (!this.db) {
      this.initialize();
    }
    return this.db!;
  }

  /** Return the total number of indexed chunks. */
  getChunkCount(): number {
    try {
      if (!this._stmtChunkCount) {
        this._stmtChunkCount = this.conn.prepare('SELECT COUNT(*) as cnt FROM chunks');
      }
      const row = this._stmtChunkCount.get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch { return 0; }
  }

  // ── Full Sync ──────────────────────────────────────────────────────

  /**
   * Scan the entire vault, hash-compare, and re-index changed files.
   */
  fullSync(): SyncStats {
    const stats: SyncStats = {
      filesScanned: 0,
      filesUpdated: 0,
      filesDeleted: 0,
      chunksTotal: 0,
    };

    // Get current file hashes from DB
    const existing = new Map<string, string>();
    const hashRows = this.conn
      .prepare('SELECT rel_path, content_hash FROM file_hashes')
      .all() as Array<{ rel_path: string; content_hash: string }>;
    for (const row of hashRows) {
      existing.set(row.rel_path, row.content_hash);
    }

    // Scan vault
    const seenFiles = new Set<string>();
    const filesToUpdate: string[] = [];

    this.walkMdFiles(this.vaultDir, (filePath) => {
      const rel = path.relative(this.vaultDir, filePath);

      // Skip .obsidian and templates
      if (rel.includes('.obsidian') || rel.startsWith('06-Templates')) {
        return;
      }

      seenFiles.add(rel);
      stats.filesScanned++;

      // Hash the file content
      let fileHash: string;
      try {
        const bytes = readFileSync(filePath);
        fileHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      } catch {
        return;
      }

      // Skip unchanged files
      if (existing.has(rel) && existing.get(rel) === fileHash) {
        return;
      }

      filesToUpdate.push(filePath);
    });

    // Delete removed files
    for (const relPath of existing.keys()) {
      if (!seenFiles.has(relPath)) {
        this.deleteFileChunks(relPath);
        stats.filesDeleted++;
      }
    }

    // Process changed/new files
    for (const filePath of filesToUpdate) {
      const rel = path.relative(this.vaultDir, filePath);
      const chunks = chunkFile(filePath, this.vaultDir);
      if (chunks.length === 0) continue;

      // Delete old chunks for this file
      this.deleteFileChunks(rel);

      // Insert new chunks
      const insertStmt = this.conn.prepare(
        `INSERT INTO chunks
         (source_file, section, content, chunk_type, frontmatter_json, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        insertStmt.run(
          chunk.sourceFile,
          chunk.section,
          chunk.content,
          chunk.chunkType,
          chunk.frontmatterJson,
          chunk.contentHash,
        );
      }

      // Parse and index wikilinks
      this.indexWikilinks(rel, filePath);

      // Update file hash
      const bytes = readFileSync(filePath);
      const fileHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      this.conn
        .prepare(
          `INSERT OR REPLACE INTO file_hashes (rel_path, content_hash, last_synced)
           VALUES (?, ?, datetime('now'))`,
        )
        .run(rel, fileHash);

      stats.filesUpdated++;
    }

    // Count total chunks
    const countRow = this.conn
      .prepare('SELECT COUNT(*) as cnt FROM chunks')
      .get() as { cnt: number } | undefined;
    stats.chunksTotal = countRow?.cnt ?? 0;

    return stats;
  }

  // ── Incremental Update ─────────────────────────────────────────────

  /**
   * Re-index a single file after a write operation.
   */
  updateFile(relPath: string, agentSlug?: string): void {
    const fullPath = path.join(this.vaultDir, relPath);

    if (!existsSync(fullPath)) {
      this.deleteFileChunks(relPath);
      return;
    }

    // Delete old chunks
    this.deleteFileChunks(relPath);

    // Re-chunk
    const chunks = chunkFile(fullPath, this.vaultDir);
    if (chunks.length === 0) return;

    // Insert new chunks
    const insertStmt = this.conn.prepare(
      `INSERT INTO chunks
       (source_file, section, content, chunk_type, frontmatter_json, content_hash, agent_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const chunk of chunks) {
      insertStmt.run(
        chunk.sourceFile,
        chunk.section,
        chunk.content,
        chunk.chunkType,
        chunk.frontmatterJson,
        chunk.contentHash,
        agentSlug ?? null,
      );
    }

    // Parse and index wikilinks
    this.indexWikilinks(relPath, fullPath);

    // Update file hash
    const bytes = readFileSync(fullPath);
    const fileHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO file_hashes (rel_path, content_hash, last_synced)
         VALUES (?, ?, datetime('now'))`,
      )
      .run(relPath, fileHash);
  }

  // ── Search: FTS5 ──────────────────────────────────────────────────

  /**
   * Full-text search using FTS5 with BM25 ranking.
   */
  searchFts(query: string, limit: number = 20): SearchResult[] {
    const sanitized = MemoryStore.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      const rows = this.conn
        .prepare(
          `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                  c.updated_at, c.salience, c.agent_slug,
                  bm25(chunks_fts) as score
           FROM chunks_fts f
           JOIN chunks c ON c.id = f.rowid
           WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts)
           LIMIT ?`,
        )
        .all(sanitized, limit) as Array<{
        id: number;
        source_file: string;
        section: string;
        content: string;
        chunk_type: string;
        updated_at: string | null;
        salience: number | null;
        agent_slug: string | null;
        score: number;
      }>;

      return rows.map((row) => ({
        sourceFile: row.source_file,
        section: row.section,
        content: row.content,
        score: -row.score, // BM25 returns negative scores (lower = better)
        chunkType: row.chunk_type,
        matchType: 'fts' as const,
        lastUpdated: row.updated_at ?? '',
        chunkId: row.id,
        salience: row.salience ?? 0,
        agentSlug: row.agent_slug ?? null,
      }));
    } catch {
      return [];
    }
  }

  // ── Search: Recent Chunks ─────────────────────────────────────────

  /**
   * Get the most recently updated chunks.
   */
  getRecentChunks(limit: number = 5, agentSlug?: string): SearchResult[] {
    type ChunkRow = {
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      updated_at: string | null;
      salience: number | null;
      agent_slug: string | null;
    };

    const mapRow = (row: ChunkRow): SearchResult => ({
      sourceFile: row.source_file,
      section: row.section,
      content: row.content,
      score: 0,
      chunkType: row.chunk_type,
      matchType: 'recency' as const,
      lastUpdated: row.updated_at ?? '',
      chunkId: row.id,
      salience: row.salience ?? 0,
      agentSlug: row.agent_slug ?? null,
    });

    // If agent specified, get a mix: mostly agent-specific, some global
    if (agentSlug) {
      const agentRows = this.conn.prepare(
        `SELECT id, source_file, section, content, chunk_type,
                updated_at, salience, agent_slug
         FROM chunks WHERE agent_slug = ?
         ORDER BY updated_at DESC LIMIT ?`,
      ).all(agentSlug, Math.ceil(limit * 0.6)) as ChunkRow[];

      const globalRows = this.conn.prepare(
        `SELECT id, source_file, section, content, chunk_type,
                updated_at, salience, agent_slug
         FROM chunks WHERE agent_slug IS NULL
         ORDER BY updated_at DESC LIMIT ?`,
      ).all(Math.ceil(limit * 0.4)) as ChunkRow[];

      return [...agentRows, ...globalRows].slice(0, limit).map(mapRow);
    }

    const rows = this.conn
      .prepare(
        `SELECT id, source_file, section, content, chunk_type,
                updated_at, salience, agent_slug
         FROM chunks
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as ChunkRow[];

    return rows.map(mapRow);
  }

  // ── Search: Context (Layer 3) ─────────────────────────────────────

  /**
   * Combined FTS5 relevance + recency search for context injection.
   *
   * Layer 3 of the memory architecture:
   * 1. FTS5 search -> top N relevant
   * 2. Recency fetch -> N most recent chunks
   * 3. Deduplicate by (source_file, section)
   * 4. Apply salience boost to FTS results
   */
  searchContext(
    query: string,
    limitOrOpts: number | { limit?: number; recencyLimit?: number; agentSlug?: string } = 3,
    recencyLimitArg: number = 5,
  ): SearchResult[] {
    let limit: number;
    let recencyLimit: number;
    let agentSlug: string | undefined;
    if (typeof limitOrOpts === 'object') {
      limit = limitOrOpts.limit ?? 3;
      recencyLimit = limitOrOpts.recencyLimit ?? 5;
      agentSlug = limitOrOpts.agentSlug;
    } else {
      limit = limitOrOpts;
      recencyLimit = recencyLimitArg;
    }
    // 1. FTS5 relevance (fetch extra to allow re-ranking after boost)
    const ftsResults = this.searchFts(query, agentSlug ? limit * 2 : limit);

    // Apply salience boost to FTS results
    for (const r of ftsResults) {
      if (r.salience > 0) {
        r.score *= 1.0 + r.salience;
      }
    }

    // Apply agent affinity boost — own-agent results get 1.4× score
    if (agentSlug) {
      for (const r of ftsResults) {
        if (r.agentSlug === agentSlug) {
          r.score *= 1.4;
        }
      }
    }

    // 2. Vector similarity (if embeddings available)
    let vectorResults: SearchResult[] = [];
    try {
      if (embeddingsModule.isReady()) {
        const queryVec = embeddingsModule.embed(query);
        if (queryVec) {
          vectorResults = this.searchByEmbedding(queryVec, limit, agentSlug);
        }
      }
    } catch {
      // Embeddings not available — fallback to FTS only
    }

    // 3. Recency
    const recentResults = this.getRecentChunks(recencyLimit, agentSlug);

    // 4. Merge and deduplicate (FTS results first, then vector, then recency)
    const merged = [...ftsResults, ...vectorResults, ...recentResults];
    return mmrRerank(deduplicateResults(merged), 0.7, limit + recencyLimit);
  }

  /**
   * Search chunks by embedding cosine similarity.
   * Scans chunks that have stored embeddings and returns top matches.
   */
  private searchByEmbedding(queryVec: Float32Array, limit: number, agentSlug?: string): SearchResult[] {
    const rows = this.conn
      .prepare(
        `SELECT id, source_file, section, content, chunk_type, embedding, salience, agent_slug, updated_at
         FROM chunks
         WHERE embedding IS NOT NULL AND consolidated = 0
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all() as Array<{
        id: number;
        source_file: string;
        section: string;
        content: string;
        chunk_type: string;
        embedding: Buffer;
        salience: number;
        agent_slug: string | null;
        updated_at: string;
      }>;

    const scored: SearchResult[] = [];
    for (const row of rows) {
      try {
        const vec = embeddingsModule.deserializeEmbedding(row.embedding);
        const sim = embeddingsModule.cosineSimilarity(queryVec, vec);
        if (sim < 0.15) continue; // threshold for relevance

        let score = sim * 10; // scale to comparable range with FTS scores
        if (row.salience > 0) score *= (1.0 + row.salience);
        if (agentSlug && row.agent_slug === agentSlug) score *= 1.4;

        scored.push({
          sourceFile: row.source_file,
          section: row.section,
          content: row.content,
          score,
          chunkType: row.chunk_type,
          matchType: 'vector',
          lastUpdated: row.updated_at,
          chunkId: row.id,
          salience: row.salience,
          agentSlug: row.agent_slug ?? undefined,
        });
      } catch { continue; }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ── Wikilink Graph ────────────────────────────────────────────────

  /**
   * Get all notes connected to/from the given note via wikilinks.
   */
  getConnections(noteName: string): WikilinkConnection[] {
    const results: WikilinkConnection[] = [];

    // Outgoing links (this note links to others)
    const outgoing = this.conn
      .prepare(
        'SELECT target_file, context FROM wikilinks WHERE source_file LIKE ?',
      )
      .all(`%${noteName}%`) as Array<{ target_file: string; context: string }>;
    for (const row of outgoing) {
      results.push({
        direction: 'outgoing',
        file: row.target_file,
        context: row.context,
      });
    }

    // Incoming links (other notes link to this one)
    const incoming = this.conn
      .prepare(
        'SELECT source_file, context FROM wikilinks WHERE target_file LIKE ?',
      )
      .all(`%${noteName}%`) as Array<{ source_file: string; context: string }>;
    for (const row of incoming) {
      results.push({
        direction: 'incoming',
        file: row.source_file,
        context: row.context,
      });
    }

    return results;
  }

  // ── Transcripts ───────────────────────────────────────────────────

  /**
   * Save a conversation turn to the transcripts table.
   */
  saveTurn(
    sessionKey: string,
    role: string,
    content: string,
    model: string = '',
  ): void {
    if (!this._stmtInsertTranscript) {
      this._stmtInsertTranscript = this.conn.prepare(
        'INSERT INTO transcripts (session_key, role, content, model) VALUES (?, ?, ?, ?)',
      );
    }
    this._stmtInsertTranscript.run(sessionKey, role, content, model);
  }

  /**
   * Get all turns for a given session, ordered chronologically.
   */
  getSessionTranscript(sessionKey: string): TranscriptTurn[] {
    const rows = this.conn
      .prepare(
        `SELECT session_key, role, content, model, created_at
         FROM transcripts WHERE session_key = ? ORDER BY id`,
      )
      .all(sessionKey) as Array<{
      session_key: string;
      role: string;
      content: string;
      model: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      sessionKey: row.session_key,
      role: row.role,
      content: row.content,
      model: row.model,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get recent transcript activity across all sessions since a given timestamp.
   * Returns a compact summary of what happened (sessions, message counts, snippets).
   */
  getRecentActivity(sinceIso: string, maxEntries = 10): Array<{
    sessionKey: string;
    role: string;
    content: string;
    createdAt: string;
  }> {
    const rows = this.conn
      .prepare(
        `SELECT session_key, role, content, created_at
         FROM transcripts
         WHERE created_at > ? AND role IN ('user', 'assistant', 'system')
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceIso, maxEntries) as Array<{
      session_key: string;
      role: string;
      content: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      sessionKey: row.session_key,
      role: row.role,
      content: row.content.slice(0, 300),
      createdAt: row.created_at,
    }));
  }

  /**
   * Search transcripts by keyword. Returns matching turns with context.
   */
  searchTranscripts(
    query: string,
    limit: number = 20,
    sessionKey: string = '',
  ): TranscriptTurn[] {
    const queryLower = `%${query.toLowerCase()}%`;
    let rows: Array<{
      session_key: string;
      role: string;
      content: string;
      model: string;
      created_at: string;
    }>;

    if (sessionKey) {
      rows = this.conn
        .prepare(
          `SELECT session_key, role, content, model, created_at
           FROM transcripts
           WHERE session_key = ? AND LOWER(content) LIKE ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(sessionKey, queryLower, limit) as typeof rows;
    } else {
      rows = this.conn
        .prepare(
          `SELECT session_key, role, content, model, created_at
           FROM transcripts
           WHERE LOWER(content) LIKE ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(queryLower, limit) as typeof rows;
    }

    return rows.map((row) => ({
      sessionKey: row.session_key,
      role: row.role,
      content: row.content.slice(0, 2000), // Truncate for readability
      model: row.model,
      createdAt: row.created_at,
    }));
  }

  // ── Session Summaries ─────────────────────────────────────────────

  /**
   * Save a session summary for cross-session context.
   */
  saveSessionSummary(
    sessionKey: string,
    summary: string,
    exchangeCount: number = 0,
  ): void {
    this.conn
      .prepare(
        'INSERT INTO session_summaries (session_key, summary, exchange_count) VALUES (?, ?, ?)',
      )
      .run(sessionKey, summary, exchangeCount);
  }

  /**
   * Get the most recent session summaries.
   */
  getRecentSummaries(limit: number = 3): SessionSummary[] {
    const rows = this.conn
      .prepare(
        `SELECT session_key, summary, exchange_count, created_at
         FROM session_summaries ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      session_key: string;
      summary: string;
      exchange_count: number;
      created_at: string;
    }>;

    return rows.map((row) => ({
      sessionKey: row.session_key,
      summary: row.summary,
      exchangeCount: row.exchange_count,
      createdAt: row.created_at,
    }));
  }

  // ── Salience Tracking ─────────────────────────────────────────────

  /**
   * Record that chunks were accessed (retrieved/displayed).
   */
  recordAccess(chunkIds: number[], accessType: string = 'retrieval'): void {
    if (chunkIds.length === 0) return;

    const insertStmt = this.conn.prepare(
      'INSERT INTO access_log (chunk_id, access_type) VALUES (?, ?)',
    );
    for (const cid of chunkIds) {
      insertStmt.run(cid, accessType);
    }

    // Recompute salience for accessed chunks
    for (const cid of chunkIds) {
      this.recomputeSalience(cid);
    }
  }

  /**
   * Recompute salience score for a chunk based on access patterns.
   *
   * salience = frequency_bonus + recency_bonus
   * frequency_bonus = log(access_count + 1) * 0.15
   * recency_bonus = decay(days_since_last_access, half_life=7) * 0.3
   */
  private recomputeSalience(chunkId: number): void {
    const row = this.conn
      .prepare(
        'SELECT COUNT(*) as cnt, MAX(accessed_at) as last_access FROM access_log WHERE chunk_id = ?',
      )
      .get(chunkId) as { cnt: number; last_access: string | null } | undefined;

    if (!row || row.cnt === 0) return;

    const frequencyBonus = Math.log(row.cnt + 1) * 0.15;

    let recencyBonus = 0;
    if (row.last_access) {
      try {
        const last = new Date(row.last_access);
        const daysOld = (Date.now() - last.getTime()) / 86_400_000;
        recencyBonus = Math.exp(-0.693 * daysOld / 7.0) * 0.3;
      } catch {
        // Invalid date, skip recency bonus
      }
    }

    const salience = frequencyBonus + recencyBonus;
    this.conn
      .prepare('UPDATE chunks SET salience = ? WHERE id = ?')
      .run(salience, chunkId);
  }

  // ── Decay & Pruning ─────────────────────────────────────────────

  /**
   * Apply temporal decay to all chunk salience scores.
   *
   * Call daily (or on startup). Reduces salience for chunks that
   * haven't been accessed recently, so stale memories naturally
   * sink below active ones.
   *
   * decay = exp(-0.693 * daysSinceLastAccess / halfLife)
   */
  decaySalience(halfLifeDays: number = 30): number {
    // Get chunks that have salience > 0 and their most recent access
    const rows = this.conn
      .prepare(
        `SELECT c.id, c.salience,
                MAX(a.accessed_at) as last_access
         FROM chunks c
         LEFT JOIN access_log a ON a.chunk_id = c.id
         WHERE c.salience > 0.001
         GROUP BY c.id`,
      )
      .all() as Array<{
      id: number;
      salience: number;
      last_access: string | null;
    }>;

    if (rows.length === 0) return 0;

    let updated = 0;
    const updateStmt = this.conn.prepare(
      'UPDATE chunks SET salience = ? WHERE id = ?',
    );

    for (const row of rows) {
      let daysOld = halfLifeDays; // default if no access log
      if (row.last_access) {
        try {
          const last = new Date(row.last_access);
          daysOld = (Date.now() - last.getTime()) / 86_400_000;
        } catch {
          // Use default
        }
      }

      const decayFactor = Math.exp(-0.693 * daysOld / halfLifeDays);
      const newSalience = row.salience * decayFactor;

      // Only update if meaningfully changed
      if (Math.abs(newSalience - row.salience) > 0.001) {
        updateStmt.run(newSalience < 0.001 ? 0 : newSalience, row.id);
        updated++;
      }
    }

    return updated;
  }

  /**
   * Prune stale data to keep the database bounded.
   *
   * - Deletes episodic chunks with salience < threshold and age > maxDays
   * - Trims access_log entries older than retentionDays
   * - Trims transcripts older than retentionDays
   *
   * Returns counts of deleted items.
   */
  pruneStaleData(opts: {
    maxAgeDays?: number;
    salienceThreshold?: number;
    accessLogRetentionDays?: number;
    transcriptRetentionDays?: number;
  } = {}): { episodicPruned: number; accessLogPruned: number; transcriptsPruned: number } {
    const maxAge = opts.maxAgeDays ?? 90;
    const threshold = opts.salienceThreshold ?? 0.01;
    const accessRetention = opts.accessLogRetentionDays ?? 60;
    const transcriptRetention = opts.transcriptRetentionDays ?? 90;

    // Prune stale episodic chunks (not vault-sourced content)
    const episodicResult = this.conn
      .prepare(
        `DELETE FROM chunks
         WHERE sector = 'episodic'
           AND salience < ?
           AND created_at < datetime('now', ?)`,
      )
      .run(threshold, `-${maxAge} days`);

    // Trim old access_log entries
    const accessResult = this.conn
      .prepare(
        `DELETE FROM access_log
         WHERE accessed_at < datetime('now', ?)`,
      )
      .run(`-${accessRetention} days`);

    // Trim old transcripts (keep session_summaries which are more compact)
    const transcriptResult = this.conn
      .prepare(
        `DELETE FROM transcripts
         WHERE created_at < datetime('now', ?)`,
      )
      .run(`-${transcriptRetention} days`);

    return {
      episodicPruned: episodicResult.changes,
      accessLogPruned: accessResult.changes,
      transcriptsPruned: transcriptResult.changes,
    };
  }

  // ── Timeline Query ─────────────────────────────────────────────

  /**
   * Get chunks within a date range, ordered chronologically.
   * Useful for "what happened last week" type queries.
   */
  getTimeline(
    startDate: string,
    endDate: string,
    limit: number = 20,
  ): SearchResult[] {
    const rows = this.conn
      .prepare(
        `SELECT id, source_file, section, content, chunk_type,
                updated_at, salience
         FROM chunks
         WHERE updated_at >= ? AND updated_at <= ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(startDate, endDate + 'T23:59:59', limit) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      updated_at: string | null;
      salience: number | null;
    }>;

    return rows.map((row) => ({
      sourceFile: row.source_file,
      section: row.section,
      content: row.content,
      score: 0,
      chunkType: row.chunk_type,
      matchType: 'timeline' as const,
      lastUpdated: row.updated_at ?? '',
      chunkId: row.id,
      salience: row.salience ?? 0,
    }));
  }

  // ── Episodic Memory ───────────────────────────────────────────────

  /**
   * Index a session summary as an episodic memory chunk.
   *
   * These chunks have sector='episodic' and a synthetic source_file
   * so they can be found by search but distinguished from vault content.
   */
  indexEpisodicChunk(sessionKey: string, summaryText: string): void {
    const sourceFile = `_episodic/${sessionKey}`;
    const hash = createHash('sha256')
      .update(summaryText)
      .digest('hex')
      .slice(0, 16);

    this.conn
      .prepare(
        `INSERT INTO chunks
         (source_file, section, content, chunk_type, frontmatter_json,
          content_hash, sector)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sourceFile, 'session-summary', summaryText, 'episodic', '', hash, 'episodic');
  }

  // ── Deduplication ──────────────────────────────────────────────

  /**
   * Check if content is a duplicate of something already stored.
   * Returns match info or null if content is unique.
   *
   * Strategy:
   * 1. Exact match via content_hash (fast)
   * 2. Near-duplicate via FTS5 BM25 + word overlap (conservative)
   */
  checkDuplicate(content: string, sourceFile?: string): {
    isDuplicate: boolean;
    matchType: 'exact' | 'near' | null;
    matchId?: number;
  } {
    // Skip dedup for very short content
    if (content.length < 20) {
      return { isDuplicate: false, matchType: null };
    }

    // 1. Exact hash match
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    try {
      const exactMatch = this.conn
        .prepare(
          `SELECT id FROM chunks WHERE content_hash = ?${sourceFile ? ' AND source_file = ?' : ''} LIMIT 1`,
        )
        .get(...(sourceFile ? [hash, sourceFile] : [hash])) as { id: number } | undefined;

      if (exactMatch) {
        return { isDuplicate: true, matchType: 'exact', matchId: exactMatch.id };
      }
    } catch {
      // Fall through to near-duplicate check
    }

    // 2. Near-duplicate via FTS5 BM25 + word overlap
    try {
      // Extract significant words (>3 chars, no stop words)
      const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should']);
      const words = content
        .toLowerCase()
        .split(/\s+/)
        .map(w => w.replace(/[^a-z0-9]/g, ''))
        .filter(w => w.length > 3 && !stopWords.has(w));

      if (words.length < 3) {
        return { isDuplicate: false, matchType: null };
      }

      // Take top 8 most significant words for the FTS query
      const queryWords = [...new Set(words)].slice(0, 8);
      const ftsQuery = queryWords.map(w => `"${w}"`).join(' OR ');

      const rows = this.conn
        .prepare(
          `SELECT c.id, c.content, bm25(chunks_fts) as score
           FROM chunks_fts f
           JOIN chunks c ON c.id = f.rowid
           WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts)
           LIMIT 5`,
        )
        .all(ftsQuery) as Array<{ id: number; content: string; score: number }>;

      // Check word overlap with top results
      const contentWordsSet = new Set(words);
      for (const row of rows) {
        const matchWords = row.content
          .toLowerCase()
          .split(/\s+/)
          .map(w => w.replace(/[^a-z0-9]/g, ''))
          .filter(w => w.length > 3 && !stopWords.has(w));

        const matchWordsSet = new Set(matchWords);
        const overlap = [...contentWordsSet].filter(w => matchWordsSet.has(w)).length;
        const overlapRatio = overlap / Math.max(contentWordsSet.size, 1);

        // Conservative threshold: >70% word overlap AND good BM25 score
        if (overlapRatio > 0.7 && -row.score > 5) {
          return { isDuplicate: true, matchType: 'near', matchId: row.id };
        }
      }
    } catch {
      // FTS5 query failed — fall through (exact-hash-only is fine)
    }

    return { isDuplicate: false, matchType: null };
  }

  /**
   * Bump a chunk's salience and update its timestamp when a duplicate is detected.
   * Instead of discarding duplicate mentions, this reinforces the existing chunk
   * so frequently-mentioned facts surface higher in search results.
   */
  bumpChunkSalience(chunkId: number, boost: number = 0.1): void {
    this.conn
      .prepare(
        `UPDATE chunks
         SET salience = MIN(salience + ?, 1.0),
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(boost, chunkId);
  }

  // ── Memory Extractions ──────────────────────────────────────────

  /**
   * Log a memory extraction event for transparency tracking.
   */
  logExtraction(extraction: Omit<MemoryExtraction, 'id'>): void {
    this.conn
      .prepare(
        `INSERT INTO memory_extractions
         (session_key, user_message, tool_name, tool_input, extracted_at, status, agent_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        extraction.sessionKey,
        extraction.userMessage,
        extraction.toolName,
        extraction.toolInput,
        extraction.extractedAt,
        extraction.status,
        extraction.agentSlug ?? null,
      );
  }

  /**
   * Get recent memory extractions, optionally filtered by status.
   */
  getRecentExtractions(limit: number = 10, status?: string): MemoryExtraction[] {
    let rows: Array<{
      id: number;
      session_key: string;
      user_message: string;
      tool_name: string;
      tool_input: string;
      extracted_at: string;
      status: string;
      correction: string | null;
    }>;

    if (status) {
      rows = this.conn
        .prepare(
          `SELECT id, session_key, user_message, tool_name, tool_input,
                  extracted_at, status, correction
           FROM memory_extractions
           WHERE status = ?
           ORDER BY extracted_at DESC LIMIT ?`,
        )
        .all(status, limit) as typeof rows;
    } else {
      rows = this.conn
        .prepare(
          `SELECT id, session_key, user_message, tool_name, tool_input,
                  extracted_at, status, correction
           FROM memory_extractions
           ORDER BY extracted_at DESC LIMIT ?`,
        )
        .all(limit) as typeof rows;
    }

    return rows.map((row) => ({
      id: row.id,
      sessionKey: row.session_key,
      userMessage: row.user_message,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      extractedAt: row.extracted_at,
      status: row.status as MemoryExtraction['status'],
      correction: row.correction ?? undefined,
    }));
  }

  /**
   * Mark an extraction as corrected with a replacement fact.
   * Also removes the wrong content from the search index so it stops surfacing.
   */
  correctExtraction(id: number, correction: string): void {
    // Mark the extraction record
    this.conn
      .prepare(
        `UPDATE memory_extractions
         SET status = 'corrected', correction = ?
         WHERE id = ?`,
      )
      .run(correction, id);

    // Find the original extraction to identify what was written
    const extraction = this.conn
      .prepare('SELECT tool_name, tool_input FROM memory_extractions WHERE id = ?')
      .get(id) as { tool_name: string; tool_input: string } | undefined;

    if (!extraction) return;

    // Try to find and remove the wrong content from the chunks index.
    // Parse the tool_input to extract the content that was originally written.
    try {
      const input = JSON.parse(extraction.tool_input);
      const content = input.content ?? input.text ?? '';
      if (content && content.length > 10) {
        // Find chunks that match the wrong content via FTS5
        const dup = this.checkDuplicate(content);
        if (dup.isDuplicate && dup.matchId) {
          // Delete the wrong chunk from the search index
          this.conn.prepare('DELETE FROM chunks WHERE id = ?').run(dup.matchId);
        }
      }
    } catch {
      // Non-fatal — the extraction record is still corrected even if we can't find the chunk
    }
  }

  /**
   * Dismiss an extraction (mark as invalid).
   * Also removes the content from the search index.
   */
  dismissExtraction(id: number): void {
    // Find the original extraction before dismissing
    const extraction = this.conn
      .prepare('SELECT tool_name, tool_input FROM memory_extractions WHERE id = ?')
      .get(id) as { tool_name: string; tool_input: string } | undefined;

    this.conn
      .prepare(
        `UPDATE memory_extractions
         SET status = 'dismissed'
         WHERE id = ?`,
      )
      .run(id);

    // Remove wrong content from chunks index
    if (extraction) {
      try {
        const input = JSON.parse(extraction.tool_input);
        const content = input.content ?? input.text ?? '';
        if (content && content.length > 10) {
          const dup = this.checkDuplicate(content);
          if (dup.isDuplicate && dup.matchId) {
            this.conn.prepare('DELETE FROM chunks WHERE id = ?').run(dup.matchId);
          }
        }
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Get recent corrections to use as negative examples in auto-memory extraction.
   * Returns corrections from the last 30 days so the extraction prompt knows
   * what facts have been corrected and shouldn't be re-extracted.
   */
  getRecentCorrections(limit: number = 20): Array<{
    toolInput: string;
    correction: string;
  }> {
    const rows = this.conn
      .prepare(
        `SELECT tool_input, correction
         FROM memory_extractions
         WHERE status IN ('corrected', 'dismissed')
           AND extracted_at >= datetime('now', '-30 days')
         ORDER BY extracted_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ tool_input: string; correction: string | null }>;

    return rows.map((row) => ({
      toolInput: row.tool_input,
      correction: row.correction ?? '(dismissed — this was wrong)',
    }));
  }

  // ── Feedback ───────────────────────────────────────────────────────

  /**
   * Log feedback about response quality.
   */
  logFeedback(feedback: {
    sessionKey?: string;
    channel: string;
    messageSnippet?: string;
    responseSnippet?: string;
    rating: 'positive' | 'negative' | 'mixed';
    comment?: string;
  }): void {
    this.conn
      .prepare(
        `INSERT INTO feedback
         (session_key, channel, message_snippet, response_snippet, rating, comment)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.sessionKey ?? null,
        feedback.channel,
        feedback.messageSnippet ?? null,
        feedback.responseSnippet ?? null,
        feedback.rating,
        feedback.comment ?? null,
      );
  }

  /**
   * Get recent feedback entries.
   */
  getRecentFeedback(limit: number = 10): Feedback[] {
    const rows = this.conn
      .prepare(
        `SELECT id, session_key, channel, message_snippet, response_snippet,
                rating, comment, created_at
         FROM feedback
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      session_key: string | null;
      channel: string;
      message_snippet: string | null;
      response_snippet: string | null;
      rating: string;
      comment: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionKey: row.session_key ?? undefined,
      channel: row.channel,
      messageSnippet: row.message_snippet ?? undefined,
      responseSnippet: row.response_snippet ?? undefined,
      rating: row.rating as Feedback['rating'],
      comment: row.comment ?? undefined,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get aggregate feedback statistics.
   */
  getFeedbackStats(): { positive: number; negative: number; mixed: number; total: number } {
    const rows = this.conn
      .prepare(
        'SELECT rating, COUNT(*) as cnt FROM feedback GROUP BY rating',
      )
      .all() as Array<{ rating: string; cnt: number }>;

    const stats = { positive: 0, negative: 0, mixed: 0, total: 0 };
    for (const row of rows) {
      if (row.rating === 'positive') stats.positive = row.cnt;
      else if (row.rating === 'negative') stats.negative = row.cnt;
      else if (row.rating === 'mixed') stats.mixed = row.cnt;
      stats.total += row.cnt;
    }
    return stats;
  }

  // ── Session Reflections ──────────────────────────────────────────

  saveSessionReflection(reflection: {
    sessionKey: string;
    exchangeCount: number;
    frictionSignals: string[];
    qualityScore: number;
    behavioralCorrections: Array<{ correction: string; category: string; strength: string }>;
    preferencesLearned: Array<{ preference: string; confidence: string }>;
    agentSlug?: string;
  }): void {
    this.conn
      .prepare(
        `INSERT INTO session_reflections
         (session_key, exchange_count, friction_signals, quality_score, behavioral_corrections, preferences_learned, agent_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reflection.sessionKey,
        reflection.exchangeCount,
        JSON.stringify(reflection.frictionSignals),
        reflection.qualityScore,
        JSON.stringify(reflection.behavioralCorrections),
        JSON.stringify(reflection.preferencesLearned),
        reflection.agentSlug ?? null,
      );
  }

  getRecentReflections(limit = 20, agentSlug?: string): Array<{
    sessionKey: string;
    exchangeCount: number;
    frictionSignals: string[];
    qualityScore: number;
    behavioralCorrections: Array<{ correction: string; category: string; strength: string }>;
    preferencesLearned: Array<{ preference: string; confidence: string }>;
    agentSlug: string | null;
    createdAt: string;
  }> {
    const query = agentSlug
      ? `SELECT * FROM session_reflections WHERE agent_slug = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM session_reflections ORDER BY created_at DESC LIMIT ?`;
    const params = agentSlug ? [agentSlug, limit] : [limit];
    const rows = this.conn.prepare(query).all(...params) as any[];
    return rows.map(r => ({
      sessionKey: r.session_key,
      exchangeCount: r.exchange_count,
      frictionSignals: JSON.parse(r.friction_signals || '[]'),
      qualityScore: r.quality_score,
      behavioralCorrections: JSON.parse(r.behavioral_corrections || '[]'),
      preferencesLearned: JSON.parse(r.preferences_learned || '[]'),
      agentSlug: r.agent_slug,
      createdAt: r.created_at,
    }));
  }

  /** Get recurring behavioral corrections (appeared in 2+ sessions). */
  getBehavioralPatterns(minOccurrences = 2): Array<{
    correction: string;
    category: string;
    count: number;
    lastSeen: string;
  }> {
    const rows = this.conn.prepare(
      `SELECT behavioral_corrections, created_at FROM session_reflections
       WHERE created_at >= datetime('now', '-30 days')
       ORDER BY created_at DESC`,
    ).all() as Array<{ behavioral_corrections: string; created_at: string }>;

    // Count occurrences of each correction (normalized lowercase)
    const counts = new Map<string, { correction: string; category: string; count: number; lastSeen: string }>();
    for (const row of rows) {
      try {
        const corrections = JSON.parse(row.behavioral_corrections || '[]') as Array<{ correction: string; category: string }>;
        for (const c of corrections) {
          const key = c.correction.toLowerCase().trim();
          const existing = counts.get(key);
          if (existing) {
            existing.count++;
          } else {
            counts.set(key, { correction: c.correction, category: c.category, count: 1, lastSeen: row.created_at });
          }
        }
      } catch { /* skip malformed */ }
    }

    return [...counts.values()]
      .filter(c => c.count >= minOccurrences)
      .sort((a, b) => b.count - a.count);
  }

  // ── Usage Tracking ────────────────────────────────────────────────

  /**
   * Log token usage from an SDK query result.
   * Iterates modelUsage record and inserts one row per model.
   */
  logUsage(entry: {
    sessionKey: string;
    source: string;
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
    numTurns: number;
    durationMs: number;
  }): void {
    if (!this._stmtInsertUsage) {
      this._stmtInsertUsage = this.conn.prepare(
        `INSERT INTO usage_log (session_key, source, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
    }
    for (const [model, usage] of Object.entries(entry.modelUsage)) {
      this._stmtInsertUsage.run(
        entry.sessionKey,
        entry.source,
        model,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadInputTokens ?? 0,
        usage.cacheCreationInputTokens ?? 0,
        entry.numTurns ?? 0,
        entry.durationMs ?? 0,
      );
    }
  }

  /**
   * Get aggregated usage summary, optionally filtered by time.
   */
  getUsageSummary(sinceIso?: string): {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheCreation: number;
    totalTokens: number;
    byModel: Array<{ model: string; input: number; output: number; cacheRead: number }>;
    bySource: Array<{ source: string; input: number; output: number }>;
    byDay: Array<{ day: string; input: number; output: number }>;
  } {
    const where = sinceIso ? `WHERE created_at >= ?` : '';
    const params = sinceIso ? [sinceIso] : [];

    // Totals
    const totals = this.conn.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_,
              COALESCE(SUM(cache_read_tokens), 0) as tcr, COALESCE(SUM(cache_creation_tokens), 0) as tcc
       FROM usage_log ${where}`,
    ).get(...params) as { ti: number; to_: number; tcr: number; tcc: number };

    // By model
    const byModel = this.conn.prepare(
      `SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output, SUM(cache_read_tokens) as cacheRead
       FROM usage_log ${where} GROUP BY model ORDER BY input DESC`,
    ).all(...params) as Array<{ model: string; input: number; output: number; cacheRead: number }>;

    // By source
    const bySource = this.conn.prepare(
      `SELECT source, SUM(input_tokens) as input, SUM(output_tokens) as output
       FROM usage_log ${where} GROUP BY source ORDER BY input DESC`,
    ).all(...params) as Array<{ source: string; input: number; output: number }>;

    // By day (last 7 days)
    const byDay = this.conn.prepare(
      `SELECT date(created_at) as day, SUM(input_tokens) as input, SUM(output_tokens) as output
       FROM usage_log ${where ? where + ' AND' : 'WHERE'} created_at >= date('now', '-7 days')
       GROUP BY date(created_at) ORDER BY day`,
    ).all(...params) as Array<{ day: string; input: number; output: number }>;

    return {
      totalInput: totals.ti,
      totalOutput: totals.to_,
      totalCacheRead: totals.tcr,
      totalCacheCreation: totals.tcc,
      totalTokens: totals.ti + totals.to_,
      byModel,
      bySource,
      byDay,
    };
  }

  /**
   * Get usage summary for a specific session.
   */
  getSessionUsage(sessionKey: string): {
    totalInput: number;
    totalOutput: number;
    totalTokens: number;
    numQueries: number;
  } {
    const row = this.conn.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_,
              COUNT(*) as cnt
       FROM usage_log WHERE session_key = ?`,
    ).get(sessionKey) as { ti: number; to_: number; cnt: number };

    return {
      totalInput: row.ti,
      totalOutput: row.to_,
      totalTokens: row.ti + row.to_,
      numQueries: row.cnt,
    };
  }

  // ── Memory Consolidation ──────────────────────────────────────────

  /**
   * Get chunks that are candidates for consolidation:
   * - Older than `minAgeDays`
   * - Not already consolidated
   * - Grouped by source file prefix (topic area)
   *
   * Returns groups with 3+ chunks that can be synthesized into summaries.
   */
  getConsolidationCandidates(minAgeDays: number = 30): Array<{
    topic: string;
    chunkIds: number[];
    contents: string[];
    totalChars: number;
  }> {
    const rows = this.conn
      .prepare(
        `SELECT id, source_file, section, content
         FROM chunks
         WHERE consolidated = 0
           AND sector = 'semantic'
           AND updated_at <= datetime('now', ? || ' days')
           AND chunk_type != 'frontmatter'
         ORDER BY source_file, section`,
      )
      .all(`-${minAgeDays}`) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
    }>;

    // Group by top-level topic (first path segment, e.g., "03-Projects", "04-Topics")
    const groups = new Map<string, { chunkIds: number[]; contents: string[]; totalChars: number }>();
    for (const row of rows) {
      // Use source_file directory as the grouping key
      const topic = row.source_file.split('/').slice(0, 2).join('/') || row.source_file;
      const group = groups.get(topic) ?? { chunkIds: [], contents: [], totalChars: 0 };
      group.chunkIds.push(row.id);
      group.contents.push(`[${row.section}] ${row.content}`);
      group.totalChars += row.content.length;
      groups.set(topic, group);
    }

    // Only return groups with 3+ chunks (worth consolidating)
    return [...groups.entries()]
      .filter(([, g]) => g.chunkIds.length >= 3)
      .map(([topic, g]) => ({ topic, ...g }))
      .sort((a, b) => b.chunkIds.length - a.chunkIds.length);
  }

  /**
   * Mark chunks as consolidated after they've been synthesized into a summary.
   * Reduces salience so they appear lower in search results (but aren't deleted).
   */
  markConsolidated(chunkIds: number[]): void {
    if (chunkIds.length === 0) return;

    const placeholders = chunkIds.map(() => '?').join(',');
    this.conn
      .prepare(
        `UPDATE chunks
         SET consolidated = 1, salience = MAX(salience - 0.3, 0.0)
         WHERE id IN (${placeholders})`,
      )
      .run(...chunkIds);
  }

  /**
   * Get consolidation stats for monitoring.
   */
  getConsolidationStats(): { totalChunks: number; consolidated: number; unconsolidated: number } {
    const row = this.conn
      .prepare(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(CASE WHEN consolidated = 1 THEN 1 ELSE 0 END), 0) as consolidated
         FROM chunks`,
      )
      .get() as { total: number; consolidated: number };

    return {
      totalChunks: row.total,
      consolidated: row.consolidated,
      unconsolidated: row.total - row.consolidated,
    };
  }

  /**
   * Insert a summary chunk created by the consolidation engine.
   * Gets higher initial salience than regular chunks.
   */
  insertSummaryChunk(sourceFile: string, section: string, content: string): void {
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    this.conn
      .prepare(
        `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, salience, consolidated)
         VALUES (?, ?, ?, 'summary', ?, 0.8, 0)`,
      )
      .run(sourceFile, section, content, hash);
  }

  // ── SDR Operational Data ─────────────────────────────────────────

  // -- Leads --

  upsertLead(lead: {
    agentSlug: string; email: string; name: string;
    company?: string; title?: string; status?: string;
    source?: string; sfId?: string; metadata?: Record<string, unknown>;
  }): { id: number; created: boolean } {
    const existing = this.conn.prepare('SELECT id FROM leads WHERE email = ?').get(lead.email) as { id: number } | undefined;
    if (existing) {
      const sets: string[] = ['updated_at = datetime(\'now\')'];
      const vals: unknown[] = [];
      if (lead.name) { sets.push('name = ?'); vals.push(lead.name); }
      if (lead.company !== undefined) { sets.push('company = ?'); vals.push(lead.company); }
      if (lead.title !== undefined) { sets.push('title = ?'); vals.push(lead.title); }
      if (lead.status) { sets.push('status = ?'); vals.push(lead.status); }
      if (lead.source !== undefined) { sets.push('source = ?'); vals.push(lead.source); }
      if (lead.sfId !== undefined) { sets.push('sf_id = ?'); vals.push(lead.sfId); }
      if (lead.metadata) { sets.push('metadata = ?'); vals.push(JSON.stringify(lead.metadata)); }
      vals.push(existing.id);
      this.conn.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return { id: existing.id, created: false };
    }
    const result = this.conn.prepare(
      `INSERT INTO leads (agent_slug, email, name, company, title, status, source, sf_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      lead.agentSlug, lead.email, lead.name, lead.company ?? null, lead.title ?? null,
      lead.status ?? 'new', lead.source ?? null, lead.sfId ?? null,
      JSON.stringify(lead.metadata ?? {}),
    );
    return { id: Number(result.lastInsertRowid), created: true };
  }

  searchLeads(filters: {
    agentSlug?: string; status?: string; company?: string;
    query?: string; limit?: number;
  }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filters.agentSlug) { where.push('agent_slug = ?'); vals.push(filters.agentSlug); }
    if (filters.status) { where.push('status = ?'); vals.push(filters.status); }
    if (filters.company) { where.push('company LIKE ?'); vals.push(`%${filters.company}%`); }
    if (filters.query) { where.push('(name LIKE ? OR email LIKE ? OR company LIKE ?)'); vals.push(`%${filters.query}%`, `%${filters.query}%`, `%${filters.query}%`); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 50, 200);
    return this.conn.prepare(`SELECT * FROM leads ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...vals, limit) as Array<Record<string, unknown>>;
  }

  getLeadByEmail(email: string): Record<string, unknown> | undefined {
    return this.conn.prepare('SELECT * FROM leads WHERE email = ?').get(email) as Record<string, unknown> | undefined;
  }

  getLeadById(id: number): Record<string, unknown> | undefined {
    return this.conn.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  // -- Sequence Enrollments --

  enrollSequence(enrollment: {
    leadId: number; sequenceName: string; nextStepDueAt?: string;
  }): number {
    const result = this.conn.prepare(
      `INSERT INTO sequence_enrollments (lead_id, sequence_name, current_step, status, next_step_due_at)
       VALUES (?, ?, 0, 'active', ?)`
    ).run(enrollment.leadId, enrollment.sequenceName, enrollment.nextStepDueAt ?? null);
    return Number(result.lastInsertRowid);
  }

  advanceSequence(id: number, updates: {
    currentStep?: number; status?: string; nextStepDueAt?: string | null;
  }): void {
    const sets: string[] = ['updated_at = datetime(\'now\')'];
    const vals: unknown[] = [];
    if (updates.currentStep !== undefined) { sets.push('current_step = ?'); vals.push(updates.currentStep); }
    if (updates.status) { sets.push('status = ?'); vals.push(updates.status); }
    if (updates.nextStepDueAt !== undefined) { sets.push('next_step_due_at = ?'); vals.push(updates.nextStepDueAt); }
    vals.push(id);
    this.conn.prepare(`UPDATE sequence_enrollments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getDueSequences(agentSlug?: string): Array<Record<string, unknown>> {
    const base = `SELECT se.*, l.email, l.name, l.company FROM sequence_enrollments se
      JOIN leads l ON l.id = se.lead_id
      WHERE se.status = 'active' AND se.next_step_due_at <= datetime('now')`;
    const clause = agentSlug ? ` AND l.agent_slug = ?` : '';
    return this.conn.prepare(`${base}${clause} ORDER BY se.next_step_due_at ASC`).all(
      ...(agentSlug ? [agentSlug] : [])
    ) as Array<Record<string, unknown>>;
  }

  getSequencesByLead(leadId: number): Array<Record<string, unknown>> {
    return this.conn.prepare('SELECT * FROM sequence_enrollments WHERE lead_id = ? ORDER BY started_at DESC').all(leadId) as Array<Record<string, unknown>>;
  }

  // -- Activities --

  logActivity(activity: {
    leadId?: number; agentSlug: string; type: string;
    subject?: string; detail?: string; templateUsed?: string;
  }): number {
    const result = this.conn.prepare(
      `INSERT INTO activities (lead_id, agent_slug, type, subject, detail, template_used)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      activity.leadId ?? null, activity.agentSlug, activity.type,
      activity.subject ?? null, activity.detail ?? null, activity.templateUsed ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getActivities(filters: {
    leadId?: number; agentSlug?: string; type?: string; limit?: number; sinceIso?: string;
  }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filters.leadId) { where.push('lead_id = ?'); vals.push(filters.leadId); }
    if (filters.agentSlug) { where.push('agent_slug = ?'); vals.push(filters.agentSlug); }
    if (filters.type) { where.push('type = ?'); vals.push(filters.type); }
    if (filters.sinceIso) { where.push('performed_at >= ?'); vals.push(filters.sinceIso); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 50, 500);
    return this.conn.prepare(`SELECT * FROM activities ${clause} ORDER BY performed_at DESC LIMIT ?`).all(...vals, limit) as Array<Record<string, unknown>>;
  }

  // -- Suppression List --

  addSuppression(email: string, reason: string, addedBy?: string): void {
    this.conn.prepare(
      `INSERT OR IGNORE INTO suppression_list (email, reason, added_by) VALUES (?, ?, ?)`
    ).run(email.toLowerCase(), reason, addedBy ?? null);
  }

  isSuppressed(email: string): boolean {
    const row = this.conn.prepare('SELECT 1 FROM suppression_list WHERE email = ?').get(email.toLowerCase());
    return !!row;
  }

  getSuppressionList(limit: number = 100): Array<Record<string, unknown>> {
    return this.conn.prepare('SELECT * FROM suppression_list ORDER BY added_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  }

  // -- Send Log --

  logSend(entry: {
    agentSlug: string; recipient: string; subject?: string;
    templateUsed?: string; policyRef?: string;
  }): void {
    this.conn.prepare(
      `INSERT INTO send_log (agent_slug, recipient, subject, template_used, policy_ref) VALUES (?, ?, ?, ?, ?)`
    ).run(entry.agentSlug, entry.recipient, entry.subject ?? null, entry.templateUsed ?? null, entry.policyRef ?? null);
  }

  getDailySendCount(agentSlug: string): number {
    const row = this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM send_log WHERE agent_slug = ? AND sent_at >= date('now')`
    ).get(agentSlug) as { cnt: number };
    return row.cnt;
  }

  getSendLog(filters: {
    agentSlug?: string; limit?: number; sinceIso?: string;
  }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filters.agentSlug) { where.push('agent_slug = ?'); vals.push(filters.agentSlug); }
    if (filters.sinceIso) { where.push('sent_at >= ?'); vals.push(filters.sinceIso); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 50, 500);
    return this.conn.prepare(`SELECT * FROM send_log ${clause} ORDER BY sent_at DESC LIMIT ?`).all(...vals, limit) as Array<Record<string, unknown>>;
  }

  // -- Approval Queue --

  addApproval(entry: {
    agentSlug: string; actionType: string; summary: string;
    detail?: Record<string, unknown>;
  }): number {
    const result = this.conn.prepare(
      `INSERT INTO approval_queue (agent_slug, action_type, summary, detail) VALUES (?, ?, ?, ?)`
    ).run(entry.agentSlug, entry.actionType, entry.summary, JSON.stringify(entry.detail ?? {}));
    return Number(result.lastInsertRowid);
  }

  resolveApproval(id: number, status: 'approved' | 'rejected', resolvedBy?: string): void {
    this.conn.prepare(
      `UPDATE approval_queue SET status = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?`
    ).run(status, resolvedBy ?? null, id);
  }

  getPendingApprovals(agentSlug?: string): Array<Record<string, unknown>> {
    if (agentSlug) {
      return this.conn.prepare(
        `SELECT * FROM approval_queue WHERE status = 'pending' AND agent_slug = ? ORDER BY requested_at DESC`
      ).all(agentSlug) as Array<Record<string, unknown>>;
    }
    return this.conn.prepare(
      `SELECT * FROM approval_queue WHERE status = 'pending' ORDER BY requested_at DESC`
    ).all() as Array<Record<string, unknown>>;
  }

  getApprovalById(id: number): Record<string, unknown> | undefined {
    return this.conn.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  // -- Agent KPIs --

  getAgentKpis(agentSlug: string, sinceIso?: string): Record<string, number> {
    const since = sinceIso ?? new Date(Date.now() - 7 * 86400000).toISOString();

    const emailsSent = (this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM activities WHERE agent_slug = ? AND type = 'email_sent' AND performed_at >= ?`
    ).get(agentSlug, since) as { cnt: number }).cnt;

    const emailsReceived = (this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM activities WHERE agent_slug = ? AND type = 'email_received' AND performed_at >= ?`
    ).get(agentSlug, since) as { cnt: number }).cnt;

    const meetingsBooked = (this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM activities WHERE agent_slug = ? AND type = 'meeting_booked' AND performed_at >= ?`
    ).get(agentSlug, since) as { cnt: number }).cnt;

    const leadsCreated = (this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM leads WHERE agent_slug = ? AND created_at >= ?`
    ).get(agentSlug, since) as { cnt: number }).cnt;

    const leadsContacted = (this.conn.prepare(
      `SELECT COUNT(DISTINCT lead_id) as cnt FROM activities WHERE agent_slug = ? AND type = 'email_sent' AND performed_at >= ?`
    ).get(agentSlug, since) as { cnt: number }).cnt;

    const sequencesActive = (this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM sequence_enrollments se JOIN leads l ON l.id = se.lead_id
       WHERE l.agent_slug = ? AND se.status = 'active'`
    ).get(agentSlug) as { cnt: number }).cnt;

    const sequencesCompleted = (this.conn.prepare(
      `SELECT COUNT(*) as cnt FROM sequence_enrollments se JOIN leads l ON l.id = se.lead_id
       WHERE l.agent_slug = ? AND se.status = 'completed' AND se.updated_at >= ?`
    ).get(agentSlug, since) as { cnt: number }).cnt;

    const replyRate = emailsSent > 0 ? Math.round((emailsReceived / emailsSent) * 1000) / 10 : 0;

    return {
      emailsSent, emailsReceived, replyRate, meetingsBooked,
      leadsCreated, leadsContacted, sequencesActive, sequencesCompleted,
    };
  }

  // -- Agent Budget --

  /** Get current month's token spend for an agent (in cents, estimated from token counts). */
  getAgentMonthlySpend(agentSlug: string): number {
    // Estimate cost from tokens: ~$3/M input, ~$15/M output for Sonnet-class
    // This is a rough estimate — can be refined with actual pricing
    const row = this.conn.prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as inp,
        COALESCE(SUM(output_tokens), 0) as out
       FROM usage_log
       WHERE session_key LIKE ? AND created_at >= date('now', 'start of month')`
    ).get(`%${agentSlug}%`) as { inp: number; out: number };
    // Rough pricing: $3/M input = 0.3 cents/1K, $15/M output = 1.5 cents/1K
    const inputCents = (row.inp / 1000) * 0.3;
    const outputCents = (row.out / 1000) * 1.5;
    return Math.round(inputCents + outputCents);
  }

  /** Check if an agent has exceeded its monthly budget. */
  isOverBudget(agentSlug: string, budgetCents: number): boolean {
    if (!budgetCents || budgetCents <= 0) return false;
    return this.getAgentMonthlySpend(agentSlug) >= budgetCents;
  }

  // -- Config Revisions --

  /** Snapshot a config file before writing changes. */
  snapshotConfig(agentSlug: string, fileName: string, content: string, changedBy?: string): void {
    this.conn.prepare(
      `INSERT INTO config_revisions (agent_slug, file_name, content, changed_by) VALUES (?, ?, ?, ?)`
    ).run(agentSlug, fileName, content, changedBy ?? null);
    // Keep max 20 revisions per file
    this.conn.prepare(
      `DELETE FROM config_revisions WHERE agent_slug = ? AND file_name = ? AND id NOT IN (
        SELECT id FROM config_revisions WHERE agent_slug = ? AND file_name = ? ORDER BY created_at DESC LIMIT 20
      )`
    ).run(agentSlug, fileName, agentSlug, fileName);
  }

  /** Get revision history for an agent's config files. */
  getConfigRevisions(agentSlug: string, fileName?: string, limit: number = 10): Array<Record<string, unknown>> {
    if (fileName) {
      return this.conn.prepare(
        `SELECT id, agent_slug, file_name, length(content) as size_bytes, changed_by, created_at
         FROM config_revisions WHERE agent_slug = ? AND file_name = ? ORDER BY created_at DESC LIMIT ?`
      ).all(agentSlug, fileName, limit) as Array<Record<string, unknown>>;
    }
    return this.conn.prepare(
      `SELECT id, agent_slug, file_name, length(content) as size_bytes, changed_by, created_at
       FROM config_revisions WHERE agent_slug = ? ORDER BY created_at DESC LIMIT ?`
    ).all(agentSlug, limit) as Array<Record<string, unknown>>;
  }

  /** Get a specific config revision's content. */
  getConfigRevisionContent(id: number): string | null {
    const row = this.conn.prepare('SELECT content FROM config_revisions WHERE id = ?').get(id) as { content: string } | undefined;
    return row?.content ?? null;
  }

  // ── Salesforce Sync ──────────────────────────────────────────────

  logSfSync(record: {
    localTable: string; localId: number; sfObjectType: string;
    sfId: string; syncDirection: string; syncStatus?: string; errorMessage?: string;
  }): number {
    const result = this.conn.prepare(
      `INSERT INTO sf_sync_log (local_table, local_id, sf_object_type, sf_id, sync_direction, sync_status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.localTable, record.localId, record.sfObjectType, record.sfId,
      record.syncDirection, record.syncStatus ?? 'success', record.errorMessage ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getSfSyncHistory(opts: {
    limit?: number; sfObjectType?: string; syncStatus?: string;
  } = {}): Array<Record<string, unknown>> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts.sfObjectType) { where.push('sf_object_type = ?'); vals.push(opts.sfObjectType); }
    if (opts.syncStatus) { where.push('sync_status = ?'); vals.push(opts.syncStatus); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(opts.limit ?? 50, 500);
    return this.conn.prepare(
      `SELECT * FROM sf_sync_log ${clause} ORDER BY synced_at DESC LIMIT ?`
    ).all(...vals, limit) as Array<Record<string, unknown>>;
  }

  getLeadBySfId(sfId: string): Record<string, unknown> | undefined {
    return this.conn.prepare('SELECT * FROM leads WHERE sf_id = ?').get(sfId) as Record<string, unknown> | undefined;
  }

  getUnsyncedLeads(agentSlug?: string): Array<Record<string, unknown>> {
    const base = `SELECT * FROM leads WHERE sf_id IS NULL AND status != 'opted_out'`;
    const clause = agentSlug ? ` AND agent_slug = ?` : '';
    return this.conn.prepare(`${base}${clause} ORDER BY created_at ASC`).all(
      ...(agentSlug ? [agentSlug] : [])
    ) as Array<Record<string, unknown>>;
  }

  getLeadsModifiedSince(since: string, agentSlug?: string): Array<Record<string, unknown>> {
    const base = `SELECT * FROM leads WHERE updated_at >= ?`;
    const clause = agentSlug ? ` AND agent_slug = ?` : '';
    return this.conn.prepare(`${base}${clause} ORDER BY updated_at ASC`).all(
      since, ...(agentSlug ? [agentSlug] : [])
    ) as Array<Record<string, unknown>>;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * Delete all chunks, wikilinks, and file hash for a given file.
   */
  private deleteFileChunks(relPath: string): void {
    this.conn.prepare('DELETE FROM chunks WHERE source_file = ?').run(relPath);
    this.conn.prepare('DELETE FROM wikilinks WHERE source_file = ?').run(relPath);
    this.conn.prepare('DELETE FROM file_hashes WHERE rel_path = ?').run(relPath);
  }

  /**
   * Sanitize a query for FTS5 syntax.
   *
   * Quotes each word and joins with OR to match any word (not all).
   * This works better for natural language queries.
   */
  static sanitizeFtsQuery(query: string): string {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return '';

    const quoted = words
      .map((w) => w.replace(/"/g, ''))
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"`);

    return quoted.join(' OR ');
  }

  /**
   * Parse and index [[wikilinks]] from a file.
   */
  private indexWikilinks(relPath: string, filePath: string): void {
    this.conn
      .prepare('DELETE FROM wikilinks WHERE source_file = ?')
      .run(relPath);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const insertStmt = this.conn.prepare(
      'INSERT INTO wikilinks (source_file, target_file, context, link_type) VALUES (?, ?, ?, ?)',
    );

    for (const line of content.split('\n')) {
      let match: RegExpExecArray | null;
      // Reset regex lastIndex for each line since it's global
      WIKILINK_RE.lastIndex = 0;
      while ((match = WIKILINK_RE.exec(line)) !== null) {
        const target = match[1].trim();
        const context = line.trim().slice(0, 200);
        insertStmt.run(relPath, target, context, 'wikilink');
      }
    }
  }

  /**
   * Recursively walk a directory for .md files.
   */
  private walkMdFiles(dir: string, callback: (filePath: string) => void): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        this.walkMdFiles(fullPath, callback);
      } else if (entry.endsWith('.md')) {
        callback(fullPath);
      }
    }
  }
}
