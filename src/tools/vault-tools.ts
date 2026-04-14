/**
 * Clementine TypeScript — Vault & Notes MCP tools.
 *
 * note_create, task_list, task_add, task_update, vault_stats, daily_note, note_take
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ACTIVE_AGENT_SLUG, BASE_DIR, DAILY_NOTES_DIR, INBOX_DIR, MEMORY_FILE, PEOPLE_DIR,
  PROJECTS_DIR, SYSTEM_DIR, TASKS_DIR, TASKS_FILE, TEMPLATES_DIR,
  TOPICS_DIR, VAULT_DIR,
  TASK_ID_RE, agentTasksFile, agentDailyNotesDir, ensureDailyNote, folderForType, getStore, globMd, incrementalSync,
  nextDueDate, nextTaskId, nowTime, parseTasks, textResult,
  timeOfDaySection, todayStr, validateVaultPath,
} from './shared.js';

export function registerVaultTools(server: McpServer): void {
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

    // Dedup check for note content — bump salience instead of discarding
    if (content && content.length >= 20) {
      try {
        const store = await getStore();
        const dup = store.checkDuplicate(content);
        if (dup.isDuplicate && dup.matchId) {
          store.bumpChunkSalience(dup.matchId, 0.1);
          store.logExtraction({
            sessionKey: 'mcp', userMessage: `note_create: ${title}`,
            toolName: 'note_create', toolInput: JSON.stringify({ note_type, title }),
            extractedAt: new Date().toISOString(), status: 'dedup_skipped',
          });
          return textResult(`Reinforced existing memory (chunk #${dup.matchId}, salience bumped). No duplicate note created.`);
        }
      } catch { /* dedup failure is non-fatal */ }
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
  'List tasks from the master task list. Tasks have IDs like {T-001}. Tasks may have @assignee:agentname tags — use assignee filter to see only tasks for a specific agent.',
  {
    status: z.enum(['all', 'pending', 'completed']).optional().describe('Filter by status'),
    project: z.string().optional().describe('Filter by project tag'),
    assignee: z.string().optional().describe('Filter by assignee (e.g. "ross-the-sdr", "nora-senior-sdr", "clementine"). Use "unassigned" to see tasks with no assignee.'),
  },
  async ({ status, project, assignee }) => {
    const statusFilter = status ?? 'all';
    const projectFilter = project ?? '';
    const assigneeFilter = assignee ?? '';

    const tasksFilePath = agentTasksFile(ACTIVE_AGENT_SLUG);
    if (!existsSync(tasksFilePath)) {
      return textResult('No task list found.');
    }

    const body = readFileSync(tasksFilePath, 'utf-8');
    const allTasks = parseTasks(body);
    let filtered = allTasks;

    if (statusFilter !== 'all') {
      filtered = filtered.filter(t => t.status === statusFilter);
    }
    if (projectFilter) {
      filtered = filtered.filter(t => t.project.toLowerCase() === projectFilter.toLowerCase());
    }
    if (assigneeFilter) {
      if (assigneeFilter === 'unassigned') {
        filtered = filtered.filter(t => !t.assignee);
      } else {
        filtered = filtered.filter(t => t.assignee.toLowerCase() === assigneeFilter.toLowerCase());
      }
    }

    if (!filtered.length) {
      const parts: string[] = [statusFilter];
      if (projectFilter) parts.push(`project:${projectFilter}`);
      if (assigneeFilter) parts.push(`assignee:${assigneeFilter}`);
      return textResult(`No tasks matching: ${parts.join(', ')}`);
    }

    // Annotate each line with assignee if present
    const lines = filtered.map(t => {
      const assigneeNote = t.assignee ? ` [assignee: ${t.assignee}]` : '';
      return t.rawLine + assigneeNote;
    });
    let header = `**Tasks (${statusFilter})`;
    if (projectFilter) header += `, project:${projectFilter}`;
    if (assigneeFilter) header += `, assignee:${assigneeFilter}`;
    header += ` — ${filtered.length} results:**`;

    return textResult(`${header}\n\n${lines.join('\n')}`);
  },
);


// ── 7. task_add ────────────────────────────────────────────────────────

