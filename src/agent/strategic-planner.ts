/**
 * Clementine TypeScript — Strategic Planner (Multi-Horizon Planning).
 *
 * Weekly reviews: synthesize daily plans + goal progress into accomplishments,
 * missed targets, patterns, and recommendations.
 *
 * Monthly assessments: cross-reference weekly reviews with goal completion
 * and self-improvement experiments. Proposes OKR-style goals.
 *
 * Plans are persisted to ~/.clementine/plans/weekly/ and monthly/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import Anthropic from '@anthropic-ai/sdk';
import { BASE_DIR, GOALS_DIR, MODELS } from '../config.js';
import type { DailyPlan, PersistentGoal } from '../types.js';

const logger = pino({ name: 'clementine.strategic-planner' });

const DAILY_PLANS_DIR = path.join(BASE_DIR, 'plans', 'daily');
const WEEKLY_PLANS_DIR = path.join(BASE_DIR, 'plans', 'weekly');
const MONTHLY_PLANS_DIR = path.join(BASE_DIR, 'plans', 'monthly');

export interface WeeklyReview {
  weekId: string;            // YYYY-Wnn
  createdAt: string;
  accomplishments: string[];
  missedTargets: string[];
  patterns: string[];        // recurring themes or issues
  recommendations: string[]; // what to focus on next week
  goalProgress: Array<{ goalId: string; title: string; status: string; noteCount: number }>;
  summary: string;
}

export interface MonthlyAssessment {
  monthId: string;           // YYYY-MM
  createdAt: string;
  weeklyTrends: string[];
  goalCompletionRate: number;
  systemicIssues: string[];
  proposedGoals: Array<{ title: string; description: string; priority: string }>;
  summary: string;
}

// ── .env reader ──────────────────────────────────────────────────────

function getEnvValue(key: string): string {
  if (process.env[key]) return process.env[key]!;
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return '';
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    if (trimmed.slice(0, eqIndex) !== key) continue;
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

function getAnthropicCredentials(): { apiKey?: string; authToken?: string } | null {
  const oauthToken = getEnvValue('CLAUDE_CODE_OAUTH_TOKEN');
  if (oauthToken) return { authToken: oauthToken };
  const authToken = getEnvValue('ANTHROPIC_AUTH_TOKEN');
  if (authToken) return { authToken };
  const apiKey = getEnvValue('ANTHROPIC_API_KEY');
  if (apiKey) return { apiKey };
  return null;
}

function makeAnthropicClient(): Anthropic | null {
  const creds = getAnthropicCredentials();
  if (!creds) return null;
  return new Anthropic(creds.authToken ? { authToken: creds.authToken } : { apiKey: creds.apiKey });
}

// ── Strategic Planner ────────────────────────────────────────────────

export class StrategicPlanner {
  constructor() {
    mkdirSync(WEEKLY_PLANS_DIR, { recursive: true });
    mkdirSync(MONTHLY_PLANS_DIR, { recursive: true });
  }

  // ── Weekly Review ────────────────────────────────────────────────────

  hasWeeklyReview(weekId?: string): boolean {
    const id = weekId ?? currentWeekId();
    return existsSync(path.join(WEEKLY_PLANS_DIR, `${id}.json`));
  }

  async generateWeeklyReview(): Promise<WeeklyReview> {
    const weekId = currentWeekId();
    const context = this.gatherWeeklyContext();
    const review = await this.callLlmForWeekly(weekId, context);

    writeFileSync(path.join(WEEKLY_PLANS_DIR, `${weekId}.json`), JSON.stringify(review, null, 2));
    logger.info({ weekId, accomplishments: review.accomplishments.length }, 'Weekly review generated');
    return review;
  }

  private gatherWeeklyContext(): string {
    const parts: string[] = [];

    // Last 7 daily plans
    const dailyPlans = this.loadRecentDailyPlans(7);
    if (dailyPlans.length > 0) {
      parts.push('## Daily Plans This Week');
      for (const plan of dailyPlans) {
        const priorities = plan.priorities.map(p => `  - [${p.type}] ${p.action} (urgency: ${p.urgency})`).join('\n');
        parts.push(`### ${plan.date}\n${plan.summary}\n${priorities}`);
      }
    }

    // Goal progress
    const goals = this.loadActiveGoals();
    if (goals.length > 0) {
      parts.push('## Goal Status');
      for (const goal of goals) {
        const recentNotes = (goal.progressNotes ?? []).slice(-3).join('; ');
        parts.push(`- [${goal.priority}] ${goal.title}: ${goal.status} | Notes: ${recentNotes || 'none'}`);
      }
    }

    // Goal progress logs
    const progressDir = path.join(GOALS_DIR, 'progress');
    if (existsSync(progressDir)) {
      const files = readdirSync(progressDir).filter(f => f.endsWith('.progress.jsonl'));
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const entries: string[] = [];
      for (const file of files.slice(0, 10)) {
        const lines = readFileSync(path.join(progressDir, file), 'utf-8').trim().split('\n').filter(Boolean);
        for (const line of lines.slice(-10)) {
          try {
            const entry = JSON.parse(line);
            if (entry.timestamp > weekAgo) {
              entries.push(`[${entry.status}] ${entry.focus}: ${entry.resultSnippet?.slice(0, 80)}`);
            }
          } catch { continue; }
        }
      }
      if (entries.length > 0) {
        parts.push(`## Goal Work Sessions This Week\n${entries.join('\n')}`);
      }
    }

    return parts.join('\n\n');
  }

  private async callLlmForWeekly(weekId: string, context: string): Promise<WeeklyReview> {
    const goals = this.loadActiveGoals();

    const prompt =
      `You are reviewing the week ${weekId}. Based on the context below, produce a weekly review.\n\n` +
      `${context}\n\n` +
      `Output ONLY a JSON object:\n` +
      `{\n` +
      `  "accomplishments": ["what was achieved"],\n` +
      `  "missedTargets": ["what was planned but not done"],\n` +
      `  "patterns": ["recurring themes or issues noticed"],\n` +
      `  "recommendations": ["what to focus on next week"],\n` +
      `  "summary": "2-3 sentence overall assessment"\n` +
      `}`;

    const defaultReview: WeeklyReview = {
      weekId,
      createdAt: new Date().toISOString(),
      accomplishments: [],
      missedTargets: [],
      patterns: [],
      recommendations: [],
      goalProgress: goals.map(g => ({
        goalId: g.id,
        title: g.title,
        status: g.status,
        noteCount: g.progressNotes?.length ?? 0,
      })),
      summary: 'No data available for weekly review.',
    };

    const client = makeAnthropicClient();
    if (!client) return defaultReview;

    try {
      const response = await client.messages.create({
        model: MODELS.haiku,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          ...defaultReview,
          accomplishments: parsed.accomplishments ?? [],
          missedTargets: parsed.missedTargets ?? [],
          patterns: parsed.patterns ?? [],
          recommendations: parsed.recommendations ?? [],
          summary: parsed.summary ?? defaultReview.summary,
        };
      }
    } catch (err) {
      logger.warn({ err }, 'Weekly review LLM call failed');
    }

    return defaultReview;
  }

  // ── Monthly Assessment ───────────────────────────────────────────────

  hasMonthlyAssessment(monthId?: string): boolean {
    const id = monthId ?? currentMonthId();
    return existsSync(path.join(MONTHLY_PLANS_DIR, `${id}.json`));
  }

  async generateMonthlyAssessment(): Promise<MonthlyAssessment> {
    const monthId = currentMonthId();
    const context = this.gatherMonthlyContext();
    const assessment = await this.callLlmForMonthly(monthId, context);

    writeFileSync(path.join(MONTHLY_PLANS_DIR, `${monthId}.json`), JSON.stringify(assessment, null, 2));
    logger.info({ monthId }, 'Monthly assessment generated');
    return assessment;
  }

  private gatherMonthlyContext(): string {
    const parts: string[] = [];

    // Last 4 weekly reviews
    const weeklyFiles = existsSync(WEEKLY_PLANS_DIR)
      ? readdirSync(WEEKLY_PLANS_DIR).filter(f => f.endsWith('.json')).sort().slice(-4)
      : [];

    if (weeklyFiles.length > 0) {
      parts.push('## Weekly Reviews');
      for (const file of weeklyFiles) {
        try {
          const review: WeeklyReview = JSON.parse(readFileSync(path.join(WEEKLY_PLANS_DIR, file), 'utf-8'));
          parts.push(`### ${review.weekId}\n${review.summary}`);
          if (review.patterns.length > 0) {
            parts.push(`Patterns: ${review.patterns.join('; ')}`);
          }
        } catch { continue; }
      }
    }

    // Goal completion stats
    const goals = this.loadActiveGoals();
    const allGoals = this.loadAllGoals();
    const completed = allGoals.filter(g => g.status === 'completed');
    parts.push(`## Goals: ${goals.length} active, ${completed.length} completed this period`);

    return parts.join('\n\n');
  }

  private async callLlmForMonthly(monthId: string, context: string): Promise<MonthlyAssessment> {
    const allGoals = this.loadAllGoals();
    const completed = allGoals.filter(g => g.status === 'completed').length;
    const total = allGoals.length || 1;

    const defaultAssessment: MonthlyAssessment = {
      monthId,
      createdAt: new Date().toISOString(),
      weeklyTrends: [],
      goalCompletionRate: completed / total,
      systemicIssues: [],
      proposedGoals: [],
      summary: 'No data available for monthly assessment.',
    };

    const client2 = makeAnthropicClient();
    if (!client2) return defaultAssessment;

    const prompt =
      `You are generating a monthly strategic assessment for ${monthId}.\n\n` +
      `${context}\n\n` +
      `Output ONLY a JSON object:\n` +
      `{\n` +
      `  "weeklyTrends": ["trends across the weekly reviews"],\n` +
      `  "systemicIssues": ["recurring problems that need structural fixes"],\n` +
      `  "proposedGoals": [{"title": "...", "description": "...", "priority": "high|medium|low"}],\n` +
      `  "summary": "2-3 sentence strategic assessment"\n` +
      `}`;

    try {
      const response = await client2.messages.create({
        model: MODELS.haiku,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          ...defaultAssessment,
          weeklyTrends: parsed.weeklyTrends ?? [],
          systemicIssues: parsed.systemicIssues ?? [],
          proposedGoals: parsed.proposedGoals ?? [],
          summary: parsed.summary ?? defaultAssessment.summary,
        };
      }
    } catch (err) {
      logger.warn({ err }, 'Monthly assessment LLM call failed');
    }

    return defaultAssessment;
  }

  // ── Goal-Plan Alignment Check ────────────────────────────────────────

  /**
   * Check if today's daily plan aligns with active high-priority goals.
   * Returns a warning string if misaligned, null if fine.
   */
  checkGoalPlanAlignment(dailyPlan: DailyPlan): string | null {
    const goals = this.loadActiveGoals();
    const highPriority = goals.filter(g => g.priority === 'high');
    if (highPriority.length === 0) return null;

    // Check if any priority items reference a high-priority goal
    const goalTitlesLower = highPriority.map(g => g.title.toLowerCase());
    const priorityTexts = dailyPlan.priorities.map(p => p.action.toLowerCase());

    const hasGoalWork = goalTitlesLower.some(title =>
      priorityTexts.some(pt => pt.includes(title.slice(0, 20)) || pt.includes(title.split(' ')[0]))
    );

    // Also check if any priorities are of type 'goal'
    const hasGoalType = dailyPlan.priorities.some(p => p.type === 'goal');

    if (!hasGoalWork && !hasGoalType) {
      const goalNames = highPriority.map(g => g.title).join(', ');
      return `Today's plan doesn't directly advance any high-priority goals (${goalNames}). Consider scheduling focused work on at least one.`;
    }

    return null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private loadRecentDailyPlans(days: number): DailyPlan[] {
    if (!existsSync(DAILY_PLANS_DIR)) return [];
    const files = readdirSync(DAILY_PLANS_DIR).filter(f => f.endsWith('.json')).sort().slice(-days);
    return files.map(f => {
      try { return JSON.parse(readFileSync(path.join(DAILY_PLANS_DIR, f), 'utf-8')); }
      catch { return null; }
    }).filter(Boolean);
  }

  private loadActiveGoals(): PersistentGoal[] {
    if (!existsSync(GOALS_DIR)) return [];
    return readdirSync(GOALS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter((g: any) => g && g.status === 'active');
  }

  private loadAllGoals(): PersistentGoal[] {
    if (!existsSync(GOALS_DIR)) return [];
    return readdirSync(GOALS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean);
  }
}

// ── Date helpers ───────────────────────────────────────────────────────

function currentWeekId(): string {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now.getTime() - yearStart.getTime()) / 86_400_000 + yearStart.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function currentMonthId(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
