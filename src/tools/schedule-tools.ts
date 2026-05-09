/**
 * Clementine TypeScript — Schedule MCP tools.
 *
 * Thin chat-facing wrappers around src/agent/schedule-registry.ts so
 * the agent can compose the full automation flow from natural language:
 *
 *   user: "scrape Drive every 2 days for AI articles, save to memory"
 *   agent: 1. create_skill('drive-ai-scraper', { body: '...' })
 *          2. schedule_skill('drive-ai-scraper', '0 9 *_/2 * *')  (comment elides slash)
 *
 * 1.18.145 — closes the chat-parity gap on the automation side. Before
 * this, the agent could create skills but had no way to schedule them
 * recurringly without dropping to the dashboard.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import cron from 'node-cron';
import {
  listSchedules,
  getSchedule,
  setSchedule,
  removeSchedule,
  enableSchedule,
} from '../agent/schedule-registry.js';
import { loadSkillByName } from '../agent/skill-extractor.js';
import { textResult, logger } from './shared.js';

export function registerScheduleTools(server: McpServer): void {
  server.tool(
    'schedule_skill',
    'Schedule a skill to run automatically on a cron expression. Pair with create_skill to build "recurring brain feeds" or any other automation from chat. The skill must already exist in the catalog. Idempotent — calling twice for the same skill updates the existing schedule. Use enabled=false to pause without losing the schedule.',
    {
      skillName: z.string().describe('The skill slug (must already exist in the catalog — call create_skill first if needed).'),
      schedule: z.string().describe('Cron expression. Examples: "0 9 * * *" = daily 9am, "0 9 */2 * *" = every 2 days at 9am, "0 */4 * * *" = every 4 hours, "0 7 * * 1-5" = weekdays at 7am.'),
      enabled: z.boolean().optional().describe('When false, schedule is saved but the runner skips it. Default: true.'),
      agentSlug: z.string().nullable().optional().describe('Optional: run as a hired agent (e.g. "ross-the-sdr"). Default: null = Clementine.'),
    },
    async ({ skillName, schedule, enabled, agentSlug }) => {
      // Validate cron expression up-front so the user gets a clear
      // error before we touch the registry.
      if (!cron.validate(schedule)) {
        return textResult(`schedule_skill: "${schedule}" is not a valid cron expression. Try something like "0 9 * * *" (daily 9am).`);
      }

      // Validate the skill exists. Without this, the schedule would
      // silently sit in the registry and the cron scheduler would skip
      // it on every fire — confusing failure mode.
      const skill = loadSkillByName(skillName, agentSlug ?? undefined);
      if (!skill) {
        return textResult(
          `schedule_skill: skill "${skillName}" not found${agentSlug ? ` (in agent "${agentSlug}" scope)` : ''}. ` +
          `Create it first with create_skill, then schedule it.`,
        );
      }

      try {
        const entry = setSchedule(skillName, {
          schedule,
          enabled: enabled ?? true,
          agentSlug: agentSlug ?? null,
        });
        logger.info({ skillName, schedule, enabled: entry.enabled, agentSlug: entry.agentSlug }, 'schedule_skill: scheduled');
        return textResult(
          `Scheduled "${skillName}" to run on "${schedule}"` +
          (entry.enabled ? '' : ' (DISABLED — flip enabled:true to start firing)') +
          `. View on the Tasks page or call list_schedules to confirm.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, skillName }, 'schedule_skill: failed');
        return textResult(`schedule_skill failed: ${msg}`);
      }
    },
  );

  server.tool(
    'list_schedules',
    'List every scheduled skill and its cron expression. Returns the same data the dashboard\'s Tasks page shows for the SKILL-tagged rows.',
    {},
    async () => {
      try {
        const entries = listSchedules();
        if (entries.length === 0) {
          return textResult('No scheduled skills yet. Use schedule_skill to create one.');
        }
        const lines = [`${entries.length} scheduled skill${entries.length === 1 ? '' : 's'}:`];
        for (const e of entries) {
          const status = e.enabled ? '✓' : '⏸';
          const owner = e.agentSlug ? ` (as ${e.agentSlug})` : '';
          lines.push(`${status} ${e.skillName} — ${e.schedule}${owner}`);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`list_schedules failed: ${msg}`);
      }
    },
  );

  server.tool(
    'unschedule_skill',
    'Remove a skill\'s schedule entirely. The skill stays in the catalog and can still be run manually or rescheduled later. Use pause_schedule (enabled:false via schedule_skill) for a temporary pause instead.',
    {
      skillName: z.string().describe('The skill slug to unschedule.'),
    },
    async ({ skillName }) => {
      const existing = getSchedule(skillName);
      if (!existing) {
        return textResult(`unschedule_skill: "${skillName}" wasn't scheduled — nothing to do.`);
      }
      try {
        removeSchedule(skillName);
        logger.info({ skillName }, 'unschedule_skill: removed');
        return textResult(`Unscheduled "${skillName}". The skill stays in the catalog and can be run manually.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`unschedule_skill failed: ${msg}`);
      }
    },
  );

  server.tool(
    'pause_schedule',
    'Pause or resume an existing scheduled skill without losing its cron expression. Equivalent to schedule_skill with enabled:false but doesn\'t require re-passing the schedule string.',
    {
      skillName: z.string().describe('The skill slug.'),
      enabled: z.boolean().describe('true = resume firing, false = pause.'),
    },
    async ({ skillName, enabled }) => {
      const updated = enableSchedule(skillName, enabled);
      if (!updated) {
        return textResult(`pause_schedule: "${skillName}" isn't scheduled. Use schedule_skill to create the schedule first.`);
      }
      logger.info({ skillName, enabled }, 'pause_schedule: updated');
      return textResult(`${enabled ? 'Resumed' : 'Paused'} "${skillName}" (${updated.schedule}).`);
    },
  );
}
