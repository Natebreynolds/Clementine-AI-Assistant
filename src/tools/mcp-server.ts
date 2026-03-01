/**
 * Clementine TypeScript — Standalone MCP stdio server for memory and task tools.
 *
 * Runs as a child process. The Claude CLI connects via stdio transport.
 *
 * Usage:
 *   npx tsx src/tools/mcp-server.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';
import { z } from 'zod';

// ── Resolve paths ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');

// Read .env locally — never pollute process.env with secrets
function readEnvFile(): Record<string, string> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
const env = readEnvFile();

const VAULT_DIR = path.join(BASE_DIR, 'vault');
const SYSTEM_DIR = path.join(VAULT_DIR, '00-System');
const DAILY_NOTES_DIR = path.join(VAULT_DIR, '01-Daily-Notes');
const PEOPLE_DIR = path.join(VAULT_DIR, '02-People');
const PROJECTS_DIR = path.join(VAULT_DIR, '03-Projects');
const TOPICS_DIR = path.join(VAULT_DIR, '04-Topics');
const TASKS_DIR = path.join(VAULT_DIR, '05-Tasks');
const TEMPLATES_DIR = path.join(VAULT_DIR, '06-Templates');
const INBOX_DIR = path.join(VAULT_DIR, '07-Inbox');

const MEMORY_FILE = path.join(SYSTEM_DIR, 'MEMORY.md');
const TASKS_FILE = path.join(TASKS_DIR, 'TASKS.md');
const SOUL_FILE = path.join(SYSTEM_DIR, 'SOUL.md');
const HEARTBEAT_FILE = path.join(SYSTEM_DIR, 'HEARTBEAT.md');
const CRON_FILE = path.join(SYSTEM_DIR, 'CRON.md');

// Log to stderr so stdout stays clean for MCP stdio
const logger = pino(
  { name: 'clementine.mcp', level: process.env.LOG_LEVEL ?? 'info' },
  pino.destination(2),
);

// ── Lazy memory store ──────────────────────────────────────────────────

// Dynamic import to avoid circular dependency / init issues
type MemoryStoreType = {
  searchFts(query: string, limit: number): unknown[];
  getRecentChunks(limit: number): unknown[];
  searchContext(query: string, limit?: number, recencyLimit?: number): unknown[];
  getConnections(noteName: string): Array<{ direction: string; file: string; context: string }>;
  getTimeline(startDate: string, endDate: string, limit?: number): unknown[];
  searchTranscripts(query: string, limit?: number, sessionKey?: string): Array<{
    sessionKey: string; role: string; content: string; model: string; createdAt: string;
  }>;
  fullSync(): { filesScanned: number; filesUpdated: number; filesDeleted: number; chunksTotal: number };
  updateFile(relPath: string): void;
  recordAccess(chunkIds: number[]): void;
  decaySalience(halfLifeDays?: number): number;
  pruneStaleData(opts?: {
    maxAgeDays?: number; salienceThreshold?: number;
    accessLogRetentionDays?: number; transcriptRetentionDays?: number;
  }): { episodicPruned: number; accessLogPruned: number; transcriptsPruned: number };
  db: unknown;
};

let _store: MemoryStoreType | null = null;

async function getStore(): Promise<MemoryStoreType> {
  if (_store) return _store;
  const { MemoryStore } = await import('../memory/store.js');
  const store = new MemoryStore(path.join(VAULT_DIR, '.memory.db'), VAULT_DIR);
  store.initialize();
  _store = store as unknown as MemoryStoreType;
  return _store;
}

// ── Helpers ────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function timeOfDaySection(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

/** Resolve a vault note name/shortcut to an absolute path. */
function resolvePath(name: string): string {
  const shortcuts: Record<string, string> = {
    today: path.join(DAILY_NOTES_DIR, `${todayStr()}.md`),
    yesterday: path.join(DAILY_NOTES_DIR, `${yesterdayStr()}.md`),
    memory: MEMORY_FILE,
    tasks: TASKS_FILE,
    heartbeat: HEARTBEAT_FILE,
    cron: CRON_FILE,
    soul: SOUL_FILE,
  };

  const key = name.toLowerCase();
  if (shortcuts[key]) return shortcuts[key];

  // Direct path within vault
  const vaultPath = path.join(VAULT_DIR, name);
  if (existsSync(vaultPath)) return vaultPath;

  // Try appending .md
  if (!name.endsWith('.md')) {
    const withMd = path.join(VAULT_DIR, `${name}.md`);
    if (existsSync(withMd)) return withMd;
  }

  // Recursive search by stem (case-insensitive)
  const found = findByName(VAULT_DIR, name.toLowerCase());
  if (found) return found;

  return vaultPath;
}

