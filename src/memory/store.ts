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
  Chunk,
  SearchResult,
  SessionSummary,
  SyncStats,
  TranscriptTurn,
  WikilinkConnection,
} from '../types.js';
import { chunkFile } from './chunker.js';
import { deduplicateResults } from './search.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export class MemoryStore {
  private dbPath: string;
  private vaultDir: string;
  private db: Database.Database | null = null;

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
  updateFile(relPath: string): void {
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
                  c.updated_at, c.salience,
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
      }));
    } catch {
      return [];
    }
  }

  // ── Search: Recent Chunks ─────────────────────────────────────────

  /**
   * Get the most recently updated chunks.
   */
  getRecentChunks(limit: number = 5): SearchResult[] {
    const rows = this.conn
      .prepare(
        `SELECT id, source_file, section, content, chunk_type,
                updated_at, salience
         FROM chunks
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
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
      matchType: 'recency' as const,
      lastUpdated: row.updated_at ?? '',
      chunkId: row.id,
      salience: row.salience ?? 0,
    }));
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
    limitOrOpts: number | { limit?: number; recencyLimit?: number } = 3,
    recencyLimitArg: number = 5,
  ): SearchResult[] {
    let limit: number;
    let recencyLimit: number;
    if (typeof limitOrOpts === 'object') {
      limit = limitOrOpts.limit ?? 3;
      recencyLimit = limitOrOpts.recencyLimit ?? 5;
    } else {
      limit = limitOrOpts;
      recencyLimit = recencyLimitArg;
    }
    // 1. FTS5 relevance
    const ftsResults = this.searchFts(query, limit);

    // Apply salience boost to FTS results
    for (const r of ftsResults) {
      if (r.salience > 0) {
        r.score *= 1.0 + r.salience;
      }
    }

    // 2. Recency
    const recentResults = this.getRecentChunks(recencyLimit);

    // 3. Merge and deduplicate (FTS results first, so they win on ties)
    const merged = [...ftsResults, ...recentResults];
    return deduplicateResults(merged);
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
    this.conn
      .prepare(
        'INSERT INTO transcripts (session_key, role, content, model) VALUES (?, ?, ?, ?)',
      )
      .run(sessionKey, role, content, model);
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
      content: row.content.slice(0, 500), // Truncate for readability
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
