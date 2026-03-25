/**
 * Clementine TypeScript — Daily Planning Session.
 *
 * Gathers context from goals, cron runs, reflections, tasks, and inbox,
 * then uses a lightweight Haiku call to produce a prioritized daily plan.
 * Plans are persisted to ~/.clementine/plans/daily/{date}.json.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import Anthropic from '@anthropic-ai/sdk';
import {
  BASE_DIR,
  GOALS_DIR,
  CRON_REFLECTIONS_DIR,
  TASKS_FILE,
  INBOX_DIR,
  MODELS,
} from '../config.js';
import type { PersistentGoal, DailyPlan, DailyPlanPriority } from '../types.js';
import { CronRunLog } from '../gateway/heartbeat.js';

const logger = pino({ name: 'clementine.daily-planner' });

const PLANS_DIR = path.join(BASE_DIR, 'plans', 'daily');

// ── .env reader (self-contained — no config.ts secret imports) ───────

function getApiKey(): string {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return '';
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    if (key !== 'ANTHROPIC_API_KEY') continue;
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── DailyPlanner ────────────────────────────────────────────────────

export class DailyPlanner {
  constructor() {
    if (!existsSync(PLANS_DIR)) {
      mkdirSync(PLANS_DIR, { recursive: true });
    }
  }

  hasPlanForToday(): boolean {
    const planPath = path.join(PLANS_DIR, `${todayStr()}.json`);
    return existsSync(planPath);
  }

  getPlan(date?: string): DailyPlan | null {
    const d = date ?? todayStr();
    const planPath = path.join(PLANS_DIR, `${d}.json`);
    if (!existsSync(planPath)) return null;
    try {
      return JSON.parse(readFileSync(planPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  async plan(): Promise<DailyPlan> {
    const context = this.gatherContext();
    const plan = await this.generatePlan(context);

    const planPath = path.join(PLANS_DIR, `${plan.date}.json`);
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    logger.info({ date: plan.date, priorities: plan.priorities.length }, 'Daily plan generated');

    return plan;
  }

  // ── Context Gathering ───────────────────────────────────────────────

  private gatherContext(): string {
    const sections: string[] = [];

    // Active goals
    const goals = this.loadActiveGoals();
    if (goals.length > 0) {
      const goalLines = goals.map(g => {
        const parts = [`- "${g.title}" (${g.priority} priority, owner: ${g.owner})`];
        if (g.nextActions?.length) parts.push(`  Next: ${g.nextActions.slice(0, 3).join('; ')}`);
        if (g.blockers?.length) parts.push(`  Blockers: ${g.blockers.join('; ')}`);
        if (g.targetDate) parts.push(`  Target: ${g.targetDate}`);
        return parts.join('\n');
      });
      sections.push(`## Active Goals (${goals.length})\n${goalLines.join('\n')}`);
    }

    // Recent cron failures (last 24h)
    const failures = this.loadRecentCronFailures();
    if (failures.length > 0) {
      const failLines = failures.map(f => `- ${f.jobName}: ${f.error ?? 'unknown error'} (${f.finishedAt})`);
      sections.push(`## Recent Cron Failures (last 24h)\n${failLines.join('\n')}`);
    }

    // Recent reflections
    const reflections = this.loadRecentReflections();
    if (reflections.length > 0) {
      const refLines = reflections.map(r => `- ${r.jobName} (quality: ${r.quality}/5): ${r.gap || 'no gap noted'}`);
      sections.push(`## Recent Cron Reflections\n${refLines.join('\n')}`);
    }

    // Pending tasks
    const pendingTasks = this.loadPendingTasks();
    if (pendingTasks.length > 0) {
      sections.push(`## Pending Tasks (${pendingTasks.length})\n${pendingTasks.slice(0, 15).map(t => `- ${t}`).join('\n')}`);
    }

    // Inbox
    const inboxCount = this.countInboxItems();
    if (inboxCount > 0) {
      sections.push(`## Inbox\n${inboxCount} unprocessed item(s)`);
    }

    // Delegated tasks
    const delegated = this.loadDelegatedTasks();
    if (delegated.length > 0) {
      sections.push(`## Delegated Tasks (${delegated.length})\n${delegated.map(d => `- [${d.status}] ${d.task} (to: ${d.toAgent})`).join('\n')}`);
    }

    return sections.join('\n\n') || 'No context available — all clear.';
  }

  private loadActiveGoals(): PersistentGoal[] {
    if (!existsSync(GOALS_DIR)) return [];
    try {
      const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
      const goals: PersistentGoal[] = [];
      for (const f of files) {
        try {
          const goal = JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8'));
          if (goal.status === 'active') goals.push(goal);
        } catch { continue; }
      }
      return goals.sort((a, b) => {
        const p = { high: 0, medium: 1, low: 2 };
        return (p[a.priority] ?? 2) - (p[b.priority] ?? 2);
      });
    } catch {
      return [];
    }
  }

  private loadRecentCronFailures(): Array<{ jobName: string; error?: string; finishedAt: string }> {
    const runDir = path.join(BASE_DIR, 'cron', 'runs');
    if (!existsSync(runDir)) return [];

    const cutoff = Date.now() - 86_400_000;
    const failures: Array<{ jobName: string; error?: string; finishedAt: string }> = [];

    try {
      for (const f of readdirSync(runDir).filter(f => f.endsWith('.jsonl'))) {
        try {
          const lines = readFileSync(path.join(runDir, f), 'utf-8').trim().split('\n').filter(Boolean);
          for (const line of lines.slice(-10)) {
            try {
              const entry = JSON.parse(line);
              if (entry.status !== 'ok' && entry.finishedAt && new Date(entry.finishedAt).getTime() > cutoff) {
                failures.push({ jobName: entry.jobName ?? f.replace('.jsonl', ''), error: entry.error, finishedAt: entry.finishedAt });
              }
            } catch { continue; }
          }
        } catch { continue; }
      }
    } catch { /* non-fatal */ }

    return failures;
  }

  private loadRecentReflections(): Array<{ jobName: string; quality: number; gap: string }> {
    if (!existsSync(CRON_REFLECTIONS_DIR)) return [];

    const results: Array<{ jobName: string; quality: number; gap: string }> = [];

    try {
      for (const f of readdirSync(CRON_REFLECTIONS_DIR).filter(f => f.endsWith('.jsonl'))) {
        try {
          const lines = readFileSync(path.join(CRON_REFLECTIONS_DIR, f), 'utf-8').trim().split('\n').filter(Boolean);
          const recent = lines.slice(-5);
          for (const line of recent) {
            try {
              const entry = JSON.parse(line);
              results.push({ jobName: entry.jobName ?? f.replace('.jsonl', ''), quality: entry.quality ?? 0, gap: entry.gap ?? '' });
            } catch { continue; }
          }
        } catch { continue; }
      }
    } catch { /* non-fatal */ }

    return results;
  }

  private loadPendingTasks(): string[] {
    if (!existsSync(TASKS_FILE)) return [];
    try {
      const content = readFileSync(TASKS_FILE, 'utf-8');
      return content.split('\n')
        .filter(line => /^\s*- \[ \]/.test(line))
        .map(line => line.trim().replace(/^- \[ \]\s*/, ''));
    } catch {
      return [];
    }
  }

  private countInboxItems(): number {
    if (!existsSync(INBOX_DIR)) return 0;
    try {
      return readdirSync(INBOX_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_')).length;
    } catch {
      return 0;
    }
  }

  private loadDelegatedTasks(): Array<{ task: string; toAgent: string; status: string }> {
    const delegationsDir = path.join(BASE_DIR, 'vault', '00-System', 'agents');
    if (!existsSync(delegationsDir)) return [];

    const results: Array<{ task: string; toAgent: string; status: string }> = [];
    try {
      for (const agentDir of readdirSync(delegationsDir)) {
        const tasksDir = path.join(delegationsDir, agentDir, 'delegations');
        if (!existsSync(tasksDir)) continue;
        try {
          for (const f of readdirSync(tasksDir).filter(f => f.endsWith('.json'))) {
            try {
              const task = JSON.parse(readFileSync(path.join(tasksDir, f), 'utf-8'));
              if (task.status !== 'completed') {
                results.push({ task: task.task ?? f, toAgent: task.toAgent ?? agentDir, status: task.status ?? 'pending' });
              }
            } catch { continue; }
          }
        } catch { continue; }
      }
    } catch { /* non-fatal */ }

    return results;
  }

  // ── Plan Generation ─────────────────────────────────────────────────

  private async generatePlan(context: string): Promise<DailyPlan> {
    const today = todayStr();
    const prompt = `Today is ${today}. Based on the following context about active goals, tasks, cron job health, and inbox items, produce a prioritized daily plan.

${context}

Respond with a JSON object (no markdown fencing) matching this schema:
{
  "date": "${today}",
  "createdAt": "<ISO timestamp>",
  "priorities": [
    { "type": "goal|task|cron-fix|inbox", "id": "<goal-id or description>", "action": "<what to do>", "urgency": <1-5> }
  ],
  "suggestedCronChanges": [
    { "job": "<job name>", "change": "adjust-schedule|adjust-prompt|disable", "reason": "<why>" }
  ],
  "newWork": [
    { "description": "<what to do>", "goalId": "<optional goal id>", "suggestedSchedule": "<optional cron expression>" }
  ],
  "summary": "<2-3 sentence summary of the day's focus>"
}

Rules:
- Urgency 5 = critical/overdue, 1 = nice-to-have
- Limit to at most 10 priorities, 5 cron changes, 5 new work items
- Focus on actionable items, not status reports
- If everything is on track, return minimal priorities`;

    const apiKey = getApiKey();
    if (!apiKey) {
      logger.warn('No ANTHROPIC_API_KEY found — generating fallback plan');
      return this.fallbackPlan(today);
    }

    try {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: MODELS.haiku,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a planning assistant. Analyze the context and produce a prioritized daily plan as JSON. Return only valid JSON, no markdown fencing.',
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      const plan = JSON.parse(text) as DailyPlan;
      plan.date = today;
      plan.createdAt = new Date().toISOString();
      plan.priorities = plan.priorities ?? [];
      plan.suggestedCronChanges = plan.suggestedCronChanges ?? [];
      plan.newWork = plan.newWork ?? [];
      plan.summary = plan.summary ?? 'No summary generated.';

      return plan;
    } catch (err) {
      logger.warn({ err }, 'LLM plan generation failed — using fallback');
      return this.fallbackPlan(today);
    }
  }

  private fallbackPlan(date: string): DailyPlan {
    const priorities: DailyPlanPriority[] = [];

    // Add high-priority goals
    const goals = this.loadActiveGoals();
    for (const g of goals.filter(g => g.priority === 'high').slice(0, 3)) {
      priorities.push({
        type: 'goal',
        id: g.id,
        action: g.nextActions?.[0] ?? `Review "${g.title}"`,
        urgency: 4,
      });
    }

    // Add cron failures
    const failures = this.loadRecentCronFailures();
    for (const f of failures.slice(0, 3)) {
      priorities.push({
        type: 'cron-fix',
        id: f.jobName,
        action: `Fix failing job: ${f.jobName}`,
        urgency: 4,
      });
    }

    // Add inbox
    const inbox = this.countInboxItems();
    if (inbox > 0) {
      priorities.push({
        type: 'inbox',
        id: 'inbox',
        action: `Process ${inbox} inbox item(s)`,
        urgency: 2,
      });
    }

    return {
      date,
      createdAt: new Date().toISOString(),
      priorities,
      suggestedCronChanges: [],
      newWork: [],
      summary: `Fallback plan: ${priorities.length} items to address. LLM planning unavailable.`,
    };
  }
}