server.tool(
  'task_add',
  'Add a new task to the master task list. Auto-generates a {T-NNN} ID. Include @assignee:agentname in description to assign to a specific agent (e.g. @assignee:ross-the-sdr).',
  {
    description: z.string().describe('Task description. Include @assignee:agentname to assign to a specific agent.'),
    priority: z.enum(['high', 'medium', 'low']).optional().describe('Task priority'),
    due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
    project: z.string().optional().describe('Project name'),
  },
  async ({ description, priority, due_date, project }) => {
    // Dedup check for task descriptions
    if (description.length >= 20) {
      try {
        const store = await getStore();
        const dup = store.checkDuplicate(description);
        if (dup.isDuplicate) {
          store.logExtraction({
            sessionKey: 'mcp', userMessage: description.slice(0, 200),
            toolName: 'task_add', toolInput: JSON.stringify({ description, project }),
            extractedAt: new Date().toISOString(), status: 'dedup_skipped',
          });
          return textResult(`Skipped: ${dup.matchType} duplicate task already exists (chunk #${dup.matchId})`);
        }
      } catch { /* dedup failure is non-fatal */ }
    }

    const tasksFilePath = agentTasksFile(ACTIVE_AGENT_SLUG);
    if (!existsSync(tasksFilePath)) {
      mkdirSync(path.dirname(tasksFilePath), { recursive: true });
      writeFileSync(tasksFilePath, `---\ntype: task-list\ntags:\n  - tasks\n---\n\n# Tasks\n\n## Pending\n\n## In Progress\n\n## Completed\n`, 'utf-8');
    }

    let body = readFileSync(tasksFilePath, 'utf-8');
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

    writeFileSync(tasksFilePath, body, 'utf-8');
    const rel = path.relative(VAULT_DIR, tasksFilePath);
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
  async ({ task_id, status, description: _newDesc, priority: newPriority, due_date: newDue }) => {
    const tasksFilePath = agentTasksFile(ACTIVE_AGENT_SLUG);
    if (!existsSync(tasksFilePath)) {
      return textResult('No task list found.');
    }

    let body = readFileSync(tasksFilePath, 'utf-8');
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

    writeFileSync(tasksFilePath, body, 'utf-8');
    const rel = path.relative(VAULT_DIR, tasksFilePath);
    await incrementalSync(rel);
    return textResult(`Moved to ${newStatus}: ${task_id}${recurringMsg}`);
  },
);

// ── 8b. heartbeat_queue_work ──────────────────────────────────────────

const HEARTBEAT_WORK_QUEUE_FILE = path.join(BASE_DIR, 'heartbeat', 'work-queue.json');

server.tool(
  'heartbeat_queue_work',
  'Queue a background task for the next heartbeat cycle to execute. Use for approved work that should happen asynchronously during the next check-in.',
  {
    description: z.string().describe('Short human-readable description of the work'),
    prompt: z.string().describe('Detailed prompt for the agent executing this work'),
    priority: z.enum(['high', 'normal']).optional().default('normal').describe('high = next tick, normal = when convenient'),
    max_turns: z.number().optional().default(3).describe('Max conversation turns for this work (1-5)'),
    tier: z.number().optional().default(1).describe('Security tier: 1 = vault-only, 2 = bash/git allowed'),
    agent: z.string().optional().describe('Agent slug this work is for (e.g. "ross"). Omit for global work.'),
  },
  async ({ description, prompt, priority, max_turns, tier, agent }) => {
    const queueDir = path.dirname(HEARTBEAT_WORK_QUEUE_FILE);
    mkdirSync(queueDir, { recursive: true });

    let queue: Array<Record<string, unknown>> = [];
    try {
      if (existsSync(HEARTBEAT_WORK_QUEUE_FILE)) {
        queue = JSON.parse(readFileSync(HEARTBEAT_WORK_QUEUE_FILE, 'utf-8'));
      }
    } catch { /* start fresh */ }

    const id = randomBytes(4).toString('hex');
    const item: Record<string, unknown> = {
      id,
      description,
      prompt,
      source: 'mcp-tool',
      priority,
      queuedAt: new Date().toISOString(),
      maxTurns: Math.min(max_turns, 5),
      tier: Math.min(tier, 2),
      status: 'pending',
    };
    if (agent) item.agentSlug = agent;
    queue.push(item);

    writeFileSync(HEARTBEAT_WORK_QUEUE_FILE, JSON.stringify(queue, null, 2));
    return textResult(`Queued work item ${id}: "${description}" (priority: ${priority}, next heartbeat will pick it up)`);
  },
);


// ── 9. vault_stats ─────────────────────────────────────────────────────

server.tool(
  'vault_stats',
  'Quick dashboard of vault health — note counts, task counts, memory size, recent activity.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
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


// ── agent_daily_note ───────────────────────────────────────────────────

server.tool(
  'agent_daily_note',
  'Write an entry to today\'s daily note. When running as a team agent, writes to their own daily notes directory. Use this to log completed work, observations, and status updates.',
  {
    content: z.string().describe('Content to append to today\'s daily note'),
    replace: z.boolean().optional().describe('If true, replace today\'s note entirely instead of appending'),
  },
  async ({ content, replace }) => {
    const { todayISO } = await import('../gateway/cron-scheduler.js');
    const notesDir = agentDailyNotesDir(ACTIVE_AGENT_SLUG);
    if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });

    const today = todayISO();
    const notePath = path.join(notesDir, `${today}.md`);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    if (replace || !existsSync(notePath)) {
      writeFileSync(notePath, `# Daily Log — ${today}\n\n${content}\n`);
    } else {
      const existing = readFileSync(notePath, 'utf-8');
      writeFileSync(notePath, `${existing.trimEnd()}\n\n**${timestamp}:** ${content}\n`);
    }

    return textResult(`Daily note updated for ${today}.`);
  },
);


}
