/**
 * Clementine TypeScript — Decision-loop reflection MCP tool.
 *
 * `decision_reflection` runs the analysis from agent/decision-reflection.ts
 * for an agent and surfaces the result as a markdown report. Optionally
 * persists the report to the agent's reflections history and/or appends
 * a summary to their working-memory so the next heartbeat tick reads it
 * as prompt context.
 *
 * Intended usage:
 *   - Manual call by the owner ("Clementine, reflect on your week")
 *   - Weekly cron job that calls this for each active agent
 *   - On-demand by an agent when they suspect they're miscalibrated
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  analyzeAgentDecisions,
  formatReflectionReport,
  formatReflectionSummary,
} from '../agent/decision-reflection.js';
import { ACTIVE_AGENT_SLUG, AGENTS_DIR, logger, textResult } from './shared.js';

function reflectionsDir(slug: string): string {
  return path.join(AGENTS_DIR, slug, 'reflections');
}

function workingMemoryPath(slug: string): string {
  return path.join(AGENTS_DIR, slug, 'working-memory.md');
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Append a summary block to working-memory.md, creating the file if needed. */
function appendToWorkingMemory(slug: string, summary: string): void {
  const file = workingMemoryPath(slug);
  mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  if (existsSync(file)) existing = readFileSync(file, 'utf-8');
  const appended = (existing.endsWith('\n') || existing === '' ? existing : existing + '\n')
    + '\n'
    + summary
    + '\n';
  writeFileSync(file, appended);
}

export function registerDecisionReflectionTools(server: McpServer): void {
  server.tool(
    'decision_reflection',
    'Run a self-reflection on your recent autonomous decisions: read the proactive ledger, compute success rates per action type, identify miscalibration patterns, and surface concrete tuning suggestions. Use to spot when you are over-acting, under-acting, or going dormant. Optionally writes a summary to working-memory so your next heartbeat tick reads it as context.',
    {
      slug: z.string().optional().describe('Agent slug to reflect on. Defaults to the calling agent (or "clementine" for the daemon).'),
      window_days: z.number().optional().describe('Window in days to analyze. Default 7. Range 1-90.'),
      save_to_history: z.boolean().optional().describe('Persist the full report to vault/00-System/agents/<slug>/reflections/<date>.md (default true).'),
      append_to_memory: z.boolean().optional().describe('Append a compact summary to working-memory.md so the next tick reads it (default false). Be deliberate — repeated appends bloat the prompt.'),
    },
    async ({ slug, window_days, save_to_history, append_to_memory }) => {
      const targetSlug = slug || ACTIVE_AGENT_SLUG || 'clementine';
      const window = Math.max(1, Math.min(90, typeof window_days === 'number' ? window_days : 7));
      const persistHistory = save_to_history !== false; // default true
      const updateMemory = append_to_memory === true;   // default false (explicit opt-in)

      const reflection = analyzeAgentDecisions(targetSlug, window);
      const report = formatReflectionReport(reflection);

      const writes: string[] = [];
      if (persistHistory) {
        try {
          const dir = reflectionsDir(targetSlug);
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${todayStamp()}.md`);
          writeFileSync(file, report);
          writes.push(`Saved to ${file}`);
        } catch (err) {
          logger.warn({ err, slug: targetSlug }, 'Failed to save reflection history');
          writes.push(`Failed to save history: ${String(err).slice(0, 200)}`);
        }
      }

      if (updateMemory) {
        try {
          appendToWorkingMemory(targetSlug, formatReflectionSummary(reflection));
          writes.push(`Appended summary to ${workingMemoryPath(targetSlug)}`);
        } catch (err) {
          logger.warn({ err, slug: targetSlug }, 'Failed to append reflection to working-memory');
          writes.push(`Failed to update working-memory: ${String(err).slice(0, 200)}`);
        }
      }

      const footer = writes.length > 0 ? '\n\n---\n' + writes.map((w) => `- ${w}`).join('\n') : '';
      return textResult(report + footer);
    },
  );
}
