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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { temporalDecay } from './search.js';
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
import { HotCache } from './hot-cache.js';
import { WriteQueue, type WriteQueueOpts } from './write-queue.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export class MemoryStore {
  private dbPath: string;
  private vaultDir: string;
  private db: Database.Database | null = null;

  // Cached prepared statements for hot-path queries
  private _stmtChunkCount: Database.Statement | null = null;
  private _stmtInsertTranscript: Database.Statement | null = null;
  private _stmtInsertUsage: Database.Statement | null = null;

  // In-process LRU for chunk-row reads. Hit on every retrieval that calls
  // getChunksByIds; invalidated on softDeleteChunk, restoreChunk, setPinned,
  // updateFile, and bulk fullSync. Capacity tunable; default 1000 chunks.
  private chunkRowCache = new HotCache<number, {
    id: number;
    sourceFile: string;
    section: string;
    content: string;
    chunkType: string;
    agentSlug: string | null;
    pinned: boolean;
    consolidated: boolean;
    derivedFrom: number[] | null;
    salience: number;
    updatedAt: string;
  }>(1000);

  // Async write-behind queue for non-critical writes (transcripts, recall
  // traces, outcomes, access log). Null = sync mode (default; tests rely on
  // immediate persistence). Enabled via enableWriteQueue() at daemon boot.
  private writeQueue: WriteQueue | null = null;

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

    // Add category column to chunks (hierarchical tag: facts/events/discoveries/preferences/advice)
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN category TEXT DEFAULT NULL');
    } catch {
      // Column already exists
    }

    // Add topic column to chunks (hierarchical tag: free-form topic string)
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN topic TEXT DEFAULT NULL');
    } catch {
      // Column already exists
    }

    // Add pinned flag — manual salience reinforcement. When true, recall
    // applies an extra score boost on top of the access-pattern salience.
    // Toggled by `clementine memory pin/unpin <chunkId>` (or the dashboard).
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN pinned INTEGER DEFAULT 0');
    } catch {
      // Column already exists
    }

    // Indexes for category/topic filtering
    try {
      this.conn.exec('CREATE INDEX idx_chunks_category ON chunks(category)');
    } catch {
      // Index already exists
    }
    try {
      this.conn.exec('CREATE INDEX idx_chunks_topic ON chunks(topic)');
    } catch {
      // Index already exists
    }

    // Hot-path indices: every chat turn sorts/filters chunks by updated_at
    // (recency) and by (agent_slug, updated_at) for agent-scoped recent
    // context. Without these the queries do full table scans.
    try {
      this.conn.exec('CREATE INDEX idx_chunks_updated_at ON chunks(updated_at DESC)');
    } catch { /* already exists */ }
    try {
      this.conn.exec('CREATE INDEX idx_chunks_agent_updated ON chunks(agent_slug, updated_at DESC)');
    } catch { /* already exists */ }
    // Embedding filter — searchByEmbedding's base predicate is
    // `embedding IS NOT NULL`; a partial index turns that into an
    // index-only scan for the candidate set.
    try {
      this.conn.exec('CREATE INDEX idx_chunks_has_embedding ON chunks(id) WHERE embedding IS NOT NULL');
    } catch { /* already exists */ }

    // Confidence column — orthogonal to salience. Salience = "how important
    // is this if true?", confidence = "how certain am I this is still true?"
    // Decays via the daily heartbeat sweep on chunks that haven't been
    // accessed or reinforced. Used in Phase 3 for fading stale facts and as
    // input to the supersession decision.
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN confidence REAL DEFAULT 1.0');
    } catch { /* already exists */ }

    // Supersede graph — explicit "this old chunk is replaced by this new
    // chunk." Distinct from soft-delete because supersedes carries provenance
    // (which fact replaced which) and lets us reconstruct corrections later.
    // Search joins LEFT JOIN this table and excludes rows where the chunk
    // appears as `old_chunk_id`, mirroring the soft-delete pattern.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS chunk_supersedes (
        old_chunk_id INTEGER PRIMARY KEY,
        new_chunk_id INTEGER NOT NULL,
        reason TEXT,
        superseded_at TEXT DEFAULT (datetime('now')),
        superseded_by_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_supersedes_new ON chunk_supersedes(new_chunk_id);
    `);

    // Maintenance meta key for the salience decay sweep — last run timestamp.
    // (maintenance_meta table itself is created elsewhere if not yet present.)

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

    // Outcome-driven salience: per-turn "was this retrieved chunk actually
    // referenced in the response?" signal. Feeds last_outcome_score on chunks
    // so chunks that earn their context budget stay high, and chunks that
    // keep losing bids drift down.
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN last_outcome_score REAL DEFAULT 0.0');
    } catch { /* already exists */ }

    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL,
        session_key TEXT,
        referenced INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_chunk ON outcomes(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_created ON outcomes(created_at);
    `);

    // SDK SessionStore mirror: append-only sidecar for the transcript
    // JSONL that the Claude Agent SDK writes locally. Lets resume pull
    // session state from our SQLite instead of local files; idempotent
    // on uuid so retries and imports don't duplicate.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS sdk_session_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        subpath TEXT NOT NULL DEFAULT '',
        uuid TEXT,
        type TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sdk_session_entries_uuid
        ON sdk_session_entries(session_id, subpath, uuid) WHERE uuid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sdk_session_entries_session
        ON sdk_session_entries(session_id, subpath, id);
    `);

    // SessionStore sidecar for incremental session summaries.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS sdk_session_summaries (
        session_id TEXT NOT NULL,
        subpath TEXT NOT NULL DEFAULT '',
        project_key TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, subpath)
      );
      CREATE INDEX IF NOT EXISTS idx_sdk_session_summaries_project
        ON sdk_session_summaries(project_key, mtime DESC);
    `);

    // Artifact memory: persistent store for large tool outputs so the
    // agent can recall them many turns later without re-running the tool.
    // Content lives here verbatim; a summary lets the agent skim without
    // pulling the full blob back into context.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS tool_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT,
        agent_slug TEXT,
        tool_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        stored_at TEXT DEFAULT (datetime('now')),
        last_accessed_at TEXT,
        access_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON tool_artifacts(session_key);
      CREATE INDEX IF NOT EXISTS idx_artifacts_stored ON tool_artifacts(stored_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_agent ON tool_artifacts(agent_slug);

      CREATE VIRTUAL TABLE IF NOT EXISTS tool_artifacts_fts USING fts5(
        tool_name, summary, content, tags,
        content='tool_artifacts', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS tool_artifacts_ai AFTER INSERT ON tool_artifacts BEGIN
        INSERT INTO tool_artifacts_fts(rowid, tool_name, summary, content, tags)
        VALUES (new.id, new.tool_name, new.summary, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS tool_artifacts_ad AFTER DELETE ON tool_artifacts BEGIN
        INSERT INTO tool_artifacts_fts(tool_artifacts_fts, rowid, tool_name, summary, content, tags)
        VALUES ('delete', old.id, old.tool_name, old.summary, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS tool_artifacts_au AFTER UPDATE ON tool_artifacts BEGIN
        INSERT INTO tool_artifacts_fts(tool_artifacts_fts, rowid, tool_name, summary, content, tags)
        VALUES ('delete', old.id, old.tool_name, old.summary, old.content, old.tags);
        INSERT INTO tool_artifacts_fts(rowid, tool_name, summary, content, tags)
        VALUES (new.id, new.tool_name, new.summary, new.content, new.tags);
      END;
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

    // Migration: add agent_slug column for per-agent observability
    try {
      this.conn.exec(`ALTER TABLE usage_log ADD COLUMN agent_slug TEXT DEFAULT NULL`);
      this.conn.exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_log(agent_slug)`);
    } catch { /* column already exists */ }

    // Migration: add cost_cents for budget enforcement (per-agent monthly caps).
    // Stored as INTEGER cents to avoid float precision drift across aggregations.
    try {
      this.conn.exec(`ALTER TABLE usage_log ADD COLUMN cost_cents INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }

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

      CREATE TABLE IF NOT EXISTS skill_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        session_key TEXT,
        query_text TEXT,
        retrieved_at TEXT NOT NULL DEFAULT (datetime('now')),
        score REAL,
        outcome TEXT,
        agent_slug TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skill_usage_name ON skill_usage(skill_name, retrieved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_time ON skill_usage(retrieved_at DESC);

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        session_key TEXT,
        message_snippet TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        due_at TEXT,
        verify_strategy TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        verdict TEXT,
        extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
        verified_at TEXT,
        agent_slug TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status, extracted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_claims_due ON claims(due_at) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_claims_extracted ON claims(extracted_at DESC);

      CREATE TABLE IF NOT EXISTS graded_runs (
        job_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        passed INTEGER NOT NULL,
        score INTEGER NOT NULL,
        reasoning TEXT,
        graded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (job_name, started_at)
      );
      CREATE INDEX IF NOT EXISTS idx_graded_runs_job ON graded_runs(job_name, started_at DESC);
    `);

    // ── Brain / Ingestion ─────────────────────────────────────────────
    // Extends chunks with external provenance so ingested content
    // (CSV rows, PDFs, emails, API responses) can be upserted by stable
    // upstream id instead of vault path. Every existing search tool sees
    // ingested content for free — this is NOT a parallel store.
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN source_slug TEXT DEFAULT NULL');
    } catch { /* already exists */ }
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN external_id TEXT DEFAULT NULL');
    } catch { /* already exists */ }
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN source_type TEXT DEFAULT NULL');
    } catch { /* already exists */ }
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN last_synced_at TEXT DEFAULT NULL');
    } catch { /* already exists */ }
    try {
      this.conn.exec('CREATE INDEX idx_chunks_source_external ON chunks(source_slug, external_id)');
    } catch { /* already exists */ }

    // Source registry — declarative external data sources
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        slug TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        adapter TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        credential_ref TEXT,
        schedule_cron TEXT,
        target_folder TEXT,
        agent_slug TEXT,
        intelligence TEXT NOT NULL DEFAULT 'auto',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_status TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
      CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled);
    `);
    try {
      this.conn.exec('ALTER TABLE sources ADD COLUMN project TEXT DEFAULT NULL');
    } catch { /* already exists */ }
    try {
      this.conn.exec('CREATE INDEX idx_sources_project ON sources(project)');
    } catch { /* already exists */ }

    // Ingestion runs — per-run audit trail
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_slug TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        records_in INTEGER NOT NULL DEFAULT 0,
        records_written INTEGER NOT NULL DEFAULT 0,
        records_skipped INTEGER NOT NULL DEFAULT 0,
        records_failed INTEGER NOT NULL DEFAULT 0,
        overview_note_path TEXT,
        errors_json TEXT,
        status TEXT NOT NULL DEFAULT 'running'
      );
      CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source ON ingestion_runs(source_slug, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON ingestion_runs(status);
    `);

    // Ingested rows — structured overlay on chunks for SQL aggregates.
    // chunk_id FK makes this an INDEX on top of chunks, not a silo.
    // Per-source dynamic columns are added via ALTER TABLE during
    // schema-infer (e.g. amount REAL, customer_id TEXT).
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS ingested_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_slug TEXT NOT NULL,
        external_id TEXT NOT NULL,
        chunk_id INTEGER,
        artifact_id INTEGER,
        row_json TEXT NOT NULL,
        ingested_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ingested_rows_key
        ON ingested_rows(source_slug, external_id);
      CREATE INDEX IF NOT EXISTS idx_ingested_rows_chunk ON ingested_rows(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_ingested_rows_ingested
        ON ingested_rows(ingested_at DESC);
    `);

    // Derived-from lineage — when consolidation/principle extraction produces
    // a summary chunk, this stores the source chunk IDs that fed into it.
    // JSON array of chunk IDs. Lets the dashboard show "this principle was
    // derived from these N source episodes" — abstractions become auditable
    // instead of magic.
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN derived_from TEXT DEFAULT NULL');
    } catch { /* already exists */ }

    // Recall traces — per-message audit of which chunks were retrieved for
    // context. Powers the "🧠 N sources" affordance in the dashboard chat
    // panel and is the debugging substrate for retrieval-quality work
    // (dense embeddings, scoring tweaks, etc). Pruned to 90 days by
    // pruneStaleData() to bound write amplification.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS recall_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT,
        message_id TEXT,
        query TEXT NOT NULL,
        chunk_ids TEXT NOT NULL,
        scores TEXT NOT NULL,
        agent_slug TEXT,
        retrieved_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_recall_traces_session
        ON recall_traces(session_key, retrieved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recall_traces_message
        ON recall_traces(message_id) WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_recall_traces_retrieved
        ON recall_traces(retrieved_at);
    `);
    // Phase 4 migration: per-result match types stored alongside chunk_ids/scores
    // so we can aggregate "which retrieval signal earned the recall" over time.
    try {
      this.conn.exec('ALTER TABLE recall_traces ADD COLUMN match_types TEXT DEFAULT NULL');
    } catch { /* column already exists */ }

    // Dense neural embeddings (transformers.js — arctic-embed-m by default).
    // Parallel to the existing chunks.embedding (TF-IDF, 512-dim) so we can
    // backfill incrementally and fall back gracefully if the dense model
    // isn't available yet. embedding_dense_model tracks which model produced
    // each vector — lets us migrate to a new model later by re-running the
    // memory:reembed command.
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN embedding_dense BLOB');
    } catch { /* already exists */ }
    try {
      this.conn.exec('ALTER TABLE chunks ADD COLUMN embedding_dense_model TEXT DEFAULT NULL');
    } catch { /* already exists */ }
    try {
      this.conn.exec('CREATE INDEX idx_chunks_has_dense ON chunks(id) WHERE embedding_dense IS NOT NULL');
    } catch { /* already exists */ }

    // Soft-delete via a separate table — keeps the chunks_au trigger
    // out of the path so we don't have to fight with the FTS5 contentless
    // index's delete-then-insert semantics. Search query paths LEFT JOIN
    // this table and filter WHERE chunk_soft_deletes.chunk_id IS NULL.
    // Soft-delete and restore handle FTS index updates explicitly without
    // UPDATEing the chunks row at all.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS chunk_soft_deletes (
        chunk_id INTEGER PRIMARY KEY,
        deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_soft_deletes_at
        ON chunk_soft_deletes(deleted_at);
    `);

    // Clean up earlier experimental trigger variants from dev versions.
    // The original chunks_au handles the normal "edit a chunk" path correctly.
    try {
      this.conn.exec('DROP TRIGGER IF EXISTS chunks_au_remove');
      this.conn.exec('DROP TRIGGER IF EXISTS chunks_au_insert');
      this.conn.exec('DROP TRIGGER IF EXISTS chunks_au1_remove');
      this.conn.exec('DROP TRIGGER IF EXISTS chunks_au2_insert');
    } catch { /* best-effort */ }

    // Edit history — append-only audit trail for content edits via the
    // dashboard CRUD UI. Lets the user see "what did I change in this chunk
    // and when" if memory drifts in surprising ways.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS chunk_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL,
        prev_content TEXT NOT NULL,
        prev_section TEXT,
        prev_category TEXT,
        prev_topic TEXT,
        edited_by TEXT,
        edited_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_history_chunk ON chunk_history(chunk_id, edited_at DESC);
    `);

    // User mental model — MemGPT-style core memory blocks always loaded into
    // the agent's context. Unlike chunks (retrieved on demand), these are
    // the coherent "what we know about Nathan" surface: identifiers, lasting
    // preferences, active goals, key relationships, agent persona. Editable
    // by the agent via the user_model MCP tool, and by the user via the
    // dashboard "User Model" panel. Hard char_limit per slot prevents bloat.
    //
    // Per-agent isolation: agent_slug NULL = global (main user model).
    // Specific slug = per-agent override (e.g., the SDR agent has its own
    // sense of who Nathan is in that working relationship).
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS user_model_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        char_limit INTEGER NOT NULL DEFAULT 2000,
        agent_slug TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_model_slot_agent
        ON user_model_blocks(slot, COALESCE(agent_slug, ''));
    `);

    // Persistent key/value scratch for the memory janitor — last vacuum
    // timestamp, last janitor run, etc. Survives daemon restarts so we
    // don't VACUUM on every boot.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Autonomy log — structured event stream for the self-improving,
    // proactive, and planning layers. Makes the autonomous subsystem
    // observable without grepping logs.
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        component TEXT NOT NULL,
        event TEXT NOT NULL,
        agent_slug TEXT,
        details_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_component ON autonomy_log(component, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_event ON autonomy_log(event, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_agent ON autonomy_log(agent_slug, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_created ON autonomy_log(created_at DESC);
    `);
  }

  // ── Skill usage telemetry ─────────────────────────────────────────

  private _stmtLogSkillUse: Database.Statement | null = null;

  /**
   * Record that a skill was retrieved and injected into a query context.
   * Outcome is left null; a follow-up could backfill from reflection scores.
   */
  logSkillUse(row: {
    skillName: string;
    sessionKey?: string | null;
    queryText?: string | null;
    score?: number | null;
    agentSlug?: string | null;
  }): void {
    try {
      if (!this._stmtLogSkillUse) {
        this._stmtLogSkillUse = this.conn.prepare(
          'INSERT INTO skill_usage (skill_name, session_key, query_text, score, agent_slug) VALUES (?, ?, ?, ?, ?)',
        );
      }
      this._stmtLogSkillUse.run(
        row.skillName,
        row.sessionKey ?? null,
        row.queryText ? row.queryText.slice(0, 200) : null,
        row.score ?? null,
        row.agentSlug ?? null,
      );
    } catch {
      // Best-effort — telemetry must never break retrieval.
    }
  }

  /** Aggregate skill usage stats keyed by skill_name. */
  skillUsageStats(windowDays = 7): Map<string, { retrievals: number; lastRetrievedAt: string | null; avgScore: number | null }> {
    const out = new Map<string, { retrievals: number; lastRetrievedAt: string | null; avgScore: number | null }>();
    try {
      const rows = this.conn.prepare(
        `SELECT skill_name,
                COUNT(*) AS retrievals,
                MAX(retrieved_at) AS last_retrieved_at,
                AVG(score) AS avg_score
         FROM skill_usage
         WHERE retrieved_at >= datetime('now', ?)
         GROUP BY skill_name`,
      ).all(`-${Math.max(1, Math.floor(windowDays))} days`) as Array<{
        skill_name: string;
        retrievals: number;
        last_retrieved_at: string | null;
        avg_score: number | null;
      }>;
      for (const r of rows) {
        out.set(r.skill_name, {
          retrievals: r.retrievals,
          lastRetrievedAt: r.last_retrieved_at,
          avgScore: r.avg_score,
        });
      }
    } catch {
      // Table may not exist yet on legacy DBs — caller should tolerate empty.
    }
    return out;
  }

  /** Number of times a skill has been retrieved (all time). */
  skillRetrievalCount(skillName: string): number {
    try {
      const row = this.conn.prepare('SELECT COUNT(*) AS cnt FROM skill_usage WHERE skill_name = ?').get(skillName) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch { return 0; }
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

  /** Toggle the manual pin flag on a chunk. Pinned chunks get a 2x score boost in recall. */
  setPinned(chunkId: number, pinned: boolean): boolean {
    this.chunkRowCache.delete(chunkId);
    try {
      const result = this.conn.prepare('UPDATE chunks SET pinned = ? WHERE id = ?')
        .run(pinned ? 1 : 0, chunkId);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  // ── Chunk CRUD (dashboard curation) ───────────────────────────────

  /** Full detail for a single chunk, including soft-delete state and provenance. */
  getChunkDetail(chunkId: number): {
    id: number;
    sourceFile: string;
    section: string;
    content: string;
    chunkType: string;
    salience: number;
    pinned: boolean;
    consolidated: boolean;
    deletedAt: string | null;
    derivedFrom: number[] | null;
    agentSlug: string | null;
    category: string | null;
    topic: string | null;
    createdAt: string;
    updatedAt: string;
    historyCount: number;
  } | null {
    const row = this.conn.prepare(
      `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type, c.salience,
              c.pinned, c.consolidated, c.derived_from, c.agent_slug, c.category, c.topic,
              c.created_at, c.updated_at, sd.deleted_at AS soft_deleted_at
       FROM chunks c
       LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
       WHERE c.id = ?`,
    ).get(chunkId) as {
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      salience: number;
      pinned: number;
      consolidated: number;
      soft_deleted_at: string | null;
      derived_from: string | null;
      agent_slug: string | null;
      category: string | null;
      topic: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return null;
    const histRow = this.conn.prepare(
      'SELECT COUNT(*) as c FROM chunk_history WHERE chunk_id = ?',
    ).get(chunkId) as { c: number } | undefined;
    return {
      id: row.id,
      sourceFile: row.source_file,
      section: row.section,
      content: row.content,
      chunkType: row.chunk_type,
      salience: row.salience,
      pinned: !!row.pinned,
      consolidated: !!row.consolidated,
      deletedAt: row.soft_deleted_at,
      derivedFrom: row.derived_from ? this._parseJsonArray<number>(row.derived_from) : null,
      agentSlug: row.agent_slug,
      category: row.category,
      topic: row.topic,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      historyCount: histRow?.c ?? 0,
    };
  }

  /**
   * Edit a chunk's content (and optionally section/category/topic). Records
   * the previous values to chunk_history for audit. Re-computes content_hash
   * and embedding (if vocab is ready). FTS index updates via trigger.
   */
  updateChunkContent(opts: {
    chunkId: number;
    content?: string;
    section?: string;
    category?: string | null;
    topic?: string | null;
    editedBy?: string | null;
  }): boolean {
    const existing = this.conn.prepare(
      `SELECT content, section, category, topic FROM chunks WHERE id = ?`,
    ).get(opts.chunkId) as {
      content: string; section: string; category: string | null; topic: string | null;
    } | undefined;
    if (!existing) return false;

    const newContent = opts.content ?? existing.content;
    const newSection = opts.section ?? existing.section;
    const newCategory = opts.category !== undefined ? opts.category : existing.category;
    const newTopic = opts.topic !== undefined ? opts.topic : existing.topic;

    const contentChanged = newContent !== existing.content;
    const anyChange = contentChanged
      || newSection !== existing.section
      || newCategory !== existing.category
      || newTopic !== existing.topic;
    if (!anyChange) return true; // no-op succeeds

    // Audit row first — keep previous values regardless of which field changed.
    this.conn.prepare(
      `INSERT INTO chunk_history (chunk_id, prev_content, prev_section, prev_category, prev_topic, edited_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.chunkId, existing.content, existing.section,
      existing.category, existing.topic, opts.editedBy ?? null,
    );

    const newHash = createHash('sha256').update(newContent).digest('hex').slice(0, 16);
    this.conn.prepare(
      `UPDATE chunks
       SET content = ?, section = ?, category = ?, topic = ?,
           content_hash = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(newContent, newSection, newCategory, newTopic, newHash, opts.chunkId);

    // Recompute embedding if content changed
    if (contentChanged && embeddingsModule.isReady()) {
      try {
        const vec = embeddingsModule.embed(newContent);
        if (vec) {
          this.conn.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
            .run(embeddingsModule.serializeEmbedding(vec), opts.chunkId);
        }
      } catch { /* embedding is best-effort */ }
    }

    return true;
  }

  /** Soft-delete a chunk. Inserts a row into chunk_soft_deletes (the chunks
   *  row itself is untouched) and removes the chunk from the FTS index.
   *  Search query paths LEFT JOIN chunk_soft_deletes so deleted chunks are
   *  excluded everywhere. */
  softDeleteChunk(chunkId: number, deletedBy?: string | null): boolean {
    const tx = this.conn.transaction((id: number) => {
      const row = this.conn.prepare(
        `SELECT c.id, c.source_file, c.section, c.content
         FROM chunks c LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE c.id = ? AND sd.chunk_id IS NULL`,
      ).get(id) as { id: number; source_file: string; section: string; content: string } | undefined;
      if (!row) return false;
      this.conn.prepare(
        `INSERT INTO chunk_soft_deletes (chunk_id, deleted_by) VALUES (?, ?)`,
      ).run(id, deletedBy ?? null);
      // Remove from FTS index — search joins on chunk_soft_deletes already
      // filter, but pulling out of FTS speeds up MATCH queries (fewer terms
      // to scan) and is correct hygiene.
      this.conn.prepare(
        `INSERT INTO chunks_fts(chunks_fts, rowid, source_file, section, content)
         VALUES ('delete', ?, ?, ?, ?)`,
      ).run(row.id, row.source_file, row.section, row.content);
      return true;
    });
    const ok = tx(chunkId) as boolean;
    if (ok) this.chunkRowCache.delete(chunkId);
    return ok;
  }

  /** Restore a soft-deleted chunk. Removes the chunk_soft_deletes row and
   *  re-inserts the content into the FTS index. */
  restoreChunk(chunkId: number): boolean {
    const tx = this.conn.transaction((id: number) => {
      const row = this.conn.prepare(
        `SELECT c.id, c.source_file, c.section, c.content
         FROM chunks c JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE c.id = ?`,
      ).get(id) as { id: number; source_file: string; section: string; content: string } | undefined;
      if (!row) return false;
      this.conn.prepare(`DELETE FROM chunk_soft_deletes WHERE chunk_id = ?`).run(id);
      // Re-insert into FTS. The chunks row's content is unchanged so this
      // adds back the same indexed terms that softDeleteChunk removed.
      this.conn.prepare(
        `INSERT INTO chunks_fts(rowid, source_file, section, content)
         VALUES (?, ?, ?, ?)`,
      ).run(row.id, row.source_file, row.section, row.content);
      return true;
    });
    const ok = tx(chunkId) as boolean;
    if (ok) this.chunkRowCache.delete(chunkId);
    return ok;
  }

  /** Recent edit history for a chunk (newest first). */
  getChunkHistory(chunkId: number, limit = 20): Array<{
    id: number;
    prevContent: string;
    prevSection: string | null;
    prevCategory: string | null;
    prevTopic: string | null;
    editedBy: string | null;
    editedAt: string;
  }> {
    const rows = this.conn.prepare(
      `SELECT id, prev_content, prev_section, prev_category, prev_topic, edited_by, edited_at
       FROM chunk_history WHERE chunk_id = ?
       ORDER BY edited_at DESC, id DESC LIMIT ?`,
    ).all(chunkId, limit) as Array<{
      id: number;
      prev_content: string;
      prev_section: string | null;
      prev_category: string | null;
      prev_topic: string | null;
      edited_by: string | null;
      edited_at: string;
    }>;
    return rows.map(r => ({
      id: r.id,
      prevContent: r.prev_content,
      prevSection: r.prev_section,
      prevCategory: r.prev_category,
      prevTopic: r.prev_topic,
      editedBy: r.edited_by,
      editedAt: r.edited_at,
    }));
  }

  /**
   * Aggregate stats for the memory store — used by `clementine memory status`.
   * Single-pass scans so it stays fast even on large chunk tables.
   */
  getMemoryStats(): {
    totalChunks: number;
    chunksWithEmbeddings: number;
    chunksWithDenseEmbeddings: number;
    denseEmbeddingModels: Array<{ model: string; count: number }>;
    pinnedChunks: number;
    perAgent: Array<{ agentSlug: string; count: number }>;
    perCategory: Array<{ category: string; count: number }>;
    avgSalience: number;
    oldestUpdated: string | null;
    newestUpdated: string | null;
  } {
    const totalChunks = this.getChunkCount();
    const chunksWithEmbeddings = (this.conn
      .prepare('SELECT COUNT(*) as cnt FROM chunks WHERE embedding IS NOT NULL')
      .get() as { cnt: number } | undefined)?.cnt ?? 0;
    const chunksWithDenseEmbeddings = (this.conn
      .prepare('SELECT COUNT(*) as cnt FROM chunks WHERE embedding_dense IS NOT NULL')
      .get() as { cnt: number } | undefined)?.cnt ?? 0;
    const denseEmbeddingModels = (this.conn
      .prepare(`SELECT COALESCE(embedding_dense_model, '(unknown)') as model, COUNT(*) as count
                FROM chunks WHERE embedding_dense IS NOT NULL
                GROUP BY embedding_dense_model ORDER BY count DESC`)
      .all() as Array<{ model: string; count: number }>);
    const pinnedChunks = (this.conn
      .prepare('SELECT COUNT(*) as cnt FROM chunks WHERE pinned = 1')
      .get() as { cnt: number } | undefined)?.cnt ?? 0;
    const perAgent = (this.conn
      .prepare(`SELECT COALESCE(agent_slug, 'global') as agentSlug, COUNT(*) as count
                FROM chunks GROUP BY agent_slug ORDER BY count DESC`)
      .all() as Array<{ agentSlug: string; count: number }>);
    const perCategory = (this.conn
      .prepare(`SELECT COALESCE(category, '(none)') as category, COUNT(*) as count
                FROM chunks GROUP BY category ORDER BY count DESC`)
      .all() as Array<{ category: string; count: number }>);
    const avgRow = this.conn
      .prepare('SELECT AVG(salience) as avg FROM chunks WHERE salience > 0')
      .get() as { avg: number | null } | undefined;
    const dateRow = this.conn
      .prepare('SELECT MIN(updated_at) as oldest, MAX(updated_at) as newest FROM chunks WHERE updated_at IS NOT NULL')
      .get() as { oldest: string | null; newest: string | null } | undefined;
    return {
      totalChunks,
      chunksWithEmbeddings,
      chunksWithDenseEmbeddings,
      denseEmbeddingModels,
      pinnedChunks,
      perAgent,
      perCategory,
      avgSalience: avgRow?.avg ?? 0,
      oldestUpdated: dateRow?.oldest ?? null,
      newestUpdated: dateRow?.newest ?? null,
    };
  }

  /**
   * Find clusters of near-duplicate chunks using embedding cosine similarity.
   * Returns clusters where at least 2 chunks score above the threshold.
   *
   * Caller decides what to do — typical use is `clementine memory dedup` to
   * preview / merge / mark-superseded. Per-pair O(n²) within agent scope to
   * keep the search space tractable; cross-agent dupes are surfaced separately
   * by the auto-promote flow.
   */
  findNearDuplicates(opts: { threshold?: number; minLen?: number; limit?: number } = {}): Array<{
    keep: { chunkId: number; sourceFile: string; section: string; content: string; agentSlug: string | null; updatedAt: string | null };
    duplicates: Array<{ chunkId: number; sourceFile: string; section: string; content: string; agentSlug: string | null; updatedAt: string | null; similarity: number }>;
  }> {
    const threshold = opts.threshold ?? 0.95;
    const minLen = opts.minLen ?? 80;        // skip very short chunks — too easily collide
    const limitClusters = opts.limit ?? 50;  // cap results so the CLI stays readable

    if (!embeddingsModule.isReady()) return [];

    const rows = this.conn.prepare(
      `SELECT id, source_file, section, content, embedding, agent_slug, updated_at
       FROM chunks
       WHERE embedding IS NOT NULL AND length(content) >= ?
       ORDER BY agent_slug, updated_at DESC`,
    ).all(minLen) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      embedding: Buffer;
      agent_slug: string | null;
      updated_at: string | null;
    }>;

    // Group by agent first — only compare within the same scope to bound the
    // O(n²) blow-up. Cross-agent dedup is the auto-promote flow's job.
    const buckets = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.agent_slug ?? '__global__';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }

    const clusters: Array<ReturnType<typeof this.findNearDuplicates>[number]> = [];
    const consumed = new Set<number>();

    for (const bucket of buckets.values()) {
      // Decode embeddings once per row.
      const decoded = bucket.map(r => ({
        ...r,
        vec: embeddingsModule.deserializeEmbedding(r.embedding),
      }));
      for (let i = 0; i < decoded.length; i++) {
        if (consumed.has(decoded[i].id)) continue;
        const head = decoded[i];
        const dupes: Array<{ chunkId: number; sourceFile: string; section: string; content: string; agentSlug: string | null; updatedAt: string | null; similarity: number }> = [];
        for (let j = i + 1; j < decoded.length; j++) {
          if (consumed.has(decoded[j].id)) continue;
          const sim = embeddingsModule.cosineSimilarity(head.vec, decoded[j].vec);
          if (sim >= threshold) {
            dupes.push({
              chunkId: decoded[j].id,
              sourceFile: decoded[j].source_file,
              section: decoded[j].section,
              content: decoded[j].content,
              agentSlug: decoded[j].agent_slug,
              updatedAt: decoded[j].updated_at,
              similarity: sim,
            });
            consumed.add(decoded[j].id);
          }
        }
        if (dupes.length > 0) {
          consumed.add(head.id);
          clusters.push({
            keep: {
              chunkId: head.id,
              sourceFile: head.source_file,
              section: head.section,
              content: head.content,
              agentSlug: head.agent_slug,
              updatedAt: head.updated_at,
            },
            duplicates: dupes,
          });
          if (clusters.length >= limitClusters) return clusters;
        }
      }
    }
    return clusters;
  }

  /** Delete chunks by id. Used by dedup --apply. */
  deleteChunks(chunkIds: number[]): number {
    if (!chunkIds.length) return 0;
    const placeholders = chunkIds.map(() => '?').join(',');
    const result = this.conn.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...chunkIds);
    return result.changes;
  }

  /**
   * Find chunks whose semantic content recurs across 3+ different agents —
   * candidates for promotion to global memory. Detection-only; surfacing.
   * The user (or a future cron) decides whether to actually promote.
   *
   * Approach: scan agent-scoped chunks with embeddings, cluster cross-agent
   * pairs above the similarity threshold, return clusters touching >= minAgents
   * distinct agents. Limits keep the O(n²) scan tractable on large stores.
   */
  findCrossAgentRecurrence(opts: { threshold?: number; minAgents?: number; minLen?: number; limit?: number } = {}): Array<{
    representative: { chunkId: number; sourceFile: string; section: string; content: string; agentSlug: string };
    members: Array<{ chunkId: number; sourceFile: string; section: string; agentSlug: string; similarity: number; updatedAt: string | null }>;
    agents: string[]; // distinct agent slugs touched by the cluster
  }> {
    const threshold = opts.threshold ?? 0.88; // looser than dedup — paraphrases count
    const minAgents = opts.minAgents ?? 3;
    const minLen = opts.minLen ?? 100;
    const limitClusters = opts.limit ?? 30;

    if (!embeddingsModule.isReady()) return [];

    // Only consider chunks that ARE agent-scoped (NULL = already global).
    const rows = this.conn.prepare(
      `SELECT id, source_file, section, content, embedding, agent_slug, updated_at
       FROM chunks
       WHERE embedding IS NOT NULL
         AND agent_slug IS NOT NULL
         AND length(content) >= ?
       ORDER BY updated_at DESC`,
    ).all(minLen) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      embedding: Buffer;
      agent_slug: string;
      updated_at: string | null;
    }>;

    if (rows.length < minAgents) return [];

    const decoded = rows.map(r => ({ ...r, vec: embeddingsModule.deserializeEmbedding(r.embedding) }));

    const clusters: ReturnType<typeof this.findCrossAgentRecurrence> = [];
    const consumed = new Set<number>();

    for (let i = 0; i < decoded.length; i++) {
      if (consumed.has(decoded[i].id)) continue;
      const head = decoded[i];
      const members: Array<{ chunkId: number; sourceFile: string; section: string; agentSlug: string; similarity: number; updatedAt: string | null }> = [
        { chunkId: head.id, sourceFile: head.source_file, section: head.section, agentSlug: head.agent_slug, similarity: 1.0, updatedAt: head.updated_at },
      ];
      const agentsTouched = new Set<string>([head.agent_slug]);

      for (let j = i + 1; j < decoded.length; j++) {
        if (consumed.has(decoded[j].id)) continue;
        const sim = embeddingsModule.cosineSimilarity(head.vec, decoded[j].vec);
        if (sim >= threshold) {
          members.push({
            chunkId: decoded[j].id,
            sourceFile: decoded[j].source_file,
            section: decoded[j].section,
            agentSlug: decoded[j].agent_slug,
            similarity: sim,
            updatedAt: decoded[j].updated_at,
          });
          agentsTouched.add(decoded[j].agent_slug);
        }
      }

      if (agentsTouched.size >= minAgents) {
        // Mark all in this cluster consumed so we don't re-cluster around them.
        for (const m of members) consumed.add(m.chunkId);
        clusters.push({
          representative: {
            chunkId: head.id,
            sourceFile: head.source_file,
            section: head.section,
            content: head.content,
            agentSlug: head.agent_slug,
          },
          members,
          agents: Array.from(agentsTouched).sort(),
        });
        if (clusters.length >= limitClusters) break;
      }
    }

    return clusters;
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

    // Process changed/new files inside a single transaction so a 1000-file
    // sync produces one WAL commit instead of 1000+. Prepared statements are
    // hoisted out of the loop — better-sqlite3 caches by SQL text anyway, but
    // the explicit handle avoids re-parsing and makes the intent clear.
    const insertStmt = this.conn.prepare(
      `INSERT INTO chunks
       (source_file, section, content, chunk_type, frontmatter_json, content_hash, category, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertHashStmt = this.conn.prepare(
      `INSERT OR REPLACE INTO file_hashes (rel_path, content_hash, last_synced)
       VALUES (?, ?, datetime('now'))`,
    );
    const processFile = (filePath: string): void => {
      const rel = path.relative(this.vaultDir, filePath);
      const chunks = chunkFile(filePath, this.vaultDir);
      if (chunks.length === 0) return;
      this.deleteFileChunks(rel);
      for (const chunk of chunks) {
        insertStmt.run(
          chunk.sourceFile,
          chunk.section,
          chunk.content,
          chunk.chunkType,
          chunk.frontmatterJson,
          chunk.contentHash,
          chunk.category ?? null,
          chunk.topic ?? null,
        );
      }
      this.indexWikilinks(rel, filePath);
      const bytes = readFileSync(filePath);
      const fileHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      upsertHashStmt.run(rel, fileHash);
      stats.filesUpdated++;
    };
    const processAll = this.conn.transaction((files: string[]) => {
      for (const f of files) processFile(f);
    });
    processAll(filesToUpdate);

    // Count total chunks
    const countRow = this.conn
      .prepare('SELECT COUNT(*) as cnt FROM chunks')
      .get() as { cnt: number } | undefined;
    stats.chunksTotal = countRow?.cnt ?? 0;

    // Rebuild embedding vocabulary and backfill missing embeddings
    if (filesToUpdate.length > 0) {
      try {
        this.buildEmbeddings();
      } catch {
        // Non-fatal — FTS search still works without embeddings
      }
    }

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
       (source_file, section, content, chunk_type, frontmatter_json, content_hash, agent_slug, category, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        chunk.category ?? null,
        chunk.topic ?? null,
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
  searchFts(
    query: string,
    limit: number = 20,
    filters?: { category?: string; topic?: string },
    isolateAgentSlug?: string, // if set, filter to this agent + global (NULL)
  ): SearchResult[] {
    const sanitized = MemoryStore.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      let sql = `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                  c.updated_at, c.salience, c.last_outcome_score, c.agent_slug, c.category, c.topic,
                  c.pinned, bm25(chunks_fts) as score
           FROM chunks_fts f
           JOIN chunks c ON c.id = f.rowid
           LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
           WHERE chunks_fts MATCH ?
             AND sd.chunk_id IS NULL`;
      const params: any[] = [sanitized];

      if (isolateAgentSlug) {
        sql += ' AND (c.agent_slug = ? OR c.agent_slug IS NULL)';
        params.push(isolateAgentSlug);
      }
      if (filters?.category) {
        sql += ' AND c.category = ?';
        params.push(filters.category);
      }
      if (filters?.topic) {
        sql += ' AND c.topic = ?';
        params.push(filters.topic);
      }

      sql += ' ORDER BY bm25(chunks_fts) LIMIT ?';
      params.push(limit);

      const rows = this.conn.prepare(sql).all(...params) as Array<{
        id: number;
        source_file: string;
        section: string;
        content: string;
        chunk_type: string;
        updated_at: string | null;
        salience: number | null;
        last_outcome_score: number | null;
        agent_slug: string | null;
        category: string | null;
        topic: string | null;
        pinned: number | null;
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
        lastOutcomeScore: row.last_outcome_score ?? 0,
        agentSlug: row.agent_slug ?? null,
        category: row.category,
        topic: row.topic,
        pinned: row.pinned === 1,
      }));
    } catch {
      return [];
    }
  }

  // ── Search: Recent Chunks ─────────────────────────────────────────

  /**
   * Get the most recently updated chunks.
   */
  getRecentChunks(
    limit: number = 5,
    agentSlug?: string,
    filters?: { category?: string; topic?: string },
    strict = false,
  ): SearchResult[] {
    type ChunkRow = {
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      updated_at: string | null;
      salience: number | null;
      last_outcome_score: number | null;
      agent_slug: string | null;
      category: string | null;
      topic: string | null;
    };

    const now = Date.now();
    const mapRow = (row: ChunkRow): SearchResult => {
      // Score recency by exponential decay (half-life 30 days). Previously
      // every recent row got score=0, which meant MMR's min-max normalization
      // ranked them at the floor — a two-day-old chunk and a six-month-old
      // chunk were indistinguishable. Decay lets recent results actually
      // compete with FTS and vector matches during rerank.
      const daysOld = row.updated_at ? (now - Date.parse(row.updated_at)) / 86_400_000 : 0;
      const decayed = temporalDecay(daysOld);
      return {
        sourceFile: row.source_file,
        section: row.section,
        content: row.content,
        score: decayed,
        chunkType: row.chunk_type,
        matchType: 'recency' as const,
        lastUpdated: row.updated_at ?? '',
        chunkId: row.id,
        salience: row.salience ?? 0,
        lastOutcomeScore: row.last_outcome_score ?? 0,
        agentSlug: row.agent_slug ?? null,
        category: row.category,
        topic: row.topic,
      };
    };

    // Build optional WHERE clauses for category/topic
    let filterSql = '';
    const filterParams: any[] = [];
    if (filters?.category) {
      filterSql += ' AND category = ?';
      filterParams.push(filters.category);
    }
    if (filters?.topic) {
      filterSql += ' AND topic = ?';
      filterParams.push(filters.topic);
    }

    // If agent specified: hard isolation = only own + global; soft = mix with extra global
    // Soft-delete filter for all branches: LEFT JOIN chunk_soft_deletes and
    // require the join row to be NULL.
    const sdJoin = ' LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id ';
    const sdFilter = ' AND sd.chunk_id IS NULL ';

    if (agentSlug) {
      if (strict) {
        const rows = this.conn.prepare(
          `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                  c.updated_at, c.salience, c.last_outcome_score, c.agent_slug, c.category, c.topic
           FROM chunks c${sdJoin}
           WHERE (c.agent_slug = ? OR c.agent_slug IS NULL)${sdFilter}${filterSql.replace(/(?<!c\.)agent_slug|(?<!c\.)category|(?<!c\.)topic/g, m => 'c.' + m)}
           ORDER BY c.updated_at DESC LIMIT ?`,
        ).all(agentSlug, ...filterParams, limit) as ChunkRow[];
        return rows.map(mapRow);
      }

      const agentRows = this.conn.prepare(
        `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                c.updated_at, c.salience, c.last_outcome_score, c.agent_slug, c.category, c.topic
         FROM chunks c${sdJoin}
         WHERE c.agent_slug = ?${sdFilter}${filterSql.replace(/(?<!c\.)agent_slug|(?<!c\.)category|(?<!c\.)topic/g, m => 'c.' + m)}
         ORDER BY c.updated_at DESC LIMIT ?`,
      ).all(agentSlug, ...filterParams, Math.ceil(limit * 0.6)) as ChunkRow[];

      const globalRows = this.conn.prepare(
        `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                c.updated_at, c.salience, c.last_outcome_score, c.agent_slug, c.category, c.topic
         FROM chunks c${sdJoin}
         WHERE c.agent_slug IS NULL${sdFilter}${filterSql.replace(/(?<!c\.)agent_slug|(?<!c\.)category|(?<!c\.)topic/g, m => 'c.' + m)}
         ORDER BY c.updated_at DESC LIMIT ?`,
      ).all(...filterParams, Math.ceil(limit * 0.4)) as ChunkRow[];

      return [...agentRows, ...globalRows].slice(0, limit).map(mapRow);
    }

    const rows = this.conn
      .prepare(
        `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                c.updated_at, c.salience, c.last_outcome_score, c.agent_slug, c.category, c.topic
         FROM chunks c${sdJoin}
         WHERE 1=1${sdFilter}${filterSql.replace(/(?<!c\.)agent_slug|(?<!c\.)category|(?<!c\.)topic/g, m => 'c.' + m)}
         ORDER BY c.updated_at DESC
         LIMIT ?`,
      )
      .all(...filterParams, limit) as ChunkRow[];

    return rows.map(mapRow);
  }

  // ── Search: Context (Layer 3) ─────────────────────────────────────

  /**
   * 1-hop wikilink expansion: for each seed chunk's source_file, find files
   * that link to it or that it links to, and pull their top chunks. Returns
   * SearchResult-shaped rows with a fractional boost so they enter the
   * candidate pool below the seed scores but above pure noise.
   *
   * Pattern: 2026-frontier agent memory uses graph expansion (Mem0g, Zep
   * Graphiti) to surface chunks that share an entity but miss the lexical
   * match. Wikilinks are the cheapest available edge — Clementine already
   * extracts them on every vault sync. The richer FalkorDB graph adds
   * temporal validity and entity types but isn't required for this lift.
   */
  expandViaWikilinks(
    seeds: SearchResult[],
    opts: {
      boost?: number;
      limitPerFile?: number;
      maxNeighbors?: number;
      agentSlug?: string;
      strict?: boolean;
    } = {},
  ): SearchResult[] {
    const boost = opts.boost ?? 0.7;
    const limitPerFile = opts.limitPerFile ?? 1;
    const maxNeighbors = opts.maxNeighbors ?? 10;
    if (seeds.length === 0) return [];

    const seedFiles = new Set<string>(seeds.map((s) => s.sourceFile));
    const seedFilesArr = [...seedFiles];
    if (seedFilesArr.length === 0) return [];
    // Wikilinks store the raw bracket text (e.g. "hub" from "[[hub]]"), not
    // the resolved path "hub.md". Match against both forms when looking up
    // backlinks so a seed of "hub.md" finds rows where target_file = "hub".
    const seedBasenames = seedFilesArr.map((f) => path.basename(f, '.md'));
    const fwdMatchSet = new Set([...seedFilesArr]);
    const backMatchSet = new Set([...seedFilesArr, ...seedBasenames]);
    const fwdArr = [...fwdMatchSet];
    const backArr = [...backMatchSet];
    const fwdPh = fwdArr.map(() => '?').join(',');
    const backPh = backArr.map(() => '?').join(',');

    const neighborFiles = new Set<string>();
    try {
      const fwdRows = this.conn
        .prepare(`SELECT DISTINCT target_file FROM wikilinks WHERE source_file IN (${fwdPh})`)
        .all(...fwdArr) as Array<{ target_file: string }>;
      for (const r of fwdRows) {
        // target_file may be a basename — try both with and without .md.
        const candidates = [r.target_file, `${r.target_file}.md`];
        for (const c of candidates) {
          if (!seedFiles.has(c)) neighborFiles.add(c);
        }
      }
      const backRows = this.conn
        .prepare(`SELECT DISTINCT source_file FROM wikilinks WHERE target_file IN (${backPh})`)
        .all(...backArr) as Array<{ source_file: string }>;
      for (const r of backRows) {
        if (!seedFiles.has(r.source_file)) neighborFiles.add(r.source_file);
      }
    } catch {
      // wikilinks lookup failure — graph expansion is optional.
      return [];
    }
    if (neighborFiles.size === 0) return [];

    const neighborFilesArr = [...neighborFiles].slice(0, maxNeighbors * 2);
    const filePh = neighborFilesArr.map(() => '?').join(',');
    const args: unknown[] = [...neighborFilesArr];
    let agentClause = '';
    if (opts.agentSlug && opts.strict) {
      agentClause = 'AND (c.agent_slug = ? OR c.agent_slug IS NULL)';
      args.push(opts.agentSlug);
    }

    const chunkRows = this.conn
      .prepare(
        `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                c.salience, c.agent_slug, c.category, c.topic, c.updated_at,
                c.last_outcome_score, c.pinned
         FROM chunks c
         LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE c.source_file IN (${filePh})
           AND c.chunk_type != 'frontmatter'
           AND sd.chunk_id IS NULL
           ${agentClause}
         ORDER BY c.salience DESC, c.updated_at DESC`,
      )
      .all(...args) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      salience: number | null;
      agent_slug: string | null;
      category: string | null;
      topic: string | null;
      updated_at: string;
      last_outcome_score: number | null;
      pinned: number | null;
    }>;

    const seedScoreMax = Math.max(...seeds.map((s) => s.score), 1);
    const perFile = new Map<string, number>();
    const out: SearchResult[] = [];
    for (const r of chunkRows) {
      const count = perFile.get(r.source_file) ?? 0;
      if (count >= limitPerFile) continue;
      perFile.set(r.source_file, count + 1);
      out.push({
        sourceFile: r.source_file,
        section: r.section,
        content: r.content,
        score: seedScoreMax * boost * (1 + (r.salience ?? 0)),
        chunkType: r.chunk_type,
        matchType: 'graph',
        lastUpdated: r.updated_at,
        chunkId: r.id,
        salience: r.salience ?? 0,
        lastOutcomeScore: r.last_outcome_score ?? 0,
        agentSlug: r.agent_slug ?? undefined,
        category: r.category,
        topic: r.topic,
        pinned: !!r.pinned,
      });
      if (out.length >= maxNeighbors) break;
    }
    return out;
  }

  /**
   * Combined FTS5 relevance + recency search for context injection.
   *
   * Layer 3 of the memory architecture:
   * 1. FTS5 search -> top N relevant
   * 2. Recency fetch -> N most recent chunks
   * 3. Deduplicate by (source_file, section)
   * 4. Apply salience boost to FTS results
   * 5. Wikilink graph expansion -> 1-hop neighbors of top seeds (boost 0.7×)
   */
  searchContext(
    query: string,
    limitOrOpts: number | {
      limit?: number;
      recencyLimit?: number;
      agentSlug?: string;
      category?: string;
      topic?: string;
      strict?: boolean;
      sessionKey?: string;
      messageId?: string;
      skipTrace?: boolean;
      /** Pre-computed dense query vector. When provided, use the dense
       *  embedding column for vector search. Caller computes this via
       *  embedDense() (async) so this method can stay sync. */
      queryDenseVec?: Float32Array;
    } = 3,
    recencyLimitArg: number = 5,
  ): SearchResult[] {
    let limit: number;
    let recencyLimit: number;
    let agentSlug: string | undefined;
    let category: string | undefined;
    let topic: string | undefined;
    let strict: boolean = false;
    let sessionKey: string | undefined;
    let messageId: string | undefined;
    let skipTrace: boolean = false;
    let queryDenseVec: Float32Array | undefined;
    if (typeof limitOrOpts === 'object') {
      limit = limitOrOpts.limit ?? 3;
      recencyLimit = limitOrOpts.recencyLimit ?? 5;
      agentSlug = limitOrOpts.agentSlug;
      category = limitOrOpts.category;
      topic = limitOrOpts.topic;
      strict = limitOrOpts.strict ?? false;
      sessionKey = limitOrOpts.sessionKey;
      messageId = limitOrOpts.messageId;
      skipTrace = limitOrOpts.skipTrace ?? false;
      queryDenseVec = limitOrOpts.queryDenseVec;
    } else {
      limit = limitOrOpts;
      recencyLimit = recencyLimitArg;
    }

    const tagFilters = (category || topic) ? { category, topic } : undefined;

    // 1. FTS5 relevance (fetch extra to allow re-ranking after boost)
    const ftsResults = this.searchFts(query, agentSlug ? limit * 2 : limit, tagFilters, agentSlug && strict ? agentSlug : undefined);

    // Apply boosts. Order doesn't matter (all multiplicative) but readability does.
    const nowMs = Date.now();
    for (const r of ftsResults) {
      // Salience: editor-curated importance (admin tag, sticky note, etc.)
      if (r.salience > 0) {
        r.score *= 1.0 + r.salience;
      }
      // Manual pin: stronger boost than access-pattern salience. Toggled via
      // `clementine memory pin <chunkId>`. Doubles the relevance score so
      // pinned chunks consistently rank near the top within their relevance band.
      if (r.pinned) {
        r.score *= 2.0;
      }
      // Outcome-driven adjustment: chunks that recently got cited in
      // responses get a small boost; chunks that were pulled in and
      // ignored get a small penalty. Bounded to ±30% so outcome noise
      // can't dominate ranking.
      const outcome = r.lastOutcomeScore ?? 0;
      if (outcome !== 0) {
        r.score *= 1.0 + 0.3 * outcome;
      }
      // Temporal decay — without this, a 2-year-old chunk with the same BM25
      // score ranks identically to one from yesterday. Half-life of 30 days
      // (matches TEMPORAL_DECAY_HALF_LIFE_DAYS in config). Applied to a
      // bounded fraction (max 60% reduction) so genuinely high-relevance
      // historical context still surfaces — this is a tiebreaker, not a cliff.
      if (r.lastUpdated) {
        const daysOld = Math.max(0, (nowMs - new Date(r.lastUpdated).getTime()) / 86_400_000);
        const decay = temporalDecay(daysOld, 30);
        // Clamp to [0.4, 1.0] so very old chunks lose at most 60% of their score.
        r.score *= Math.max(0.4, decay);
      }
    }

    // Soft-isolation: apply agent affinity boost when not strict
    if (agentSlug && !strict) {
      for (const r of ftsResults) {
        if (r.agentSlug === agentSlug) {
          r.score *= 1.4;
        }
      }
    }

    // 2. Vector similarity. Prefer dense if a pre-computed query vector
    // was passed in (caller did the async embedDense up the stack). Fall
    // back to TF-IDF if no dense vec available — keeps single-process
    // sync paths and tests working without the model loaded.
    let vectorResults: SearchResult[] = [];
    if (queryDenseVec && queryDenseVec.length > 0) {
      try {
        vectorResults = this.searchByDenseEmbedding(queryDenseVec, limit, agentSlug, strict);
      } catch { /* dense search failed — leave empty */ }
    }
    if (vectorResults.length === 0) {
      try {
        if (embeddingsModule.isReady()) {
          const queryVec = embeddingsModule.embed(query);
          if (queryVec) {
            vectorResults = this.searchByEmbedding(queryVec, limit, agentSlug, strict);
          }
        }
      } catch { /* embeddings not available — fall through */ }
    }

    // 3. Recency
    const recentResults = this.getRecentChunks(recencyLimit, agentSlug, tagFilters, strict);

    // 3b. 1-hop wikilink expansion. Only run when we have seed candidates so
    // we don't blow up on empty queries; bounded to keep MMR cost flat.
    let graphResults: SearchResult[] = [];
    try {
      const seeds = [...ftsResults.slice(0, 5), ...vectorResults.slice(0, 5)];
      if (seeds.length > 0) {
        graphResults = this.expandViaWikilinks(seeds, {
          agentSlug,
          strict,
          maxNeighbors: 5,
          limitPerFile: 1,
        });
      }
    } catch { /* graph expansion is optional — never fail the whole retrieval */ }

    // 4. Merge and deduplicate (FTS first, then vector, then graph, then recency)
    const merged = [...ftsResults, ...vectorResults, ...graphResults, ...recentResults];
    const finalResults = mmrRerank(deduplicateResults(merged), 0.7, limit + recencyLimit);

    // 5. Log recall trace if session context provided. Skipped for internal
    // calls (e.g. consolidation, dedup checks) by passing skipTrace=true.
    if (sessionKey && !skipTrace && finalResults.length > 0) {
      this.logRecallTrace({
        sessionKey,
        messageId: messageId ?? null,
        query,
        chunkIds: finalResults.map(r => r.chunkId),
        scores: finalResults.map(r => r.score),
        agentSlug: agentSlug ?? null,
        matchTypes: finalResults.map(r => r.matchType),
      });
    }

    return finalResults;
  }

  /**
   * Log a recall trace — which chunks were retrieved for a given query/message.
   * Powers dashboard "🧠 N sources" affordance and retrieval debugging.
   * Non-fatal: errors are swallowed so retrieval never fails on logging issues.
   */
  logRecallTrace(opts: {
    sessionKey: string;
    messageId?: string | null;
    query: string;
    chunkIds: number[];
    scores: number[];
    agentSlug?: string | null;
    matchTypes?: string[];
  }): void {
    if (opts.chunkIds.length === 0) return;
    if (this.writeQueue) {
      this.writeQueue.enqueue({
        kind: 'recall',
        sessionKey: opts.sessionKey,
        messageId: opts.messageId ?? null,
        query: opts.query,
        chunkIds: [...opts.chunkIds],
        scores: [...opts.scores],
        agentSlug: opts.agentSlug ?? null,
        matchTypes: opts.matchTypes ? [...opts.matchTypes] : undefined,
      });
      return;
    }
    this._logRecallTraceSync(opts);
  }

  /** Internal sync recall_trace insert. Called by the WriteQueue. */
  _logRecallTraceSync(opts: {
    sessionKey: string;
    messageId?: string | null;
    query: string;
    chunkIds: number[];
    scores: number[];
    agentSlug?: string | null;
    matchTypes?: string[];
  }): void {
    if (opts.chunkIds.length === 0) return;
    try {
      this.conn.prepare(
        `INSERT INTO recall_traces (session_key, message_id, query, chunk_ids, scores, agent_slug, match_types)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        opts.sessionKey,
        opts.messageId ?? null,
        opts.query,
        JSON.stringify(opts.chunkIds),
        JSON.stringify(opts.scores),
        opts.agentSlug ?? null,
        opts.matchTypes ? JSON.stringify(opts.matchTypes) : null,
      );
    } catch {
      // Non-fatal — recall trace logging never breaks retrieval
    }
  }

  /**
   * Fetch recent recall traces for a session, newest first.
   * Used by the dashboard chat panel to show "what memory powered this answer".
   */
  getRecentRecallTraces(sessionKey: string, limit = 50): Array<{
    id: number;
    messageId: string | null;
    query: string;
    chunkIds: number[];
    scores: number[];
    retrievedAt: string;
  }> {
    const rows = this.conn.prepare(
      `SELECT id, message_id, query, chunk_ids, scores, retrieved_at
       FROM recall_traces
       WHERE session_key = ?
       ORDER BY retrieved_at DESC, id DESC
       LIMIT ?`,
    ).all(sessionKey, limit) as Array<{
      id: number;
      message_id: string | null;
      query: string;
      chunk_ids: string;
      scores: string;
      retrieved_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      query: r.query,
      chunkIds: this._parseJsonArray<number>(r.chunk_ids),
      scores: this._parseJsonArray<number>(r.scores),
      retrievedAt: r.retrieved_at,
    }));
  }

  /**
   * Fetch a single recall trace by id, with hydrated chunk details.
   * Used for the dashboard "view sources" expansion on a single message.
   */
  getRecallTrace(traceId: number): {
    id: number;
    sessionKey: string | null;
    messageId: string | null;
    query: string;
    retrievedAt: string;
    chunks: Array<{
      id: number;
      sourceFile: string;
      section: string;
      content: string;
      chunkType: string;
      score: number;
      pinned: boolean;
      consolidated: boolean;
      derivedFrom: number[] | null;
    }>;
  } | null {
    const trace = this.conn.prepare(
      `SELECT id, session_key, message_id, query, chunk_ids, scores, retrieved_at
       FROM recall_traces WHERE id = ?`,
    ).get(traceId) as {
      id: number;
      session_key: string | null;
      message_id: string | null;
      query: string;
      chunk_ids: string;
      scores: string;
      retrieved_at: string;
    } | undefined;
    if (!trace) return null;

    const chunkIds = this._parseJsonArray<number>(trace.chunk_ids);
    const scores = this._parseJsonArray<number>(trace.scores);
    const chunks = this.getChunksByIds(chunkIds);
    // Re-order chunks to match trace order, attach scores
    const byId = new Map(chunks.map(c => [c.id, c]));
    const ordered: Array<{
      id: number;
      sourceFile: string;
      section: string;
      content: string;
      chunkType: string;
      score: number;
      pinned: boolean;
      consolidated: boolean;
      derivedFrom: number[] | null;
    }> = [];
    chunkIds.forEach((id, idx) => {
      const c = byId.get(id);
      if (c) ordered.push({ ...c, score: scores[idx] ?? 0 });
    });

    return {
      id: trace.id,
      sessionKey: trace.session_key,
      messageId: trace.message_id,
      query: trace.query,
      retrievedAt: trace.retrieved_at,
      chunks: ordered,
    };
  }

  /**
   * Fetch chunks by id with provenance fields. Used by recall trace hydration
   * and the "view source memories" link on consolidated chunks (derived_from).
   */
  getChunksByIds(chunkIds: number[]): Array<{
    id: number;
    sourceFile: string;
    section: string;
    content: string;
    chunkType: string;
    agentSlug: string | null;
    pinned: boolean;
    consolidated: boolean;
    derivedFrom: number[] | null;
    salience: number;
    updatedAt: string;
  }> {
    if (chunkIds.length === 0) return [];

    // Hot-cache pass — split into hits (return as-is) and misses (need SQL).
    const out: Array<{
      id: number;
      sourceFile: string;
      section: string;
      content: string;
      chunkType: string;
      agentSlug: string | null;
      pinned: boolean;
      consolidated: boolean;
      derivedFrom: number[] | null;
      salience: number;
      updatedAt: string;
    }> = [];
    const misses: number[] = [];
    for (const id of chunkIds) {
      const cached = this.chunkRowCache.get(id);
      if (cached) out.push(cached);
      else misses.push(id);
    }
    if (misses.length === 0) return out;

    const placeholders = misses.map(() => '?').join(',');
    const rows = this.conn.prepare(
      `SELECT id, source_file, section, content, chunk_type, agent_slug,
              pinned, consolidated, derived_from, salience, updated_at
       FROM chunks WHERE id IN (${placeholders})`,
    ).all(...misses) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      agent_slug: string | null;
      pinned: number;
      consolidated: number;
      derived_from: string | null;
      salience: number;
      updated_at: string;
    }>;

    for (const r of rows) {
      const shaped = {
        id: r.id,
        sourceFile: r.source_file,
        section: r.section,
        content: r.content,
        chunkType: r.chunk_type,
        agentSlug: r.agent_slug,
        pinned: !!r.pinned,
        consolidated: !!r.consolidated,
        derivedFrom: r.derived_from ? this._parseJsonArray<number>(r.derived_from) : null,
        salience: r.salience,
        updatedAt: r.updated_at,
      };
      this.chunkRowCache.set(r.id, shaped);
      out.push(shaped);
    }
    return out;
  }

  /** Cache stats for the dashboard / debugging. */
  getChunkCacheStats(): ReturnType<HotCache<number, unknown>['stats']> {
    return this.chunkRowCache.stats();
  }

  // ── Async write queue lifecycle ─────────────────────────────────

  /**
   * Enable the write-behind queue. After this call, saveTurn / recordAccess /
   * recordOutcome / logRecallTrace enqueue instead of running SQL on the
   * caller's thread. Idempotent. Tests leave this off and rely on the sync path.
   */
  enableWriteQueue(opts: WriteQueueOpts = {}): void {
    if (this.writeQueue) return;
    this.writeQueue = new WriteQueue(this, opts);
    this.writeQueue.start();
  }

  /** Drain and stop the write queue. Call on graceful shutdown. */
  async flushWrites(): Promise<void> {
    if (!this.writeQueue) return;
    await this.writeQueue.drain();
    this.writeQueue = null;
  }

  /** Stats for the dashboard / debugging. Returns null when queue disabled. */
  getWriteQueueStats(): { size: number; dropped: number } | null {
    return this.writeQueue ? this.writeQueue.stats() : null;
  }

  /** Drop a single cache entry — called from mutations that touch a chunk. */
  invalidateChunkCache(chunkId: number): void {
    this.chunkRowCache.delete(chunkId);
  }

  /** Drop the whole cache — fullSync and similar bulk operations call this. */
  clearChunkCache(): void {
    this.chunkRowCache.clear();
  }

  private _parseJsonArray<T>(json: string): T[] {
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  // ── User Mental Model ──────────────────────────────────────────────
  //
  // MemGPT-style core memory: a small, always-in-context surface for
  // "what we know about the user" — identifiers, lasting preferences,
  // active goals, relationships, agent persona. Editable by the agent
  // via MCP tool and by the user via the dashboard.

  /** The fixed slot vocabulary. Adding new slots is a code change so the
   *  agent doesn't sprawl into ad-hoc namespaces. */
  static readonly USER_MODEL_SLOTS = ['user_facts', 'goals', 'relationships', 'agent_persona'] as const;

  /** Get a single user-model slot. Returns the global block (agent_slug NULL)
   *  unless an explicit agent_slug is provided. */
  getUserModelBlock(slot: string, agentSlug?: string | null): {
    slot: string;
    content: string;
    charLimit: number;
    agentSlug: string | null;
    updatedAt: string;
  } | null {
    const row = this.conn.prepare(
      `SELECT slot, content, char_limit, agent_slug, updated_at
       FROM user_model_blocks
       WHERE slot = ? AND COALESCE(agent_slug, '') = COALESCE(?, '')`,
    ).get(slot, agentSlug ?? null) as {
      slot: string;
      content: string;
      char_limit: number;
      agent_slug: string | null;
      updated_at: string;
    } | undefined;
    if (!row) return null;
    return {
      slot: row.slot,
      content: row.content,
      charLimit: row.char_limit,
      agentSlug: row.agent_slug,
      updatedAt: row.updated_at,
    };
  }

  /** List every user-model slot (across all agents).
   *  When agentSlug is provided, returns per-agent slots first (falling back
   *  to global slots for any not yet customized for this agent). */
  getAllUserModelBlocks(agentSlug?: string | null): Array<{
    slot: string;
    content: string;
    charLimit: number;
    agentSlug: string | null;
    updatedAt: string;
  }> {
    if (agentSlug) {
      // Layered view: agent-specific takes precedence over global.
      const rows = this.conn.prepare(
        `SELECT slot, content, char_limit, agent_slug, updated_at
         FROM user_model_blocks
         WHERE agent_slug = ? OR agent_slug IS NULL
         ORDER BY slot ASC, agent_slug DESC`,
      ).all(agentSlug) as Array<{
        slot: string; content: string; char_limit: number; agent_slug: string | null; updated_at: string;
      }>;
      const seen = new Set<string>();
      const out: Array<{ slot: string; content: string; charLimit: number; agentSlug: string | null; updatedAt: string }> = [];
      for (const r of rows) {
        if (seen.has(r.slot)) continue;
        seen.add(r.slot);
        out.push({
          slot: r.slot, content: r.content, charLimit: r.char_limit,
          agentSlug: r.agent_slug, updatedAt: r.updated_at,
        });
      }
      return out;
    }
    const rows = this.conn.prepare(
      `SELECT slot, content, char_limit, agent_slug, updated_at
       FROM user_model_blocks
       WHERE agent_slug IS NULL
       ORDER BY slot ASC`,
    ).all() as Array<{
      slot: string; content: string; char_limit: number; agent_slug: string | null; updated_at: string;
    }>;
    return rows.map(r => ({
      slot: r.slot, content: r.content, charLimit: r.char_limit,
      agentSlug: r.agent_slug, updatedAt: r.updated_at,
    }));
  }

  /** Replace the content of a single slot. Truncates to char_limit. */
  setUserModelBlock(opts: {
    slot: string;
    content: string;
    agentSlug?: string | null;
    charLimit?: number;
  }): { slot: string; content: string; truncated: boolean } {
    const charLimit = opts.charLimit ?? 2000;
    const truncated = opts.content.length > charLimit;
    const content = truncated ? opts.content.slice(0, charLimit) : opts.content;

    this.conn.prepare(
      `INSERT INTO user_model_blocks (slot, content, char_limit, agent_slug, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slot, COALESCE(agent_slug, '')) DO UPDATE SET
         content = excluded.content,
         char_limit = excluded.char_limit,
         updated_at = datetime('now')`,
    ).run(opts.slot, content, charLimit, opts.agentSlug ?? null);

    return { slot: opts.slot, content, truncated };
  }

  /** Append content to a slot, joined with a newline. Truncates oldest content
   *  when char_limit would be exceeded so the most recent additions always fit. */
  appendUserModelBlock(opts: {
    slot: string;
    content: string;
    agentSlug?: string | null;
  }): { slot: string; content: string; truncated: boolean } {
    const existing = this.getUserModelBlock(opts.slot, opts.agentSlug ?? null);
    const charLimit = existing?.charLimit ?? 2000;
    const sep = existing?.content ? '\n' : '';
    let merged = (existing?.content ?? '') + sep + opts.content;

    let truncated = false;
    if (merged.length > charLimit) {
      // Keep the tail (most recent additions) — older entries fall off
      merged = merged.slice(-charLimit);
      truncated = true;
    }

    this.conn.prepare(
      `INSERT INTO user_model_blocks (slot, content, char_limit, agent_slug, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slot, COALESCE(agent_slug, '')) DO UPDATE SET
         content = excluded.content,
         updated_at = datetime('now')`,
    ).run(opts.slot, merged, charLimit, opts.agentSlug ?? null);

    return { slot: opts.slot, content: merged, truncated };
  }

  /** Delete a single slot (resets to empty). */
  deleteUserModelBlock(slot: string, agentSlug?: string | null): boolean {
    const result = this.conn.prepare(
      `DELETE FROM user_model_blocks
       WHERE slot = ? AND COALESCE(agent_slug, '') = COALESCE(?, '')`,
    ).run(slot, agentSlug ?? null);
    return result.changes > 0;
  }

  /** Render the full user model as a single context-assembler-friendly block. */
  renderUserModel(agentSlug?: string | null, maxChars = 8000): string {
    const blocks = this.getAllUserModelBlocks(agentSlug ?? null);
    const slotOrder = MemoryStore.USER_MODEL_SLOTS;
    const labelMap: Record<string, string> = {
      user_facts: 'User Facts',
      goals: 'Active Goals',
      relationships: 'Key Relationships',
      agent_persona: 'Agent Persona',
    };
    const parts: string[] = [];
    for (const slot of slotOrder) {
      const block = blocks.find(b => b.slot === slot);
      if (!block || !block.content.trim()) continue;
      parts.push(`### ${labelMap[slot] ?? slot}\n${block.content.trim()}`);
    }
    if (parts.length === 0) return '';
    let out = `## User Model\n\n${parts.join('\n\n')}`;
    if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\n[^\n]*$/, '\n…(truncated)');
    return out;
  }

  /**
   * Search chunks by embedding cosine similarity.
   * Scans chunks that have stored embeddings and returns top matches.
   */
  private searchByEmbedding(queryVec: Float32Array, limit: number, agentSlug?: string, strict = false): SearchResult[] {
    // Push agent-isolation into SQL so we don't deserialize embeddings for
    // rows we'd immediately reject. Soft isolation (non-strict) still loads
    // all embeddings because the boost is applied post-scoring, but at
    // least strict mode no longer scans foreign-agent chunks.
    let sql = `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                      c.embedding, c.salience, c.last_outcome_score, c.agent_slug,
                      c.updated_at, c.category, c.topic, c.confidence
                 FROM chunks c
                 LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
                 WHERE c.embedding IS NOT NULL AND sd.chunk_id IS NULL`;
    const params: Array<string | number> = [];
    if (strict && agentSlug) {
      sql += ' AND (c.agent_slug IS NULL OR c.agent_slug = ?)';
      params.push(agentSlug);
    }
    const rows = this.conn.prepare(sql).all(...params) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      embedding: Buffer;
      salience: number;
      last_outcome_score: number | null;
      agent_slug: string | null;
      updated_at: string;
      category: string | null;
      topic: string | null;
      confidence: number | null;
    }>;

    const scored: SearchResult[] = [];
    const nowMs = Date.now();
    for (const row of rows) {
      try {
        const vec = embeddingsModule.deserializeEmbedding(row.embedding);
        const sim = embeddingsModule.cosineSimilarity(queryVec, vec);
        if (sim < 0.15) continue; // threshold for relevance

        let score = sim * 10; // scale to comparable range with FTS scores
        if (row.salience > 0) score *= (1.0 + row.salience);
        const outcome = row.last_outcome_score ?? 0;
        if (outcome !== 0) score *= 1.0 + 0.3 * outcome;
        const conf = row.confidence ?? 1;
        if (conf < 1) score *= (0.5 + 0.5 * conf);
        // Soft isolation: apply boost (only when not strict)
        if (!strict && agentSlug && row.agent_slug === agentSlug) score *= 1.4;
        // Temporal decay — same policy as FTS scoring (Phase 9d). Without
        // this, vector and FTS rankings disagree on freshness: FTS prefers
        // recent at equal relevance but vector treats all timestamps
        // equally, so MMR rerank surfaces stale matches when vector wins.
        // Same 30-day half-life, same 0.4 floor — see store.ts FTS path
        // for design rationale.
        if (row.updated_at) {
          const daysOld = Math.max(0, (nowMs - new Date(row.updated_at).getTime()) / 86_400_000);
          score *= Math.max(0.4, temporalDecay(daysOld, 30));
        }

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
          lastOutcomeScore: outcome,
          agentSlug: row.agent_slug ?? undefined,
          category: row.category,
          topic: row.topic,
        });
      } catch { continue; }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Dense-embedding search. Parallel to searchByEmbedding but uses the
   * 768-dim neural embedding column instead of TF-IDF. Same scoring boosts
   * and temporal decay so dense and sparse paths produce comparable scores
   * for MMR rerank. The caller pre-computes queryVec via embedDense() —
   * we don't compute it here because that would require this method to be
   * async, which propagates up the entire searchContext chain.
   */
  private searchByDenseEmbedding(queryVec: Float32Array, limit: number, agentSlug?: string, strict = false): SearchResult[] {
    let sql = `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
                      c.embedding_dense, c.salience, c.last_outcome_score, c.agent_slug,
                      c.updated_at, c.category, c.topic, c.confidence
                 FROM chunks c
                 LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
                 WHERE c.embedding_dense IS NOT NULL AND sd.chunk_id IS NULL`;
    const params: Array<string | number> = [];
    if (strict && agentSlug) {
      sql += ' AND (c.agent_slug IS NULL OR c.agent_slug = ?)';
      params.push(agentSlug);
    }
    const rows = this.conn.prepare(sql).all(...params) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      chunk_type: string;
      embedding_dense: Buffer;
      salience: number;
      last_outcome_score: number | null;
      agent_slug: string | null;
      updated_at: string;
      category: string | null;
      topic: string | null;
      confidence: number | null;
    }>;

    const scored: SearchResult[] = [];
    const nowMs = Date.now();
    for (const row of rows) {
      try {
        const vec = embeddingsModule.deserializeEmbedding(row.embedding_dense);
        const sim = embeddingsModule.cosineSimilarity(queryVec, vec);
        if (sim < 0.3) continue; // dense models produce more confident similarities; raise threshold from 0.15
        let score = sim * 10;
        // Confidence multiplier: tentative chunks (low confidence) lose ranking
        // weight without being hidden. confidence=1.0 → no effect, 0.5 → 0.75×.
        const conf = row.confidence ?? 1;
        if (conf < 1) score *= (0.5 + 0.5 * conf);
        if (row.salience > 0) score *= (1.0 + row.salience);
        const outcome = row.last_outcome_score ?? 0;
        if (outcome !== 0) score *= 1.0 + 0.3 * outcome;
        if (!strict && agentSlug && row.agent_slug === agentSlug) score *= 1.4;
        if (row.updated_at) {
          const daysOld = Math.max(0, (nowMs - new Date(row.updated_at).getTime()) / 86_400_000);
          score *= Math.max(0.4, temporalDecay(daysOld, 30));
        }
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
          lastOutcomeScore: outcome,
          agentSlug: row.agent_slug ?? undefined,
          category: row.category,
          topic: row.topic,
        });
      } catch { continue; }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Pre-embed the top N most-cited chunks at startup. Eliminates cold-start
   * latency for the chunks the agent is most likely to retrieve next. Skips
   * chunks that already have a current-model dense embedding.
   *
   * Ranking: by outcome citation count in the last 30d (chunks the agent
   * actually used), tiebroken by recency. Soft-deleted excluded.
   */
  async warmDenseEmbeddings(topN: number = 200): Promise<{ warmed: number; skipped: number; failed: number }> {
    const currentModel = embeddingsModule.currentDenseModel();
    const candidates = this.conn.prepare(
      `SELECT c.id, c.content, COUNT(o.id) AS refs
       FROM chunks c
       LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
       LEFT JOIN outcomes o ON o.chunk_id = c.id
                            AND o.referenced = 1
                            AND o.created_at > datetime('now', '-30 days')
       WHERE sd.chunk_id IS NULL
         AND length(c.content) >= 1
         AND (c.embedding_dense IS NULL OR c.embedding_dense_model IS NULL OR c.embedding_dense_model != ?)
       GROUP BY c.id
       HAVING refs > 0
       ORDER BY refs DESC, c.updated_at DESC
       LIMIT ?`,
    ).all(currentModel, topN) as Array<{ id: number; content: string; refs: number }>;

    let warmed = 0;
    let failed = 0;
    if (candidates.length === 0) return { warmed: 0, skipped: 0, failed: 0 };

    const updateStmt = this.conn.prepare(
      `UPDATE chunks SET embedding_dense = ?, embedding_dense_model = ? WHERE id = ?`,
    );
    for (const c of candidates) {
      try {
        const vec = await embeddingsModule.embedDense(c.content, false);
        if (vec) {
          updateStmt.run(embeddingsModule.serializeEmbedding(vec), currentModel, c.id);
          warmed++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    return { warmed, skipped: 0, failed };
  }

  /**
   * Backfill dense embeddings on chunks that don't yet have one (or that
   * were embedded by an older model). Async because the dense model itself
   * is async. Yields progress via callback so the CLI can show a counter.
   */
  async backfillDenseEmbeddings(opts: {
    limit?: number;
    onProgress?: (done: number, total: number) => void;
    forceModel?: string;
  } = {}): Promise<{ embedded: number; skipped: number; failed: number; model: string }> {
    const currentModel = embeddingsModule.currentDenseModel();
    const targetModel = opts.forceModel ?? currentModel;

    // Only re-embed chunks that lack an embedding for the current model. Soft-deleted
    // chunks are skipped; hard-deleted are gone naturally via the join.
    const candidates = this.conn.prepare(
      `SELECT c.id, c.content
       FROM chunks c
       LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
       WHERE sd.chunk_id IS NULL
         AND (c.embedding_dense IS NULL OR c.embedding_dense_model IS NULL OR c.embedding_dense_model != ?)
         AND length(c.content) >= 1
       ORDER BY c.updated_at DESC
       ${opts.limit ? 'LIMIT ?' : ''}`,
    ).all(...[targetModel, ...(opts.limit ? [opts.limit] : [])]) as Array<{ id: number; content: string }>;

    const total = candidates.length;
    let embedded = 0;
    let failed = 0;

    const updateStmt = this.conn.prepare(
      `UPDATE chunks SET embedding_dense = ?, embedding_dense_model = ? WHERE id = ?`,
    );

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const vec = await embeddingsModule.embedDense(c.content, false);
        if (vec) {
          updateStmt.run(embeddingsModule.serializeEmbedding(vec), targetModel, c.id);
          embedded++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
      if (opts.onProgress && (i + 1) % 25 === 0) {
        opts.onProgress(i + 1, total);
      }
    }
    if (opts.onProgress) opts.onProgress(total, total);

    return { embedded, skipped: 0, failed, model: targetModel };
  }

  // ── Cross-agent learning: promote insight to global ──────────────

  /**
   * Promote a memory chunk to global visibility (agent_slug = NULL).
   * Used by agents to deliberately share an insight across the agent ecosystem.
   * Does NOT copy the chunk — it promotes the existing chunk in-place.
   *
   * @param chunkId - ID of the chunk to promote
   * @param promotedBy - slug of the agent promoting it (for audit log)
   * @returns description of what was promoted, or error message
   */
  promoteToGlobal(chunkId: number, promotedBy?: string): string {
    try {
      const existing = this.conn.prepare(
        'SELECT id, source_file, section, content, agent_slug FROM chunks WHERE id = ?',
      ).get(chunkId) as { id: number; source_file: string; section: string; content: string; agent_slug: string | null } | undefined;

      if (!existing) return `Chunk ${chunkId} not found.`;
      if (existing.agent_slug === null) return `Chunk ${chunkId} is already global.`;

      this.conn.prepare(
        'UPDATE chunks SET agent_slug = NULL WHERE id = ?',
      ).run(chunkId);

      const preview = existing.content.slice(0, 80).replace(/\n/g, ' ');
      const msg = `Promoted chunk ${chunkId} (from ${existing.agent_slug ?? 'global'}) to global: "${preview}..."`;

      // Append to promoted-insights log for audit trail
      try {
        const logDir = path.join(path.dirname(this.dbPath), '..', 'logs');
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        appendFileSync(
          path.join(logDir, 'promoted-insights.jsonl'),
          JSON.stringify({ ts: new Date().toISOString(), chunkId, promotedBy, section: existing.section, preview }) + '\n',
        );
      } catch { /* non-fatal */ }

      return msg;
    } catch (err) {
      return `Failed to promote chunk: ${err}`;
    }
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
   * Save a conversation turn to the transcripts table. Routes through the
   * write queue when enabled so the request thread doesn't block on SQL.
   */
  saveTurn(
    sessionKey: string,
    role: string,
    content: string,
    model: string = '',
  ): void {
    if (this.writeQueue) {
      this.writeQueue.enqueue({ kind: 'transcript-turn', sessionKey, role, content, model });
      return;
    }
    this._saveTurnSync(sessionKey, role, content, model);
  }

  /** Internal sync transcript insert. Called directly by the WriteQueue. */
  _saveTurnSync(sessionKey: string, role: string, content: string, model: string): void {
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
   * Get user/assistant transcript turns from the tail of a session, skipping
   * the most recent `skipFromTail` turns. Returned chronologically. Used to
   * reconstruct context older than what's already in the in-memory cache,
   * for restart restore and SDK session-death recovery.
   */
  getTranscriptTail(sessionKey: string, skipFromTail: number, limit: number = 40): TranscriptTurn[] {
    const rows = this.conn
      .prepare(
        `SELECT session_key, role, content, model, created_at
         FROM transcripts
         WHERE session_key = ? AND role IN ('user','assistant')
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(sessionKey, limit, Math.max(0, skipFromTail)) as Array<{
      session_key: string;
      role: string;
      content: string;
      model: string;
      created_at: string;
    }>;

    return rows
      .map((row) => ({
        sessionKey: row.session_key,
        role: row.role,
        content: row.content,
        model: row.model,
        createdAt: row.created_at,
      }))
      .reverse();
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
   * Record that chunks were accessed (retrieved/displayed). Routes through
   * the write queue when enabled.
   */
  recordAccess(chunkIds: number[], accessType: string = 'retrieval'): void {
    if (chunkIds.length === 0) return;
    if (this.writeQueue) {
      this.writeQueue.enqueue({ kind: 'access', chunkIds: [...chunkIds], accessType });
      return;
    }
    this._recordAccessSync(chunkIds, accessType);
  }

  /** Internal sync access log insert. Called directly by the WriteQueue. */
  _recordAccessSync(chunkIds: number[], accessType: string): void {
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

  // ── Outcome-Driven Salience ────────────────────────────────────

  /**
   * Record whether retrieved chunks were actually referenced in the
   * assistant's response. Updates `last_outcome_score` as an exponential
   * moving average in [-1, 1]: chunks that keep getting cited drift toward
   * +1 (search boost), chunks that keep getting retrieved-and-ignored drift
   * toward -1 (search penalty).
   *
   * Ranking applies this as a bounded ±30% multiplier so it influences but
   * can't dominate salience + BM25 + vector score.
   */
  recordOutcome(
    outcomes: Array<{ chunkId: number; referenced: boolean }>,
    sessionKey?: string | null,
  ): void {
    if (outcomes.length === 0) return;
    if (this.writeQueue) {
      this.writeQueue.enqueue({
        kind: 'outcome',
        outcomes: outcomes.map((o) => ({ ...o })),
        sessionKey: sessionKey ?? null,
      });
      return;
    }
    this._recordOutcomeSync(outcomes, sessionKey);
  }

  /** Internal sync outcome insert + EMA update. Called by the WriteQueue. */
  _recordOutcomeSync(
    outcomes: Array<{ chunkId: number; referenced: boolean }>,
    sessionKey?: string | null,
  ): void {
    if (outcomes.length === 0) return;

    const alpha = 0.3; // EMA weight on the new observation

    const logStmt = this.conn.prepare(
      'INSERT INTO outcomes (chunk_id, session_key, referenced) VALUES (?, ?, ?)',
    );
    const readStmt = this.conn.prepare(
      'SELECT last_outcome_score FROM chunks WHERE id = ?',
    );
    const writeStmt = this.conn.prepare(
      'UPDATE chunks SET last_outcome_score = ? WHERE id = ?',
    );

    const tx = this.conn.transaction((rows: Array<{ chunkId: number; referenced: boolean }>) => {
      for (const o of rows) {
        try {
          logStmt.run(o.chunkId, sessionKey ?? null, o.referenced ? 1 : 0);
          const cur = readStmt.get(o.chunkId) as { last_outcome_score: number | null } | undefined;
          const prev = cur?.last_outcome_score ?? 0;
          const observation = o.referenced ? 1 : -1;
          let next = alpha * observation + (1 - alpha) * prev;
          if (next > 1) next = 1;
          if (next < -1) next = -1;
          writeStmt.run(next, o.chunkId);
        } catch {
          // Non-fatal; keep going
        }
      }
    });

    try {
      tx(outcomes);
    } catch {
      // Non-fatal
    }
  }

  // ── SDK Session Store Sidecar ───────────────────────────────────

  /**
   * Idempotent append for a batch of SDK session transcript entries.
   * Entries with a uuid are upserted on (session_id, subpath, uuid);
   * entries without a uuid always insert.
   */
  appendSessionEntries(
    sessionId: string,
    projectKey: string,
    subpath: string,
    entries: Array<{ type: string; uuid?: string; [k: string]: unknown }>,
  ): void {
    if (entries.length === 0) return;

    // Partial unique index on (session_id, subpath, uuid) WHERE uuid IS NOT NULL
    // can't be named in ON CONFLICT, so use OR IGNORE to let the index enforce
    // idempotency silently on duplicate uuid.
    const insertWithUuid = this.conn.prepare(
      `INSERT OR IGNORE INTO sdk_session_entries (session_id, project_key, subpath, uuid, type, entry_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertNoUuid = this.conn.prepare(
      `INSERT INTO sdk_session_entries (session_id, project_key, subpath, uuid, type, entry_json)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    );

    const tx = this.conn.transaction((rows: typeof entries) => {
      for (const e of rows) {
        const json = JSON.stringify(e);
        if (typeof e.uuid === 'string' && e.uuid.length > 0) {
          insertWithUuid.run(sessionId, projectKey, subpath, e.uuid, e.type, json);
        } else {
          insertNoUuid.run(sessionId, projectKey, subpath, e.type, json);
        }
      }
    });
    tx(entries);
  }

  /**
   * Load all entries for a session/subpath in insertion order.
   * Returns null if the key was never written, so the SDK can distinguish
   * "no-op resume" from "empty session".
   */
  loadSessionEntries(
    sessionId: string,
    subpath: string,
  ): Array<Record<string, unknown>> | null {
    const rows = this.conn
      .prepare(
        `SELECT entry_json FROM sdk_session_entries
         WHERE session_id = ? AND subpath = ?
         ORDER BY id ASC`,
      )
      .all(sessionId, subpath) as Array<{ entry_json: string }>;

    if (rows.length === 0) {
      // Distinguish never-written from emptied by checking if we've ever
      // seen this session_id at all (any subpath).
      const any = this.conn
        .prepare('SELECT 1 FROM sdk_session_entries WHERE session_id = ? LIMIT 1')
        .get(sessionId);
      if (!any) return null;
      return [];
    }

    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.entry_json));
      } catch { /* skip malformed — shouldn't happen */ }
    }
    return out;
  }

  /**
   * List sessions under a project, newest first. Uses the summary sidecar
   * when present; falls back to distinct session ids from the entries table.
   */
  listSdkSessions(projectKey: string): Array<{ sessionId: string; mtime: number }> {
    const rows = this.conn
      .prepare(
        `SELECT DISTINCT session_id,
                (strftime('%s', MAX(created_at)) * 1000) as mtime
         FROM sdk_session_entries
         WHERE project_key = ? AND subpath = ''
         GROUP BY session_id
         ORDER BY mtime DESC`,
      )
      .all(projectKey) as Array<{ session_id: string; mtime: number }>;
    return rows.map(r => ({ sessionId: r.session_id, mtime: r.mtime }));
  }

  /** Delete all entries (and summary) for a session across all subpaths. */
  deleteSdkSession(sessionId: string): void {
    const tx = this.conn.transaction(() => {
      this.conn.prepare('DELETE FROM sdk_session_entries WHERE session_id = ?').run(sessionId);
      this.conn.prepare('DELETE FROM sdk_session_summaries WHERE session_id = ?').run(sessionId);
    });
    tx();
  }

  /** List subpath keys recorded for a session — used to discover subagent transcripts. */
  listSdkSessionSubkeys(sessionId: string): string[] {
    const rows = this.conn
      .prepare(
        `SELECT DISTINCT subpath FROM sdk_session_entries
         WHERE session_id = ? AND subpath <> ''`,
      )
      .all(sessionId) as Array<{ subpath: string }>;
    return rows.map(r => r.subpath);
  }

  /** Upsert an SDK-provided session summary sidecar. Opaque data blob. */
  upsertSessionSummary(
    sessionId: string,
    subpath: string,
    projectKey: string,
    mtime: number,
    data: Record<string, unknown>,
  ): void {
    this.conn
      .prepare(
        `INSERT INTO sdk_session_summaries (session_id, subpath, project_key, mtime, data_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, subpath) DO UPDATE SET
           project_key = excluded.project_key,
           mtime = excluded.mtime,
           data_json = excluded.data_json`,
      )
      .run(sessionId, subpath, projectKey, mtime, JSON.stringify(data));
  }

  listSdkSessionSummaries(projectKey: string): Array<{
    sessionId: string;
    subpath: string;
    mtime: number;
    data: Record<string, unknown>;
  }> {
    const rows = this.conn
      .prepare(
        `SELECT session_id, subpath, mtime, data_json FROM sdk_session_summaries
         WHERE project_key = ? ORDER BY mtime DESC`,
      )
      .all(projectKey) as Array<{
      session_id: string; subpath: string; mtime: number; data_json: string;
    }>;
    return rows.map(r => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(r.data_json); } catch { /* keep empty */ }
      return { sessionId: r.session_id, subpath: r.subpath, mtime: r.mtime, data };
    });
  }

  // ── Artifact Memory ─────────────────────────────────────────────

  /**
   * Persist a tool output (or any blob the agent wants to remember) so
   * later turns can recall it without re-running the tool.
   */
  storeArtifact(input: {
    toolName: string;
    summary: string;
    content: string;
    tags?: string;
    sessionKey?: string | null;
    agentSlug?: string | null;
  }): number {
    const stmt = this.conn.prepare(
      `INSERT INTO tool_artifacts (session_key, agent_slug, tool_name, summary, content, tags)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      input.sessionKey ?? null,
      input.agentSlug ?? null,
      input.toolName,
      input.summary,
      input.content,
      input.tags ?? '',
    );
    return info.lastInsertRowid as number;
  }

  /**
   * Search artifacts via FTS over summary + content + tool_name + tags.
   * Returns metadata only — use getArtifact(id) to pull the full blob.
   */
  searchArtifacts(opts: {
    query?: string;
    limit?: number;
    sessionKey?: string | null;
    agentSlug?: string | null;
  } = {}): Array<{
    id: number;
    toolName: string;
    summary: string;
    tags: string;
    storedAt: string;
    sessionKey: string | null;
    agentSlug: string | null;
    accessCount: number;
  }> {
    const limit = opts.limit ?? 10;

    // Build rows via FTS if a query is given, otherwise fall back to
    // recency ordering on the base table.
    if (opts.query && opts.query.trim()) {
      const sanitized = MemoryStore.sanitizeFtsQuery(opts.query);
      if (sanitized) {
        let sql = `SELECT a.id, a.tool_name, a.summary, a.tags, a.stored_at,
                          a.session_key, a.agent_slug, a.access_count
                   FROM tool_artifacts_fts f
                   JOIN tool_artifacts a ON a.id = f.rowid
                   WHERE tool_artifacts_fts MATCH ?`;
        const params: any[] = [sanitized];
        if (opts.sessionKey) { sql += ' AND a.session_key = ?'; params.push(opts.sessionKey); }
        if (opts.agentSlug) { sql += ' AND a.agent_slug = ?'; params.push(opts.agentSlug); }
        sql += ' ORDER BY bm25(tool_artifacts_fts) LIMIT ?';
        params.push(limit);
        try {
          const rows = this.conn.prepare(sql).all(...params) as Array<{
            id: number; tool_name: string; summary: string; tags: string;
            stored_at: string; session_key: string | null; agent_slug: string | null;
            access_count: number;
          }>;
          return rows.map((r) => ({
            id: r.id, toolName: r.tool_name, summary: r.summary, tags: r.tags,
            storedAt: r.stored_at, sessionKey: r.session_key, agentSlug: r.agent_slug,
            accessCount: r.access_count,
          }));
        } catch {
          // Fall through to recency-only if FTS errors
        }
      }
    }

    let sql = `SELECT id, tool_name, summary, tags, stored_at,
                      session_key, agent_slug, access_count
               FROM tool_artifacts WHERE 1=1`;
    const params: any[] = [];
    if (opts.sessionKey) { sql += ' AND session_key = ?'; params.push(opts.sessionKey); }
    if (opts.agentSlug) { sql += ' AND agent_slug = ?'; params.push(opts.agentSlug); }
    // stored_at is second-precision; tiebreak on id DESC so same-second
    // inserts still come back in insertion order (newest first).
    sql += ' ORDER BY stored_at DESC, id DESC LIMIT ?';
    params.push(limit);
    const rows = this.conn.prepare(sql).all(...params) as Array<{
      id: number; tool_name: string; summary: string; tags: string;
      stored_at: string; session_key: string | null; agent_slug: string | null;
      access_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id, toolName: r.tool_name, summary: r.summary, tags: r.tags,
      storedAt: r.stored_at, sessionKey: r.session_key, agentSlug: r.agent_slug,
      accessCount: r.access_count,
    }));
  }

  /**
   * Fetch a single artifact with full content. Bumps access_count and
   * last_accessed_at so recency-based pruning can keep the useful ones.
   */
  getArtifact(id: number): {
    id: number;
    toolName: string;
    summary: string;
    content: string;
    tags: string;
    storedAt: string;
    sessionKey: string | null;
    agentSlug: string | null;
    accessCount: number;
  } | null {
    const row = this.conn
      .prepare(
        `SELECT id, session_key, agent_slug, tool_name, summary, content, tags,
                stored_at, access_count
         FROM tool_artifacts WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number; session_key: string | null; agent_slug: string | null;
          tool_name: string; summary: string; content: string; tags: string;
          stored_at: string; access_count: number;
        }
      | undefined;

    if (!row) return null;

    try {
      this.conn
        .prepare(
          `UPDATE tool_artifacts
           SET access_count = access_count + 1, last_accessed_at = datetime('now')
           WHERE id = ?`,
        )
        .run(id);
    } catch { /* non-fatal */ }

    return {
      id: row.id,
      toolName: row.tool_name,
      summary: row.summary,
      content: row.content,
      tags: row.tags,
      storedAt: row.stored_at,
      sessionKey: row.session_key,
      agentSlug: row.agent_slug,
      accessCount: row.access_count + 1,
    };
  }

  // ── Brain / Ingestion helpers ─────────────────────────────────────
  //
  // All of these operate on tables that EXTEND the existing memory
  // system: `chunks` gains four columns for external provenance, and
  // three new tables (sources, ingestion_runs, ingested_rows) reference
  // chunks via FK — they are an overlay, not a parallel store.

  /** Register or update a declarative source. */
  upsertSource(input: {
    slug: string;
    kind: string;
    adapter: string;
    configJson?: string;
    credentialRef?: string | null;
    scheduleCron?: string | null;
    targetFolder?: string | null;
    agentSlug?: string | null;
    project?: string | null;
    intelligence?: string;
    enabled?: boolean;
  }): void {
    this.conn
      .prepare(
        `INSERT INTO sources (slug, kind, adapter, config_json, credential_ref, schedule_cron,
                              target_folder, agent_slug, project, intelligence, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(slug) DO UPDATE SET
           kind=excluded.kind, adapter=excluded.adapter, config_json=excluded.config_json,
           credential_ref=excluded.credential_ref, schedule_cron=excluded.schedule_cron,
           target_folder=excluded.target_folder, agent_slug=excluded.agent_slug,
           project=excluded.project, intelligence=excluded.intelligence, enabled=excluded.enabled,
           updated_at=datetime('now')`,
      )
      .run(
        input.slug,
        input.kind,
        input.adapter,
        input.configJson ?? '{}',
        input.credentialRef ?? null,
        input.scheduleCron ?? null,
        input.targetFolder ?? null,
        input.agentSlug ?? null,
        input.project ?? null,
        input.intelligence ?? 'auto',
        input.enabled === false ? 0 : 1,
      );
  }

  getSource(slug: string): {
    slug: string; kind: string; adapter: string; configJson: string;
    credentialRef: string | null; scheduleCron: string | null;
    targetFolder: string | null; agentSlug: string | null;
    project: string | null;
    intelligence: string; enabled: boolean;
    lastRunAt: string | null; lastStatus: string | null;
    createdAt: string; updatedAt: string;
  } | null {
    const row = this.conn
      .prepare(
        `SELECT slug, kind, adapter, config_json, credential_ref, schedule_cron,
                target_folder, agent_slug, project, intelligence, enabled, last_run_at,
                last_status, created_at, updated_at
         FROM sources WHERE slug = ?`,
      )
      .get(slug) as any;
    if (!row) return null;
    return {
      slug: row.slug, kind: row.kind, adapter: row.adapter, configJson: row.config_json,
      credentialRef: row.credential_ref, scheduleCron: row.schedule_cron,
      targetFolder: row.target_folder, agentSlug: row.agent_slug,
      project: row.project ?? null,
      intelligence: row.intelligence, enabled: !!row.enabled,
      lastRunAt: row.last_run_at, lastStatus: row.last_status,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  listSources(filter: { enabled?: boolean; kind?: string } = {}): Array<ReturnType<MemoryStore['getSource']>> {
    let sql = `SELECT slug FROM sources WHERE 1=1`;
    const params: any[] = [];
    if (filter.enabled !== undefined) { sql += ' AND enabled = ?'; params.push(filter.enabled ? 1 : 0); }
    if (filter.kind) { sql += ' AND kind = ?'; params.push(filter.kind); }
    sql += ' ORDER BY slug';
    const slugs = (this.conn.prepare(sql).all(...params) as Array<{ slug: string }>).map((r) => r.slug);
    return slugs.map((s) => this.getSource(s));
  }

  deleteSource(slug: string): void {
    this.conn.prepare(`DELETE FROM sources WHERE slug = ?`).run(slug);
  }

  markSourceRun(slug: string, status: 'ok' | 'error' | 'partial'): void {
    this.conn
      .prepare(`UPDATE sources SET last_run_at = datetime('now'), last_status = ? WHERE slug = ?`)
      .run(status, slug);
  }

  /** Create an ingestion_runs row in 'running' state. Returns the new run id. */
  createIngestionRun(sourceSlug: string): number {
    const info = this.conn
      .prepare(`INSERT INTO ingestion_runs (source_slug) VALUES (?)`)
      .run(sourceSlug);
    return info.lastInsertRowid as number;
  }

  updateIngestionRun(id: number, patch: {
    recordsIn?: number;
    recordsWritten?: number;
    recordsSkipped?: number;
    recordsFailed?: number;
    overviewNotePath?: string | null;
    errorsJson?: string | null;
    status?: 'running' | 'ok' | 'error' | 'partial';
    finished?: boolean;
  }): void {
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.recordsIn !== undefined) { sets.push('records_in = ?'); params.push(patch.recordsIn); }
    if (patch.recordsWritten !== undefined) { sets.push('records_written = ?'); params.push(patch.recordsWritten); }
    if (patch.recordsSkipped !== undefined) { sets.push('records_skipped = ?'); params.push(patch.recordsSkipped); }
    if (patch.recordsFailed !== undefined) { sets.push('records_failed = ?'); params.push(patch.recordsFailed); }
    if (patch.overviewNotePath !== undefined) { sets.push('overview_note_path = ?'); params.push(patch.overviewNotePath); }
    if (patch.errorsJson !== undefined) { sets.push('errors_json = ?'); params.push(patch.errorsJson); }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.finished) { sets.push(`finished_at = datetime('now')`); }
    if (sets.length === 0) return;
    params.push(id);
    this.conn.prepare(`UPDATE ingestion_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  listIngestionRuns(sourceSlug?: string, limit = 50): Array<{
    id: number; sourceSlug: string; startedAt: string; finishedAt: string | null;
    recordsIn: number; recordsWritten: number; recordsSkipped: number; recordsFailed: number;
    overviewNotePath: string | null; errorsJson: string | null; status: string;
  }> {
    let sql = `SELECT id, source_slug, started_at, finished_at, records_in, records_written,
                      records_skipped, records_failed, overview_note_path, errors_json, status
               FROM ingestion_runs`;
    const params: any[] = [];
    if (sourceSlug) { sql += ` WHERE source_slug = ?`; params.push(sourceSlug); }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.conn.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id, sourceSlug: r.source_slug, startedAt: r.started_at, finishedAt: r.finished_at,
      recordsIn: r.records_in, recordsWritten: r.records_written,
      recordsSkipped: r.records_skipped, recordsFailed: r.records_failed,
      overviewNotePath: r.overview_note_path, errorsJson: r.errors_json, status: r.status,
    }));
  }

  /** Find a chunk previously written for (sourceSlug, externalId) so the pipeline can upsert. */
  findChunkByExternalId(sourceSlug: string, externalId: string): {
    id: number; sourceFile: string; contentHash: string;
  } | null {
    const row = this.conn
      .prepare(
        `SELECT id, source_file, content_hash FROM chunks
         WHERE source_slug = ? AND external_id = ? LIMIT 1`,
      )
      .get(sourceSlug, externalId) as any;
    if (!row) return null;
    return { id: row.id, sourceFile: row.source_file, contentHash: row.content_hash };
  }

  /** Tag all chunks from a vault file with ingestion provenance (called after updateFile). */
  tagChunksForSource(relPath: string, meta: {
    sourceSlug: string; externalId: string; sourceType: string; lastSyncedAt?: string;
  }): void {
    this.conn
      .prepare(
        `UPDATE chunks
         SET source_slug = ?, external_id = ?, source_type = ?, last_synced_at = COALESCE(?, datetime('now'))
         WHERE source_file = ?`,
      )
      .run(meta.sourceSlug, meta.externalId, meta.sourceType, meta.lastSyncedAt ?? null, relPath);
  }

  /** Insert (or replace) a structured row overlay for SQL aggregate queries. */
  insertIngestedRow(input: {
    sourceSlug: string;
    externalId: string;
    chunkId?: number | null;
    artifactId?: number | null;
    rowJson: string;
    structuredColumns?: Record<string, string | number | null>;
  }): number {
    const info = this.conn
      .prepare(
        `INSERT INTO ingested_rows (source_slug, external_id, chunk_id, artifact_id, row_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_slug, external_id) DO UPDATE SET
           chunk_id = excluded.chunk_id, artifact_id = excluded.artifact_id,
           row_json = excluded.row_json, ingested_at = datetime('now')`,
      )
      .run(
        input.sourceSlug,
        input.externalId,
        input.chunkId ?? null,
        input.artifactId ?? null,
        input.rowJson,
      );
    const id = (info.lastInsertRowid as number) || this.conn
      .prepare(`SELECT id FROM ingested_rows WHERE source_slug = ? AND external_id = ?`)
      .get(input.sourceSlug, input.externalId) as any;
    const rowId = typeof id === 'number' ? id : id.id;
    // Apply per-source dynamic columns (populated after schema-infer ALTER TABLEs)
    if (input.structuredColumns) {
      for (const [col, val] of Object.entries(input.structuredColumns)) {
        if (!/^[a-z][a-z0-9_]*$/i.test(col)) continue;
        try {
          this.conn.prepare(`UPDATE ingested_rows SET ${col} = ? WHERE id = ?`).run(val, rowId);
        } catch { /* column doesn't exist yet — schema-infer hasn't added it */ }
      }
    }
    return rowId;
  }

  /** Declare a per-source structured column (idempotent). Called once during schema-infer. */
  ensureIngestedRowColumn(column: string, sqlType: 'TEXT' | 'REAL' | 'INTEGER'): void {
    if (!/^[a-z][a-z0-9_]*$/i.test(column)) return;
    try {
      this.conn.exec(`ALTER TABLE ingested_rows ADD COLUMN ${column} ${sqlType}`);
    } catch { /* already exists */ }
  }

  /**
   * Read-only SQL query over ingested_rows. Intended for agent-facing
   * brain_query tool; caller must pass a SELECT statement (no writes).
   * A defensive LIMIT is appended if none present.
   */
  queryIngestedRows(sql: string, params: unknown[] = [], hardLimit = 500): unknown[] {
    const trimmed = sql.trim();
    if (!/^select\b/i.test(trimmed)) {
      throw new Error('queryIngestedRows only accepts SELECT statements');
    }
    const hasLimit = /\blimit\b/i.test(trimmed);
    const final = hasLimit ? trimmed : `${trimmed} LIMIT ${hardLimit}`;
    return this.conn.prepare(final).all(...params);
  }

  /** Columns present on ingested_rows (for schema discovery by agents). */
  ingestedRowColumns(): string[] {
    const rows = this.conn
      .prepare(`PRAGMA table_info(ingested_rows)`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
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
    behavioralRetentionDays?: number;
    recallTraceRetentionDays?: number;
  } = {}): {
    episodicPruned: number;
    accessLogPruned: number;
    transcriptsPruned: number;
    skillUsagePruned: number;
    feedbackPruned: number;
    reflectionsPruned: number;
    usageLogPruned: number;
    recallTracesPruned: number;
  } {
    const maxAge = opts.maxAgeDays ?? 90;
    const threshold = opts.salienceThreshold ?? 0.01;
    const accessRetention = opts.accessLogRetentionDays ?? 60;
    const transcriptRetention = opts.transcriptRetentionDays ?? 90;
    // Behavioral telemetry kept longer than transcripts so the feedback loop
    // (getFeedbackStats, getBehavioralPatterns, getSkillsToSuppress) has a
    // wide enough window to aggregate meaningful signal.
    const behavioralRetention = opts.behavioralRetentionDays ?? 180;
    // Recall traces are written ~once per agent retrieval — high write volume.
    // 90-day window is enough to debug "why did the agent answer that way last
    // week" without letting the table grow unbounded.
    const recallRetention = opts.recallTraceRetentionDays ?? 90;

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

    // Clean orphaned access_log entries (chunk was deleted but access_log wasn't)
    this.conn.exec(
      'DELETE FROM access_log WHERE chunk_id NOT IN (SELECT id FROM chunks)',
    );

    // Trim old transcripts (keep session_summaries which are more compact)
    const transcriptResult = this.conn
      .prepare(
        `DELETE FROM transcripts
         WHERE created_at < datetime('now', ?)`,
      )
      .run(`-${transcriptRetention} days`);

    // Behavioral telemetry pruning — these tables were previously unbounded.
    // Each is append-only, so a rolling window is safe; aggregate stats
    // consume the window directly rather than historical totals.
    const skillUsageResult = this.conn
      .prepare(`DELETE FROM skill_usage WHERE retrieved_at < datetime('now', ?)`)
      .run(`-${behavioralRetention} days`);
    const feedbackResult = this.conn
      .prepare(`DELETE FROM feedback WHERE created_at < datetime('now', ?)`)
      .run(`-${behavioralRetention} days`);
    const reflectionsResult = this.conn
      .prepare(`DELETE FROM session_reflections WHERE created_at < datetime('now', ?)`)
      .run(`-${behavioralRetention} days`);
    // Usage log is denser (per-exchange) — keep a shorter window.
    const usageResult = this.conn
      .prepare(`DELETE FROM usage_log WHERE created_at < datetime('now', ?)`)
      .run(`-${Math.min(behavioralRetention, 90)} days`);

    // Recall traces — bounded by retrieval frequency, can grow fast.
    let recallTracesPruned = 0;
    try {
      const recallResult = this.conn
        .prepare(`DELETE FROM recall_traces WHERE retrieved_at < datetime('now', ?)`)
        .run(`-${recallRetention} days`);
      recallTracesPruned = recallResult.changes;
    } catch {
      // Table may not exist on first boot before initialize() runs the new schema
    }

    return {
      episodicPruned: episodicResult.changes,
      accessLogPruned: accessResult.changes,
      transcriptsPruned: transcriptResult.changes,
      skillUsagePruned: skillUsageResult.changes,
      feedbackPruned: feedbackResult.changes,
      reflectionsPruned: reflectionsResult.changes,
      usageLogPruned: usageResult.changes,
      recallTracesPruned,
    };
  }

  // ── Staleness detection ─────────────────────────────────────────

  /**
   * User-model slots whose `updated_at` is older than maxAgeDays. These are
   * candidates for the "verify or refresh" nudge — high-relevance memories
   * that may have become silently wrong (Mem0 2026 calls this out as an
   * open problem; we surface it via observability rather than auto-decay).
   *
   * Empty content is skipped (an empty slot has no claim to verify).
   */
  findStaleUserModelSlots(opts: { maxAgeDays?: number; agentSlug?: string | null } = {}): Array<{
    slot: string;
    ageDays: number;
    agentSlug: string | null;
  }> {
    const maxAge = opts.maxAgeDays ?? 90;
    const rows = this.conn
      .prepare(
        `SELECT slot, agent_slug,
                CAST(strftime('%s', 'now') - strftime('%s', updated_at) AS INTEGER) AS age_seconds
         FROM user_model_blocks
         WHERE length(content) > 0
           AND updated_at < datetime('now', ?)
           AND COALESCE(agent_slug, '') = COALESCE(?, '')`,
      )
      .all(`-${maxAge} days`, opts.agentSlug ?? null) as Array<{
      slot: string;
      agent_slug: string | null;
      age_seconds: number;
    }>;
    return rows.map((r) => ({
      slot: r.slot,
      agentSlug: r.agent_slug,
      ageDays: Math.round(r.age_seconds / 86400),
    }));
  }

  /**
   * High-salience chunks whose outcome EMA has drifted negative — i.e., we
   * keep ranking them high but the agent stopped citing them. Strong signal
   * that the chunk is stale or wrong even though salience hasn't decayed.
   *
   * Conservative threshold: salience > 0.8 AND last_outcome_score < 0.
   * Soft-deleted excluded.
   */
  findStaleHighSalienceChunks(opts: {
    salienceFloor?: number;
    outcomeCeiling?: number;
    limit?: number;
  } = {}): Array<{
    chunkId: number;
    sourceFile: string;
    section: string;
    salience: number;
    lastOutcomeScore: number;
  }> {
    const salienceFloor = opts.salienceFloor ?? 0.8;
    const outcomeCeiling = opts.outcomeCeiling ?? 0;
    const limit = opts.limit ?? 25;
    const rows = this.conn
      .prepare(
        `SELECT c.id, c.source_file, c.section, c.salience, c.last_outcome_score
         FROM chunks c
         LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE sd.chunk_id IS NULL
           AND c.salience > ?
           AND COALESCE(c.last_outcome_score, 0) < ?
         ORDER BY c.salience DESC
         LIMIT ?`,
      )
      .all(salienceFloor, outcomeCeiling, limit) as Array<{
      id: number;
      source_file: string;
      section: string;
      salience: number;
      last_outcome_score: number | null;
    }>;
    return rows.map((r) => ({
      chunkId: r.id,
      sourceFile: r.source_file,
      section: r.section,
      salience: r.salience,
      lastOutcomeScore: r.last_outcome_score ?? 0,
    }));
  }

  /**
   * Format staleness findings into ready-to-inject prompt text. Heartbeat
   * builders can drop this into the system prompt verbatim. Returns null
   * if there's nothing to nudge about — caller should not inject empty text.
   */
  getStalenessNudges(opts: { agentSlug?: string | null; maxSlotAgeDays?: number } = {}): string | null {
    const stale = this.findStaleUserModelSlots({
      maxAgeDays: opts.maxSlotAgeDays,
      agentSlug: opts.agentSlug,
    });
    if (stale.length === 0) return null;
    const lines = stale.map((s) => `- \`${s.slot}\` is ${s.ageDays}d old`);
    return [
      'User-model maintenance:',
      ...lines,
      'Verify or refresh these during the next natural turn — do not force a check-in.',
    ].join('\n');
  }

  // ── Procedural memory ───────────────────────────────────────────

  /**
   * Find procedure chunks whose frontmatter `triggers` overlap with words
   * in the query. Used to surface learned workflows ("how Nate ships a
   * release", "how to handle inbound replies") above generic facts when
   * the user's intent matches.
   *
   * Match rule: case-insensitive substring of any trigger phrase appears
   * in the query. Empty result if no procedure chunks exist or no triggers
   * match — caller should treat this as additive context, not the whole
   * answer.
   */
  findRelevantProcedures(
    query: string,
    opts: { limit?: number; agentSlug?: string | null } = {},
  ): Array<{
    id: number;
    sourceFile: string;
    section: string;
    content: string;
    triggers: string[];
    matched: string[];
  }> {
    const limit = opts.limit ?? 5;
    const q = query.toLowerCase();
    // Exclude the frontmatter chunk — chunker emits one per file (a key:val
    // dump) which inherits category=procedure from the parent. Only the body
    // chunks contain the actual procedure content the agent wants to recall.
    const rows = this.conn
      .prepare(
        `SELECT c.id, c.source_file, c.section, c.content, c.frontmatter_json
         FROM chunks c
         LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE c.category = 'procedure'
           AND c.chunk_type != 'frontmatter'
           AND sd.chunk_id IS NULL
           AND (c.agent_slug IS NULL OR c.agent_slug = COALESCE(?, c.agent_slug))`,
      )
      .all(opts.agentSlug ?? null) as Array<{
      id: number;
      source_file: string;
      section: string;
      content: string;
      frontmatter_json: string;
    }>;

    const matches: Array<{
      id: number;
      sourceFile: string;
      section: string;
      content: string;
      triggers: string[];
      matched: string[];
    }> = [];
    for (const row of rows) {
      let triggers: string[] = [];
      try {
        const fm = row.frontmatter_json ? JSON.parse(row.frontmatter_json) : {};
        if (Array.isArray(fm.triggers)) {
          triggers = fm.triggers.map((t: unknown) => String(t).toLowerCase()).filter(Boolean);
        }
      } catch { /* malformed frontmatter — skip */ }
      if (triggers.length === 0) continue;
      const matched = triggers.filter((t) => q.includes(t));
      if (matched.length === 0) continue;
      matches.push({
        id: row.id,
        sourceFile: row.source_file,
        section: row.section,
        content: row.content,
        triggers,
        matched,
      });
    }
    // Most-matched first, then most-specific (longest matched trigger).
    matches.sort((a, b) => {
      if (b.matched.length !== a.matched.length) return b.matched.length - a.matched.length;
      const aMax = Math.max(...a.matched.map((m) => m.length));
      const bMax = Math.max(...b.matched.map((m) => m.length));
      return bMax - aMax;
    });
    return matches.slice(0, limit);
  }

  // ── Janitor: bounded growth ─────────────────────────────────────

  /** Persistent key/value for janitor state (last vacuum, etc.). */
  getMaintenanceMeta(key: string): string | null {
    const row = this.conn
      .prepare('SELECT value FROM maintenance_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMaintenanceMeta(key: string, value: string): void {
    this.conn
      .prepare(
        `INSERT INTO maintenance_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, value);
  }

  /**
   * Two-phase delete for consolidated, low-salience, unused chunks.
   *
   * Phase 1: soft-delete chunks where consolidated=1, not pinned, salience
   *          below floor, and never accessed (or last access older than
   *          expireDays).
   * Phase 2: physically delete chunks that have been in chunk_soft_deletes
   *          for graceDays. Cascades to access_log, outcomes, chunk_history
   *          for the same chunk_id.
   *
   * Summary chunks whose `derived_from` references the deleted IDs are
   * intentionally NOT propagate-deleted — the summary still encodes signal.
   */
  expireConsolidated(opts: {
    expireDays?: number;
    salienceFloor?: number;
    graceDays?: number;
  } = {}): { softDeleted: number; physicallyDeleted: number } {
    const expireDays = opts.expireDays ?? 60;
    const salienceFloor = opts.salienceFloor ?? 0.2;
    const graceDays = opts.graceDays ?? 14;

    // Phase 1 — soft-delete candidates.
    const candidates = this.conn
      .prepare(
        `SELECT c.id
         FROM chunks c
         LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         LEFT JOIN (
           SELECT chunk_id, MAX(accessed_at) as last_access
           FROM access_log GROUP BY chunk_id
         ) a ON a.chunk_id = c.id
         WHERE c.consolidated = 1
           AND COALESCE(c.pinned, 0) = 0
           AND COALESCE(c.salience, 0) < ?
           AND sd.chunk_id IS NULL
           AND (a.last_access IS NULL OR a.last_access < datetime('now', ?))
           AND c.created_at < datetime('now', ?)`,
      )
      .all(
        salienceFloor,
        `-${expireDays} days`,
        `-${expireDays} days`,
      ) as Array<{ id: number }>;

    let softDeleted = 0;
    for (const row of candidates) {
      if (this.softDeleteChunk(row.id, 'janitor')) softDeleted++;
    }

    // Phase 2 — physical delete after grace period.
    const stale = this.conn
      .prepare(
        `SELECT chunk_id FROM chunk_soft_deletes
         WHERE deleted_at < datetime('now', ?)`,
      )
      .all(`-${graceDays} days`) as Array<{ chunk_id: number }>;

    let physicallyDeleted = 0;
    if (stale.length > 0) {
      // softDeleteChunk removed these rows from chunks_fts. The chunks_ad
      // trigger fires on DELETE FROM chunks and tries to remove them again —
      // FTS5 contentless tables corrupt ("database disk image is malformed")
      // when you delete a docid that's already gone. Re-add the row to FTS
      // first so the trigger can do a clean delete.
      const fetchRow = this.conn.prepare(
        `SELECT id, source_file, section, content FROM chunks WHERE id = ?`,
      );
      const reAddFts = this.conn.prepare(
        `INSERT INTO chunks_fts (rowid, source_file, section, content) VALUES (?, ?, ?, ?)`,
      );
      const delChunk = this.conn.prepare('DELETE FROM chunks WHERE id = ?');
      const delSoft = this.conn.prepare('DELETE FROM chunk_soft_deletes WHERE chunk_id = ?');
      const delAccess = this.conn.prepare('DELETE FROM access_log WHERE chunk_id = ?');
      const delOutcomes = this.conn.prepare('DELETE FROM outcomes WHERE chunk_id = ?');
      const delHistory = this.conn.prepare('DELETE FROM chunk_history WHERE chunk_id = ?');
      const tx = this.conn.transaction((rows: Array<{ chunk_id: number }>) => {
        for (const r of rows) {
          delAccess.run(r.chunk_id);
          delOutcomes.run(r.chunk_id);
          delHistory.run(r.chunk_id);
          delSoft.run(r.chunk_id);
          const chunkRow = fetchRow.get(r.chunk_id) as
            | { id: number; source_file: string; section: string; content: string }
            | undefined;
          if (chunkRow) {
            try {
              reAddFts.run(chunkRow.id, chunkRow.source_file, chunkRow.section, chunkRow.content);
            } catch {
              // Already in FTS (chunk was never soft-removed from FTS) — fine.
            }
            const result = delChunk.run(r.chunk_id);
            if (result.changes > 0) physicallyDeleted++;
          }
        }
      });
      tx(stale);
      // Invalidate cache for all physically-deleted ids.
      for (const r of stale) this.chunkRowCache.delete(r.chunk_id);
    }

    return { softDeleted, physicallyDeleted };
  }

  /** Trim outcomes table to a rolling window. Append-only, can grow fast. */
  pruneOutcomes(retentionDays: number = 30): number {
    const result = this.conn
      .prepare(`DELETE FROM outcomes WHERE created_at < datetime('now', ?)`)
      .run(`-${retentionDays} days`);
    return result.changes;
  }

  /**
   * Cap memory_extractions to maxRows. Deletes oldest non-active rows first;
   * 'active' extractions are preserved regardless of count to protect the
   * audit trail for in-flight work.
   */
  capExtractions(maxRows: number = 50000): number {
    let count: number;
    try {
      count = (this.conn.prepare('SELECT COUNT(*) as c FROM memory_extractions').get() as { c: number }).c;
    } catch {
      return 0; // table missing on first boot
    }
    if (count <= maxRows) return 0;
    const overflow = count - maxRows;
    const result = this.conn
      .prepare(
        `DELETE FROM memory_extractions
         WHERE id IN (
           SELECT id FROM memory_extractions
           WHERE status != 'active'
           ORDER BY extracted_at ASC
           LIMIT ?
         )`,
      )
      .run(overflow);
    return result.changes;
  }

  /** Approximate SQLite database file size on disk, in bytes. */
  dbSizeBytes(): number {
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * VACUUM the database. Reclaims space from deleted rows. Holds an
   * exclusive lock for the duration — caller is expected to gate on
   * idleness (see lastActivityAt).
   */
  vacuum(): { sizeBeforeBytes: number; sizeAfterBytes: number; durationMs: number } {
    const sizeBeforeBytes = this.dbSizeBytes();
    const start = Date.now();
    this.conn.exec('VACUUM');
    return {
      sizeBeforeBytes,
      sizeAfterBytes: this.dbSizeBytes(),
      durationMs: Date.now() - start,
    };
  }

  /**
   * Most recent timestamp across the high-write activity tables, as a Unix
   * milliseconds value. Returns null if all tables are empty. Used by the
   * janitor's idle gate.
   *
   * Implementation note: SQLite's datetime() returns "YYYY-MM-DD HH:MM:SS"
   * in UTC with no timezone marker — JS Date.parse interprets that as local
   * time and skews by the offset. We compute the unix epoch in SQL to avoid
   * the bug entirely.
   */
  lastActivityAt(): number | null {
    try {
      const row = this.conn
        .prepare(
          `SELECT MAX(unix_t) as last FROM (
             SELECT CAST(strftime('%s', retrieved_at) AS INTEGER) as unix_t FROM recall_traces
             UNION ALL
             SELECT CAST(strftime('%s', accessed_at) AS INTEGER) as unix_t FROM access_log
             UNION ALL
             SELECT CAST(strftime('%s', created_at) AS INTEGER) as unix_t FROM transcripts
           )`,
        )
        .get() as { last: number | null };
      return row.last !== null && row.last !== undefined ? row.last * 1000 : null;
    } catch {
      return null;
    }
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
          content_hash, sector, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sourceFile, 'session-summary', summaryText, 'episodic', '', hash, 'episodic', 'events');
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

  /**
   * Mark a chunk as superseded by a newer one. The old chunk becomes
   * invisible to retrieval but stays in the DB for provenance. Idempotent:
   * supersede(A, B) followed by supersede(A, C) records C as the new
   * pointer. Won't link a chunk to itself or to a missing chunk.
   */
  markChunkSuperseded(oldChunkId: number, newChunkId: number, opts: { reason?: string; agent?: string } = {}): boolean {
    if (!Number.isFinite(oldChunkId) || !Number.isFinite(newChunkId)) return false;
    if (oldChunkId === newChunkId) return false;
    const exists = this.conn.prepare('SELECT 1 FROM chunks WHERE id IN (?, ?)').all(oldChunkId, newChunkId) as Array<unknown>;
    if (exists.length < 2) return false;
    this.conn
      .prepare(
        `INSERT INTO chunk_supersedes (old_chunk_id, new_chunk_id, reason, superseded_at, superseded_by_agent)
         VALUES (?, ?, ?, datetime('now'), ?)
         ON CONFLICT(old_chunk_id) DO UPDATE SET
           new_chunk_id = excluded.new_chunk_id,
           reason = excluded.reason,
           superseded_at = excluded.superseded_at,
           superseded_by_agent = excluded.superseded_by_agent`,
      )
      .run(oldChunkId, newChunkId, opts.reason ?? null, opts.agent ?? null);
    // Piggyback on chunk_soft_deletes so every existing search path (FTS,
    // dense, sparse, recency) excludes the old chunk without needing edits.
    // The supersede table retains provenance; soft-delete just hides it.
    this.conn
      .prepare(
        `INSERT OR IGNORE INTO chunk_soft_deletes (chunk_id, deleted_at, deleted_by)
         VALUES (?, datetime('now'), ?)`,
      )
      .run(oldChunkId, opts.agent ? `superseded:${opts.agent}` : 'superseded');
    return true;
  }

  /**
   * Daily salience-decay sweep. Multiplies salience by `decayFactor` (default
   * 0.95) on chunks that haven't been accessed or written-to in `staleDays`.
   * Pinned chunks are exempt — pinning is the user's explicit "keep this hot."
   * Soft-deleted and superseded chunks are also skipped (they're already out
   * of circulation). Returns count of rows updated.
   */
  decayStaleSalience(opts: { staleDays?: number; decayFactor?: number; floor?: number } = {}): number {
    const staleDays = opts.staleDays ?? 30;
    const decay = Math.max(0, Math.min(1, opts.decayFactor ?? 0.95));
    const floor = Math.max(0, opts.floor ?? 0);
    const result = this.conn
      .prepare(
        `UPDATE chunks
         SET salience = MAX(?, salience * ?)
         WHERE pinned = 0
           AND salience > ?
           AND (
             SELECT MAX(accessed_at) FROM access_log WHERE chunk_id = chunks.id
           ) < datetime('now', ?)
           AND id NOT IN (SELECT chunk_id FROM chunk_soft_deletes)
           AND id NOT IN (SELECT old_chunk_id FROM chunk_supersedes)`,
      )
      .run(floor, decay, floor, `-${staleDays} days`);
    return Number(result.changes ?? 0);
  }

  /**
   * Composition / graph stats — wikilink density + per-match-type recall
   * contribution over a recent window. Surfaces whether entity linking is
   * paying off in retrieval.
   */
  getGraphStats(opts: { topN?: number; lookbackHours?: number } = {}): {
    wikilinkCount: number;
    topLinkedTargets: Array<{ target: string; count: number }>;
    recallContributionByType: Record<string, number>;
    tracesAnalyzed: number;
  } {
    const topN = opts.topN ?? 12;
    const lookbackHours = opts.lookbackHours ?? 24 * 7;

    const wikilinkCount = (this.conn
      .prepare('SELECT COUNT(*) as c FROM wikilinks')
      .get() as { c: number } | undefined)?.c ?? 0;

    const topLinkedTargets = this.conn
      .prepare(
        `SELECT target_file as target, COUNT(*) as count
         FROM wikilinks GROUP BY target_file
         ORDER BY count DESC LIMIT ?`,
      )
      .all(topN) as Array<{ target: string; count: number }>;

    const traceRows = this.conn
      .prepare(
        `SELECT match_types FROM recall_traces
         WHERE retrieved_at > datetime('now', ?)
           AND match_types IS NOT NULL`,
      )
      .all(`-${lookbackHours} hours`) as Array<{ match_types: string }>;

    const counts: Record<string, number> = {};
    for (const row of traceRows) {
      try {
        const arr = JSON.parse(row.match_types) as string[];
        for (const t of arr) counts[t] = (counts[t] ?? 0) + 1;
      } catch { /* skip */ }
    }
    return { wikilinkCount, topLinkedTargets, recallContributionByType: counts, tracesAnalyzed: traceRows.length };
  }

  /**
   * Cross-channel session bridge — the most recent N session summaries per
   * channel (Discord / dashboard / cron / etc). Channel inferred from the
   * sessionKey prefix (everything before first ':'). Powers the dashboard
   * "Cross-channel handoff" panel so we can see whether continuity is
   * actually flowing between sources.
   */
  getRecentSummariesByChannel(limitPerChannel: number = 3): Record<string, SessionSummary[]> {
    const rows = this.conn
      .prepare(
        `SELECT session_key, summary, exchange_count, created_at
         FROM session_summaries ORDER BY created_at DESC LIMIT 200`,
      )
      .all() as Array<{ session_key: string; summary: string; exchange_count: number; created_at: string }>;

    const grouped: Record<string, SessionSummary[]> = {};
    for (const row of rows) {
      const colonIdx = row.session_key.indexOf(':');
      const channel = colonIdx > 0 ? row.session_key.slice(0, colonIdx) : 'other';
      if (!grouped[channel]) grouped[channel] = [];
      if (grouped[channel].length >= limitPerChannel) continue;
      grouped[channel].push({
        sessionKey: row.session_key,
        summary: row.summary,
        exchangeCount: row.exchange_count,
        createdAt: row.created_at,
      });
    }
    return grouped;
  }

  /**
   * Stats for the supersede graph — count of superseded chunks (excluded
   * from retrieval) for the dashboard.
   */
  getSupersedeStats(): { superseded: number; recent: Array<{ oldId: number; newId: number; reason: string | null; supersededAt: string }> } {
    const total = (this.conn
      .prepare('SELECT COUNT(*) as c FROM chunk_supersedes')
      .get() as { c: number } | undefined)?.c ?? 0;
    const recent = this.conn
      .prepare(
        `SELECT old_chunk_id as oldId, new_chunk_id as newId, reason, superseded_at as supersededAt
         FROM chunk_supersedes
         ORDER BY superseded_at DESC
         LIMIT 20`,
      )
      .all() as Array<{ oldId: number; newId: number; reason: string | null; supersededAt: string }>;
    return { superseded: total, recent };
  }

  /**
   * Apply an agent-supplied salience hint to chunks freshly written by
   * memory_write. Called after incrementalSync so the new chunks exist.
   * Sets salience to MAX(existing, hint) — a higher hint wins, but we
   * never trample reinforcement that already accumulated. Allowed range
   * 0.5–2.0; values >1.0 are reserved for explicit "this is critical"
   * signals from the agent (e.g. user identity, hard preferences,
   * irreversible decisions).
   */
  applyWriteSalience(sourceFile: string, section: string | null, hint: number): number {
    if (!Number.isFinite(hint)) return 0;
    const clamped = Math.max(0.5, Math.min(2.0, hint));
    const sql = section
      ? `UPDATE chunks SET salience = MAX(salience, ?), updated_at = datetime('now')
         WHERE source_file = ? AND section = ?`
      : `UPDATE chunks SET salience = MAX(salience, ?), updated_at = datetime('now')
         WHERE source_file = ?`;
    const params = section ? [clamped, sourceFile, section] : [clamped, sourceFile];
    const result = this.conn.prepare(sql).run(...params);
    return Number(result.changes ?? 0);
  }

  /**
   * Apply an agent-supplied confidence value to chunks freshly written by
   * memory_write. Confidence (0.0–1.0) is orthogonal to salience: salience
   * = "how important if true," confidence = "how certain it's still true."
   * Defaults to 1.0 on insert; agents lower it for tentative facts. Used as
   * a multiplier in retrieval scoring so uncertain chunks lose ranking.
   */
  applyWriteConfidence(sourceFile: string, section: string | null, confidence: number): number {
    if (!Number.isFinite(confidence)) return 0;
    const clamped = Math.max(0, Math.min(1, confidence));
    const sql = section
      ? `UPDATE chunks SET confidence = ?, updated_at = datetime('now')
         WHERE source_file = ? AND section = ?`
      : `UPDATE chunks SET confidence = ?, updated_at = datetime('now')
         WHERE source_file = ?`;
    const params = section ? [clamped, sourceFile, section] : [clamped, sourceFile];
    const result = this.conn.prepare(sql).run(...params);
    return Number(result.changes ?? 0);
  }

  /**
   * Recent writes panel — surfaces what the agent has been capturing and why.
   * Joins memory_extractions to chunks (best-effort match by source_file +
   * section if the tool_input carries those). Limit defaults to 50 since this
   * powers a dashboard panel, not analytics.
   */
  getRecentWrites(limit: number = 50): Array<{
    id: number;
    extractedAt: string;
    sessionKey: string;
    agentSlug: string | null;
    toolName: string;
    action: string | null;
    section: string | null;
    filePath: string | null;
    reason: string | null;
    salienceHint: number | null;
    status: string;
    userMessage: string;
  }> {
    const rows = this.conn
      .prepare(
        `SELECT id, session_key, user_message, tool_name, tool_input,
                extracted_at, status, agent_slug
         FROM memory_extractions
         WHERE tool_name LIKE 'memory_%' OR tool_name = 'note_create'
         ORDER BY extracted_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
        id: number;
        session_key: string;
        user_message: string;
        tool_name: string;
        tool_input: string;
        extracted_at: string;
        status: string;
        agent_slug: string | null;
      }>;

    return rows.map((r) => {
      let action: string | null = null;
      let section: string | null = null;
      let filePath: string | null = null;
      let reason: string | null = null;
      let salienceHint: number | null = null;
      try {
        const parsed = JSON.parse(r.tool_input ?? '{}') as Record<string, unknown>;
        if (typeof parsed.action === 'string') action = parsed.action;
        if (typeof parsed.section === 'string') section = parsed.section;
        if (typeof parsed.file_path === 'string') filePath = parsed.file_path;
        if (typeof parsed.reason === 'string') reason = parsed.reason;
        const sh = parsed.salience_hint;
        if (typeof sh === 'number' && Number.isFinite(sh)) salienceHint = sh;
      } catch { /* tool_input wasn't JSON — fall back to nulls */ }
      return {
        id: r.id,
        extractedAt: r.extracted_at,
        sessionKey: r.session_key,
        agentSlug: r.agent_slug,
        toolName: r.tool_name,
        action,
        section,
        filePath,
        reason,
        salienceHint,
        status: r.status,
        userMessage: r.user_message,
      };
    });
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
   * Skills to suppress from retrieval: those that coincide with negative feedback
   * in ≥3 sessions and whose negative rate exceeds 50% of rated sessions.
   * Attribution is by session_key join; a feedback entry is credited to every
   * skill retrieved in that session. Window: last 60 days.
   */
  getSkillsToSuppress(agentSlug?: string): Set<string> {
    const suppressed = new Set<string>();
    try {
      const sql = `
        SELECT su.skill_name,
               SUM(CASE WHEN f.rating = 'negative' THEN 1 ELSE 0 END) AS negative,
               SUM(CASE WHEN f.rating = 'positive' THEN 1 ELSE 0 END) AS positive,
               COUNT(DISTINCT f.id) AS total
        FROM skill_usage su
        JOIN feedback f ON f.session_key = su.session_key
        WHERE su.retrieved_at >= datetime('now', '-60 days')
          AND f.created_at >= su.retrieved_at
          ${agentSlug ? 'AND su.agent_slug = ?' : ''}
        GROUP BY su.skill_name
        HAVING negative >= 3 AND negative * 2 > total
      `;
      const rows = this.conn.prepare(sql).all(
        ...(agentSlug ? [agentSlug] : []),
      ) as Array<{ skill_name: string; negative: number; positive: number; total: number }>;
      for (const r of rows) suppressed.add(r.skill_name);
    } catch {
      // skill_usage or feedback tables may be empty / legacy — return empty set
    }
    return suppressed;
  }

  /**
   * Get a compact "recent feedback signal" snapshot for prompt injection.
   * Closes the feedback → behavior loop: the agent sees the last week's
   * negative pattern in its system prompt instead of feedback being
   * write-only.
   *
   * - `negative` / `positive`: counts in the window
   * - `negativesWithComments`: up to `limit` most recent negatives that
   *   carry a non-empty comment (these are the actionable ones — silent
   *   👎 reactions don't tell the agent what to fix)
   * - `behavioralChannel` is excluded because behavioral-corrections are
   *   already pushed to hotCorrections directly
   */
  getRecentFeedbackSignals(opts: { days?: number; limit?: number } = {}): {
    negative: number;
    positive: number;
    negativesWithComments: Array<{ comment: string; channel: string; createdAt: string }>;
  } {
    const days = Math.max(1, opts.days ?? 14);
    const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
    const since = `datetime('now', '-${days} days')`;

    let negative = 0;
    let positive = 0;
    let negativesWithComments: Array<{ comment: string; channel: string; createdAt: string }> = [];
    try {
      const rows = this.conn
        .prepare(
          `SELECT rating, COUNT(*) as cnt FROM feedback
           WHERE created_at >= ${since}
             AND channel != 'behavioral-correction'
             AND channel != 'preference-learned'
           GROUP BY rating`,
        )
        .all() as Array<{ rating: string; cnt: number }>;
      for (const row of rows) {
        if (row.rating === 'negative') negative = row.cnt;
        else if (row.rating === 'positive') positive = row.cnt;
      }

      const commented = this.conn
        .prepare(
          `SELECT comment, channel, created_at
           FROM feedback
           WHERE rating = 'negative'
             AND comment IS NOT NULL
             AND TRIM(comment) != ''
             AND channel != 'behavioral-correction'
             AND created_at >= ${since}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as Array<{ comment: string; channel: string; created_at: string }>;
      negativesWithComments = commented.map((r) => ({
        comment: r.comment,
        channel: r.channel,
        createdAt: r.created_at,
      }));
    } catch {
      // Empty / legacy schema — return zeros
    }
    return { negative, positive, negativesWithComments };
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
   * Iterates modelUsage record and inserts one row per model. Cost is
   * apportioned across models proportionally to total tokens (input +
   * output) so per-agent monthly aggregations stay accurate when a turn
   * uses more than one model.
   */
  logUsage(entry: {
    sessionKey: string;
    source: string;
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
    numTurns: number;
    durationMs: number;
    agentSlug?: string;
    /** Total cost in USD for the whole turn (from SDK result.total_cost_usd). */
    totalCostUsd?: number;
  }): void {
    if (!this._stmtInsertUsage) {
      this._stmtInsertUsage = this.conn.prepare(
        `INSERT INTO usage_log (session_key, source, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, duration_ms, agent_slug, cost_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
    }

    // Apportion the total cost across models by token share.
    const totalCostCents = entry.totalCostUsd != null
      ? Math.max(0, Math.round(entry.totalCostUsd * 100))
      : 0;
    const totalTokens = Object.values(entry.modelUsage).reduce(
      (sum, u) => sum + (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
      0,
    );

    for (const [model, usage] of Object.entries(entry.modelUsage)) {
      const modelTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      const shareCents = totalCostCents > 0 && totalTokens > 0
        ? Math.round(totalCostCents * (modelTokens / totalTokens))
        : 0;
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
        entry.agentSlug ?? null,
        shareCents,
      );
    }
  }

  /**
   * Get the current month's spend in cents for an agent (or for global
   * Clementine if agentSlug is null/undefined). "Month" = first day of
   * the current calendar month in UTC.
   */
  getMonthlyCostCents(agentSlug: string | null | undefined): number {
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);
    const sinceIso = startOfMonth.toISOString();

    const where = agentSlug
      ? 'WHERE agent_slug = ? AND created_at >= ?'
      : 'WHERE agent_slug IS NULL AND created_at >= ?';
    const params = agentSlug ? [agentSlug, sinceIso] : [sinceIso];

    try {
      const row = this.conn
        .prepare(`SELECT COALESCE(SUM(cost_cents), 0) as total FROM usage_log ${where}`)
        .get(...params) as { total: number } | undefined;
      return row?.total ?? 0;
    } catch {
      return 0;
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
   * Get per-agent usage stats for observability dashboard.
   */
  getAgentStats(agentSlug: string, sinceIso?: string): {
    totalInput: number;
    totalOutput: number;
    totalTokens: number;
    numQueries: number;
    avgTurns: number;
    avgDurationMs: number;
    bySource: Array<{ source: string; count: number; tokens: number }>;
    byDay: Array<{ day: string; tokens: number; count: number }>;
  } {
    const where = sinceIso
      ? `WHERE agent_slug = ? AND created_at >= ?`
      : `WHERE agent_slug = ?`;
    const params = sinceIso ? [agentSlug, sinceIso] : [agentSlug];

    const totals = this.conn.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_,
              COUNT(*) as cnt, COALESCE(AVG(num_turns), 0) as avg_turns,
              COALESCE(AVG(duration_ms), 0) as avg_dur
       FROM usage_log ${where}`,
    ).get(...params) as { ti: number; to_: number; cnt: number; avg_turns: number; avg_dur: number };

    const bySource = this.conn.prepare(
      `SELECT source, COUNT(*) as count, SUM(input_tokens + output_tokens) as tokens
       FROM usage_log ${where} GROUP BY source ORDER BY tokens DESC`,
    ).all(...params) as Array<{ source: string; count: number; tokens: number }>;

    const byDay = this.conn.prepare(
      `SELECT date(created_at) as day, SUM(input_tokens + output_tokens) as tokens, COUNT(*) as count
       FROM usage_log ${where} ${sinceIso ? 'AND' : 'AND'} created_at >= date('now', '-14 days')
       GROUP BY date(created_at) ORDER BY day`,
    ).all(...params) as Array<{ day: string; tokens: number; count: number }>;

    return {
      totalInput: totals.ti,
      totalOutput: totals.to_,
      totalTokens: totals.ti + totals.to_,
      numQueries: totals.cnt,
      avgTurns: Math.round(totals.avg_turns * 10) / 10,
      avgDurationMs: Math.round(totals.avg_dur),
      bySource,
      byDay,
    };
  }

  /**
   * Compare all agents by usage. Returns a leaderboard.
   */
  getAgentComparison(sinceIso?: string): Array<{
    agentSlug: string;
    totalTokens: number;
    numQueries: number;
    avgTurns: number;
  }> {
    const where = sinceIso ? `WHERE agent_slug IS NOT NULL AND created_at >= ?` : `WHERE agent_slug IS NOT NULL`;
    const params = sinceIso ? [sinceIso] : [];

    return this.conn.prepare(
      `SELECT agent_slug as agentSlug,
              SUM(input_tokens + output_tokens) as totalTokens,
              COUNT(*) as numQueries,
              COALESCE(AVG(num_turns), 0) as avgTurns
       FROM usage_log ${where}
       GROUP BY agent_slug ORDER BY totalTokens DESC`,
    ).all(...params) as Array<{ agentSlug: string; totalTokens: number; numQueries: number; avgTurns: number }>;
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
        `SELECT id, source_file, section, content, topic AS chunk_topic
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
      chunk_topic: string | null;
    }>;

    // Group by topic column (preferred) or fall back to directory path
    const groups = new Map<string, { chunkIds: number[]; contents: string[]; totalChars: number }>();
    for (const row of rows) {
      const topic = row.chunk_topic || row.source_file.split('/').slice(0, 2).join('/') || row.source_file;
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

  // ── Autonomy log ───────────────────────────────────────────────────

  private _stmtLogAutonomy: Database.Statement | null = null;
  private _stmtQueryAutonomy: Database.Statement | null = null;

  logAutonomyEvent(row: {
    component: string;
    event: string;
    agentSlug?: string | null;
    details?: Record<string, unknown>;
  }): void {
    try {
      if (!this._stmtLogAutonomy) {
        this._stmtLogAutonomy = this.conn.prepare(
          'INSERT INTO autonomy_log (component, event, agent_slug, details_json) VALUES (?, ?, ?, ?)',
        );
      }
      this._stmtLogAutonomy.run(
        row.component,
        row.event,
        row.agentSlug ?? null,
        JSON.stringify(row.details ?? {}),
      );
    } catch {
      // Best-effort — autonomy telemetry must never break the system.
    }
  }

  queryAutonomyLog(opts: {
    component?: string;
    event?: string;
    agentSlug?: string;
    limit?: number;
    since?: string;
  } = {}): Array<{
    id: number;
    component: string;
    event: string;
    agentSlug: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (opts.component) {
      conditions.push('component = ?');
      params.push(opts.component);
    }
    if (opts.event) {
      conditions.push('event = ?');
      params.push(opts.event);
    }
    if (opts.agentSlug) {
      conditions.push('agent_slug = ?');
      params.push(opts.agentSlug);
    }
    if (opts.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    if (!this._stmtQueryAutonomy || conditions.length) {
      // Ad-hoc query — conditions vary, use generic runner
      return this.conn
        .prepare(`SELECT * FROM autonomy_log ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, limit)
        .map((row: unknown) => {
          const r = row as Record<string, unknown>;
          return {
            id: r.id as number,
            component: r.component as string,
            event: r.event as string,
            agentSlug: r.agent_slug as string | null,
            details: JSON.parse((r.details_json as string) || '{}'),
            createdAt: r.created_at as string,
          };
        });
    }
    return this._stmtQueryAutonomy.all(limit).map((row: unknown) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as number,
        component: r.component as string,
        event: r.event as string,
        agentSlug: r.agent_slug as string | null,
        details: JSON.parse((r.details_json as string) || '{}'),
        createdAt: r.created_at as string,
      };
    });
  }

  /**
   * Aggregate memory-health snapshot for the dashboard.
   *
   * Single-pass queries over each table; cheap enough to call on every
   * dashboard tab visit without caching. Adds graph stats only if a
   * graphStore is supplied and reachable.
   */
  getMemoryHealth(opts: {
    graphStore?: { isAvailable(): boolean; nodeCount?(): Promise<number>; edgeCount?(): Promise<number> };
    topCitedLimit?: number;
  } = {}): {
    chunks: { total: number; consolidated: number; pinned: number; softDeleted: number; zombieCount: number };
    chunksByCategory: Array<{ category: string | null; count: number }>;
    tableRowCounts: Record<string, number>;
    recentActivity: { recallTracesLast7d: number; recallTracesLast30d: number; extractionSkipsLast30d: number };
    topCitedLast30d: Array<{ chunkId: number; sourceFile: string; section: string; refCount: number }>;
    userModelSlots: { total: number; populated: number; global: number; agentScoped: number };
    staleUserModelSlots: Array<{ slot: string; ageDays: number; agentSlug: string | null }>;
    staleHighSalienceChunks: Array<{ chunkId: number; sourceFile: string; section: string; salience: number; lastOutcomeScore: number }>;
    selfImprovePlateausLast7d: number;
    chunkCacheStats: ReturnType<HotCache<number, unknown>['stats']>;
    writeQueue: { size: number; dropped: number } | null;
    lastIntegrityReport: { ftsOk: boolean; ftsRebuilt: boolean; orphanRefsNulled: number; missingEmbeddings: number; ranAt: string } | null;
    dbSizeBytes: number;
    lastVacuumAt: string | null;
    denseEmbeddings: {
      withDense: number;
      total: number;
      models: Array<{ model: string; count: number }>;
      currentModel: string;
      ready: boolean;
    };
  } {
    const topLimit = opts.topCitedLimit ?? 10;

    const chunkAgg = this.conn
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN consolidated = 1 THEN 1 ELSE 0 END), 0) AS consolidated,
           COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned
         FROM chunks`,
      )
      .get() as { total: number; consolidated: number; pinned: number };

    const softDeletedRow = this.conn
      .prepare('SELECT COUNT(*) AS c FROM chunk_soft_deletes')
      .get() as { c: number };

    // Zombies: consolidated AND no access in last 30d (or never accessed at all).
    const zombieRow = this.conn
      .prepare(
        `SELECT COUNT(*) AS c
         FROM chunks c
         LEFT JOIN (
           SELECT chunk_id, MAX(accessed_at) AS la
           FROM access_log GROUP BY chunk_id
         ) a ON a.chunk_id = c.id
         LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
         WHERE c.consolidated = 1
           AND sd.chunk_id IS NULL
           AND (a.la IS NULL OR a.la < datetime('now', '-30 days'))`,
      )
      .get() as { c: number };

    const byCategory = this.conn
      .prepare(
        `SELECT COALESCE(category, '(uncategorized)') AS category, COUNT(*) AS count
         FROM chunks GROUP BY category ORDER BY count DESC`,
      )
      .all() as Array<{ category: string | null; count: number }>;

    // Row counts for the high-write tables (cheap COUNT(*) per table).
    const trackedTables = [
      'chunks',
      'chunks_fts',
      'recall_traces',
      'access_log',
      'outcomes',
      'transcripts',
      'session_summaries',
      'memory_extractions',
      'chunk_soft_deletes',
      'chunk_history',
      'sdk_session_entries',
      'wikilinks',
    ];
    const tableRowCounts: Record<string, number> = {};
    for (const t of trackedTables) {
      try {
        const row = this.conn.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number };
        tableRowCounts[t] = row.c;
      } catch {
        tableRowCounts[t] = -1;
      }
    }

    const recentActivity = {
      recallTracesLast7d: (this.conn
        .prepare(`SELECT COUNT(*) AS c FROM recall_traces WHERE retrieved_at >= datetime('now', '-7 days')`)
        .get() as { c: number }).c,
      recallTracesLast30d: (this.conn
        .prepare(`SELECT COUNT(*) AS c FROM recall_traces WHERE retrieved_at >= datetime('now', '-30 days')`)
        .get() as { c: number }).c,
      extractionSkipsLast30d: (this.conn
        .prepare(`SELECT COUNT(*) AS c FROM memory_extractions WHERE status LIKE 'skipped:%' AND extracted_at >= datetime('now', '-30 days')`)
        .get() as { c: number }).c,
    };

    const userModelSlots = this.conn
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN length(trim(content)) > 0 THEN 1 ELSE 0 END), 0) AS populated,
           COALESCE(SUM(CASE WHEN agent_slug IS NULL THEN 1 ELSE 0 END), 0) AS global,
           COALESCE(SUM(CASE WHEN agent_slug IS NOT NULL THEN 1 ELSE 0 END), 0) AS agentScoped
         FROM user_model_blocks`,
      )
      .get() as { total: number; populated: number; global: number; agentScoped: number };

    const selfImprovePlateausLast7d = (() => {
      const logPath = path.join(BASE_DIR, 'self-improve', 'experiment-log.jsonl');
      if (!existsSync(logPath)) return 0;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      try {
        return readFileSync(logPath, 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .reduce((count, line) => {
            try {
              const entry = JSON.parse(line) as {
                startedAt?: string;
                finishedAt?: string;
                reason?: string;
                hypothesis?: string;
              };
              const ts = Date.parse(entry.finishedAt ?? entry.startedAt ?? '');
              if (!Number.isFinite(ts) || ts < cutoff) return count;
              const plateau = entry.reason?.startsWith('Plateau')
                || entry.hypothesis?.startsWith('No new hypothesis');
              return plateau ? count + 1 : count;
            } catch {
              return count;
            }
          }, 0);
      } catch {
        return 0;
      }
    })();

    const topCited = this.conn
      .prepare(
        `SELECT o.chunk_id, c.source_file, c.section, COUNT(*) AS ref_count
         FROM outcomes o
         JOIN chunks c ON c.id = o.chunk_id
         WHERE o.referenced = 1
           AND o.created_at > datetime('now', '-30 days')
         GROUP BY o.chunk_id
         ORDER BY ref_count DESC
         LIMIT ?`,
      )
      .all(topLimit) as Array<{ chunk_id: number; source_file: string; section: string; ref_count: number }>;

    return {
      chunks: {
        total: chunkAgg.total,
        consolidated: chunkAgg.consolidated,
        pinned: chunkAgg.pinned,
        softDeleted: softDeletedRow.c,
        zombieCount: zombieRow.c,
      },
      chunksByCategory: byCategory,
      tableRowCounts,
      recentActivity,
      topCitedLast30d: topCited.map((r) => ({
        chunkId: r.chunk_id,
        sourceFile: r.source_file,
        section: r.section,
        refCount: r.ref_count,
      })),
      userModelSlots,
      staleUserModelSlots: this.findStaleUserModelSlots(),
      staleHighSalienceChunks: this.findStaleHighSalienceChunks({ limit: 10 }),
      selfImprovePlateausLast7d,
      chunkCacheStats: this.chunkRowCache.stats(),
      writeQueue: this.getWriteQueueStats(),
      lastIntegrityReport: (() => {
        const raw = this.getMaintenanceMeta('last_integrity_report');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
      })(),
      dbSizeBytes: this.dbSizeBytes(),
      lastVacuumAt: this.getMaintenanceMeta('last_vacuum_at'),
      denseEmbeddings: (() => {
        const withDense = (this.conn
          .prepare('SELECT COUNT(*) as cnt FROM chunks WHERE embedding_dense IS NOT NULL')
          .get() as { cnt: number } | undefined)?.cnt ?? 0;
        const models = (this.conn
          .prepare(`SELECT COALESCE(embedding_dense_model, '(unknown)') as model, COUNT(*) as count
                    FROM chunks WHERE embedding_dense IS NOT NULL
                    GROUP BY embedding_dense_model ORDER BY count DESC`)
          .all() as Array<{ model: string; count: number }>);
        return {
          withDense,
          total: chunkAgg.total,
          models,
          currentModel: embeddingsModule.currentDenseModel(),
          ready: embeddingsModule.isDenseReady(),
        };
      })(),
    };
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
   *
   * `derivedFromIds` records the source chunks that fed into this summary.
   * Stored as JSON in `chunks.derived_from` so the dashboard can show
   * "view source memories" — abstractions become auditable.
   */
  insertSummaryChunk(sourceFile: string, section: string, content: string, derivedFromIds?: number[]): void {
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const derivedJson = derivedFromIds && derivedFromIds.length > 0 ? JSON.stringify(derivedFromIds) : null;
    const result = this.conn
      .prepare(
        `INSERT INTO chunks (source_file, section, content, chunk_type, content_hash, salience, consolidated, derived_from)
         VALUES (?, ?, ?, 'summary', ?, 0.8, 0, ?)`,
      )
      .run(sourceFile, section, content, hash, derivedJson);

    // Immediately compute embedding so the summary is vector-searchable right away
    if (embeddingsModule.isReady()) {
      const vec = embeddingsModule.embed(content);
      if (vec) {
        this.conn.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
          .run(embeddingsModule.serializeEmbedding(vec), result.lastInsertRowid);
      }
    }
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

  // ── Embeddings ──────────────────────────────────────────────────

  /**
   * Build the TF-IDF vocabulary from all chunk contents, then backfill
   * embeddings for any chunks that don't have one yet.
   * Safe to call repeatedly — skips chunks that already have embeddings.
   */
  buildEmbeddings(): { vocabSize: number; backfilled: number; invalidated: number } {
    // Gather all chunk contents for vocabulary building
    const rows = this.conn
      .prepare('SELECT id, content FROM chunks')
      .all() as Array<{ id: number; content: string }>;

    if (rows.length === 0) return { vocabSize: 0, backfilled: 0, invalidated: 0 };

    // Capture prior vocab hash BEFORE rebuild. If buildVocab produces a
    // different word→dimension mapping, previously-stored embedding vectors
    // become silently wrong (dimension N now represents a different word).
    const hashFile = path.join(BASE_DIR, '.embedding-vocab.hash');
    let priorHash = '';
    try {
      if (existsSync(hashFile)) priorHash = readFileSync(hashFile, 'utf-8').trim();
    } catch { /* first run */ }

    // Build vocabulary from entire corpus (including consolidated summaries)
    embeddingsModule.buildVocab(rows.map((r) => r.content));

    if (!embeddingsModule.isReady()) return { vocabSize: 0, backfilled: 0, invalidated: 0 };

    // If the vocab shifted, invalidate every stored vector so they re-embed
    // against the new word→dim mapping. Without this, old vectors silently
    // mismatch query vectors and cosine similarity returns nonsense.
    const newHash = embeddingsModule.getVocabHash();
    let invalidated = 0;
    if (priorHash && priorHash !== newHash) {
      const res = this.conn.prepare('UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL').run();
      invalidated = res.changes;
      // Count is returned in the result object — callers (maintenance cycle)
      // log it there. No local logger in this file to avoid the import.
    }
    try {
      writeFileSync(hashFile, newHash);
    } catch { /* non-fatal */ }

    // Backfill embeddings for all chunks that don't have one
    const missing = this.conn
      .prepare('SELECT id, content FROM chunks WHERE embedding IS NULL')
      .all() as Array<{ id: number; content: string }>;

    const updateStmt = this.conn.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');
    let backfilled = 0;

    // Wrap backfill in a transaction — potentially thousands of UPDATEs
    // per vocab shift, and a single WAL commit is dramatically faster.
    const backfillAll = this.conn.transaction((items: Array<{ id: number; content: string }>) => {
      for (const row of items) {
        const vec = embeddingsModule.embed(row.content);
        if (vec) {
          updateStmt.run(embeddingsModule.serializeEmbedding(vec), row.id);
          backfilled++;
        }
      }
    });
    backfillAll(missing);

    return { vocabSize: rows.length, backfilled, invalidated };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * Delete all chunks, wikilinks, file hash, and access log for a given file.
   */
  private deleteFileChunks(relPath: string): void {
    // Capture chunk ids first so we can invalidate the LRU after the deletes.
    const ids = this.conn
      .prepare('SELECT id FROM chunks WHERE source_file = ?')
      .all(relPath) as Array<{ id: number }>;
    // Delete access_log entries for chunks being removed (prevent orphans)
    this.conn
      .prepare('DELETE FROM access_log WHERE chunk_id IN (SELECT id FROM chunks WHERE source_file = ?)')
      .run(relPath);
    this.conn.prepare('DELETE FROM chunks WHERE source_file = ?').run(relPath);
    this.conn.prepare('DELETE FROM wikilinks WHERE source_file = ?').run(relPath);
    this.conn.prepare('DELETE FROM file_hashes WHERE rel_path = ?').run(relPath);
    for (const r of ids) this.chunkRowCache.delete(r.id);
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
