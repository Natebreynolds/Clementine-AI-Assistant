/**
 * Clementine TypeScript — Heartbeat scheduler.
 *
 * HeartbeatScheduler: periodic general check-ins using setInterval.
 * Channel-agnostic — sends notifications via the NotificationDispatcher.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import {
  HEARTBEAT_FILE,
  TASKS_FILE,
  INBOX_DIR,
  DAILY_NOTES_DIR,
  HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_ACTIVE_START,
  HEARTBEAT_ACTIVE_END,
  BASE_DIR,
  GOALS_DIR,
} from '../config.js';
import type { HeartbeatState } from '../types.js';
import type { CronRunEntry } from '../types.js';
import type { NotificationDispatcher } from './notifications.js';
import type { Gateway } from './router.js';
import { logToDailyNote, CronRunLog } from './cron-scheduler.js';

const logger = pino({ name: 'clementine.heartbeat' });

// ── HeartbeatScheduler ────────────────────────────────────────────────

export class HeartbeatScheduler {
  private readonly stateFile: string;
  private gateway: Gateway;
  private dispatcher: NotificationDispatcher;
  private lastState: HeartbeatState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSelfImproveDate = '';
  private lastAgentSiRuns = new Map<string, string>();

  private getLastAgentSiRun(slug: string): string | undefined {
    return this.lastAgentSiRuns.get(slug);
  }

  private setLastAgentSiRun(slug: string): void {
    this.lastAgentSiRuns.set(slug, new Date().toISOString());
  }

  constructor(gateway: Gateway, dispatcher: NotificationDispatcher) {
    this.gateway = gateway;
    this.dispatcher = dispatcher;
    this.stateFile = path.join(BASE_DIR, '.heartbeat_state.json');
    this.lastState = this.loadState();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
    this.timer = setInterval(() => {
      this.heartbeatTick().catch((err) => {
        logger.error({ err }, 'Heartbeat tick failed');
      });
    }, intervalMs);
    logger.info(
      `Heartbeat started: every ${HEARTBEAT_INTERVAL_MINUTES}min, active ${HEARTBEAT_ACTIVE_START}:00-${HEARTBEAT_ACTIVE_END}:00`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Heartbeat stopped');
    }
  }

  async runManual(): Promise<string> {
    const standingInstructions = this.readHeartbeatConfig();
    const now = new Date();
    const [, currentDetails] = this.computeStateFingerprint();
    let changesSummary = this.computeChangesSummary(
      this.lastState.details ?? {},
      currentDetails,
    );
    const activitySummary = this.getRecentActivitySummary();
    if (activitySummary) {
      changesSummary += `\n\nRecent activity:\n${activitySummary}`;
    }
    const goalSummary = HeartbeatScheduler.loadGoalSummary();
    if (goalSummary) {
      changesSummary += `\n\n${goalSummary}`;
    }
    const timeContext = HeartbeatScheduler.getTimeContext(now.getHours());

    try {
      const response = await this.gateway.handleHeartbeat(
        standingInstructions,
        changesSummary,
        timeContext,
      );
      return response || '*(heartbeat completed — nothing to report)*';
    } catch (err) {
      logger.error({ err }, 'Manual heartbeat failed');
      return `Heartbeat error: ${err}`;
    }
  }

  // ── Private methods ─────────────────────────────────────────────────

  private async heartbeatTick(): Promise<void> {
    // Periodic housekeeping: evict stale gateway sessions
    try { this.gateway.evictStaleSessions(); } catch (err) { logger.warn({ err }, 'Session eviction failed'); }

    const now = new Date();
    const hour = now.getHours();

    // Check active hours
    if (hour < HEARTBEAT_ACTIVE_START || hour >= HEARTBEAT_ACTIVE_END) {
      logger.debug(`Heartbeat skipped: outside active hours (${hour}:00)`);
      return;
    }

    // ── Daily planning session: first tick of the day ──
    let dailyPlanner: import('../agent/daily-planner.js').DailyPlanner | null = null;
    try {
      const { DailyPlanner } = await import('../agent/daily-planner.js');
      dailyPlanner = new DailyPlanner();
      if (!dailyPlanner.hasPlanForToday()) {
        logger.info('First active-hours tick — generating daily plan');
        const plan = await dailyPlanner.plan();
        if (plan.priorities.length > 0) {
          const highUrgency = plan.priorities.filter(p => p.urgency >= 4);
          if (highUrgency.length > 0) {
            const goalTriggerDir = path.join(BASE_DIR, 'cron', 'goal-triggers');
            mkdirSync(goalTriggerDir, { recursive: true });
            for (const item of highUrgency) {
              if (item.type === 'goal') {
                const triggerPath = path.join(goalTriggerDir, `${item.id}.trigger.json`);
                if (!existsSync(triggerPath)) {
                  writeFileSync(triggerPath, JSON.stringify({
                    goalId: item.id,
                    focus: item.action,
                    maxTurns: 10,
                    triggeredAt: new Date().toISOString(),
                    source: 'daily-plan',
                  }, null, 2));
                }
              }
            }
          }
          logger.info({ priorities: plan.priorities.length, urgent: plan.priorities.filter(p => p.urgency >= 4).length }, 'Daily plan generated');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Daily planning failed (non-fatal)');
    }

    // Compute current state for context (always run — heartbeats keep the agent alive)
    const [currentFingerprint, currentDetails] = this.computeStateFingerprint();

    // Build change summary — tells the agent what's different since last tick
    let changesSummary = this.computeChangesSummary(
      this.lastState.details ?? {},
      currentDetails,
    );

    // Include recent chat/cron activity so the heartbeat knows what happened
    const activitySummary = this.getRecentActivitySummary();
    if (activitySummary) {
      changesSummary += `\n\nRecent activity:\n${activitySummary}`;
    }

    // Inject active goal summaries so the heartbeat can flag goals needing attention
    const goalSummary = HeartbeatScheduler.loadGoalSummary();
    if (goalSummary) {
      changesSummary += `\n\n${goalSummary}`;
    }

    // Enrich active goals with relevant memory snippets
    const goalMemoryContext = this.enrichGoalsWithMemory();
    if (goalMemoryContext) {
      changesSummary += `\n\n${goalMemoryContext}`;
    }

    // Inject daily plan summary if available
    try {
      const todayPlan = dailyPlanner?.getPlan();
      if (todayPlan) {
        changesSummary += `\n\n## Today's Plan\n${todayPlan.summary}\nTop priorities: ${todayPlan.priorities.slice(0, 3).map(p => p.action).join('; ')}`;
      }
    } catch (err) { logger.warn({ err }, 'Daily plan enrichment failed'); }

    // Persist new state
    this.lastState = {
      fingerprint: currentFingerprint,
      details: currentDetails,
      timestamp: now.toISOString(),
    };
    this.saveState();

    // Build time-of-day context
    const timeContext = HeartbeatScheduler.getTimeContext(hour);

    // Read standing instructions from HEARTBEAT.md
    const standingInstructions = this.readHeartbeatConfig();

    try {
      const response = await this.gateway.handleHeartbeat(
        standingInstructions,
        changesSummary,
        timeContext,
      );

      const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const timeStr = `${h12}:${String(now.getMinutes()).padStart(2, '0')} ${ampm}`;
      if (response && !HeartbeatScheduler.isSilent(response)) {
        await this.dispatcher.send(`**[${timeStr} check-in]**\n\n${response}`);
        logToDailyNote(`**${timeStr}**: ${response.slice(0, 100).replace(/\n/g, ' ')}`);
      } else {
        logger.info(`Heartbeat silent at ${timeStr}`);
        // Don't log "all clear" heartbeats to daily notes — they create noise
      }
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick failed');
    }

    // Fire-and-forget: nudge stale goals by writing trigger files
    this.nudgeStaleGoals();

    // Fire-and-forget: process inbox items
    this.processInbox();

    // Nightly self-improvement: run once per day at 2 AM
    if (hour === 2 && this.lastSelfImproveDate !== new Date().toISOString().slice(0, 10)) {
      this.lastSelfImproveDate = new Date().toISOString().slice(0, 10);
      logger.info('Triggering nightly self-improvement cycle');
      this.gateway.handleSelfImprove('run-nightly').catch(err => {
        logger.error({ err }, 'Nightly self-improvement failed');
      });
    }

    // Weekly per-agent improvement: one agent per day, cycling through
    if (hour === 3) {
      try {
        const agentMgr = this.gateway.getAgentManager();
        const agents = agentMgr.listAll().filter(a => a.slug !== 'clementine');
        if (agents.length > 0) {
          const dayOfYear = Math.floor((Date.now() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
          const agentIndex = dayOfYear % agents.length;
          const targetAgent = agents[agentIndex];

          // Only run weekly (check if 7 days since last run for this agent)
          const lastRun = this.getLastAgentSiRun(targetAgent.slug);
          const daysSinceLastRun = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 86400000 : Infinity;

          if (daysSinceLastRun >= 7) {
            logger.info({ agentSlug: targetAgent.slug }, 'Triggering weekly per-agent self-improvement');
            this.gateway.handleSelfImprove('run-agent', { experimentId: targetAgent.slug }).catch(err => {
              logger.error({ err, agentSlug: targetAgent.slug }, 'Per-agent self-improvement failed');
            });
            this.setLastAgentSiRun(targetAgent.slug);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Per-agent self-improvement scheduling error');
      }
    }
  }

  private readHeartbeatConfig(): string {
    if (!existsSync(HEARTBEAT_FILE)) {
      return 'Check for overdue tasks. Ensure today\'s daily note exists.';
    }
    const raw = readFileSync(HEARTBEAT_FILE, 'utf-8');
    const parsed = matter(raw);
    return parsed.content;
  }

  private loadState(): HeartbeatState {
    if (existsSync(this.stateFile)) {
      try {
        return JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      } catch {
        logger.warn('Failed to load heartbeat state — starting fresh');
      }
    }
    return { fingerprint: '', details: {}, timestamp: '' };
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.lastState, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save heartbeat state');
    }
  }

  private computeStateFingerprint(): [string, Record<string, number | string>] {
    const details: Record<string, number | string> = {};
    const todayStr = new Date().toISOString().slice(0, 10);

    // Count tasks by status from TASKS.md
    if (existsSync(TASKS_FILE)) {
      const content = readFileSync(TASKS_FILE, 'utf-8');
      let overdue = 0;
      let dueToday = 0;
      let pending = 0;

      for (const line of content.split('\n')) {
        const s = line.trim();
        if (/^- \[ \]/.test(s)) {
          pending++;
          const dueMatch = s.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
          if (dueMatch) {
            const dueDate = dueMatch[1];
            if (dueDate < todayStr) overdue++;
            else if (dueDate === todayStr) dueToday++;
          }
        }
      }
      details.tasks_pending = pending;
      details.tasks_overdue = overdue;
      details.tasks_due_today = dueToday;
    }

    // Count inbox items
    if (existsSync(INBOX_DIR)) {
      try {
        const files = readdirSync(INBOX_DIR).filter((f) => f.endsWith('.md'));
        details.inbox_count = files.length;
      } catch {
        details.inbox_count = 0;
      }
    }

    // Hash of today's daily note size
    const todayNote = path.join(DAILY_NOTES_DIR, `${todayStr}.md`);
    if (existsSync(todayNote)) {
      details.daily_note_size = statSync(todayNote).size;
    }

    // Include the date so day rollover always triggers a heartbeat
    details.today = todayStr;

    // Build fingerprint from details
    const fingerprintStr = JSON.stringify(details, Object.keys(details).sort());
    const fingerprint = createHash('md5').update(fingerprintStr).digest('hex').slice(0, 12);

    return [fingerprint, details];
  }

  private computeChangesSummary(
    oldDetails: Record<string, number | string>,
    newDetails: Record<string, number | string>,
  ): string {
    const changes: string[] = [];

    const oldOverdue = Number(oldDetails.tasks_overdue ?? 0);
    const newOverdue = Number(newDetails.tasks_overdue ?? 0);
    if (newOverdue > oldOverdue) {
      changes.push(`${newOverdue - oldOverdue} NEW overdue task(s) since last check`);
    } else if (newOverdue > 0) {
      changes.push(`${newOverdue} overdue task(s)`);
    }

    const oldDue = Number(oldDetails.tasks_due_today ?? 0);
    const newDue = Number(newDetails.tasks_due_today ?? 0);
    if (newDue !== oldDue) {
      changes.push(`Tasks due today: ${oldDue} → ${newDue}`);
    }

    const oldPending = Number(oldDetails.tasks_pending ?? 0);
    const newPending = Number(newDetails.tasks_pending ?? 0);
    if (newPending !== oldPending) {
      const diff = newPending - oldPending;
      const word = diff > 0 ? 'added' : 'completed/removed';
      changes.push(
        `${Math.abs(diff)} task(s) ${word} (pending: ${oldPending} → ${newPending})`,
      );
    }

    const oldInbox = Number(oldDetails.inbox_count ?? 0);
    const newInbox = Number(newDetails.inbox_count ?? 0);
    if (newInbox > oldInbox) {
      changes.push(`${newInbox - oldInbox} new inbox item(s)`);
    }

    const oldSize = Number(oldDetails.daily_note_size ?? 0);
    const newSize = Number(newDetails.daily_note_size ?? 0);
    if (newSize > oldSize && oldSize > 0) {
      changes.push('Daily note has new entries');
    } else if (newSize > 0 && oldSize === 0) {
      changes.push('Daily note was created');
    }

    if (changes.length === 0) {
      changes.push('State fingerprint changed (minor updates)');
    }

    return changes.join('; ');
  }

  /**
   * Summarise recent chat/cron activity from transcripts so the heartbeat
   * agent knows what happened since the last beat.
   */
  private getRecentActivitySummary(): string {
    const sinceIso = this.lastState.timestamp || new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const entries = this.gateway.getRecentActivity(sinceIso);
    if (entries.length === 0) return '';

    // Group by session and summarise
    const sessions = new Map<string, { count: number; snippets: string[] }>();
    for (const e of entries) {
      if (e.role === 'system') continue; // skip tool-call audit entries
      const info = sessions.get(e.sessionKey) ?? { count: 0, snippets: [] };
      info.count++;
      if (info.snippets.length < 2) {
        const label = e.role === 'user' ? 'User' : 'Bot';
        info.snippets.push(`${label}: ${e.content.slice(0, 150)}`);
      }
      sessions.set(e.sessionKey, info);
    }

    const lines: string[] = [];
    for (const [key, info] of sessions) {
      const channel = key.split(':').slice(0, 2).join(':');
      lines.push(`- ${channel}: ${info.count} messages`);
      for (const s of info.snippets) {
        lines.push(`  ${s}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Load active goal summaries for injection into heartbeat prompts.
   * Returns null if no active goals exist.
   */
  static loadGoalSummary(): string | null {
    try {
      if (!existsSync(GOALS_DIR)) return null;
      const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
      if (files.length === 0) return null;

      const activeGoals = files
        .map(f => { try { return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')); } catch { return null; } })
        .filter((g: any) => g && g.status === 'active');

      if (activeGoals.length === 0) return null;

      const now = Date.now();
      const DAY_MS = 86_400_000;
      const lines = activeGoals.map((g: any) => {
        const nextAct = g.nextActions?.length > 0 ? ` | Next: ${g.nextActions[0]}` : '';
        const blockers = g.blockers?.length > 0 ? ` | BLOCKED: ${g.blockers[0]}` : '';
        // Flag stale goals that haven't been updated recently
        const lastUpdate = g.updatedAt ? new Date(g.updatedAt).getTime() : 0;
        const daysSinceUpdate = Math.floor((now - lastUpdate) / DAY_MS);
        const staleThreshold = g.reviewFrequency === 'daily' ? 1 : g.reviewFrequency === 'weekly' ? 7 : 30;
        const staleTag = daysSinceUpdate > staleThreshold ? ` | ⚠ STALE (${daysSinceUpdate}d since update)` : '';
        return `- [${g.priority.toUpperCase()}] ${g.title} (${g.id}, owner: ${g.owner})${nextAct}${blockers}${staleTag}`;
      });

      // Count goals needing work
      const staleCount = activeGoals.filter((g: any) => {
        const lastUpdate = g.updatedAt ? new Date(g.updatedAt).getTime() : 0;
        const daysSince = Math.floor((now - lastUpdate) / DAY_MS);
        const threshold = g.reviewFrequency === 'daily' ? 1 : g.reviewFrequency === 'weekly' ? 7 : 30;
        return daysSince > threshold;
      }).length;

      let header = `Active goals (${activeGoals.length}):`;
      if (staleCount > 0) {
        header += ` ${staleCount} goal(s) are STALE and need attention. Use \`goal_work\` to spawn focused work sessions on stale or high-priority goals.`;
      } else {
        header += ' Review if any need attention.';
      }

      return `${header}\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn({ err }, 'Goal summary enrichment failed');
      return null;
    }
  }

  /**
   * Enrich top active goals with relevant memory snippets.
   * Searches FTS5 memory for each goal's title+description to surface
   * recent conversations and facts the heartbeat agent can act on.
   */
  private enrichGoalsWithMemory(): string | null {
    try {
      if (!existsSync(GOALS_DIR)) return null;
      const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
      if (files.length === 0) return null;

      const goals = files
        .map(f => { try { return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')); } catch { return null; } })
        .filter((g: any) => g && g.status === 'active' && g.priority !== 'low');

      if (goals.length === 0) return null;

      // Sort by priority (high first) and take top 3
      const priorityOrder: Record<string, number> = { high: 0, medium: 1 };
      goals.sort((a: any, b: any) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
      const topGoals = goals.slice(0, 3);

      const sections: string[] = [];
      for (const goal of topGoals) {
        const query = `${goal.title} ${goal.description || ''}`.trim();
        const results = this.gateway.searchMemory(query, 2);
        if (results.length === 0) continue;

        const snippets = results.map((r: any) => {
          const source = r.sourceFile ? path.basename(r.sourceFile, path.extname(r.sourceFile)) : r.section;
          const content = (r.content || '').slice(0, 150).replace(/\n/g, ' ').trim();
          return `  [${source}] ${content}`;
        });
        sections.push(`- ${goal.title}:\n${snippets.join('\n')}`);
      }

      if (sections.length === 0) return null;
      return `Memory insights for active goals (act on these if relevant):\n${sections.join('\n')}`;
    } catch (err) {
      logger.warn({ err }, 'Goal memory enrichment failed');
      return null;
    }
  }

  /**
   * Nudge the most urgent stale goal by writing a trigger file.
   * Conservative: only nudges ONE goal per heartbeat tick, and skips
   * if any trigger files are already pending (prevents double-triggering).
   */
  private nudgeStaleGoals(): void {
    try {
      const goalTriggerDir = path.join(BASE_DIR, 'cron', 'goal-triggers');
      mkdirSync(goalTriggerDir, { recursive: true });

      // Guard: don't double-trigger if files are already pending
      const pending = readdirSync(goalTriggerDir).filter(f => f.endsWith('.trigger.json'));
      if (pending.length > 0) return;

      if (!existsSync(GOALS_DIR)) return;
      const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
      if (files.length === 0) return;

      const now = Date.now();
      const DAY_MS = 86_400_000;

      // Find stale goals sorted by urgency (priority + days overdue)
      const staleGoals: Array<{ goal: any; urgency: number }> = [];
      for (const f of files) {
        try {
          const goal = JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8'));
          if (goal.status !== 'active') continue;

          const lastUpdate = goal.updatedAt ? new Date(goal.updatedAt).getTime() : 0;
          const daysSinceUpdate = Math.floor((now - lastUpdate) / DAY_MS);
          const staleThreshold = goal.reviewFrequency === 'daily' ? 1 : goal.reviewFrequency === 'weekly' ? 7 : 30;
          if (daysSinceUpdate <= staleThreshold) continue;

          // Urgency: high priority gets +10, days overdue adds to score
          const priorityBoost = goal.priority === 'high' ? 10 : goal.priority === 'medium' ? 5 : 0;
          staleGoals.push({ goal, urgency: priorityBoost + (daysSinceUpdate - staleThreshold) });
        } catch { continue; }
      }

      if (staleGoals.length === 0) return;

      // Pick the most urgent
      staleGoals.sort((a, b) => b.urgency - a.urgency);
      const { goal } = staleGoals[0];

      const focus = goal.nextActions?.length > 0
        ? goal.nextActions[0]
        : `Review and update progress on "${goal.title}"`;

      const trigger = {
        goalId: goal.id,
        focus,
        maxTurns: 10,
        triggeredAt: new Date().toISOString(),
        source: 'heartbeat-nudge',
      };

      const triggerPath = path.join(goalTriggerDir, `${goal.id}.trigger.json`);
      writeFileSync(triggerPath, JSON.stringify(trigger, null, 2));
      logger.info({ goalId: goal.id, title: goal.title, focus }, 'Nudged stale goal via trigger file');

      // Goal-driven task generation: find goals with nextActions but no matching tasks
      try {
        const tasksContent = existsSync(TASKS_FILE) ? readFileSync(TASKS_FILE, 'utf-8') : '';

        for (const { goal: g } of staleGoals.slice(0, 3)) {
          if (!g.nextActions?.length) continue;

          const hasMatchingTask = g.nextActions.some((action: string) =>
            tasksContent.toLowerCase().includes(action.toLowerCase().slice(0, 30))
          );
          if (hasMatchingTask) continue;

          const taskTriggerPath = path.join(goalTriggerDir, `${g.id}-tasks.trigger.json`);
          if (!existsSync(taskTriggerPath)) {
            writeFileSync(taskTriggerPath, JSON.stringify({
              goalId: g.id,
              focus: `Create tasks for goal "${g.title}": ${g.nextActions.slice(0, 3).join('; ')}`,
              maxTurns: 5,
              triggeredAt: new Date().toISOString(),
              source: 'goal-task-gen',
            }, null, 2));
            logger.info({ goalId: g.id }, 'Generated task trigger for goal with untracked nextActions');
          }
        }

        // Check goals with linked crons but no recent progress
        for (const { goal: g } of staleGoals) {
          if (!g.linkedCronJobs?.length) continue;

          const recentProgress = g.progressNotes?.length > 0;
          if (recentProgress) continue;

          const runLog = new CronRunLog();
          const allFailing = g.linkedCronJobs.every((cronName: string) => {
            const recent = runLog.readRecent(cronName, 3);
            return recent.length > 0 && recent.every((r: CronRunEntry) => r.status !== 'ok');
          });

          if (allFailing) {
            logger.info({ goalId: g.id, crons: g.linkedCronJobs }, 'Goal has failing linked crons — needs attention');
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Goal-driven task generation failed (non-fatal)');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to nudge stale goals');
    }
  }

  /**
   * Process pending inbox items. For each .md file in INBOX_DIR:
   * - Routes to the gateway as a cron-style task for the agent to triage
   * - The agent determines the intent (task, reference, reminder) and acts
   * - Processed files are moved to a _processed subfolder
   *
   * Conservative: processes at most 3 items per heartbeat tick.
   */
  private processInbox(): void {
    try {
      if (!existsSync(INBOX_DIR)) return;

      const files = readdirSync(INBOX_DIR).filter(
        (f) => f.endsWith('.md') && !f.startsWith('_'),
      );
      if (files.length === 0) return;

      // Process at most 3 items per tick to avoid overloading
      const batch = files.slice(0, 3);
      const processedDir = path.join(INBOX_DIR, '_processed');
      mkdirSync(processedDir, { recursive: true });

      for (const file of batch) {
        const filePath = path.join(INBOX_DIR, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const title = file.replace(/\.md$/, '');

          // Move file before processing to prevent duplicate triage on next tick
          const destPath = path.join(processedDir, file);
          try {
            writeFileSync(destPath, content);
            unlinkSync(filePath);
          } catch {
            // If move fails, skip — will retry next tick
            continue;
          }

          // Build a prompt for the agent to triage this inbox item
          const prompt =
            `Triage this inbox item and take appropriate action.\n\n` +
            `**Title:** ${title}\n` +
            `**Content:**\n${content.slice(0, 2000)}\n\n` +
            `## Instructions:\n` +
            `1. Determine the intent: Is this a task, a reference/note, a reminder, or something else?\n` +
            `2. Take the appropriate action:\n` +
            `   - **Task**: Use \`task_add\` to create a task with the right priority and due date.\n` +
            `   - **Reference**: Use \`note_create\` or \`memory_write\` to file it in the vault.\n` +
            `   - **Reminder**: Add to today's daily note with \`memory_write(action="append_daily")\`.\n` +
            `   - **Project update**: Update the relevant project note.\n` +
            `3. Respond with a one-line summary of what you did.`;

          // Fire-and-forget — run as a lightweight cron job
          this.gateway
            .handleCronJob(`inbox:${title}`, prompt, 1, 5)
            .then((result) => {
              if (result) {
                logToDailyNote(`**Inbox processed: ${title}** — ${result.slice(0, 100).replace(/\n/g, ' ')}`);
              }
              logger.info({ file: title }, 'Inbox item processed');
            })
            .catch((err) => {
              // Restore file to inbox on failure so it retries
              try {
                writeFileSync(filePath, content);
                unlinkSync(destPath);
              } catch { /* best-effort restore */ }
              logger.warn({ err, file: title }, 'Failed to process inbox item');
            });
        } catch (err) {
          logger.warn({ err, file }, 'Failed to read inbox item');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to process inbox');
    }
  }

  static getTimeContext(hour: number): string {
    if (hour >= 8 && hour < 10) {
      return 'Morning — Focus on task review and daily setup.';
    } else if (hour >= 10 && hour < 18) {
      return 'Working hours — Check for overdue tasks and inbox items.';
    } else if (hour >= 18 && hour < 22) {
      return 'Evening — Focus on daily summary and memory consolidation.';
    }
    return '';
  }

  private static isSilent(response: string): boolean {
    const indicators = [
      'all clear',
      'nothing to report',
      'no updates',
      'everything looks good',
      'no urgent',
      'quiet heartbeat',
    ];
    const lower = response.toLowerCase();
    return indicators.some((ind) => lower.includes(ind));
  }
}
