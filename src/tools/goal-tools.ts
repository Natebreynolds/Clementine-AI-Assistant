/**
 * Clementine TypeScript — Goal MCP tools.
 *
 * Persistent goals that survive across sessions and drive proactive behavior.
 * Goals live per-owner: Clementine's at ~/.clementine/goals/, each agent's at
 * ~/.clementine/vault/00-System/agents/{slug}/goals/. Helpers in shared.ts
 * handle routing so tools here don't need to know the layout.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BASE_DIR, logger, textResult,
  listAllGoals, findGoalPath, readGoalById, writeGoalForOwner,
  type GoalRecord,
} from './shared.js';

const GOAL_TRIGGER_DIR = path.join(BASE_DIR, 'cron', 'goal-triggers');

export function registerGoalTools(server: McpServer): void {
  server.tool(
    'goal_create',
    'Create a new persistent goal that survives across sessions. Goals drive proactive agent behavior and can be linked to cron jobs. Agent goals live in that agent\'s own directory.',
    {
      title: z.string().describe('Short goal title'),
      description: z.string().describe('Detailed description of what this goal aims to achieve'),
      owner: z.string().optional().describe('Agent slug that owns this goal (default: "clementine"). Goal file is routed to the owner\'s directory.'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority level (default: "medium")'),
      targetDate: z.string().optional().describe('Target completion date (YYYY-MM-DD)'),
      nextActions: z.array(z.string()).optional().describe('Initial next actions to take'),
      reviewFrequency: z.enum(['daily', 'weekly', 'on-demand']).optional().describe('How often to review (default: "weekly")'),
      linkedCronJobs: z.array(z.string()).optional().describe('Cron job names that contribute to this goal'),
      autoSchedule: z.boolean().optional().describe('Allow the daily planner to auto-create/adjust cron jobs for this goal (default: false)'),
    },
    async ({ title, description, owner, priority, targetDate, nextActions, reviewFrequency, linkedCronJobs, autoSchedule }) => {
      const id = randomBytes(4).toString('hex');
      const now = new Date().toISOString();
      const goal: GoalRecord = {
        id, title, description,
        status: 'active',
        owner: owner || 'clementine',
        priority: priority || 'medium',
        createdAt: now, updatedAt: now, targetDate,
        progressNotes: [],
        nextActions: nextActions || [],
        blockers: [],
        reviewFrequency: reviewFrequency || 'weekly',
        linkedCronJobs: linkedCronJobs || [],
        ...(autoSchedule ? { autoSchedule } : {}),
      };
      const filePath = writeGoalForOwner(goal);
      logger.info({ goalId: id, title, owner: goal.owner, filePath }, 'Goal created');
      return textResult(`Goal created: "${title}" (ID: ${id}) — owner: ${goal.owner}`);
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
      const found = findGoalPath(id);
      if (!found) return textResult(`Goal not found: ${id}`);
      const goal = readGoalById(id);
      if (!goal) return textResult(`Goal not found: ${id}`);
      if (status) goal.status = status;
      if (progressNote) (goal.progressNotes ||= []).push(`[${new Date().toISOString().slice(0, 16)}] ${progressNote}`);
      if (nextActions) goal.nextActions = nextActions;
      if (blockers) goal.blockers = blockers;
      if (linkedCronJobs) goal.linkedCronJobs = linkedCronJobs;
      if (priority) goal.priority = priority;
      if (autoSchedule !== undefined) goal.autoSchedule = autoSchedule;
      goal.updatedAt = new Date().toISOString();
      writeFileSync(found.filePath, JSON.stringify(goal, null, 2));
      logger.info({ goalId: id, status: goal.status, owner: found.owner }, 'Goal updated');
      return textResult(`Goal "${goal.title}" updated (status: ${goal.status})`);
    },
  );

  server.tool(
    'goal_list',
    'List persistent goals, optionally filtered by owner or status. Walks Clementine\'s global goals dir plus every agent\'s goals dir.',
    {
      owner: z.string().optional().describe('Filter by owner agent slug'),
      status: z.enum(['active', 'paused', 'completed', 'blocked']).optional().describe('Filter by status'),
    },
    async ({ owner, status }) => {
      let entries = listAllGoals();
      if (owner) entries = entries.filter(e => e.owner === owner);
      if (status) entries = entries.filter(e => e.goal.status === status);
      if (entries.length === 0) return textResult('No goals found matching the criteria.');
      const lines = entries.map(({ goal, owner: goalOwner }) => {
        const nextAct = goal.nextActions?.length ? ` | Next: ${goal.nextActions[0]}` : '';
        const linked = goal.linkedCronJobs?.length ? ` | Crons: ${goal.linkedCronJobs.join(', ')}` : '';
        return `- [${String(goal.status).toUpperCase()}] **${goal.title}** (${goal.id}) — ${goal.priority} priority, owner: ${goalOwner}${nextAct}${linked}`;
      });
      return textResult(`Goals (${entries.length}):\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'goal_get',
    'Get a single persistent goal with full history — progress notes, next actions, blockers, and linked cron jobs.',
    { id: z.string().describe('Goal ID') },
    async ({ id }) => {
      const goal = readGoalById(id);
      if (!goal) return textResult(`Goal not found: ${id}`);
      const sections = [
        `# ${goal.title}`,
        `**ID:** ${goal.id} | **Status:** ${goal.status} | **Priority:** ${goal.priority} | **Owner:** ${goal.owner}`,
        `**Created:** ${goal.createdAt} | **Updated:** ${goal.updatedAt}${goal.targetDate ? ` | **Target:** ${goal.targetDate}` : ''}`,
        `**Review:** ${goal.reviewFrequency}`,
        `\n## Description\n${goal.description}`,
      ];
      if (goal.progressNotes?.length) sections.push(`\n## Progress Notes\n${goal.progressNotes.map(n => `- ${n}`).join('\n')}`);
      if (goal.nextActions?.length) sections.push(`\n## Next Actions\n${goal.nextActions.map(a => `- [ ] ${a}`).join('\n')}`);
      if (goal.blockers?.length) sections.push(`\n## Blockers\n${goal.blockers.map(b => `- ${b}`).join('\n')}`);
      if (goal.linkedCronJobs?.length) sections.push(`\n## Linked Cron Jobs\n${goal.linkedCronJobs.map(c => `- ${c}`).join('\n')}`);
      return textResult(sections.join('\n'));
    },
  );

  server.tool(
    'goal_work',
    'Spawn a focused background work session on a specific goal. The daemon picks up the trigger and runs a goal-directed session as the goal\'s owner (so output lands in that agent\'s channel with that agent\'s tools). Results delivered via notifications.',
    {
      goal_id: z.string().describe('ID of the goal to work on'),
      focus: z.string().optional().describe('Specific aspect to focus on. Defaults to the goal\'s first nextAction.'),
      max_turns: z.number().optional().default(15).describe('Max agent turns for this work session'),
    },
    async ({ goal_id, focus, max_turns }) => {
      const goal = readGoalById(goal_id);
      if (!goal) return textResult(`Goal not found: ${goal_id}. Use goal_list to see available goals.`);
      if (goal.status !== 'active') return textResult(`Goal "${goal.title}" is ${goal.status} — only active goals can be worked on.`);
      if (!existsSync(GOAL_TRIGGER_DIR)) mkdirSync(GOAL_TRIGGER_DIR, { recursive: true });
      const trigger = {
        goalId: goal_id,
        focus: focus || goal.nextActions?.[0] || goal.description,
        maxTurns: max_turns,
        triggeredAt: new Date().toISOString(),
      };
      const triggerFile = path.join(GOAL_TRIGGER_DIR, `${Date.now()}-${goal_id}.trigger.json`);
      writeFileSync(triggerFile, JSON.stringify(trigger, null, 2));
      logger.info({ goalId: goal_id, owner: goal.owner, focus: trigger.focus }, 'Goal work session triggered');
      return textResult(
        `Triggered goal work session for "${goal.title}" (${goal_id}).\n` +
        `Owner: ${goal.owner}\n` +
        `Focus: ${trigger.focus}\n` +
        `The daemon will pick it up within a few seconds. Results delivered via notifications.`,
      );
    },
  );
}