/** Recursively search for a .md file by stem (case-insensitive). */
function findByName(dir: string, nameLower: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.obsidian' || entry.name === 'node_modules') continue;
        const found = findByName(fullPath, nameLower);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stem = entry.name.replace(/\.md$/, '').toLowerCase();
        if (stem === nameLower) return fullPath;
      }
    }
  } catch {
    // ignore read errors
  }
  return null;
}

/** Ensure the daily note exists for a given date, creating from template if needed. */
function ensureDailyNote(dateStr?: string): string {
  const d = dateStr ?? todayStr();
  const notePath = path.join(DAILY_NOTES_DIR, `${d}.md`);

  if (!existsSync(notePath)) {
    mkdirSync(DAILY_NOTES_DIR, { recursive: true });
    const content = `---
type: daily-note
date: "${d}"
tags:
  - daily
---

# ${d}

## Morning

## Afternoon

## Evening

## Interactions

## Summary
`;
    writeFileSync(notePath, content, 'utf-8');
  }
  return notePath;
}

/** Map note_type to vault folder. */
function folderForType(noteType: string): string {
  const map: Record<string, string> = {
    person: PEOPLE_DIR,
    people: PEOPLE_DIR,
    project: PROJECTS_DIR,
    topic: TOPICS_DIR,
    task: TASKS_DIR,
    inbox: INBOX_DIR,
  };
  return map[noteType.toLowerCase()] ?? INBOX_DIR;
}

/** Validate that a resolved path stays within the vault. */
function validateVaultPath(relPath: string): string {
  const full = path.resolve(VAULT_DIR, relPath);
  const vaultResolved = path.resolve(VAULT_DIR);
  if (!full.startsWith(vaultResolved + path.sep) && full !== vaultResolved) {
    throw new Error(`Path traversal blocked: ${relPath}`);
  }
  return full;
}

/** Incremental re-index after a write. Non-fatal on failure. */
async function incrementalSync(relPath: string): Promise<void> {
  try {
    const store = await getStore();
    store.updateFile(relPath);
  } catch (err) {
    logger.warn({ err, relPath }, 'Incremental sync failed');
  }
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ── Task parsing ───────────────────────────────────────────────────────

const TASK_ID_RE = /\{T-(\d+(?:\.\d+)?)\}/;
const TASK_ID_RE_G = /\{T-(\d+(?:\.\d+)?)\}/g;
const TASK_LINE_RE = /^(\s*)- \[([ xX])\]\s+(.+)$/;

interface ParsedTask {
  id: string;
  text: string;
  status: string;
  priority: string;
  due: string;
  project: string;
  recurrence: string;
  tags: string[];
  checked: boolean;
  indent: string;
  rawLine: string;
  isSubtask: boolean;
}

function parseTasks(body: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let currentStatus = 'unknown';

  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s.startsWith('## Pending')) { currentStatus = 'pending'; continue; }
    if (s.startsWith('## In Progress')) { currentStatus = 'in-progress'; continue; }
    if (s.startsWith('## Completed')) { currentStatus = 'completed'; continue; }

    const m = TASK_LINE_RE.exec(line);
    if (!m) continue;

    const indent = m[1];
    const checked = m[2].toLowerCase() === 'x';
    const text = m[3];
    const status = checked ? 'completed' : currentStatus;

    const idMatch = TASK_ID_RE.exec(text);
    const taskId = idMatch ? idMatch[1] : '';

    const priMatch = /!!(low|normal|high|urgent)/.exec(text);
    const priority = priMatch ? priMatch[1] : 'normal';

    const dueMatch = /📅\s*(\d{4}-\d{2}-\d{2})/.exec(text);
    const due = dueMatch ? dueMatch[1] : '';

    const projMatch = /#project:(\S+)/.exec(text);
    const project = projMatch ? projMatch[1] : '';

    const recMatch = /🔁\s*(\S+)/.exec(text);
    const recurrence = recMatch ? recMatch[1] : '';

    const tagMatches = text.match(/#(\S+)/g) ?? [];
    const tags = tagMatches
      .map(t => t.slice(1))
      .filter(t => !t.startsWith('project:'));

    tasks.push({
      id: taskId,
      text,
      status,
      priority,
      due,
      project,
      recurrence,
      tags,
      checked,
      indent,
      rawLine: line,
      isSubtask: indent.length >= 2,
    });
  }

  return tasks;
}

