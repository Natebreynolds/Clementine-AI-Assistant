/**
 * Clementine TypeScript — Memory MCP tools.
 *
 * working_memory, memory_read/write/search/recall, memory_connections,
 * memory_timeline, transcript_search, memory_report/correct/consolidate,
 * graph memory tools
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ACTIVE_AGENT_SLUG, BASE_DIR, IDENTITY_FILE, MEMORY_FILE, SYSTEM_DIR,
  VAULT_DIR, WORKING_MEMORY_MAX_LINES,
  agentWorkingMemoryFile, capOutput, DEFAULT_OUTPUT_MAX_CHARS,
  ensureDailyNote, getStore, globMd, incrementalSync, logger, nowTime,
  resolvePath, textResult, todayStr, validateVaultPath,
} from './shared.js';
import { getToolDescription } from './tool-meta.js';

/** Merge duplicate `## Section` headers in a MEMORY.md body, deduplicating lines. */
function mergeDuplicateSections(body: string): string {
  const lines = body.split('\n');
  const sections = new Map<string, string[]>(); // heading → content lines
  const order: string[] = []; // preserve first-seen order
  let preamble: string[] = [];
  let currentHeading = '';

  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentHeading = line;
      if (!sections.has(currentHeading)) {
        sections.set(currentHeading, []);
        order.push(currentHeading);
      }
    } else if (!currentHeading) {
      preamble.push(line);
    } else {
      sections.get(currentHeading)!.push(line);
    }
  }

  if (sections.size === 0) return body; // no sections, nothing to merge

  // Deduplicate lines within each section
  for (const [heading, contentLines] of sections) {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const line of contentLines) {
      const key = line.trim().toLowerCase();
      if (!key || key === '') { deduped.push(line); continue; } // keep blank lines
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(line);
      }
    }
    sections.set(heading, deduped);
  }

  // Rebuild
  let result = preamble.join('\n');
  for (const heading of order) {
    const content = sections.get(heading)!;
    // Trim trailing empty lines from section
    while (content.length > 0 && content[content.length - 1].trim() === '') content.pop();
    result += '\n\n' + heading + '\n' + content.join('\n');
  }

  return result.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function registerMemoryTools(server: McpServer): void {
// ── 0. working_memory ──────────────────────────────────────────────────

server.tool(
  'working_memory',
  getToolDescription('working_memory') ?? 'Persistent scratchpad that survives across conversations. Use to jot down current project context, TODOs, reminders, or anything you need to remember for next time. Actions: read, append, replace, clear.',
  {
    action: z.enum(['read', 'append', 'replace', 'clear']).describe('What to do with working memory'),
    content: z.string().optional().describe('Text to append or replace with (required for append/replace)'),
  },
  async ({ action, content }) => {
    const wmFile = agentWorkingMemoryFile(ACTIVE_AGENT_SLUG);
    switch (action) {
      case 'read': {
        if (!existsSync(wmFile)) {
          return textResult('Working memory is empty.');
        }
        const text = readFileSync(wmFile, 'utf-8');
        const lineCount = text.split('\n').length;
        let result = text;
        if (lineCount > WORKING_MEMORY_MAX_LINES) {
          result += `\n\n⚠️ Working memory is ${lineCount} lines (limit: ${WORKING_MEMORY_MAX_LINES}). Consider compacting — remove resolved items and summarize.`;
        }
        return textResult(result);
      }
      case 'append': {
        if (!content) return textResult('Error: content is required for append.');
        const existing = existsSync(wmFile) ? readFileSync(wmFile, 'utf-8') : '';
        const separator = existing && !existing.endsWith('\n') ? '\n' : '';
        writeFileSync(wmFile, existing + separator + content + '\n');
        const newLineCount = (existing + separator + content).split('\n').length;
        let msg = `Appended to working memory.`;
        if (newLineCount > WORKING_MEMORY_MAX_LINES) {
          msg += ` ⚠️ Now ${newLineCount} lines — consider compacting.`;
        }
        return textResult(msg);
      }
      case 'replace': {
        if (!content) return textResult('Error: content is required for replace.');
        writeFileSync(wmFile, content + '\n');
        return textResult('Working memory replaced.');
      }
      case 'clear': {
        if (existsSync(wmFile)) unlinkSync(wmFile);
        return textResult('Working memory cleared.');
      }
    }
  },
);


// ── 1. memory_read ─────────────────────────────────────────────────────

server.tool(
  'memory_read',
  getToolDescription('memory_read') ?? "Read a note from the Obsidian vault. Shortcuts: 'today', 'yesterday', 'memory', 'tasks', 'heartbeat', 'cron', 'soul'. Or pass a relative path or note name.",
  {
    name: z.string().describe('Note name, path, or shortcut'),
    max_chars: z.number().int().positive().optional().describe(`Max chars to return (default ${DEFAULT_OUTPUT_MAX_CHARS}). Larger files are head-truncated with a marker — pass a higher value if you genuinely need more.`),
  },
  async ({ name, max_chars }) => {
    const filePath = resolvePath(name);
    if (!existsSync(filePath)) {
      return textResult(`Note not found: ${name}`);
    }
    const content = readFileSync(filePath, 'utf-8');
    const rel = path.relative(VAULT_DIR, filePath);
    // Cap output to avoid the unbounded-blob cost issue surfaced by Phase
    // 11b analytics (some MEMORY.md files run 60KB+ and were the single
    // biggest cost-per-call driver in the clementine-tools family).
    const capped = capOutput(content, max_chars ?? DEFAULT_OUTPUT_MAX_CHARS, { hintParam: 'max_chars' });
    return textResult(`**${rel}:**\n\n${capped}`);
  },
);


// ── 2. memory_write ────────────────────────────────────────────────────

server.tool(
  'memory_write',
  getToolDescription('memory_write') ?? "Write or append to a vault note. Actions: 'append_daily' (add to today's log), 'update_memory' (update MEMORY.md section), 'write_note' (write/overwrite a note), 'update_identity' (set identity seed — who you are, your role, key context).",
  {
    action: z.enum(['append_daily', 'update_memory', 'write_note', 'update_identity']).describe('Write action'),
    content: z.string().describe('Text to write/append'),
    section: z.string().optional().describe('Section for append_daily or update_memory'),
    file_path: z.string().optional().describe('Relative vault path for write_note action'),
  },
  async ({ action, content, section, file_path }) => {
    if (action === 'append_daily') {
      const sec = section ?? 'Interactions';
      const dailyPath = ensureDailyNote();
      let body = readFileSync(dailyPath, 'utf-8');

      const timestamp = nowTime();
      const entry = `\n- **${timestamp}** — ${content}`;

      const pattern = new RegExp(`(## ${sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?)(\\n## |$)`, 's');
      const match = pattern.exec(body);
      if (match) {
        body = body.slice(0, match.index + match[1].length) + entry + body.slice(match.index + match[1].length);
      } else {
        body += `\n\n## ${sec}${entry}`;
      }

      writeFileSync(dailyPath, body, 'utf-8');
      const rel = path.relative(VAULT_DIR, dailyPath);
      await incrementalSync(rel, ACTIVE_AGENT_SLUG ?? undefined);
      return textResult(`Appended to ${path.basename(dailyPath)} > ${sec}`);
    }

    if (action === 'update_memory') {
      const sec = section ?? '';
      if (!sec) return textResult("Error: 'section' required for update_memory");

      // Resolve target MEMORY.md: agent-specific if running as team agent, else global
      let targetMemFile = MEMORY_FILE;
      if (ACTIVE_AGENT_SLUG) {
        const agentMemDir = path.join(SYSTEM_DIR, 'agents', ACTIVE_AGENT_SLUG);
        mkdirSync(agentMemDir, { recursive: true });
        targetMemFile = path.join(agentMemDir, 'MEMORY.md');
        if (!existsSync(targetMemFile)) {
          writeFileSync(targetMemFile, `# ${ACTIVE_AGENT_SLUG} Memory\n\n`, 'utf-8');
        }
      }

      // Dedup check against indexed memory — bump salience instead of discarding
      try {
        const store = await getStore();
        const dup = store.checkDuplicate(content, path.relative(VAULT_DIR, targetMemFile));
        if (dup.isDuplicate && dup.matchId) {
          // Reinforce the existing chunk — the fact was mentioned again, so it's important
          store.bumpChunkSalience(dup.matchId, 0.1);
          store.logExtraction({
            sessionKey: 'mcp', userMessage: content.slice(0, 200),
            toolName: 'memory_write', toolInput: JSON.stringify({ action, section: sec }),
            extractedAt: new Date().toISOString(), status: 'dedup_skipped',
            agentSlug: ACTIVE_AGENT_SLUG ?? undefined,
          });
          return textResult(`Reinforced existing memory (chunk #${dup.matchId}, salience bumped). No duplicate written.`);
        }
      } catch { /* dedup failure is non-fatal — proceed with write */ }

      let body = readFileSync(targetMemFile, 'utf-8');

      // First, merge any duplicate section headers in the file
      body = mergeDuplicateSections(body);

      const pattern = new RegExp(`(## ${sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)(.*?)(\\n## |$)`, 's');
      const match = pattern.exec(body);

      if (match) {
        const existingContent = match[2].trim();
        const existingLines = existingContent.split('\n').map(l => l.trim()).filter(Boolean);
        const newLines = content.split('\n').map(l => l.trim()).filter(Boolean);

        // Dedup: skip lines that are exact or near-exact duplicates
        const filtered: string[] = [];
        for (const newLine of newLines) {
          const isDup = existingLines.some(ex => {
            const a = newLine.toLowerCase().trim();
            const b = ex.toLowerCase().trim();
            if (a === b) return true;
            // Fuzzy: if one line contains 80%+ of the other's words, treat as dup
            const aWords = a.split(/\s+/);
            const bWords = b.split(/\s+/);
            if (aWords.length < 3 || bWords.length < 3) return false;
            const overlap = aWords.filter(w => bWords.includes(w)).length;
            return overlap / Math.max(aWords.length, bWords.length) > 0.8;
          });
          if (!isDup) {
            filtered.push(newLine);
          }
        }

        if (!filtered.length) {
          return textResult(`No new information for MEMORY.md > ${sec} (all duplicates)`);
        }

        const updatedText = existingContent + '\n' + filtered.join('\n');
        body = body.slice(0, match.index + match[1].length) + updatedText + '\n' + body.slice(match.index + match[1].length + match[2].length);
      } else {
        body += `\n\n## ${sec}\n\n${content}\n`;
      }

      writeFileSync(targetMemFile, body, 'utf-8');
      const rel = path.relative(VAULT_DIR, targetMemFile);
      await incrementalSync(rel, ACTIVE_AGENT_SLUG ?? undefined);
      const label = ACTIVE_AGENT_SLUG ? `${ACTIVE_AGENT_SLUG}/MEMORY.md` : 'MEMORY.md';
      return textResult(`Updated ${label} > ${sec}`);
    }

    if (action === 'update_identity') {
      mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
      writeFileSync(IDENTITY_FILE, content, 'utf-8');
      const rel = path.relative(VAULT_DIR, IDENTITY_FILE);
      await incrementalSync(rel, ACTIVE_AGENT_SLUG ?? undefined);
      return textResult('Updated identity seed (IDENTITY.md)');
    }

    if (action === 'write_note') {
      const relPath = file_path ?? '';
      if (!relPath) return textResult("Error: 'file_path' required for write_note");

      const full = validateVaultPath(relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
      await incrementalSync(relPath, ACTIVE_AGENT_SLUG ?? undefined);
      return textResult(`Wrote: ${relPath}`);
    }

    return textResult(`Unknown action: ${action}`);
  },
);


// ── 3. memory_search ───────────────────────────────────────────────────

server.tool(
  'memory_search',
  getToolDescription('memory_search') ?? 'FTS5 search across all vault notes. Returns matching chunks with relevance scores. Optional category/topic filters narrow results.',
  {
    query: z.string().describe('Search text'),
    limit: z.number().optional().describe('Max results (default 20)'),
    category: z.enum(['facts', 'events', 'discoveries', 'preferences', 'advice']).optional().describe('Filter by category'),
    topic: z.string().optional().describe('Filter by topic'),
  },
  async ({ query, limit, category, topic }) => {
    const maxResults = limit ?? 20;
    const filters = (category || topic) ? { category, topic } : undefined;

    try {
      const store = await getStore();
      const results = store.searchFts(query, maxResults, filters);

      // Apply agent affinity boost
      if (ACTIVE_AGENT_SLUG && results.length > 0) {
        for (const r of results) {
          if (r.agentSlug === ACTIVE_AGENT_SLUG) r.score *= 1.4;
        }
        results.sort((a, b) => b.score - a.score);
      }

      if (results.length > 0) {
        const lines = results.map(r => {
          const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
          return `**${r.sourceFile} > ${r.section}** (score: ${r.score.toFixed(2)}) — ${preview}`;
        });
        return textResult(lines.join('\n'));
      }
    } catch (err) {
      logger.warn({ err }, 'FTS5 search failed, falling back to linear scan');
    }

    // Fallback: linear scan
    const qLower = query.toLowerCase();
    const results: string[] = [];
    const mdFiles = globMd(VAULT_DIR);

    for (const filePath of mdFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (qLower && lines[i].toLowerCase().includes(qLower)) {
            const rel = path.relative(VAULT_DIR, filePath);
            results.push(`**${rel}:${i + 1}** — ${lines[i].trim()}`);
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        continue;
      }
      if (results.length >= maxResults) break;
    }

    if (!results.length) {
      return textResult(`No results for: ${query}`);
    }
    return textResult(results.join('\n'));
  },
);


// ── 4. memory_recall ───────────────────────────────────────────────────

server.tool(
  'memory_recall',
  getToolDescription('memory_recall') ?? 'Context retrieval combining FTS5 relevance + recency search, scoped to your memory + global. For cross-agent synthesis use brain_recall.',
  {
    query: z.string().describe('Natural language search query'),
    category: z.enum(['facts', 'events', 'discoveries', 'preferences', 'advice']).optional().describe('Filter by category'),
    topic: z.string().optional().describe('Filter by topic'),
  },
  async ({ query, category, topic }) => {
    const store = await getStore();
    const results = store.searchContext(
      query,
      { agentSlug: ACTIVE_AGENT_SLUG ?? undefined, category, topic },
    ) as Array<{
      sourceFile: string; section: string; content: string; score: number;
      matchType: string; chunkId: number; agentSlug?: string | null;
    }>;

    if (!results.length) {
      return textResult(`No results for: ${query}`);
    }

    // Record access for salience tracking
    const chunkIds = results.map(r => r.chunkId).filter(Boolean);
    if (chunkIds.length) store.recordAccess(chunkIds);

    const lines = results.map(r => {
      const label = `[${r.matchType}]`;
      const agentTag = r.agentSlug ? ` [agent: ${r.agentSlug}]` : '';
      const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
      return `**${r.sourceFile} > ${r.section}** ${label}${agentTag} (score: ${r.score.toFixed(3)})\n${preview}\n`;
    });

    return textResult(lines.join('\n'));
  },
);


// ── 4b. brain_recall ──────────────────────────────────────────────────
//
// Cross-agent unified recall. Differs from memory_recall in two ways:
//   1. No agentSlug scope — pulls from every agent's memory + global.
//   2. Always tags each result with [agent: <slug>] so the caller can
//      see provenance (which agent's memory the chunk came from).
//
// Intended caller: Clementine herself. Specialist agents normally stay in
// memory_recall (which respects strict isolation). brain_recall is the
// "single brain" view that lets the master assistant synthesize across
// the whole team.

server.tool(
  'brain_recall',
  getToolDescription('brain_recall') ?? 'Cross-agent unified recall — searches across all agents with source-agent attribution. Use for synthesis questions or when you need the full picture, not just your own scope.',
  {
    query: z.string().describe('Natural language query — what to find across all agents'),
    category: z.enum(['facts', 'events', 'discoveries', 'preferences', 'advice']).optional().describe('Filter by category'),
    topic: z.string().optional().describe('Filter by topic'),
    limit: z.number().optional().describe('Max results across all agents (default 12)'),
  },
  async ({ query, category, topic, limit }) => {
    const store = await getStore();
    // Intentionally omit agentSlug — we want the unscoped, cross-agent view.
    const results = store.searchContext(
      query,
      { category, topic, limit: limit ?? 12 },
    ) as Array<{
      sourceFile: string; section: string; content: string; score: number;
      matchType: string; chunkId: number; agentSlug?: string | null;
    }>;

    if (!results.length) {
      return textResult(`No results for: ${query}`);
    }

    const chunkIds = results.map(r => r.chunkId).filter(Boolean);
    if (chunkIds.length) store.recordAccess(chunkIds);

    // Group attribution counts so the agent gets a quick summary of the spread.
    const perAgent = new Map<string, number>();
    for (const r of results) {
      const key = r.agentSlug ?? 'global';
      perAgent.set(key, (perAgent.get(key) ?? 0) + 1);
    }
    const spread = Array.from(perAgent.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([slug, n]) => `${slug}:${n}`)
      .join(', ');

    const lines = results.map(r => {
      const agent = r.agentSlug ?? 'global';
      const label = `[${r.matchType}]`;
      const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
      return `**${r.sourceFile} > ${r.section}** ${label} [agent: ${agent}] (score: ${r.score.toFixed(3)})\n${preview}\n`;
    });

    return textResult(`Cross-agent spread: ${spread}\n\n${lines.join('\n')}`);
  },
);


// ── 10. memory_connections ─────────────────────────────────────────────

server.tool(
  'memory_connections',
  'Query the wikilink graph — find all notes connected to/from a given note.',
  {
    note_name: z.string().describe('Note name (without .md) to find connections for'),
  },
  async ({ note_name }) => {
    try {
      const store = await getStore();
      const connections = store.getConnections(note_name);

      const outgoing = connections.filter(c => c.direction === 'outgoing');
      const incoming = connections.filter(c => c.direction === 'incoming');

      const lines = [`**Connections for [[${note_name}]]:**\n`];

      if (outgoing.length) {
        lines.push(`**Links to (${outgoing.length}):**`);
        const seen = new Set<string>();
        for (const c of outgoing) {
          if (!seen.has(c.file)) {
            lines.push(`  → [[${c.file}]] — _${c.context.slice(0, 100)}_`);
            seen.add(c.file);
          }
        }
      }

      if (incoming.length) {
        lines.push(`\n**Linked from (${incoming.length}):**`);
        const seen = new Set<string>();
        for (const c of incoming) {
          if (!seen.has(c.file)) {
            lines.push(`  ← ${c.file} — _${c.context.slice(0, 100)}_`);
            seen.add(c.file);
          }
        }
      }

      if (!connections.length) {
        return textResult(`No connections found for: ${note_name}`);
      }

      return textResult(lines.join('\n'));
    } catch (err) {
      return textResult(`Error querying connections: ${err}`);
    }
  },
);


// ── 11. memory_timeline ───────────────────────────────────────────────

server.tool(
  'memory_timeline',
  'Chronological view of memory/vault changes within a date range. Great for "what happened last week" queries.',
  {
    start_date: z.string().describe('Start date (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('End date (YYYY-MM-DD, default: today)'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ start_date, end_date, limit }) => {
    const endD = end_date ?? todayStr();
    const maxResults = limit ?? 20;

    try {
      const store = await getStore();
      const results = store.getTimeline(start_date, endD, maxResults) as Array<{
        sourceFile: string; section: string; content: string;
        lastUpdated: string; chunkType: string;
      }>;

      if (!results.length) {
        return textResult(`No activity between ${start_date} and ${endD}`);
      }

      const lines = [`**Timeline: ${start_date} → ${endD}** (${results.length} items)\n`];
      for (const r of results) {
        const date = r.lastUpdated?.slice(0, 16).replace('T', ' ') ?? '?';
        const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
        lines.push(`- **${date}** — ${r.sourceFile} > ${r.section}\n  ${preview}`);
      }

      return textResult(lines.join('\n'));
    } catch (err) {
      return textResult(`Timeline error: ${err}`);
    }
  },
);


// ── 12. transcript_search ─────────────────────────────────────────────

server.tool(
  'transcript_search',
  'Search past conversation transcripts by keyword. Returns matching turns with session context.',
  {
    query: z.string().describe('Search text'),
    limit: z.number().optional().describe('Max results (default 20)'),
    session_key: z.string().optional().describe('Filter to a specific session'),
  },
  async ({ query, limit, session_key }) => {
    const maxResults = limit ?? 20;

    try {
      const store = await getStore();
      const results = store.searchTranscripts(query, maxResults, session_key ?? '');

      if (!results.length) {
        return textResult(`No transcript matches for: ${query}`);
      }

      const lines = [`**Transcript search: "${query}"** (${results.length} matches)\n`];
      for (const r of results) {
        const date = r.createdAt?.slice(0, 16).replace('T', ' ') ?? '?';
        lines.push(`- **[${r.role}]** ${date} (session: ${r.sessionKey.slice(0, 8)}...)\n  ${r.content}`);
      }

      return textResult(lines.join('\n'));
    } catch (err) {
      return textResult(`Transcript search error: ${err}`);
    }
  },
);




// ── Memory Transparency: memory_report ──────────────────────────────────

server.tool(
  'memory_report',
  'Show recent memory extractions — what was learned, when, and from which message. Helps the owner verify what the assistant has been learning.',
  {
    limit: z.number().optional().default(10).describe('Number of recent extractions to show'),
    status: z.enum(['active', 'corrected', 'dismissed', 'all']).optional().default('all').describe('Filter by status'),
  },
  async ({ limit, status }) => {
    const store = await getStore();
    const filter = status === 'all' ? undefined : status;
    const extractions = store.getRecentExtractions(limit, filter);
    if (extractions.length === 0) {
      return textResult('No memory extractions found.');
    }
    const report = extractions.map((e, i) =>
      `${i + 1}. [${e.status}] ${e.extractedAt}\n   From: "${e.userMessage.slice(0, 100)}${e.userMessage.length > 100 ? '...' : ''}"\n   Tool: ${e.toolName}\n   Input: ${e.toolInput.slice(0, 200)}${e.correction ? `\n   Correction: ${e.correction}` : ''}`
    ).join('\n\n');
    return textResult(report);
  },
);


// ── Memory Transparency: memory_correct ─────────────────────────────────

server.tool(
  'memory_correct',
  'Correct or dismiss a memory extraction. Use when the owner says something learned was wrong.',
  {
    id: z.number().describe('Extraction ID from memory_report'),
    action: z.enum(['correct', 'dismiss']).describe('Whether to correct (replace with accurate fact) or dismiss (mark as invalid)'),
    correction: z.string().optional().describe('The corrected fact (required if action is "correct")'),
  },
  async ({ id, action, correction }) => {
    const store = await getStore();
    if (action === 'correct') {
      if (!correction) return textResult('Correction text required when action is "correct".');
      // correctExtraction now also removes the wrong content from the search index
      store.correctExtraction(id, correction);
      return textResult(`Extraction #${id} corrected and removed from search index. Corrected fact: ${correction}`);
    } else {
      // dismissExtraction now also removes the content from the search index
      store.dismissExtraction(id);
      return textResult(`Extraction #${id} dismissed and removed from search index.`);
    }
  },
);


// ── Memory Consolidation: memory_consolidate ────────────────────────────

server.tool(
  'memory_consolidate',
  'Get memory chunks that are candidates for consolidation, or mark chunks as consolidated after synthesis. Use this in weekly memory maintenance.',
  {
    action: z.enum(['candidates', 'mark_consolidated']).describe(
      '"candidates" returns groups of old chunks to consolidate. "mark_consolidated" marks chunks as archived after you\'ve written a summary.'
    ),
    min_age_days: z.number().optional().describe('Minimum age in days for consolidation candidates (default: 30)'),
    chunk_ids: z.array(z.number()).optional().describe('Chunk IDs to mark as consolidated (required for mark_consolidated)'),
  },
  async ({ action, min_age_days, chunk_ids }) => {
    const store = await getStore();

    if (action === 'candidates') {
      const groups = store.getConsolidationCandidates(min_age_days ?? 30);
      if (groups.length === 0) {
        const stats = store.getConsolidationStats();
        return textResult(`No consolidation candidates found (${stats.totalChunks} total chunks, ${stats.consolidated} already consolidated).`);
      }

      const report = groups.slice(0, 10).map((g) => {
        const preview = g.contents.slice(0, 3).map(c => `  - ${c.slice(0, 120)}`).join('\n');
        return `**${g.topic}** (${g.chunkIds.length} chunks, ${g.totalChars} chars)\n${preview}${g.contents.length > 3 ? `\n  ... and ${g.contents.length - 3} more` : ''}`;
      }).join('\n\n');

      const stats = store.getConsolidationStats();
      return textResult(
        `Found ${groups.length} topic group(s) ready for consolidation.\n` +
        `Stats: ${stats.totalChunks} total, ${stats.consolidated} consolidated, ${stats.unconsolidated} unconsolidated.\n\n` +
        `${report}\n\n` +
        `To consolidate: read the chunks, write a summary note, then call memory_consolidate(action="mark_consolidated", chunk_ids=[...]) with the original chunk IDs.`
      );
    }

    if (action === 'mark_consolidated') {
      if (!chunk_ids || chunk_ids.length === 0) {
        return textResult('Error: chunk_ids required for mark_consolidated action.');
      }
      store.markConsolidated(chunk_ids);
      return textResult(`Marked ${chunk_ids.length} chunk(s) as consolidated (salience reduced).`);
    }

    return textResult('Unknown action.');
  },
);


// ── Graph Memory Tools ─────────────────────────────────────────────────

const GRAPH_DB_DIR = path.join(BASE_DIR, '.graph.db');

let _graphStore: any = null;
async function getGraphStore(): Promise<any> {
  if (_graphStore?.isAvailable()) return _graphStore;
  try {
    const { getSharedGraphStore } = await import('../memory/graph-store.js');
    _graphStore = await getSharedGraphStore(GRAPH_DB_DIR);
    return _graphStore;
  } catch {
    return null;
  }
}

server.tool(
  'memory_graph_query',
  'Run a Cypher query against the knowledge graph. Returns entities and relationships. Use for complex graph traversals.',
  {
    query: z.string().describe('Cypher query (e.g., MATCH (p:Person)-[:WORKS_ON]->(proj:Project) RETURN p.id, proj.id)'),
  },
  async ({ query }) => {
    const gs = await getGraphStore();
    if (!gs?.isAvailable()) {
      return textResult('Graph features are not available. The knowledge graph has not been initialized.');
    }
    const results = await gs.query(query);
    if (results.length === 0) return textResult('No results.');
    const formatted = results.map((row: any) =>
      typeof row === 'object' ? Object.values(row).map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' | ') : String(row)
    ).join('\n');
    return textResult(formatted);
  },
);

server.tool(
  'memory_graph_connections',
  'Find entities connected to a given entity in the knowledge graph. Supports multi-hop traversal with typed relationships. Use as_of for point-in-time queries.',
  {
    entity: z.string().describe('Entity ID (slug) to find connections for'),
    max_hops: z.number().optional().describe('Maximum traversal depth (default: 2)'),
    relationship_types: z.array(z.string()).optional().describe('Filter by relationship types (e.g., ["WORKS_ON", "KNOWS"])'),
    as_of: z.string().optional().describe('ISO timestamp for point-in-time query (e.g., "2026-01-15T00:00:00Z"). Only shows relationships active at that time.'),
  },
  async ({ entity, max_hops, relationship_types, as_of }) => {
    const gs = await getGraphStore();
    if (!gs?.isAvailable()) {
      return textResult('Graph features are not available. The knowledge graph has not been initialized.');
    }
    const results = await gs.traverse(entity, max_hops ?? 2, relationship_types, as_of);
    if (results.length === 0) return textResult(`No connections found for '${entity}'.`);
    const lines = results.map((r: any) =>
      `[depth ${r.depth}] ${r.entity.label}:${r.entity.id} (via ${r.path.join(' → ')})`
    );
    return textResult(`Connections for '${entity}':\n${lines.join('\n')}`);
  },
);

server.tool(
  'memory_graph_path',
  'Find the shortest path between two entities in the knowledge graph. Shows how they are connected.',
  {
    from: z.string().describe('Source entity ID (slug)'),
    to: z.string().describe('Target entity ID (slug)'),
  },
  async ({ from, to }) => {
    const gs = await getGraphStore();
    if (!gs?.isAvailable()) {
      return textResult('Graph features are not available. The knowledge graph has not been initialized.');
    }
    const result = await gs.shortestPath(from, to);
    if (!result) return textResult(`No path found between '${from}' and '${to}'.`);
    const chain = result.nodes.map((n: any, i: number) => {
      const rel = result.relationships[i];
      return rel ? `${n.id} -[${rel}]->` : n.id;
    }).join(' ');
    return textResult(`Path (${result.length} hops): ${chain}`);
  },
);

server.tool(
  'promote_memory_to_global',
  'Promote one of your private memories to global shared memory, making it visible to all agents. ' +
  'Use when you have learned something universally useful that other agents should also know. ' +
  'Requires a chunk ID (from memory_search results). Owner is notified of all promotions.',
  {
    chunk_id: z.number().describe('ID of the memory chunk to promote (from memory_search results)'),
    reason: z.string().describe('Why this insight is worth sharing globally — shown in the audit log'),
  },
  async ({ chunk_id, reason }) => {
    const store = await getStore();
    if (!store) return textResult('Memory store not available.');

    const result = store.promoteToGlobal(chunk_id, ACTIVE_AGENT_SLUG ?? 'unknown');
    logger.info({ chunkId: chunk_id, promotedBy: ACTIVE_AGENT_SLUG, reason }, 'Memory promoted to global');
    return textResult(`${result}\n\nReason: ${reason}`);
  },
);

server.tool(
  'memory_graph_invalidate',
  'Mark a relationship as no longer active by setting its end date. Use when a fact changes (e.g., someone leaves a company).',
  {
    from_entity: z.string().describe('Source entity ID (slug)'),
    to_entity: z.string().describe('Target entity ID (slug)'),
    relationship_type: z.string().describe('Relationship type (e.g., WORKS_AT)'),
    as_of: z.string().optional().describe('ISO timestamp when relationship ended (defaults to now)'),
  },
  async ({ from_entity, to_entity, relationship_type, as_of }) => {
    const gs = await getGraphStore();
    if (!gs?.isAvailable()) {
      return textResult('Graph features are not available. The knowledge graph has not been initialized.');
    }
    const updated = await gs.invalidateRelationship(from_entity, to_entity, relationship_type, as_of);
    if (updated) {
      return textResult(`Invalidated ${from_entity} -[${relationship_type}]-> ${to_entity} (ended ${as_of ?? 'now'})`);
    }
    return textResult(`No active ${relationship_type} relationship found between '${from_entity}' and '${to_entity}'.`);
  },
);


}
