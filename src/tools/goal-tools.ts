/**
 * Clementine TypeScript — Goal MCP tools.
 *
 * Persistent goals that drive proactive agent behavior and
 * can be linked to cron jobs for autonomous progress.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR, logger, textResult } from './shared.js';

const GOALS_DIR = path.join(BASE_DIR, 'goals');
const GOAL_TRIGGER_DIR = path.join(BASE_DIR, 'cron', 'goal-triggers');

function ensureGoalsDir(): void {
  if (!existsSync(GOALS_DIR)) mkdirSync(GOALS_DIR, { recursive: true });
}

export function registerGoalTools(server: McpServer): void {
  server.tool(
    'goal_create',
    'Create a new persistent goal that survives across sessions. Goals drive proactive agent behavior and can be linked to cron jobs.',
    {
      title: z.string().describe('Short goal title'),
      description: z.string().describe('Detailed description of what this goal aims to achieve'),
      owner: z.string().optional().describe('Agent slug that owns this goal (default: "clementine")'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority level (default: "medium")'),
      targetDate: z.string().optional().describe('Target completion date (YYYY-MM-DD)'),
      nextActions: z.array(z.string()).optional().describe('Initial next actions to take'),
      reviewFrequency: z.enum(['daily', 'weekly', 'on-demand']).optional().describe('How often to review (default: "weekly")'),
      linkedCronJobs: z.array(z.string()).optional().describe('Cron job names that contribute to this goal'),
      autoSchedule: z.boolean().optional().describe('Allow the daily planner to auto-create/adjust cron jobs for this goal (default: false)'),
    },
    async ({ title, description, owner, priority, targetDate, nextActions, reviewFrequency, linkedCronJobs, autoSchedule }) => {
      ensureGoalsDir();
      const id = randomBytes(4).toString('hex');
      const now = new Date().toISOString();
      const goal = {
        id, title, description,
        status: 'active' as const,
        owner: owner || 'clementine',
        priority: priority || 'medium',
        createdAt: now, updatedAt: now, targetDate,
        progressNotes: [] as string[],
        nextActions: nextActions || [],
        blockers: [] as string[],
        reviewFrequency: reviewFrequency || 'weekly',
        linkedCronJobs: linkedCronJobs || [],
        ...(autoSchedule ? { autoSchedule } : {}),
      };
      writeFileSync(path.join(GOALS_DIR, `${id}.json`), JSON.stringify(goal, null, 2));
      logger.info({ goalId: id, title }, 'Goal created');
      return textResult(`Goal created: "${title}" (ID: ${id})`);
    },
  );

  server.tool(
    'goal_update',
    'Update an existing persistent goal — add progress notes, change status, update next actions, or add blockers.',
    {
      id: z.string().describe('Goal ID'),
      status: z.enum(['active', 'paused', 'completed', 'blocked']).optional().describe('New status'),
      progressNote: z.string().optional().describe('Progress note to append (what was accomplished)'),
      nextActions: z.array(z.string()).optional().describe('Replace next actions list'),
      blockers: z.array(z.string()).optional().describe('Replace blockers list'),
      linkedCronJobs: z.array(z.string()).optional().describe('Replace linked cron jobs'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('Change priority'),
      autoSchedule: z.boolean().optional().describe('Allow the daily planner to auto-create/adjust cron jobs for this goal'),
    },
    async ({ id, status, progressNote, nextActions, blockers, linkedCronJobs, priority, autoSchedule }) => {
      const filePath = path.join(GOALS_DIR, `${id}.json`);
      if (!existsSync(filePath)) return textResult(`Goal not found: ${id}`);
      const goal = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (status) goal.status = status;
      if (progressNote) goal.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${progressNote}`);
      if (nextActions) goal.nextActions = nextActions;
      if (blockers) goal.blockers = blockers;
      if (linkedCronJobs) goal.linkedCronJobs = linkedCronJobs;
      if (priority) goal.priority = priority;
      if (autoSchedule !== undefined) goal.autoSchedule = autoSchedule;
      goal.updatedAt = new Date().toISOString();
      writeFileSync(filePath, JSON.stringify(goal, null, 2));
      logger.info({ goalId: id, status: goal.status }, 'Goal updated');
      return textResult(`Goal "${goal.title}" updated (status: ${goal.status})`);
    },
  );

  server.tool(
    'goal_list',
    'List persistent goals, optionally filtered by owner or status.',
    {
      owner: z.string().optional().describe('Filter by owner agent slug'),
      status: z.enum(['active', 'paused', 'completed', 'blocked']).optional().describe('Filter by status'),
    },
    async ({ owner, status }) => {
      ensureGoalsDir();
      const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
      let goals = files.map(f => {
        try { return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')); }
        catch { return null; }
      }).filter(Boolean);
      if (owner) goals = goals.filter((g: any) => g.owner === owner);
      if (status) goals = goals.filter((g: any) => g.status === status);
      if (goals.length === 0) return textResult('No goals found matching the criteria.');
      const lines = goals.map((g: any) => {
        const nextAct = g.nextActions?.length > 0 ? ` | Next: ${g.nextActions[0]}` : '';
        const linked = g.linkedCronJobs?.length > 0 ? ` | Crons: ${g.linkedCronJobs.join(', ')}` : '';
        return `- [${g.status.toUpperCase()}] **${g.title}** (${g.id}) — ${g.priority} priority, owner: ${g.owner}${nextAct}${linked}`;
      });
      return textResult(`Goals (${goals.length}):\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'goal_get',
    'Get a single persistent goal with full history — progress notes, next actions, blockers, and linked cron jobs.',
    { id: z.string().describe('Goal ID') },
    async ({ id }) => {
      const filePath = path.join(GOALS_DIR, `${id}.json`);
      if (!existsSync(filePath)) return textResult(`Goal not found: ${id}`);
      const goal = JSON.parse(readFileSync(filePath, 'utf-8'));
      const sections = [
        `# ${goal.title}`,
        `**ID:** ${goal.id} | **Status:** ${goal.status} | **Priority:** ${goal.priority} | **Owner:** ${goal.owner}`,
        `**Created:** ${goal.createdAt} | **Updated:** ${goal.updatedAt}${goal.targetDate ? ` | **Target:** ${goal.targetDate}` : ''}`,
        `**Review:** ${goal.reviewFrequency}`,
        `\n## Description\n${goal.description}`,
      ];
      if (goal.progressNotes?.length > 0) sections.push(`\n## Progress Notes\n${goal.progressNotes.map((n: string) => `- ${n}`).join('\n')}`);
      if (goal.nextActions?.length > 0) sections.push(`\n## Next Actions\n${goal.nextActions.map((a: string) => `- [ ] ${a}`).join('\n')}`);
      if (goal.blockers?.length > 0) sections.push(`\n## Blockers\n${goal.blockers.map((b: string) => `- ${b}`).join('\n')}`);
      if (goal.linkedCronJobs?.length > 0) sections.push(`\n## Linked Cron Jobs\n${goal.linkedCronJobs.map((c: string) => `- ${c}`).join('\n')}`);
      return textResult(sections.join('\n'));
    },
  );

  server.tool(
    'goal_work',
    'Spawn a focused background work session on a specific goal. The daemon picks up the trigger and runs a goal-directed session asynchronously — results are delivered via notifications.',
    {
      goal_id: z.string().describe('ID of the goal to work on'),
      focus: z.string().optional().describe('Specific aspect to focus on. Defaults to the goal\'s first nextAction.'),
      max_turns: z.number().optional().default(15).describe('Max agent turns for this work session'),
    },
    async ({ goal_id, focus, max_turns }) => {
      ensureGoalsDir();
      const goalPath = path.join(GOALS_DIR, `${goal_id}.json`);
      if (!existsSync(goalPath)) return textResult(`Goal not found: ${goal_id}. Use goal_list to see available goals.`);
      const goal = JSON.parse(readFileSync(goalPath, 'utf-8'));
      if (goal.status !== 'active') return textResult(`Goal "${goal.title}" is ${goal.status} — only active goals can be worked on.`);
      mkdirSync(GOAL_TRIGGER_DIR, { recursive: true });
      const trigger = {
        goalId: goal_id,
        focus: focus || goal.nextActions?.[0] || goal.description,
        maxTurns: max_turns,
        triggeredAt: new Date().toISOString(),
      };
      const triggerFile = path.join(GOAL_TRIGGER_DIR, `${Date.now()}-${goal_id}.trigger.json`);
      writeFileSync(triggerFile, JSON.stringify(trigger, null, 2));
      logger.info({ goalId: goal_id, focus: trigger.focus }, 'Goal work session triggered');
      return textResult(
        `Triggered goal work session for "${goal.title}" (${goal_id}).\n` +
        `Focus: ${trigger.focus}\n` +
        `The daemon will pick it up within a few seconds. Results delivered via notifications.`,
      );
    },
  );
}
