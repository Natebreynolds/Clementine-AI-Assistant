/**
 * Clementine TypeScript — Team, Agent CRUD, and Delegation MCP tools.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ACTIVE_AGENT_SLUG, AGENTS_DIR, BASE_DIR, DELEGATIONS_BASE,
  TEAM_COMMS_LOG, env, logger, parseTasks, textResult,
} from './shared.js';
import { todayISO } from '../gateway/cron-scheduler.js';

// ── Helpers ─────────────────────────────────────────────────────────────

interface TeamAgentInfo {
  slug: string;
  name: string;
  channelName: string;
  canMessage: string[];
  description: string;
}

async function loadTeamAgents(): Promise<TeamAgentInfo[]> {
  const matterMod = await import('gray-matter');
  const agents: TeamAgentInfo[] = [];
  const seen = new Set<string>();

  if (existsSync(AGENTS_DIR)) {
    try {
      for (const slug of readdirSync(AGENTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name)) {
        const agentFile = path.join(AGENTS_DIR, slug, 'agent.md');
        if (!existsSync(agentFile)) continue;
        try {
          const { data } = matterMod.default(readFileSync(agentFile, 'utf-8'));
          const channelName = data.channelName ? String(data.channelName) : '';
          if (!channelName) continue;
          seen.add(slug);
          agents.push({ slug, name: String(data.name ?? slug), channelName, canMessage: Array.isArray(data.canMessage) ? data.canMessage.map(String) : [], description: String(data.description ?? '') });
        } catch { /* skip */ }
      }
    } catch { /* agents dir not readable */ }
  }

  // Phase 14: legacy PROFILES_DIR fallback removed — that directory has
  // been empty in production for a long time and the new format
  // (vault/00-System/agents/<slug>/agent.md) is the only source loaded above.

  return agents;
}

function assertAgentCrudAllowed(action: string): void {
  if (ACTIVE_AGENT_SLUG) {
    throw new Error(`Only the primary agent or owner can ${action}. Current agent '${ACTIVE_AGENT_SLUG}' is not authorized.`);
  }
}

const teamMessageDelivered = new Map<string, { at: number; content: string }>();

// ── Registration ────────────────────────────────────────────────────────

