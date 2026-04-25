/**
 * Clementine TypeScript — Background task MCP tools.
 *
 * `start_background_task` lets an agent kick off a long-running job
 * (research, multi-page extraction, batch outreach) without blocking
 * the conversation. The agent gets a task id immediately and is
 * notified in their channel when the work completes.
 *
 * Internally: the tool writes a pending task file. The daemon's
 * cron-scheduler tick picks it up within ~3 seconds, runs it via
 * runUnleashedTask with the agent's profile, then dispatches the
 * result to the agent's Discord channel.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createBackgroundTask,
  listBackgroundTasks,
  loadBackgroundTask,
} from '../agent/background-tasks.js';
import { ACTIVE_AGENT_SLUG, logger, textResult } from './shared.js';

const DEFAULT_MAX_MINUTES = 30;

export function registerBackgroundTaskTools(server: McpServer): void {
  server.tool(
    'start_background_task',
    'Kick off a long-running autonomous task in the background. Use when the work would burn the chat context (deep research, multi-page extraction, batch processing) or take longer than a chat turn. Returns a task id immediately. The daemon picks the task up within seconds, runs it with your profile + tools, and posts the deliverable to your Discord channel when done.',
    {
      prompt: z.string().describe('The full task description — be specific about what you want produced. Use the same level of detail you would give a teammate.'),
      max_minutes: z.number().optional().describe(`Hard wall-clock cap on the task. Default ${DEFAULT_MAX_MINUTES} min. Range 1–240. Use longer caps for sustained research.`),
    },
    async ({ prompt, max_minutes }) => {
      const fromAgent = ACTIVE_AGENT_SLUG || 'clementine';
      const trimmed = (prompt ?? '').trim();
      if (!trimmed) {
        return textResult('start_background_task: prompt is required.');
      }
      const cap = typeof max_minutes === 'number' ? max_minutes : DEFAULT_MAX_MINUTES;

      const task = createBackgroundTask({
        fromAgent,
        prompt: trimmed,
        maxMinutes: cap,
      });

      logger.info({ id: task.id, fromAgent, maxMinutes: task.maxMinutes }, 'Background task queued');
      return textResult(
        `Queued **${task.id}** (max ${task.maxMinutes} min). The daemon will pick it up within a few seconds and run it in the background. You'll get a notification in your channel when the deliverable lands. Use \`get_background_task\` to check status.`,
      );
    },
  );

  server.tool(
    'get_background_task',
    'Check the status of a background task. Returns its lifecycle state (pending|running|done|failed|aborted), how long it has been running, and the result/error if terminal.',
    {
      task_id: z.string().describe('Task id returned by start_background_task (e.g., "bg-abc123-def4")'),
    },
    async ({ task_id }) => {
      const task = loadBackgroundTask(task_id);
      if (!task) {
        return textResult(`get_background_task: no task found with id "${task_id}".`);
      }
      const lines: string[] = [];
      lines.push(`**${task.id}** — ${task.status}`);
      lines.push(`From: ${task.fromAgent}`);
      lines.push(`Created: ${task.createdAt}`);
      if (task.startedAt) lines.push(`Started: ${task.startedAt}`);
      if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
      lines.push(`Max minutes: ${task.maxMinutes}`);
      lines.push('');
      lines.push(`Prompt: ${task.prompt.slice(0, 300)}${task.prompt.length > 300 ? '...' : ''}`);
      if (task.status === 'running' && task.startedAt) {
        const elapsedMin = Math.round((Date.now() - new Date(task.startedAt).getTime()) / 60000);
        lines.push('');
        lines.push(`Running for ${elapsedMin}m / ${task.maxMinutes}m cap.`);
      }
      if (task.error) {
        lines.push('');
        lines.push(`Error: ${task.error}`);
      }
      if (task.result) {
        lines.push('');
        lines.push(`Result:\n${task.result}`);
      }
      if (task.deliverableNote) {
        lines.push('');
        lines.push(`Deliverable: ${task.deliverableNote}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'list_background_tasks',
    'List background tasks, optionally filtered by status or originating agent. Newest first. Use to see what work is in flight or completed recently.',
    {
      status: z
        .enum(['pending', 'running', 'done', 'failed', 'aborted'])
        .optional()
        .describe('Filter by lifecycle status'),
      from_agent: z.string().optional().describe('Filter by originating agent slug'),
      limit: z.number().optional().describe('Max number to return (default 20, max 100)'),
    },
    async ({ status, from_agent, limit }) => {
      const filter: { status?: 'pending' | 'running' | 'done' | 'failed' | 'aborted'; fromAgent?: string } = {};
      if (status) filter.status = status;
      if (from_agent) filter.fromAgent = from_agent;
      const all = listBackgroundTasks(filter);
      const cap = Math.max(1, Math.min(100, typeof limit === 'number' ? limit : 20));
      const tasks = all.slice(0, cap);

      if (tasks.length === 0) {
        const filterDesc = [
          status ? `status=${status}` : '',
          from_agent ? `from_agent=${from_agent}` : '',
        ].filter(Boolean).join(', ');
        return textResult(`No background tasks found${filterDesc ? ` (${filterDesc})` : ''}.`);
      }

      const lines: string[] = [`## Background tasks (${tasks.length}${all.length > tasks.length ? ` of ${all.length}` : ''})`];
      for (const t of tasks) {
        const promptHead = t.prompt.replace(/\s+/g, ' ').slice(0, 80);
        lines.push(`- **${t.id}** [${t.status}] ${t.fromAgent}: ${promptHead}${t.prompt.length > 80 ? '...' : ''}`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
