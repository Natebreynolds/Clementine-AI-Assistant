/**
 * Clementine TypeScript — Heartbeat scheduler.
 *
 * HeartbeatScheduler: periodic general check-ins using setInterval.
 * Channel-agnostic — sends notifications via the NotificationDispatcher.
 */

import { createHash, randomBytes } from 'node:crypto';
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
  HEARTBEAT_WORK_QUEUE_FILE,
} from '../config.js';
import type { HeartbeatState, HeartbeatReportedTopic, HeartbeatWorkItem } from '../types.js';
import type { CronRunEntry } from '../types.js';
import type { NotificationDispatcher } from './notifications.js';
import type { Gateway } from './router.js';
import { logToDailyNote, CronRunLog, todayISO } from './cron-scheduler.js';

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
  private lastConsolidationDate = '';
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

    // Restore persisted scheduling dates from state so they survive restarts
    if (this.lastState.lastSelfImproveDate) this.lastSelfImproveDate = this.lastState.lastSelfImproveDate;
    if (this.lastState.lastConsolidationDate) this.lastConsolidationDate = this.lastState.lastConsolidationDate;
    if (this.lastState.lastAgentSiRuns) {
      this.lastAgentSiRuns = new Map(Object.entries(this.lastState.lastAgentSiRuns));
    }
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
    const { summary } = this.computeChangesSummary(
      this.lastState.details ?? {},
      currentDetails,
    );
    let changesSummary = summary;
    const activitySummary = this.getRecentActivitySummary();
    if (activitySummary) {
      changesSummary += `\n\nRecent activity:\n${activitySummary}`;
    }
    const goalSummary = HeartbeatScheduler.loadGoalSummary();
    if (goalSummary) {
      changesSummary += `\n\n${goalSummary}`;
    }
    const dedupContext = this.buildDedupContext();
    const timeContext = HeartbeatScheduler.getTimeContext(now.getHours());

    try {
      const response = await this.gateway.handleHeartbeat(
        standingInstructions,
        changesSummary,
        timeContext,
        dedupContext,
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

    // ── Nightly tasks: run regardless of active hours ─────────────────
    // These have their own hour/date guards and must fire outside active hours.

    // Nightly self-improvement: run once per day at 1 AM
    if (hour === 1 && this.lastSelfImproveDate !== todayISO()) {
      this.lastSelfImproveDate = todayISO();
      this.lastState.lastSelfImproveDate = this.lastSelfImproveDate;
      this.saveState();
      logger.info('Triggering nightly self-improvement cycle');
      this.gateway.handleSelfImprove('run-nightly').then(summary => {
        // Notify owner of self-improvement results
        if (summary && !summary.includes('Iterations: 0')) {
          this.dispatcher.send(
            `**Self-Improvement Report (nightly)**\n${summary}`,
            {},
          ).catch(() => {});
        }
      }).catch(err => {
        logger.error({ err }, 'Nightly self-improvement failed');
      });
    }

    // Weekly per-agent improvement: one agent per day at 2 AM, cycling through
    if (hour === 2) {
      try {
        const agentMgr = this.gateway.getAgentManager();
        const agents = agentMgr.listAll().filter(a => a.slug !== 'clementine');
        if (agents.length > 0) {
          const dayOfYear = Math.floor((Date.now() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
          const agentIndex = dayOfYear % agents.length;
          const targetAgent = agents[agentIndex];

          const lastRun = this.getLastAgentSiRun(targetAgent.slug);
          const daysSinceLastRun = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 86400000 : Infinity;

          if (daysSinceLastRun >= 7) {
            logger.info({ agentSlug: targetAgent.slug }, 'Triggering weekly per-agent self-improvement');
            this.gateway.handleSelfImprove('run-agent', { experimentId: targetAgent.slug }).catch(err => {
              logger.error({ err, agentSlug: targetAgent.slug }, 'Per-agent self-improvement failed');
            });
            this.setLastAgentSiRun(targetAgent.slug);
            this.lastState.lastAgentSiRuns = Object.fromEntries(this.lastAgentSiRuns);
            this.saveState();
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Per-agent self-improvement scheduling error');
      }
    }

    // Evening memory consolidation: once per day between 7-9 PM
    if (hour >= 19 && hour < 21 && this.lastConsolidationDate !== todayISO()) {
      this.lastConsolidationDate = todayISO();
      this.lastState.lastConsolidationDate = this.lastConsolidationDate;
      this.saveState();
      logger.info('Triggering evening memory consolidation');
      this.gateway.handleCronJob(
        'memory-consolidation',
        'Review today\'s daily note and recent conversations. Promote any durable facts ' +
        '(preferences, decisions, people info, project updates) to long-term memory using ' +
        'memory_write. Skip anything already in MEMORY.md. Be selective — only save facts ' +
        'that will be useful in future conversations. Do not create duplicate entries.',
        1, // tier 1 (vault-only)
        3, // max 3 turns
        'haiku',
      ).catch(err => {
        logger.error({ err }, 'Evening memory consolidation failed');
      });
    }

    // ── Active hours check ────────────────────────────────────────────
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
    const { summary: rawSummary, hasRealChanges } = this.computeChangesSummary(
      this.lastState.details ?? {},
      currentDetails,
    );

    let changesSummary = rawSummary;

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

    // ── Drain work queue (max 2 items per tick) ──
    const completedWork: Array<{ description: string; result: string }> = [];
    for (let i = 0; i < 2; i++) {
      const item = this.claimNextItem();
      if (!item) break;

      logger.info({ id: item.id, description: item.description }, 'Executing heartbeat work item');
      try {
        const result = await this.gateway.handleCronJob(
          `heartbeat-work:${item.id}`,
          item.prompt,
          item.tier,
          item.maxTurns,
        );
        this.completeItem(item.id, result || 'completed');
        completedWork.push({ description: item.description, result: result || 'completed' });
        logToDailyNote(`**Heartbeat work: ${item.description}** — ${(result || 'completed').slice(0, 100).replace(/\n/g, ' ')}`);
      } catch (err) {
        this.failItem(item.id, String(err));
        logger.warn({ err, id: item.id }, 'Heartbeat work item failed');
      }
    }

    // ── Decide whether to invoke the LLM ──
    this.pruneReportedTopics();

    if (!this.shouldInvokeAgent(hasRealChanges, completedWork, currentDetails)) {
      // Silent tick — no LLM call, just housekeeping
      this.lastState = {
        ...this.lastState,
        fingerprint: currentFingerprint,
        details: currentDetails,
        timestamp: now.toISOString(),
        consecutiveSilentBeats: (this.lastState.consecutiveSilentBeats ?? 0) + 1,
      };
      this.saveState();
      logger.info({ silentBeats: this.lastState.consecutiveSilentBeats }, 'Heartbeat silent — nothing new');

      // Still run housekeeping
      this.nudgeStaleGoals();
      this.processInbox();
      // Fall through to nightly tasks below — don't return early
    } else {

    // Build dedup context from previously reported topics
    const dedupContext = this.buildDedupContext();

    // Build work summary for completed items
    let workSummary = '';
    if (completedWork.length > 0) {
      workSummary = '## Work Completed This Tick\n' + completedWork.map(
        (w) => `- **${w.description}**: ${w.result.slice(0, 200)}`,
      ).join('\n');
    }
    if (workSummary) {
      changesSummary = workSummary + '\n\n' + changesSummary;
    }

    // Check for incomplete work from previous chat queries
    try {
      const incompleteFile = path.join(BASE_DIR, 'incomplete-work.json');
      if (existsSync(incompleteFile)) {
        const entries: Array<{ sessionKey: string; userPrompt: string; toolCallCount: number; timestamp: string; handled: boolean }> =
          JSON.parse(readFileSync(incompleteFile, 'utf-8'));
        const unhandled = entries.filter(e => !e.handled);
        if (unhandled.length > 0) {
          const incompleteSection = '## Incomplete Work (needs follow-up)\n' +
            'These tasks were started but not completed. Proactively check if they still need attention ' +
            'and let the user know the status or finish the work.\n' +
            unhandled.map(e =>
              `- **${e.userPrompt.slice(0, 200)}** (${e.toolCallCount} tool calls, started ${e.timestamp})`
            ).join('\n');
          changesSummary = incompleteSection + '\n\n' + changesSummary;
          // Mark as handled
          for (const e of entries) { if (!e.handled) e.handled = true; }
          writeFileSync(incompleteFile, JSON.stringify(entries, null, 2));
          logger.info({ count: unhandled.length }, 'Injected incomplete work into heartbeat prompt');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read incomplete work for heartbeat');
    }

    // Persist new state (reset silent counter since we're invoking)
    this.lastState = {
      ...this.lastState,
      fingerprint: currentFingerprint,
      details: currentDetails,
      timestamp: now.toISOString(),
      consecutiveSilentBeats: 0,
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
        dedupContext,
      );

      const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const timeStr = `${h12}:${String(now.getMinutes()).padStart(2, '0')} ${ampm}`;
      if (response && !HeartbeatScheduler.shouldSuppressMessage(response)) {
        // Extract topic tags for dedup, then strip before sending
        const newTopics = HeartbeatScheduler.extractReportedTopics(response);
        const cleanResponse = HeartbeatScheduler.stripTopicTags(response);

        await this.dispatcher.send(`**[${timeStr} check-in]**\n\n${cleanResponse}`);
        logToDailyNote(`**${timeStr}**: ${cleanResponse.slice(0, 100).replace(/\n/g, ' ')}`);

        // Update dedup ledger
        if (newTopics.length > 0) {
          this.lastState.reportedTopics = [
            ...(this.lastState.reportedTopics ?? []),
            ...newTopics,
          ];
        }
        this.lastState.lastDiscordMessageAt = now.toISOString();
        this.lastState.consecutiveSilentBeats = 0;
        this.saveState();
      } else {
        logger.info(`Heartbeat suppressed at ${timeStr}`);
        this.lastState.consecutiveSilentBeats = (this.lastState.consecutiveSilentBeats ?? 0) + 1;
        this.saveState();
      }
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick failed');
    }

    // Fire-and-forget: nudge stale goals by writing trigger files
    this.nudgeStaleGoals();

    // Fire-and-forget: process inbox items
    this.processInbox();
    } // end of shouldInvokeAgent else-block

  }

  private readHeartbeatConfig(): string {
    if (!existsSync(HEARTBEAT_FILE)) {
      return 'Work-first heartbeat. Execute any queued work items first, then check for genuinely NEW issues only. ' +
        'If overdue tasks exist, alert. If nothing changed since last report, respond with exactly: __NOTHING__ ' +
        'Tag each topic: [topic: short-key]. No bullet checklists. Write naturally.';
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
    const todayStr = todayISO();

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
  ): { summary: string; hasRealChanges: boolean } {
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

    // Track daily note changes for context but don't count as "real" —
    // these are usually self-caused by heartbeat logging
    const oldSize = Number(oldDetails.daily_note_size ?? 0);
    const newSize = Number(newDetails.daily_note_size ?? 0);
    const noteInfo: string[] = [];
    if (newSize > oldSize && oldSize > 0) {
      noteInfo.push('Daily note has new entries');
    } else if (newSize > 0 && oldSize === 0) {
      noteInfo.push('Daily note was created');
    }

    const hasRealChanges = changes.length > 0;
    const allChanges = [...changes, ...noteInfo];

    return {
      summary: allChanges.length > 0 ? allChanges.join('; ') : '',
      hasRealChanges,
    };
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
    const day = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    if (hour >= 8 && hour < 10) {
      return `${day} morning — Be forward-looking. Mention today's plan priorities, flag anything due today, set the tone for the day.`;
    } else if (hour >= 10 && hour < 14) {
      return `${day} midday — Quick progress check. Reference anything discussed earlier today. Flag stuck or overdue items briefly.`;
    } else if (hour >= 14 && hour < 18) {
      return `${day} afternoon — Focus on what's been accomplished and what's still open. Be brief unless something needs attention.`;
    } else if (hour >= 18 && hour < 22) {
      return `${day} evening — Reflective wrap-up. Summarize what got done, note anything carrying over to tomorrow. Good time to consolidate memory and promote durable facts.`;
    }
    return '';
  }

  private static shouldSuppressMessage(response: string): boolean {
    const trimmed = response.trim();
    // Only suppress the explicit opt-out signal — let everything else through.
    // Short proactive messages ("Want me to check your email?") are valuable.
    return trimmed === '__NOTHING__';
  }

  // ── Dedup Ledger ──────────────────────────────────────────────────

  private pruneReportedTopics(): void {
    const topics = this.lastState.reportedTopics ?? [];
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    this.lastState.reportedTopics = topics
      .filter((t) => new Date(t.reportedAt).getTime() > fourHoursAgo)
      .slice(-20);
  }

  private buildDedupContext(): string {
    const topics = this.lastState.reportedTopics ?? [];
    if (topics.length === 0) return '';

    const lines = topics.map((t) => {
      const time = new Date(t.reportedAt).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      return `- ${time}: ${t.summary} [topic: ${t.topic}]`;
    });
    return `## Already Reported (do NOT repeat unless status changed)\n${lines.join('\n')}`;
  }

  private static extractReportedTopics(response: string): HeartbeatReportedTopic[] {
    const topics: HeartbeatReportedTopic[] = [];
    const tagRegex = /\[topic:\s*([^\]]+)\]/g;
    let match;
    while ((match = tagRegex.exec(response)) !== null) {
      const topic = match[1].trim();
      const lineStart = response.lastIndexOf('\n', match.index) + 1;
      const lineEnd = response.indexOf('\n', match.index + match[0].length);
      const line = response.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      const summary = line.replace(/\[topic:[^\]]+\]/g, '').trim();

      // Derive agentSlug from topic key — e.g. "ross:appointments" → "ross"
      const colonIdx = topic.indexOf(':');
      const agentSlug = colonIdx > 0 ? topic.substring(0, colonIdx) : undefined;

      topics.push({
        topic,
        summary,
        reportedAt: new Date().toISOString(),
        ...(agentSlug ? { agentSlug } : {}),
      });
    }
    return topics;
  }

  private static stripTopicTags(response: string): string {
    return response.replace(/\s*\[topic:[^\]]+\]/g, '').trim();
  }

  // ── Work Queue ────────────────────────────────────────────────────

  static loadWorkQueue(): HeartbeatWorkItem[] {
    try {
      if (!existsSync(HEARTBEAT_WORK_QUEUE_FILE)) return [];
      return JSON.parse(readFileSync(HEARTBEAT_WORK_QUEUE_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }

  private static saveWorkQueue(items: HeartbeatWorkItem[]): void {
    const dir = path.dirname(HEARTBEAT_WORK_QUEUE_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(HEARTBEAT_WORK_QUEUE_FILE, JSON.stringify(items, null, 2));
  }

  private claimNextItem(): HeartbeatWorkItem | null {
    const queue = HeartbeatScheduler.loadWorkQueue();
    // Auto-cleanup: remove items older than 24 hours
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const cleaned = queue.filter((item) =>
      new Date(item.queuedAt).getTime() > dayAgo || item.status === 'running',
    );

    // Find highest-priority pending item
    const pending = cleaned.filter((item) => item.status === 'pending');
    pending.sort((a, b) => {
      if (a.priority === 'high' && b.priority !== 'high') return -1;
      if (b.priority === 'high' && a.priority !== 'high') return 1;
      return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
    });

    const next = pending[0];
    if (!next) {
      if (cleaned.length !== queue.length) HeartbeatScheduler.saveWorkQueue(cleaned);
      return null;
    }

    next.status = 'running';
    HeartbeatScheduler.saveWorkQueue(cleaned);
    return next;
  }

  private completeItem(id: string, result: string): void {
    const queue = HeartbeatScheduler.loadWorkQueue();
    const item = queue.find((i) => i.id === id);
    if (item) {
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
      item.result = result.slice(0, 500);
      HeartbeatScheduler.saveWorkQueue(queue);
    }
  }

  private failItem(id: string, error: string): void {
    const queue = HeartbeatScheduler.loadWorkQueue();
    const item = queue.find((i) => i.id === id);
    if (item) {
      item.status = 'failed';
      item.completedAt = new Date().toISOString();
      item.error = error.slice(0, 500);
      HeartbeatScheduler.saveWorkQueue(queue);
    }
  }

  static enqueueWork(opts: {
    description: string;
    prompt: string;
    source: string;
    priority?: 'high' | 'normal';
    maxTurns?: number;
    tier?: number;
    agentSlug?: string;
  }): string {
    const queue = HeartbeatScheduler.loadWorkQueue();
    const id = randomBytes(4).toString('hex');
    const item: HeartbeatWorkItem = {
      id,
      description: opts.description,
      prompt: opts.prompt,
      source: opts.source,
      priority: opts.priority ?? 'normal',
      queuedAt: new Date().toISOString(),
      maxTurns: opts.maxTurns ?? 3,
      tier: opts.tier ?? 1,
      status: 'pending',
      ...(opts.agentSlug ? { agentSlug: opts.agentSlug } : {}),
    };
    queue.push(item);
    HeartbeatScheduler.saveWorkQueue(queue);
    logger.info({ id, description: opts.description }, 'Work item enqueued for heartbeat');
    return id;
  }

  // ── Decision Logic ────────────────────────────────────────────────

  private shouldInvokeAgent(
    hasRealChanges: boolean,
    workCompleted: Array<{ description: string; result: string }>,
    currentDetails: Record<string, number | string>,
  ): boolean {
    if (workCompleted.length > 0) return true;

    const newOverdue = Number(currentDetails.tasks_overdue ?? 0);
    if (newOverdue > 0) {
      const lastReported = (this.lastState.reportedTopics ?? [])
        .find((t) => t.topic === 'overdue-tasks');
      if (!lastReported) return true;
      const hoursSince = (Date.now() - new Date(lastReported.reportedAt).getTime()) / (60 * 60 * 1000);
      if (hoursSince >= 1) return true;
    }

    if (hasRealChanges) return true;

    const silentBeats = this.lastState.consecutiveSilentBeats ?? 0;
    if (silentBeats >= 3) return true;

    return false;
  }
}