export function registerTeamTools(server: McpServer): void {

  server.tool(
    'team_list',
    'List all team agents — their names, channel bindings, and messaging permissions.',
    { _empty: z.string().optional().describe('(no parameters needed)') },
    async () => {
      const agents = await loadTeamAgents();
      if (agents.length === 0) return textResult('No team agents configured.');
      const callerSlug = process.env.CLEMENTINE_TEAM_AGENT ?? '';
      const isPrimary = !agents.find(a => a.slug === callerSlug);
      const lines = agents.map(a => `- ${a.name} (${a.slug}): #${a.channelName}, canMessage=[${a.canMessage.join(', ')}]`);
      const header = isPrimary ? 'Team Agents (you are the primary agent — you can message any agent below):' : 'Team Agents:';
      return textResult(`${header}\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'team_message',
    'Send a message to another team agent. You may only send ONE message per recipient per conversation.',
    {
      to_agent: z.string().describe('Slug of the target agent'),
      message: z.string().describe('Message content to send'),
      depth: z.number().optional().describe('Message depth counter (auto-incremented). Do not set manually.'),
    },
    async ({ to_agent, message, depth }) => {
      const priorDelivery = teamMessageDelivered.get(to_agent);
      if (priorDelivery) {
        return textResult(`ALREADY DELIVERED: Your message to ${to_agent} was successfully delivered at ${new Date(priorDelivery.at).toLocaleTimeString()}. Do NOT resend.`);
      }

      const agents = await loadTeamAgents();
      const callerSlug = process.env.CLEMENTINE_TEAM_AGENT ?? '';
      if (!callerSlug) return textResult('Error: Cannot determine which agent is calling team_message.');

      const caller = agents.find(a => a.slug === callerSlug);
      if (caller && !caller.canMessage.includes(to_agent)) {
        return textResult(`Error: Agent '${callerSlug}' is not authorized to message '${to_agent}'. Allowed: ${caller.canMessage.join(', ') || 'none'}`);
      }

      const target = agents.find(a => a.slug === to_agent);
      if (!target) return textResult(`Error: Target agent '${to_agent}' not found.`);

      const msgDepth = depth ?? 0;
      if (msgDepth >= 3) return textResult('Error: Message depth limit reached (3).');

      // Try synchronous delivery via daemon HTTP API
      const dashboardPort = env['DASHBOARD_PORT'] ?? '3030';
      let dashboardToken = '';
      try { dashboardToken = readFileSync(path.join(BASE_DIR, '.dashboard-token'), 'utf-8').trim(); } catch { /* */ }
      try {
        const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/team/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(dashboardToken ? { 'Authorization': `Bearer ${dashboardToken}` } : {}) },
          body: JSON.stringify({ from_agent: callerSlug, to_agent, message, depth: msgDepth }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await res.json() as { ok: boolean; delivered?: boolean; response?: string | null; error?: string };
        if (data.ok && data.delivered) {
          teamMessageDelivered.set(to_agent, { at: Date.now(), content: message });
          return data.response ? textResult(`${target.name} responded:\n\n${data.response}`) : textResult(`Message delivered to ${target.name}. No response captured.`);
        }
        if (data.ok && !data.delivered) {
          teamMessageDelivered.set(to_agent, { at: Date.now(), content: message });
          return textResult(`Message queued for ${target.name} — they'll see it on their next interaction.`);
        }
        if (data.error) return textResult(`Error: ${data.error}`);
      } catch { /* daemon unreachable — JSONL fallback */ }

      const msgId = randomBytes(4).toString('hex');
      const record = { id: msgId, fromAgent: callerSlug, toAgent: to_agent, content: message, timestamp: new Date().toISOString(), delivered: false, depth: msgDepth };
      const logDir = path.dirname(TEAM_COMMS_LOG);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      appendFileSync(TEAM_COMMS_LOG, JSON.stringify(record) + '\n');
      teamMessageDelivered.set(to_agent, { at: Date.now(), content: message });
      return textResult(`Message queued for ${target.name} (${to_agent}). ID: ${msgId}.`);
    },
  );

  server.tool(
    'team_request',
    'Send a structured request to another team agent and wait for their response (blocks up to 5 min).',
    {
      to_agent: z.string().describe('Slug of the target agent'),
      request: z.string().describe('The question or request content'),
      timeout_seconds: z.number().optional().describe('Timeout in seconds (default: 300, max: 600)'),
    },
    async ({ to_agent, request, timeout_seconds }) => {
      const callerSlug = process.env.CLEMENTINE_TEAM_AGENT ?? '';
      if (!callerSlug) return textResult('Error: Cannot determine calling agent.');
      const timeoutMs = Math.min((timeout_seconds ?? 300) * 1000, 600_000);
      const dashboardPort = env['DASHBOARD_PORT'] ?? '3030';
      let dashboardToken = '';
      try { dashboardToken = readFileSync(path.join(BASE_DIR, '.dashboard-token'), 'utf-8').trim(); } catch { /* */ }
      try {
        const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/team/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(dashboardToken ? { 'Authorization': `Bearer ${dashboardToken}` } : {}) },
          body: JSON.stringify({ from_agent: callerSlug, to_agent, content: request, timeout_ms: timeoutMs }),
          signal: AbortSignal.timeout(timeoutMs + 10_000),
        });
        const data = await res.json() as { ok: boolean; response?: string; error?: string; timed_out?: boolean };
        if (data.ok && data.response) return textResult(`Response from ${to_agent}:\n\n${data.response}`);
        if (data.timed_out) return textResult(`Request to ${to_agent} timed out after ${timeout_seconds ?? 300}s.`);
        return textResult(`Error: ${data.error ?? 'Unknown error'}`);
      } catch (err) { return textResult(`Error sending request: ${String(err)}`); }
    },
  );

  server.tool(
    'team_pending_requests',
    'Check for pending requests from other team agents that need your response.',
    { _empty: z.string().optional().describe('(no parameters needed)') },
    async () => {
      const callerSlug = process.env.CLEMENTINE_TEAM_AGENT ?? '';
      if (!callerSlug) return textResult('Error: Cannot determine calling agent.');
      const dashboardPort = env['DASHBOARD_PORT'] ?? '3030';
      let dashboardToken = '';
      try { dashboardToken = readFileSync(path.join(BASE_DIR, '.dashboard-token'), 'utf-8').trim(); } catch { /* */ }
      try {
        const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/team/pending-requests?agent=${callerSlug}`, {
          headers: dashboardToken ? { 'Authorization': `Bearer ${dashboardToken}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as { ok: boolean; requests?: any[]; error?: string };
        if (!data.ok) return textResult(`Error: ${data.error ?? 'Failed to fetch pending requests'}`);
        const requests = data.requests ?? [];
        if (requests.length === 0) return textResult('No pending requests.');
        const lines = requests.map((r: any) => `- **[REPLY NEEDED]** From ${r.fromAgent} (${r.requestId}): ${r.content.slice(0, 200)}${r.expectedBy ? ` — expected by ${r.expectedBy}` : ''}`);
        return textResult(`## Pending Requests (${requests.length})\n${lines.join('\n')}\n\nUse team_message to respond.`);
      } catch {
        if (existsSync(TEAM_COMMS_LOG)) {
          try {
            const logLines = readFileSync(TEAM_COMMS_LOG, 'utf-8').trim().split('\n').filter(Boolean);
            const pendingReqs = logLines.slice(-100).map(l => { try { return JSON.parse(l); } catch { return null; } })
              .filter((m: any) => m && m.protocol === 'request' && m.toAgent === callerSlug && !m.response);
            if (pendingReqs.length === 0) return textResult('No pending requests found.');
            const formatted = pendingReqs.map((r: any) => `- **[REPLY NEEDED]** From ${r.fromAgent}: ${r.content.slice(0, 200)}`);
            return textResult(`## Pending Requests (${pendingReqs.length})\n${formatted.join('\n')}`);
          } catch { return textResult('No pending requests found.'); }
        }
        return textResult('No pending requests found (daemon unreachable).');
      }
    },
  );

  // ── Agent CRUD ─────────────────────────────────────────────────────

  server.tool(
    'create_agent',
    'Create a new scoped agent with its own personality, tools, crons, and project binding.',
    {
      name: z.string().describe('Display name'), description: z.string().describe('Short description'),
      personality: z.string().optional().describe('Full system prompt body'),
      channel_name: z.string().optional().describe('Discord channel name'),
      project: z.string().optional().describe('Project name binding'),
      tools: z.array(z.string()).optional().describe('Tool whitelist'),
      model: z.string().optional().describe('Model tier: "haiku", "sonnet", "opus"'),
      can_message: z.array(z.string()).optional().describe('Agent slugs this agent can message'),
      tier: z.number().optional().describe('Security tier (1=read-only, 2=read-write). Default: 2'),
    },
    async ({ name, description, personality, channel_name, project, tools, model, can_message, tier }) => {
      assertAgentCrudAllowed('create agents');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const agentDir = path.join(AGENTS_DIR, slug);
      if (existsSync(path.join(agentDir, 'agent.md'))) return textResult(`Error: Agent '${slug}' already exists.`);
      mkdirSync(agentDir, { recursive: true });
      const frontmatter: Record<string, unknown> = { name, description, tier: Math.min(tier ?? 2, 2) };
      if (model) frontmatter.model = model;
      if (channel_name) frontmatter.channelName = channel_name;
      if (can_message?.length) frontmatter.canMessage = can_message;
      if (tools?.length) frontmatter.allowedTools = tools;
      if (project) frontmatter.project = project;
      const body = personality || `You are ${name}. ${description}`;
      const matterMod = await import('gray-matter');
      writeFileSync(path.join(agentDir, 'agent.md'), matterMod.default.stringify(body, frontmatter));

      // Scaffold per-agent context files
      const tasksFile = path.join(agentDir, 'TASKS.md');
      if (!existsSync(tasksFile)) {
        writeFileSync(tasksFile, `---\ntype: task-list\ntags:\n  - tasks\n---\n\n# Tasks\n\n## Pending\n\n## In Progress\n\n## Completed\n`);
      }
      const wmFile = path.join(agentDir, 'working-memory.md');
      if (!existsSync(wmFile)) {
        writeFileSync(wmFile, `# Working Memory\n\n*Scratchpad for ${name}. Updated during runs and conversations.*\n`);
      }
      const goalsDir = path.join(agentDir, 'goals');
      if (!existsSync(goalsDir)) mkdirSync(goalsDir, { recursive: true });
      const dailyNotesDir = path.join(agentDir, 'daily-notes');
      if (!existsSync(dailyNotesDir)) mkdirSync(dailyNotesDir, { recursive: true });
      const cronFile = path.join(agentDir, 'CRON.md');
      if (!existsSync(cronFile)) {
        writeFileSync(cronFile, `---\ntype: cron-config\njobs: []\n---\n\n# Cron Jobs\n\n*No scheduled jobs yet.*\n`);
      }

      return textResult(`Created agent '${name}' (${slug}).${channel_name ? ` Channel: #${channel_name}` : ''}${project ? ` Project: ${project}` : ''}`);
    },
  );

  server.tool(
    'update_agent',
    'Update an existing agent\'s configuration. Only specified fields are changed.',
    {
      slug: z.string().describe('Agent slug'), name: z.string().optional(), description: z.string().optional(),
      personality: z.string().optional(), channel_name: z.string().optional(), project: z.string().optional(),
      tools: z.array(z.string()).optional(), model: z.string().optional(), can_message: z.array(z.string()).optional(),
      tier: z.number().optional(),
    },
    async ({ slug, name, description, personality, channel_name, project, tools, model, can_message, tier }) => {
      assertAgentCrudAllowed('update agents');
      const agentFile = path.join(AGENTS_DIR, slug, 'agent.md');
      if (!existsSync(agentFile)) return textResult(`Error: Agent '${slug}' not found.`);
      const matterMod = await import('gray-matter');
      const { data: meta, content: body } = matterMod.default(readFileSync(agentFile, 'utf-8'));
      if (name !== undefined) meta.name = name;
      if (description !== undefined) meta.description = description;
      if (tier !== undefined) meta.tier = Math.min(tier, 2);
      if (model !== undefined) meta.model = model;
      if (channel_name !== undefined) meta.channelName = channel_name;
      if (can_message !== undefined) meta.canMessage = can_message;
      if (tools !== undefined) meta.allowedTools = tools;
      if (project !== undefined) meta.project = project;
      writeFileSync(agentFile, matterMod.default.stringify(personality ?? body, meta));
      const changed = [name !== undefined && 'name', description !== undefined && 'description', personality !== undefined && 'personality',
        channel_name !== undefined && 'channelName', project !== undefined && 'project', tools !== undefined && 'tools',
        model !== undefined && 'model', can_message !== undefined && 'canMessage', tier !== undefined && 'tier'].filter(Boolean);
      return textResult(`Updated agent '${slug}'. Changes: ${changed.join(', ')}`);
    },
  );

  server.tool(
    'delete_agent',
    'Delete an agent and its entire directory.',
    { slug: z.string().describe('Agent slug'), confirm: z.boolean().describe('Must be true to confirm') },
    async ({ slug, confirm }) => {
      assertAgentCrudAllowed('delete agents');
      if (!confirm) return textResult('Deletion cancelled — set confirm=true.');
      const agentDir = path.join(AGENTS_DIR, slug);
      if (!existsSync(agentDir)) return textResult(`Error: Agent '${slug}' not found.`);
      const { rmSync } = await import('node:fs');
      rmSync(agentDir, { recursive: true, force: true });
      return textResult(`Deleted agent '${slug}'.`);
    },
  );

  // ── Delegation ─────────────────────────────────────────────────────

  server.tool(
    'delegate_task',
    'Delegate a task to a team agent. Creates a structured task in their queue.',
    {
      to_agent: z.string().describe('Slug of the target agent'),
      task: z.string().describe('What needs to be done'),
      expected_output: z.string().describe('What the result should look like'),
    },
    async ({ to_agent, task, expected_output }) => {
      const tasksDir = path.join(DELEGATIONS_BASE, to_agent, 'tasks');
      if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
      const id = randomBytes(4).toString('hex');
      const callerSlug = process.env.CLEMENTINE_TEAM_AGENT || 'clementine';
      const delegation = { id, fromAgent: callerSlug, toAgent: to_agent, task, expectedOutput: expected_output, status: 'pending' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify(delegation, null, 2));
      logger.info({ delegationId: id, from: callerSlug, to: to_agent }, 'Task delegated');
      return textResult(`Task delegated to ${to_agent} (ID: ${id}).`);
    },
  );

  server.tool(
    'check_delegation',
    'Check the status of a delegated task or list all delegations for an agent.',
    { id: z.string().optional().describe('Delegation ID'), agent: z.string().optional().describe('Agent slug to list all') },
    async ({ id, agent }) => {
      if (id) {
        if (!existsSync(DELEGATIONS_BASE)) return textResult('No delegations found.');
        for (const slug of readdirSync(DELEGATIONS_BASE, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
          const taskFile = path.join(DELEGATIONS_BASE, slug, 'tasks', `${id}.json`);
          if (existsSync(taskFile)) {
            const d = JSON.parse(readFileSync(taskFile, 'utf-8'));
            const lines = [`**Delegation ${id}**`, `From: ${d.fromAgent} → To: ${d.toAgent}`, `Status: ${d.status}`, `Task: ${d.task}`, `Expected: ${d.expectedOutput}`, `Created: ${d.createdAt}`];
            if (d.result) lines.push(`Result: ${d.result}`);
            return textResult(lines.join('\n'));
          }
        }
        return textResult(`Delegation ${id} not found.`);
      }
      if (agent) {
        const tasksDir = path.join(DELEGATIONS_BASE, agent, 'tasks');
        if (!existsSync(tasksDir)) return textResult(`No delegations for ${agent}.`);
        const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
        if (files.length === 0) return textResult(`No delegations for ${agent}.`);
        const delegations = files.map(f => { try { return JSON.parse(readFileSync(path.join(tasksDir, f), 'utf-8')); } catch { return null; } }).filter(Boolean);
        const lines = delegations.map((d: any) => `- [${d.status.toUpperCase()}] ${d.id}: "${d.task.slice(0, 80)}" (from ${d.fromAgent})`);
        return textResult(`Delegations for ${agent} (${delegations.length}):\n${lines.join('\n')}`);
      }
      return textResult('Provide "id" or "agent" parameter.');
    },
  );

  // ── Team Status ────────────────────────────────────────────────────

  server.tool(
    'team_status',
    'Get a summary of all team agents: their recent daily notes, pending tasks count, and active goals. Use this for morning briefings and cross-agent coordination.',
    {
      agent: z.string().optional().describe('Specific agent slug to check. If omitted, returns all agents.'),
      include_tasks: z.boolean().optional().describe('Include pending task count (default true)'),
      include_goals: z.boolean().optional().describe('Include active goals (default true)'),
      include_daily_notes: z.boolean().optional().describe('Include last 3 days of daily notes (default true)'),
    },
    async ({ agent, include_tasks = true, include_goals = true, include_daily_notes = true }) => {
      const agentsBase = AGENTS_DIR;
      if (!existsSync(agentsBase)) return textResult('No agents found.');

      const agentSlugs = readdirSync(agentsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(n => !agent || n === agent);

      if (!agentSlugs.length) return textResult('No agents found.');

      const matterMod = await import('gray-matter');
      const parts: string[] = ['# Team Status\n'];

      for (const slug of agentSlugs) {
        const agentDir = path.join(agentsBase, slug);
        const agentMdPath = path.join(agentDir, 'agent.md');
        let agentName = slug;
        try {
          const raw = readFileSync(agentMdPath, 'utf-8');
          const parsed = matterMod.default(raw);
          agentName = parsed.data.name ?? slug;
        } catch {}

        parts.push(`## ${agentName} (${slug})`);

        // Tasks
        if (include_tasks) {
          const tasksFile = path.join(agentDir, 'TASKS.md');
          if (existsSync(tasksFile)) {
            const body = readFileSync(tasksFile, 'utf-8');
            const tasks = parseTasks(body);
            const pending = tasks.filter(t => t.status === 'pending');
            const overdue = pending.filter(t => t.due && t.due < todayISO());
            parts.push(`**Tasks:** ${pending.length} pending${overdue.length > 0 ? `, ${overdue.length} overdue` : ''}`);
            if (pending.length > 0) {
              parts.push(pending.slice(0, 3).map(t => `  - ${t.text.slice(0, 100)}`).join('\n'));
            }
          } else {
            parts.push('**Tasks:** No task file yet');
          }
        }

        // Goals
        if (include_goals) {
          const goalsDir = path.join(agentDir, 'goals');
          if (existsSync(goalsDir)) {
            const goalFiles = readdirSync(goalsDir).filter(f => f.endsWith('.json'));
            const activeGoals = goalFiles
              .map(f => { try { return JSON.parse(readFileSync(path.join(goalsDir, f), 'utf-8')); } catch { return null; } })
              .filter((g): g is NonNullable<typeof g> => g !== null && g.status === 'active');
            if (activeGoals.length > 0) {
              parts.push(`**Goals (${activeGoals.length} active):**`);
              for (const g of activeGoals.slice(0, 3)) {
                const progress = g.progress ? ` — ${g.progress}` : '';
                parts.push(`  - ${g.title}${progress}`);
              }
            }
          }
        }

        // Daily notes
        if (include_daily_notes) {
          const dailyDir = path.join(agentDir, 'daily-notes');
          if (existsSync(dailyDir)) {
            const notes = readdirSync(dailyDir)
              .filter(f => f.endsWith('.md'))
              .sort().reverse().slice(0, 3);
            if (notes.length > 0) {
              parts.push('**Recent Activity:**');
              for (const note of notes) {
                try {
                  const content = readFileSync(path.join(dailyDir, note), 'utf-8');
                  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3);
                  parts.push(`  ${note.replace('.md', '')}: ${lines[0]?.slice(0, 120) ?? '(empty)'}`);
                } catch {}
              }
            }
          }
        }

        parts.push('');
      }

      return textResult(parts.join('\n'));
    },
  );
}
