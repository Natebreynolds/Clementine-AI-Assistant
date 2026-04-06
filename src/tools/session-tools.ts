/**
 * Clementine TypeScript — Session & Work Discovery MCP tools.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BASE_DIR, HANDOFFS_DIR, INBOX_DIR, TASKS_FILE,
  logger, textResult, todayStr,
} from './shared.js';

function ensureHandoffsDir(): void {
  if (!existsSync(HANDOFFS_DIR)) mkdirSync(HANDOFFS_DIR, { recursive: true });
}

function safeSessionName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function registerSessionTools(server: McpServer): void {

  server.tool(
    'session_pause',
    'Save a structured handoff file for the current session so work can be resumed later — even after context reset.',
    {
      session_key: z.string().describe('Session key (e.g., "discord:user:123")'),
      completed: z.array(z.string()).describe('What was accomplished in this session'),
      remaining: z.array(z.string()).describe('What still needs to be done'),
      decisions: z.array(z.string()).optional().describe('Key decisions made during this session'),
      blockers: z.array(z.string()).optional().describe('Current blockers or open questions'),
      context: z.string().optional().describe('Mental context — anything the resuming agent needs to know'),
    },
    async ({ session_key, completed, remaining, decisions, blockers, context }) => {
      ensureHandoffsDir();
      const handoff = {
        sessionKey: session_key,
        pausedAt: new Date().toISOString(),
        completed, remaining,
        decisions: decisions || [], blockers: blockers || [],
        context: context || '',
      };
      const fileName = `${safeSessionName(session_key)}.json`;
      writeFileSync(path.join(HANDOFFS_DIR, fileName), JSON.stringify(handoff, null, 2));
      logger.info({ sessionKey: session_key, completed: completed.length, remaining: remaining.length }, 'Session handoff saved');
      return textResult(
        `Handoff saved. ${completed.length} items completed, ${remaining.length} remaining.\n` +
        `Resume with session_resume when you're ready to continue.`,
      );
    },
  );

  server.tool(
    'session_resume',
    'Load a previously saved session handoff to restore context from a paused conversation.',
    { session_key: z.string().describe('Session key to resume') },
    async ({ session_key }) => {
      ensureHandoffsDir();
      const fileName = `${safeSessionName(session_key)}.json`;
      const filePath = path.join(HANDOFFS_DIR, fileName);
      if (!existsSync(filePath)) return textResult(`No handoff found for session "${session_key}". Starting fresh.`);
      try {
        const handoff = JSON.parse(readFileSync(filePath, 'utf-8'));
        const sections = [`## Session Handoff (paused at ${handoff.pausedAt})`];
        if (handoff.completed?.length > 0) sections.push(`### Completed\n${handoff.completed.map((c: string) => `- ✓ ${c}`).join('\n')}`);
        if (handoff.remaining?.length > 0) sections.push(`### Remaining\n${handoff.remaining.map((r: string) => `- [ ] ${r}`).join('\n')}`);
        if (handoff.decisions?.length > 0) sections.push(`### Decisions Made\n${handoff.decisions.map((d: string) => `- ${d}`).join('\n')}`);
        if (handoff.blockers?.length > 0) sections.push(`### Blockers\n${handoff.blockers.map((b: string) => `- ⚠ ${b}`).join('\n')}`);
        if (handoff.context) sections.push(`### Context\n${handoff.context}`);
        return textResult(sections.join('\n\n'));
      } catch { return textResult(`Error reading handoff for "${session_key}".`); }
    },
  );

  server.tool(
    'discover_work',
    'Scan goals, tasks, inbox, and recent failures to find prioritized work items.',
    {
      agent_slug: z.string().optional().describe('Filter work items for a specific agent (omit for all)'),
      limit: z.number().optional().describe('Max items to return (default: 10)'),
    },
    async ({ agent_slug, limit }) => {
      const maxItems = Math.min(limit ?? 10, 30);
      const items: Array<{ type: string; urgency: number; description: string }> = [];

      // 1. Stale goals
      const goalsDir = path.join(BASE_DIR, 'goals');
      if (existsSync(goalsDir)) {
        for (const f of readdirSync(goalsDir).filter(f => f.endsWith('.json'))) {
          try {
            const goal = JSON.parse(readFileSync(path.join(goalsDir, f), 'utf-8'));
            if (goal.status !== 'active') continue;
            if (agent_slug && goal.owner !== agent_slug) continue;
            const daysSinceUpdate = Math.floor((Date.now() - new Date(goal.updatedAt).getTime()) / 86400000);
            const staleThreshold = goal.reviewFrequency === 'daily' ? 1 : goal.reviewFrequency === 'weekly' ? 7 : 30;
            if (daysSinceUpdate > staleThreshold) {
              const urgency = Math.min(5, Math.floor(daysSinceUpdate / staleThreshold) + (goal.priority === 'high' ? 2 : goal.priority === 'medium' ? 1 : 0));
              items.push({ type: 'stale-goal', urgency, description: `Goal "${goal.title}" stale for ${daysSinceUpdate}d (${goal.priority} priority)` });
            }
          } catch { continue; }
        }
      }

      // 2. Failing cron jobs
      const runDir = path.join(BASE_DIR, 'cron', 'runs');
      if (existsSync(runDir)) {
        for (const f of readdirSync(runDir).filter(f => f.endsWith('.jsonl'))) {
          try {
            const lines = readFileSync(path.join(runDir, f), 'utf-8').trim().split('\n').filter(Boolean);
            const recent = lines.slice(-5).map(l => JSON.parse(l));
            const consecutiveErrors = recent.reverse().findIndex(r => r.status === 'ok');
            const errCount = consecutiveErrors === -1 ? recent.length : consecutiveErrors;
            if (errCount >= 2) {
              const jobName = recent[0]?.jobName ?? f.replace('.jsonl', '');
              items.push({ type: 'cron-failure', urgency: Math.min(5, errCount), description: `Job "${jobName}" has ${errCount} consecutive failures` });
            }
          } catch { continue; }
        }
      }

      // 3. Pending tasks
      if (existsSync(TASKS_FILE)) {
        const content = readFileSync(TASKS_FILE, 'utf-8');
        const today = todayStr();
        const overdue = (content.match(/- \[ \].*?📅\s*(\d{4}-\d{2}-\d{2})/g) ?? [])
          .filter(line => { const m = line.match(/📅\s*(\d{4}-\d{2}-\d{2})/); return m && m[1] < today; });
        if (overdue.length > 0) items.push({ type: 'overdue-tasks', urgency: 4, description: `${overdue.length} overdue task(s) in TASKS.md` });
      }

      // 4. Inbox items
      if (existsSync(INBOX_DIR)) {
        const inboxFiles = readdirSync(INBOX_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'));
        if (inboxFiles.length > 0) items.push({ type: 'inbox', urgency: 2, description: `${inboxFiles.length} unprocessed inbox item(s)` });
      }

      // 5. Daily plan priorities
      const planFile = path.join(BASE_DIR, 'plans', 'daily', `${todayStr()}.json`);
      if (existsSync(planFile)) {
        try {
          const plan = JSON.parse(readFileSync(planFile, 'utf-8'));
          for (const p of (plan.priorities ?? []).slice(0, 5)) {
            const alreadyListed = items.some(i => i.description.includes(p.id) || i.description.includes(p.action?.slice(0, 20)));
            if (!alreadyListed) items.push({ type: `plan-${p.type}`, urgency: p.urgency ?? 3, description: `[From daily plan] ${p.action}` });
          }
        } catch { /* non-fatal */ }
      }

      items.sort((a, b) => b.urgency - a.urgency);
      const topItems = items.slice(0, maxItems);
      if (topItems.length === 0) return textResult('No work items discovered. All goals on track, no failures, inbox clear.');
      const lines = topItems.map(i => `- [${i.type}] Urgency ${i.urgency}/5: ${i.description}`);
      return textResult(`## Discovered Work Items (${topItems.length})\n${lines.join('\n')}`);
    },
  );
}