function nextTaskId(body: string): string {
  let maxId = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(TASK_ID_RE_G.source, 'g');
  while ((m = re.exec(body)) !== null) {
    const idStr = m[1];
    if (!idStr.includes('.')) {
      maxId = Math.max(maxId, parseInt(idStr, 10));
    }
  }
  return `T-${String(maxId + 1).padStart(3, '0')}`;
}

function nextSubtaskId(body: string, parentId: string): string {
  let maxSub = 0;
  const re = new RegExp(`\\{T-${parentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    maxSub = Math.max(maxSub, parseInt(m[1], 10));
  }
  return `T-${parentId}.${maxSub + 1}`;
}

function nextDueDate(currentDue: string, recurrence: string): string {
  let current: Date;
  try {
    current = new Date(currentDue + 'T00:00:00');
    if (isNaN(current.getTime())) throw new Error();
  } catch {
    current = new Date();
  }

  let next: Date;
  switch (recurrence) {
    case 'daily':
      next = new Date(current);
      next.setDate(next.getDate() + 1);
      break;
    case 'weekdays':
      next = new Date(current);
      next.setDate(next.getDate() + 1);
      while (next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
      }
      break;
    case 'weekly':
      next = new Date(current);
      next.setDate(next.getDate() + 7);
      break;
    case 'biweekly':
      next = new Date(current);
      next.setDate(next.getDate() + 14);
      break;
    case 'monthly': {
      let month = current.getMonth() + 1;
      let year = current.getFullYear();
      if (month > 11) { month = 0; year += 1; }
      const day = Math.min(current.getDate(), 28);
      next = new Date(year, month, day);
      break;
    }
    default:
      next = new Date(current);
      next.setDate(next.getDate() + 7);
  }

  return next.toISOString().slice(0, 10);
}

// ── Glob all .md files recursively (excluding .obsidian) ──────────────

function globMd(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.obsidian' || entry.name === 'node_modules') continue;
        results.push(...globMd(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

// ── Server ─────────────────────────────────────────────────────────────

const serverName = (env['ASSISTANT_NAME'] ?? 'Clementine').toLowerCase() + '-tools';
const server = new McpServer({ name: serverName, version: '1.0.0' });

// ── 1. memory_read ─────────────────────────────────────────────────────

server.tool(
  'memory_read',
  "Read a note from the Obsidian vault. Shortcuts: 'today', 'yesterday', 'memory', 'tasks', 'heartbeat', 'cron', 'soul'. Or pass a relative path or note name.",
  { name: z.string().describe('Note name, path, or shortcut') },
  async ({ name }) => {
    const filePath = resolvePath(name);
    if (!existsSync(filePath)) {
      return textResult(`Note not found: ${name}`);
    }
    const content = readFileSync(filePath, 'utf-8');
    const rel = path.relative(VAULT_DIR, filePath);
    return textResult(`**${rel}:**\n\n${content}`);
  },
);

// ── 2. memory_write ────────────────────────────────────────────────────

server.tool(
  'memory_write',
  "Write or append to a vault note. Actions: 'append_daily' (add to today's log), 'update_memory' (update MEMORY.md section), 'write_note' (write/overwrite a note).",
  {
    action: z.enum(['append_daily', 'update_memory', 'write_note']).describe('Write action'),
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
      await incrementalSync(rel);
      return textResult(`Appended to ${path.basename(dailyPath)} > ${sec}`);
    }

    if (action === 'update_memory') {
      const sec = section ?? '';
      if (!sec) return textResult("Error: 'section' required for update_memory");

      let body = readFileSync(MEMORY_FILE, 'utf-8');

      const pattern = new RegExp(`(## ${sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)(.*?)(\\n## |$)`, 's');
      const match = pattern.exec(body);

      if (match) {
        const existingContent = match[2].trim();
        const existingLines = existingContent.split('\n').map(l => l.trim()).filter(Boolean);
        const newLines = content.split('\n').map(l => l.trim()).filter(Boolean);

        // Simple dedup: skip lines that are very similar to existing ones
        const filtered: string[] = [];
        const skipped: string[] = [];
        for (const newLine of newLines) {
          const isDup = existingLines.some(ex => {
            const a = newLine.toLowerCase();
            const b = ex.toLowerCase();
            return a === b || (a.length > 10 && b.includes(a.slice(0, Math.floor(a.length * 0.8))));
          });
          if (isDup) {
            skipped.push(newLine);
          } else {
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

      writeFileSync(MEMORY_FILE, body, 'utf-8');
      const rel = path.relative(VAULT_DIR, MEMORY_FILE);
      await incrementalSync(rel);
      return textResult(`Updated MEMORY.md > ${sec}`);
    }

    if (action === 'write_note') {
      const relPath = file_path ?? '';
      if (!relPath) return textResult("Error: 'file_path' required for write_note");

      const full = validateVaultPath(relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
      await incrementalSync(relPath);
      return textResult(`Wrote: ${relPath}`);
    }

    return textResult(`Unknown action: ${action}`);
  },
);

// ── 3. memory_search ───────────────────────────────────────────────────

server.tool(
  'memory_search',
  'FTS5 search across all vault notes. Returns matching chunks with relevance scores.',
  {
    query: z.string().describe('Search text'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ query, limit }) => {
    const maxResults = limit ?? 20;

    try {
      const store = await getStore();
      const results = (store.searchFts(query, maxResults) as Array<{
        sourceFile: string; section: string; content: string; score: number;
      }>);

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
  'Context retrieval combining FTS5 relevance + recency search. Better than memory_search for finding related content by meaning.',
  {
    query: z.string().describe('Natural language search query'),
  },
  async ({ query }) => {
    const store = await getStore();
    const results = store.searchContext(query) as Array<{
      sourceFile: string; section: string; content: string; score: number;
      matchType: string; chunkId: number;
    }>;

    if (!results.length) {
      return textResult(`No results for: ${query}`);
    }

    // Record access for salience tracking
    const chunkIds = results.map(r => r.chunkId).filter(Boolean);
    if (chunkIds.length) store.recordAccess(chunkIds);

    const lines = results.map(r => {
      const label = `[${r.matchType}]`;
      const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
      return `**${r.sourceFile} > ${r.section}** ${label} (score: ${r.score.toFixed(3)})\n${preview}\n`;
    });

    return textResult(lines.join('\n'));
  },
);

// ── 5. note_create ─────────────────────────────────────────────────────

server.tool(
  'note_create',
  'Create a new note in the right vault folder. Types: person, project, topic, task, inbox.',
  {
    note_type: z.enum(['person', 'project', 'topic', 'task', 'inbox']).describe('Note type'),
    title: z.string().describe('Note title'),
    content: z.string().optional().describe('Initial body content'),
  },
  async ({ note_type, title, content }) => {
    const folder = folderForType(note_type);
    mkdirSync(folder, { recursive: true });

    const safe = title.replace(/[<>:"/\\|?*]/g, '');
    const notePath = path.join(folder, `${safe}.md`);
    const relPath = path.relative(VAULT_DIR, notePath);

    validateVaultPath(relPath);

    if (existsSync(notePath)) {
      return textResult(`Already exists: ${relPath}`);
    }

    const body = content ?? `# ${title}\n`;
    const noteContent = `---
type: ${note_type}
created: "${todayStr()}"
tags:
  - ${note_type}
---

${body}
`;
    writeFileSync(notePath, noteContent, 'utf-8');
    await incrementalSync(relPath);
    return textResult(`Created [[${safe}]] at ${relPath}`);
  },
);

// ── 6. task_list ───────────────────────────────────────────────────────

server.tool(
  'task_list',
  'List tasks from the master task list. Tasks have IDs like {T-001}.',
  {
    status: z.enum(['all', 'pending', 'completed']).optional().describe('Filter by status'),
    project: z.string().optional().describe('Filter by project tag'),
  },
  async ({ status, project }) => {
    const statusFilter = status ?? 'all';
    const projectFilter = project ?? '';

    if (!existsSync(TASKS_FILE)) {
      return textResult('No task list found.');
    }

    const body = readFileSync(TASKS_FILE, 'utf-8');
    const allTasks = parseTasks(body);
    let filtered = allTasks;

    if (statusFilter !== 'all') {
      filtered = filtered.filter(t => t.status === statusFilter);
    }
    if (projectFilter) {
      filtered = filtered.filter(t => t.project.toLowerCase() === projectFilter.toLowerCase());
    }

    if (!filtered.length) {
      const parts: string[] = [statusFilter];
      if (projectFilter) parts.push(`project:${projectFilter}`);
      return textResult(`No tasks matching: ${parts.join(', ')}`);
    }

    const lines = filtered.map(t => t.rawLine);
    let header = `**Tasks (${statusFilter})`;
    if (projectFilter) header += `, project:${projectFilter}`;
    header += ` — ${filtered.length} results:**`;

    return textResult(`${header}\n\n${lines.join('\n')}`);
  },
);

// ── 7. task_add ────────────────────────────────────────────────────────

server.tool(
  'task_add',
  'Add a new task to the master task list. Auto-generates a {T-NNN} ID.',
  {
    description: z.string().describe('Task description'),
    priority: z.enum(['high', 'medium', 'low']).optional().describe('Task priority'),
    due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
    project: z.string().optional().describe('Project name'),
  },
  async ({ description, priority, due_date, project }) => {
    if (!existsSync(TASKS_FILE)) {
      mkdirSync(TASKS_DIR, { recursive: true });
      writeFileSync(TASKS_FILE, `---
type: tasks
---

# Tasks

## Pending

## In Progress

## Completed
`, 'utf-8');
    }

    let body = readFileSync(TASKS_FILE, 'utf-8');
    const taskId = nextTaskId(body);

    // Build metadata suffix
    let meta = '';
    if (priority && priority !== 'medium') {
      meta += ` !!${priority}`;
    }
    if (due_date) {
      meta += ` 📅 ${due_date}`;
    }
    if (project) {
      meta += ` #project:${project}`;
    }

    const taskLine = `- [ ] {${taskId}} ${description}${meta}`;

    const pendingMatch = /## Pending\n/.exec(body);
    if (pendingMatch) {
      const insertPos = pendingMatch.index + pendingMatch[0].length;
      body = body.slice(0, insertPos) + `\n${taskLine}` + body.slice(insertPos);
    } else {
      body += `\n## Pending\n\n${taskLine}\n`;
    }

    writeFileSync(TASKS_FILE, body, 'utf-8');
    const rel = path.relative(VAULT_DIR, TASKS_FILE);
    await incrementalSync(rel);
    return textResult(`Added task {${taskId}}: ${description}`);
  },
);

// ── 8. task_update ─────────────────────────────────────────────────────

server.tool(
  'task_update',
  "Update a task's status or metadata by {T-NNN} ID.",
  {
    task_id: z.string().describe('Task ID like T-001'),
    status: z.enum(['pending', 'completed']).optional().describe('New status'),
    description: z.string().optional().describe('New description text'),
    priority: z.string().optional().describe('New priority'),
    due_date: z.string().optional().describe('New due date (YYYY-MM-DD)'),
  },
  async ({ task_id, status, description: newDesc, priority: newPriority, due_date: newDue }) => {
    if (!existsSync(TASKS_FILE)) {
      return textResult('No task list found.');
    }

    let body = readFileSync(TASKS_FILE, 'utf-8');
    const lines = body.split('\n');

    // Normalize task ID
    let taskIdClean = task_id.replace(/[{}]/g, '');
    if (!taskIdClean.startsWith('T-')) taskIdClean = `T-${taskIdClean}`;
    const searchPattern = `{${taskIdClean}}`;

    // Find the task line
    let foundIdx: number | null = null;
    let foundLine = '';

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*- \[[ xX]\]/.test(lines[i]) && lines[i].includes(searchPattern)) {
        foundIdx = i;
        foundLine = lines[i].trim();
        break;
      }
    }

    if (foundIdx === null) {
      return textResult(`Task not found: ${task_id}`);
    }

    // Check for recurrence before modifying
    const recMatch = /🔁\s*(\S+)/.exec(foundLine);
    const dueMatch = /📅\s*(\d{4}-\d{2}-\d{2})/.exec(foundLine);

    // Apply metadata changes
    if (newPriority) {
      if (/!!(low|normal|high|urgent)/.test(foundLine)) {
        foundLine = foundLine.replace(/!!(low|normal|high|urgent)/, `!!${newPriority}`);
      } else if (newPriority !== 'normal') {
        const idM = TASK_ID_RE.exec(foundLine);
        if (idM) {
          const pos = (idM.index ?? 0) + idM[0].length;
          foundLine = foundLine.slice(0, pos) + ` !!${newPriority}` + foundLine.slice(pos);
        }
      }
    }

    if (newDue) {
      if (/📅\s*\d{4}-\d{2}-\d{2}/.test(foundLine)) {
        foundLine = foundLine.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${newDue}`);
      } else {
        foundLine += ` 📅 ${newDue}`;
      }
    }

    // Update checkbox
    const newStatus = status ?? 'pending';
    lines.splice(foundIdx, 1);

    if (newStatus === 'completed') {
      foundLine = foundLine.replace(/- \[ \]/, '- [x]');
    } else {
      foundLine = foundLine.replace(/- \[[xX]\]/, '- [ ]');
    }

    // Move to the right section
    const headers: Record<string, string> = {
      pending: '## Pending',
      'in-progress': '## In Progress',
      completed: '## Completed',
    };
    const target = headers[newStatus] ?? '## Pending';

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === target) {
        let insertAt = i + 1;
        if (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
        // Remove placeholder if present
        if (insertAt < lines.length && lines[insertAt].trim().startsWith('*(')) {
          lines.splice(insertAt, 1);
        }
        lines.splice(insertAt, 0, foundLine);
        break;
      }
    }

    body = lines.join('\n');

    // Handle recurring task: create new copy with next due date
    let recurringMsg = '';
    if (newStatus === 'completed' && recMatch && dueMatch) {
      const recurrence = recMatch[1];
      const currentDue = dueMatch[1];
      const nextDue = nextDueDate(currentDue, recurrence);
      const newId = nextTaskId(body);

      let newLine = foundLine;
      newLine = newLine.replace(/- \[[xX]\]/, '- [ ]');
      newLine = newLine.replace(TASK_ID_RE, `{${newId}}`);
      newLine = newLine.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${nextDue}`);

      const pMatch = /## Pending\n/.exec(body);
      if (pMatch) {
        const insertPos = pMatch.index + pMatch[0].length;
        body = body.slice(0, insertPos) + `\n${newLine}` + body.slice(insertPos);
      }
      recurringMsg = ` | Next occurrence {${newId}} due ${nextDue}`;
    }

    writeFileSync(TASKS_FILE, body, 'utf-8');
    const rel = path.relative(VAULT_DIR, TASKS_FILE);
    await incrementalSync(rel);
    return textResult(`Moved to ${newStatus}: ${task_id}${recurringMsg}`);
  },
);

// ── 9. vault_stats ─────────────────────────────────────────────────────

server.tool(
  'vault_stats',
  'Quick dashboard of vault health — note counts, task counts, memory size, recent activity.',
  {},
  async () => {
    const lines = ['**Vault Dashboard:**\n'];

    // Note counts by folder
    const folders = [
      SYSTEM_DIR, DAILY_NOTES_DIR, PEOPLE_DIR, PROJECTS_DIR,
      TOPICS_DIR, TASKS_DIR, TEMPLATES_DIR, INBOX_DIR,
    ];

    lines.push('**Notes by folder:**');
    for (const folder of folders) {
      if (existsSync(folder)) {
        try {
          const count = readdirSync(folder).filter(f => f.endsWith('.md')).length;
          lines.push(`  - ${path.basename(folder)}: ${count}`);
        } catch {
          // skip
        }
      }
    }

    // Task counts
    if (existsSync(TASKS_FILE)) {
      const body = readFileSync(TASKS_FILE, 'utf-8');
      const tasks = parseTasks(body);
      const statusCounts: Record<string, number> = {};
      let overdue = 0;
      const today = todayStr();

      for (const t of tasks) {
        statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
        if (t.due && t.due < today && !t.checked) overdue++;
      }

      lines.push('\n**Tasks:**');
      for (const [st, count] of Object.entries(statusCounts).sort()) {
        lines.push(`  - ${st}: ${count}`);
      }
      if (overdue) lines.push(`  - **OVERDUE: ${overdue}**`);
    }

    // MEMORY.md size
    if (existsSync(MEMORY_FILE)) {
      const memContent = readFileSync(MEMORY_FILE, 'utf-8');
      const memLines = memContent.split('\n').length;
      const memChars = memContent.length;
      lines.push(`\n**MEMORY.md:** ${memLines} lines, ${memChars.toLocaleString()} chars`);
    }

    // 5 most recently modified notes
    const allNotes = globMd(VAULT_DIR)
      .filter(f => !f.includes('06-Templates'))
      .map(f => ({ path: f, mtime: statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    if (allNotes.length) {
      lines.push('\n**Recently modified:**');
      for (const note of allNotes) {
        const rel = path.relative(VAULT_DIR, note.path);
        const mtime = new Date(note.mtime).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`  - ${rel} (${mtime})`);
      }
    }

    // Inbox count
    if (existsSync(INBOX_DIR)) {
      try {
        const inboxCount = readdirSync(INBOX_DIR).filter(f => f.endsWith('.md')).length;
        lines.push(`\n**Inbox items:** ${inboxCount}`);
      } catch {
        // skip
      }
    }

    // Chunk count from store
    try {
      const store = await getStore();
      const db = store.db as { prepare(sql: string): { get(): Record<string, number> | undefined } };
      const row = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get();
      if (row) lines.push(`\n**Indexed chunks:** ${row.cnt}`);
    } catch {
      // store may not be initialized
    }

    return textResult(lines.join('\n'));
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

// ── 13. daily_note ─────────────────────────────────────────────────────

server.tool(
  'daily_note',
  "Create or read today's daily note.",
  {
    action: z.enum(['read', 'create']).optional().describe("'read' or 'create' (default: read)"),
  },
  async ({ action }) => {
    const act = action ?? 'read';

    if (act === 'create') {
      const notePath = ensureDailyNote();
      const rel = path.relative(VAULT_DIR, notePath);
      await incrementalSync(rel);
      return textResult(`Daily note ready: ${rel}`);
    }

    // read
    const notePath = path.join(DAILY_NOTES_DIR, `${todayStr()}.md`);
    if (!existsSync(notePath)) {
      return textResult(`No daily note for today (${todayStr()}). Use action 'create' to create one.`);
    }
    const content = readFileSync(notePath, 'utf-8');
    return textResult(`**${todayStr()}.md:**\n\n${content}`);
  },
);

// ── 12. note_take ──────────────────────────────────────────────────────

server.tool(
  'note_take',
  "Quick capture a timestamped note to today's daily log.",
  {
    text: z.string().describe('Note text'),
  },
  async ({ text }) => {
    const section = timeOfDaySection();
    const dailyPath = ensureDailyNote();
    let body = readFileSync(dailyPath, 'utf-8');

    const timestamp = nowTime();
    const entry = `\n- **${timestamp}** — ${text}`;

    const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(## ${escapedSection}.*?)(\\n## |$)`, 's');
    const match = pattern.exec(body);
    if (match) {
      body = body.slice(0, match.index + match[1].length) + entry + body.slice(match.index + match[1].length);
    } else {
      body += `\n\n## ${section}${entry}`;
    }

    writeFileSync(dailyPath, body, 'utf-8');
    const rel = path.relative(VAULT_DIR, dailyPath);
    await incrementalSync(rel);
    return textResult(`Noted in ${path.basename(dailyPath)} > ${section}`);
  },
);

// ── 13. rss_fetch ──────────────────────────────────────────────────────

server.tool(
  'rss_fetch',
  'Fetch and parse RSS feeds. Returns recent articles with titles, links, dates, and summaries.',
  {
    feed_url: z.string().optional().describe('Single RSS feed URL (optional — if omitted, reads from RSS-FEEDS.md)'),
  },
  async ({ feed_url }) => {
    const feedsToFetch: Array<{ name: string; url: string }> = [];

    if (feed_url) {
      feedsToFetch.push({ name: 'Custom Feed', url: feed_url });
    } else {
      // Read feeds from RSS-FEEDS.md
      const rssConfig = path.join(SYSTEM_DIR, 'RSS-FEEDS.md');
      if (!existsSync(rssConfig)) {
        return textResult('Error: vault/00-System/RSS-FEEDS.md not found.');
      }
      try {
        const matter = await import('gray-matter');
        const parsed = matter.default(readFileSync(rssConfig, 'utf-8'));
        const feeds = (parsed.data?.feeds ?? []) as Array<{ name?: string; url: string; enabled?: boolean }>;
        for (const feed of feeds) {
          if (feed.enabled !== false) {
            feedsToFetch.push({ name: feed.name ?? 'Unnamed', url: feed.url });
          }
        }
      } catch (err) {
        return textResult(`Error reading RSS-FEEDS.md: ${err}`);
      }
    }

    if (!feedsToFetch.length) {
      return textResult('No enabled feeds found in RSS-FEEDS.md.');
    }

    const allResults: string[] = [];

    for (const feedInfo of feedsToFetch) {
      try {
        const response = await fetch(feedInfo.url, {
          headers: { 'User-Agent': 'Clementine/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          allResults.push(`**${feedInfo.name}** — Error: HTTP ${response.status}`);
          continue;
        }

        const xml = await response.text();

        // Simple XML parsing for RSS/Atom items
        const items = parseRssXml(xml);
        if (!items.length) {
          allResults.push(`**${feedInfo.name}** — No articles found`);
          continue;
        }

        const limited = items.slice(0, 10);
        const lines = [`**${feedInfo.name}** (${limited.length} articles):`];
        for (const item of limited) {
          let line = `- **${item.title}**`;
          if (item.pubDate) line += ` (${item.pubDate})`;
          if (item.link) line += `\n  Link: ${item.link}`;
          if (item.summary) line += `\n  ${item.summary.slice(0, 200)}`;
          lines.push(line);
        }
        allResults.push(lines.join('\n'));
      } catch (err) {
        allResults.push(`**${feedInfo.name}** — Error fetching feed: ${err}`);
      }
    }

    return textResult(allResults.join('\n\n---\n\n'));
  },
);

/** Simple RSS/Atom XML parser (no external dependency). */
function parseRssXml(xml: string): Array<{ title: string; link: string; pubDate: string; summary: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; summary: string }> = [];

  // Try RSS <item> first, then Atom <entry>
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  const regex = xml.includes('<item') ? itemRegex : entryRegex;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    const summary = extractTag(block, 'description') || extractTag(block, 'summary') || '';

    // Strip HTML tags from summary
    const cleanSummary = summary.replace(/<[^>]+>/g, '').trim();

    items.push({ title, link, pubDate, summary: cleanSummary });
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}

// ── 14. github_prs ─────────────────────────────────────────────────────

server.tool(
  'github_prs',
  'Check GitHub PRs — review-requested and authored. Read-only.',
  {},
  async () => {
    const parts: string[] = [];

    try {
      const reviewResult = execSync(
        'gh pr list --search "review-requested:@me"',
        { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      parts.push(reviewResult
        ? `**PRs needing your review:**\n${reviewResult}`
        : '**PRs needing your review:** None');
    } catch (err) {
      parts.push(`**PRs needing review:** Error — ${err}`);
    }

    try {
      const authorResult = execSync(
        'gh pr list --author "@me"',
        { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      parts.push(authorResult
        ? `**Your open PRs:**\n${authorResult}`
        : '**Your open PRs:** None');
    } catch (err) {
      parts.push(`**Your open PRs:** Error — ${err}`);
    }

    return textResult(parts.join('\n\n'));
  },
);

// ── 15. browser_screenshot ─────────────────────────────────────────────

server.tool(
  'browser_screenshot',
  'Take a screenshot of a URL using a Kernel cloud browser.',
  {
    url: z.string().describe('URL to screenshot'),
  },
  async ({ url }) => {
    try {
      // Verify kernel CLI is available
      execSync('which kernel', { stdio: 'pipe' });
    } catch {
      return textResult('kernel CLI not found. Install with: npm i -g @onkernel/cli');
    }

    let browserId: string | null = null;
    try {
      // Create browser
      const createOut = execSync(
        `kernel browsers create --timeout 60 --viewport "1920x1080@25" -o json`,
        { encoding: 'utf-8', timeout: 30000 },
      );
      const data = JSON.parse(createOut);
      browserId = data.id ?? data.session_id ?? null;

      if (!browserId) {
        return textResult(`No browser ID in response: ${createOut.slice(0, 200)}`);
      }

      // Navigate
      const navCode = `await page.goto("${url.replace(/"/g, '\\"')}", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000);`;
      execSync(
        `kernel browsers playwright execute ${browserId} '${navCode.replace(/'/g, "\\'")}'`,
        { encoding: 'utf-8', timeout: 60000 },
      );

      // Screenshot
      const tmpPath = path.join(
        (process.env.TMPDIR ?? '/tmp'),
        `kernel_screenshot_${Date.now()}.png`,
      );
      execSync(
        `kernel browsers computer screenshot ${browserId} --to "${tmpPath}"`,
        { encoding: 'utf-8', timeout: 15000 },
      );

      return textResult(`Screenshot saved to: ${tmpPath}`);
    } catch (err) {
      return textResult(`Browser screenshot error: ${err}`);
    } finally {
      if (browserId) {
        try {
          execSync(`kernel browsers delete ${browserId}`, { timeout: 10000, stdio: 'pipe' });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
);

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Initialize memory store and run full sync on startup
  try {
    const store = await getStore();
    const stats = store.fullSync();
    logger.info(
      {
        filesScanned: stats.filesScanned,
        filesUpdated: stats.filesUpdated,
        chunksTotal: stats.chunksTotal,
      },
      'Startup sync complete',
    );

    // Daily maintenance: decay salience scores and prune stale data
    const decayed = store.decaySalience();
    const pruned = store.pruneStaleData();
    if (decayed > 0 || pruned.episodicPruned > 0 || pruned.accessLogPruned > 0 || pruned.transcriptsPruned > 0) {
      logger.info(
        { decayed, ...pruned },
        'Startup maintenance complete',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Startup sync failed (non-fatal)');
  }

  // Graceful shutdown — close MemoryStore to checkpoint WAL
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'MCP server shutting down');
    if (_store && typeof (_store as any).close === 'function') {
      (_store as any).close();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected via stdio');
}

main().catch(err => {
  logger.fatal({ err }, 'MCP server failed to start');
  process.exit(1);
});
