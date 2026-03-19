/**
 * Clementine TypeScript — Heartbeat + Cron scheduler (autonomous execution).
 *
 * HeartbeatScheduler: periodic general check-ins using setInterval
 * CronScheduler: precise scheduled tasks using node-cron
 *
 * Both schedulers are channel-agnostic — they send notifications via
 * the NotificationDispatcher, which fans out to all active channels.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import matter from 'gray-matter';
import pino from 'pino';
import {
  VAULT_DIR,
  HEARTBEAT_FILE,
  CRON_FILE,
  WORKFLOWS_DIR,
  AGENTS_DIR,
  TASKS_FILE,
  INBOX_DIR,
  DAILY_NOTES_DIR,
  HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_ACTIVE_START,
  HEARTBEAT_ACTIVE_END,
  BASE_DIR,
  DISCORD_OWNER_ID,
  GOALS_DIR,
} from '../config.js';
import type { CronJobDefinition, CronRunEntry, HeartbeatState, SelfImproveConfig, SelfImproveExperiment, SelfImproveState, WorkflowDefinition } from '../types.js';
import type { NotificationDispatcher } from './notifications.js';
import type { Gateway } from './router.js';
import { scanner } from '../security/scanner.js';
import { parseAllWorkflows as parseAllWorkflowsSync } from '../agent/workflow-runner.js';
import { SelfImproveLoop } from '../agent/self-improve.js';

const logger = pino({ name: 'clementine.heartbeat' });

/** Default timeout for standard cron jobs (10 minutes). */
const CRON_STANDARD_TIMEOUT_MS = 10 * 60 * 1000;

/** System timezone for cron scheduling — ensures jobs fire at local time
 *  regardless of how the daemon is launched (launchd, pm2, etc.). */
const SYSTEM_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── Daily Note Activity Logger ───────────────────────────────────────

/** Local-time YYYY-MM-DD for daily note path. */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Append a line to today's daily note under ## Interactions.
 * Creates the section if it doesn't exist. Non-fatal — never throws.
 */
function logToDailyNote(line: string): void {
  try {
    const notePath = path.join(DAILY_NOTES_DIR, `${todayISO()}.md`);
    if (!existsSync(notePath)) return; // template hasn't created the note yet

    let content = readFileSync(notePath, 'utf-8');
    const marker = '## Interactions';
    const idx = content.indexOf(marker);
    if (idx === -1) {
      // No Interactions section — append one
      content += `\n\n${marker}\n\n- ${line}`;
    } else {
      // Find the end of the marker line and insert after it
      const afterMarker = idx + marker.length;
      const nextNewline = content.indexOf('\n', afterMarker);
      const insertAt = nextNewline === -1 ? content.length : nextNewline;
      // Check if there's already content in this section
      const nextSection = content.indexOf('\n## ', insertAt + 1);
      const sectionEnd = nextSection === -1 ? content.length : nextSection;
      const sectionContent = content.slice(insertAt, sectionEnd).trim();
      // Insert at the end of the section (before next ## or EOF)
      const insertPoint = nextSection === -1 ? content.length : nextSection;
      content = content.slice(0, insertPoint) + `\n- ${line}` + content.slice(insertPoint);
    }
    writeFileSync(notePath, content);
  } catch {
    // Non-fatal — daily note logging should never break cron/heartbeat
  }
}

// ── HeartbeatScheduler ────────────────────────────────────────────────

export class HeartbeatScheduler {
  private readonly stateFile: string;
  private gateway: Gateway;
  private dispatcher: NotificationDispatcher;
  private lastState: HeartbeatState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

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
    const now = new Date();
    const hour = now.getHours();

    // Check active hours
    if (hour < HEARTBEAT_ACTIVE_START || hour >= HEARTBEAT_ACTIVE_END) {
      logger.debug(`Heartbeat skipped: outside active hours (${hour}:00)`);
      return;
    }

    // Compute current state and compare to last
    const [currentFingerprint, currentDetails] = this.computeStateFingerprint();
    const lastFingerprint = this.lastState.fingerprint ?? '';

    // Even if nothing changed, fire at least once every 4 hours during active hours
    // to ensure daily notes get created, proactive checks run, etc.
    const MAX_SILENT_MS = 4 * 60 * 60 * 1000;
    const lastTimestamp = this.lastState.timestamp ? new Date(this.lastState.timestamp).getTime() : 0;
    const msSinceLast = Date.now() - lastTimestamp;
    const stale = msSinceLast >= MAX_SILENT_MS;

    if (currentFingerprint === lastFingerprint && !stale) {
      logger.debug('Heartbeat: no changes since last check — skipping agent call');
      return;
    }

    if (stale && currentFingerprint === lastFingerprint) {
      logger.info(`Heartbeat: no changes but ${(msSinceLast / 3_600_000).toFixed(1)}h since last beat — running proactive check`);
    }

    // Something changed — compute a summary of what
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

      const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (response && !HeartbeatScheduler.isSilent(response)) {
        await this.dispatcher.send(`**[Heartbeat — ${timeStr}]**\n\n${response}`);
        logToDailyNote(`**Heartbeat ${timeStr}**: ${response.slice(0, 100).replace(/\n/g, ' ')}`);
      } else {
        logger.info(`Heartbeat silent at ${timeStr}`);
        // Don't log "all clear" heartbeats to daily notes — they create noise
      }
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick failed');
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
    } catch {
      return null;
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

// ── Shared CRON.md parser ────────────────────────────────────────────

/**
 * Parse cron job definitions from vault/00-System/CRON.md frontmatter.
 * Used by both the in-process CronScheduler and the standalone CLI runner.
 */
export function parseCronJobs(): CronJobDefinition[] {
  if (!existsSync(CRON_FILE)) return [];

  const raw = readFileSync(CRON_FILE, 'utf-8');
  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    logger.error({ err }, 'CRON.md YAML parse error — keeping previous jobs. Fix the file manually.');
    return [];
  }
  const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
  const jobs: CronJobDefinition[] = [];

  for (const job of jobDefs) {
    const name = String(job.name ?? '');
    const schedule = String(job.schedule ?? '');
    const prompt = String(job.prompt ?? '');
    const enabled = job.enabled !== false;
    const tier = Number(job.tier ?? 1);
    const maxTurns = job.max_turns != null ? Number(job.max_turns) : undefined;
    const model = job.model != null ? String(job.model) : undefined;
    const workDir = job.work_dir != null ? String(job.work_dir) : undefined;
    const mode = job.mode === 'unleashed' ? 'unleashed' as const : 'standard' as const;
    const maxHours = job.max_hours != null ? Number(job.max_hours) : undefined;
    const maxRetries = job.max_retries != null ? Number(job.max_retries) : undefined;
    const after = job.after != null ? String(job.after) : undefined;
    const successCriteria = Array.isArray(job.success_criteria)
      ? (job.success_criteria as unknown[]).map(c => String(c))
      : undefined;

    if (!name || !schedule || !prompt) {
      logger.warn({ job }, 'Skipping malformed cron job');
      continue;
    }

    jobs.push({ name, schedule, prompt, enabled, tier, maxTurns, model, workDir, mode, maxHours, maxRetries, after, successCriteria });
  }

  return jobs;
}

/**
 * Parse cron jobs from agent-scoped CRON.md files.
 * Scans each agent subdirectory for CRON.md, prefixes job names with agent slug.
 */
export function parseAgentCronJobs(agentsDir: string): CronJobDefinition[] {
  if (!existsSync(agentsDir)) return [];

  const allJobs: CronJobDefinition[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(agentsDir, { withFileTypes: true } as any)
      .filter((d: any) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d: any) => d.name);
  } catch {
    return [];
  }

  for (const slug of dirs) {
    const cronFile = path.join(agentsDir, slug, 'CRON.md');
    if (!existsSync(cronFile)) continue;

    try {
      const raw = readFileSync(cronFile, 'utf-8');
      const parsed = matter(raw);
      const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;

      for (const job of jobDefs) {
        const name = String(job.name ?? '');
        const schedule = String(job.schedule ?? '');
        const prompt = String(job.prompt ?? '');
        const enabled = job.enabled !== false;
        const tier = Number(job.tier ?? 1);
        const maxTurns = job.max_turns != null ? Number(job.max_turns) : undefined;
        const model = job.model != null ? String(job.model) : undefined;
        const workDir = job.work_dir != null ? String(job.work_dir) : undefined;
        const mode = job.mode === 'unleashed' ? 'unleashed' as const : 'standard' as const;
        const maxHours = job.max_hours != null ? Number(job.max_hours) : undefined;
        const maxRetries = job.max_retries != null ? Number(job.max_retries) : undefined;
        const after = job.after != null ? String(job.after) : undefined;
        const successCriteria = Array.isArray(job.success_criteria)
          ? (job.success_criteria as unknown[]).map(c => String(c))
          : undefined;

        if (!name || !schedule || !prompt) {
          logger.warn({ job, agent: slug }, 'Skipping malformed agent cron job');
          continue;
        }

        // Prefix name with agent slug and tag with agentSlug
        allJobs.push({
          name: `${slug}:${name}`,
          schedule, prompt, enabled, tier, maxTurns, model, workDir,
          mode, maxHours, maxRetries, after, successCriteria,
          agentSlug: slug,
        });
      }
    } catch (err) {
      logger.error({ err, agent: slug }, `Agent ${slug} CRON.md parse error — skipping`);
    }
  }

  return allJobs;
}

/**
 * Validate that a CRON.md string parses without YAML errors.
 * Call this before writing to prevent corrupted files from crashing the daemon.
 * Returns null on success, or the error message on failure.
 */
export function validateCronYaml(content: string): string | null {
  try {
    matter(content);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── Retry / backoff ──────────────────────────────────────────────────

/** Exponential backoff schedule in ms: 30s, 1m, 5m, 15m, 60m */
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/** Patterns that indicate a transient (retryable) error. */
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /5\d\d/,
  /overloaded/i,
  /temporarily unavailable/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /service.?unavailable/i,
  /capacity/i,
  /try again/i,
];

export function classifyError(err: unknown): 'transient' | 'permanent' {
  const msg = String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg)) ? 'transient' : 'permanent';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Run history logging ──────────────────────────────────────────────

/**
 * JSONL-based per-job run log.  Auto-prunes to keep files under 2 MB
 * and 2000 lines (whichever limit hits first).
 */
export class CronRunLog {
  private readonly dir: string;
  private static readonly MAX_BYTES = 2_000_000;
  private static readonly MAX_LINES = 2000;

  constructor(baseDir?: string) {
    this.dir = path.join(baseDir ?? BASE_DIR, 'cron', 'runs');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private logPath(jobName: string): string {
    // Sanitize job name for filesystem
    const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  append(entry: CronRunEntry): void {
    const filePath = this.logPath(entry.jobName);
    const line = JSON.stringify(entry) + '\n';
    try {
      appendFileSync(filePath, line);
      // Schedule pruning asynchronously so it doesn't block the caller
      setImmediate(() => this.maybePrune(filePath));
    } catch (err) {
      logger.warn({ err, job: entry.jobName }, 'Failed to write run log');
    }
  }

  readRecent(jobName: string, count = 20): CronRunEntry[] {
    const filePath = this.logPath(jobName);
    if (!existsSync(filePath)) return [];

    try {
      const lines = readFileSync(filePath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      return lines
        .slice(-count)
        .map((l) => JSON.parse(l) as CronRunEntry)
        .reverse(); // newest first
    } catch {
      return [];
    }
  }

  consecutiveErrors(jobName: string): number {
    const recent = this.readRecent(jobName, 10);
    let count = 0;
    for (const entry of recent) {
      if (entry.status === 'ok') break;
      count++;
    }
    return count;
  }

  private maybePrune(filePath: string): void {
    try {
      const { size } = statSync(filePath);
      if (size <= CronRunLog.MAX_BYTES) return;

      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      if (lines.length <= CronRunLog.MAX_LINES) return;

      // Keep the most recent MAX_LINES entries
      const trimmed = lines.slice(-CronRunLog.MAX_LINES);
      writeFileSync(filePath, trimmed.join('\n') + '\n');
    } catch {
      // non-critical
    }
  }
}

// ── CronScheduler ─────────────────────────────────────────────────────

export class CronScheduler {
  private gateway: Gateway;
  private dispatcher: NotificationDispatcher;
  private jobs: CronJobDefinition[] = [];
  private disabledJobs = new Set<string>();
  private scheduledTasks = new Map<string, cron.ScheduledTask>();
  private runningJobs = new Set<string>();
  private completedJobs = new Map<string, number>(); // jobName → completion timestamp
  private watching = false;
  readonly runLog: CronRunLog;

  // Workflow support
  private workflowDefs: WorkflowDefinition[] = [];
  private workflowTasks = new Map<string, cron.ScheduledTask>();
  private runningWorkflows = new Set<string>();
  private watchingWorkflows = false;

  // Trigger directory for MCP-initiated job runs
  private triggerDir = path.join(BASE_DIR, 'cron', 'triggers');
  private goalTriggerDir = path.join(BASE_DIR, 'cron', 'goal-triggers');
  private triggerTimer: ReturnType<typeof setInterval> | null = null;

  // Event-driven status change listeners (used by Discord status embed)
  private statusChangeListeners: Array<() => void> = [];

  constructor(gateway: Gateway, dispatcher: NotificationDispatcher) {
    this.gateway = gateway;
    this.dispatcher = dispatcher;
    this.runLog = new CronRunLog();
  }

  /** Register a listener that fires when system state changes (job start/finish, self-improve, etc). */
  onStatusChange(cb: () => void): void {
    this.statusChangeListeners.push(cb);
  }

  private emitStatusChange(): void {
    for (const cb of this.statusChangeListeners) {
      try { cb(); } catch { /* ignore listener errors */ }
    }
  }

  start(): void {
    this.reloadJobs();
    this.reloadWorkflows();
    this.watchCronFile();
    this.watchAgentsDir();
    this.watchWorkflowDir();

    this.watchTriggers();

    // Wire up push notifications for unleashed task completions
    this.gateway.setUnleashedCompleteCallback((jobName, result) => {
      this.completedJobs.set(jobName, Date.now());
      if (result && result !== '__NOTHING__') {
        this.dispatcher.send(`✅ Unleashed task **${jobName}** completed:\n\n${result.slice(0, 1500)}`).catch(() => {});
      }
    });

    // Wire up phase progress notifications for unleashed tasks
    this.gateway.setPhaseCompleteCallback((jobName, phase, _total, output) => {
      const preview = output.slice(0, 500);
      this.dispatcher.send(`⏳ **${jobName}** — phase ${phase} complete:\n${preview}`).catch(() => {});
    });

    logger.info(`Cron scheduler started with ${this.jobs.length} jobs`);
  }

  stop(): void {
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();
    for (const [name, task] of this.workflowTasks) {
      task.stop();
      logger.debug(`Stopped workflow task: ${name}`);
    }
    this.workflowTasks.clear();
    this.unwatchCronFile();
    this.unwatchAgentsDir();
    this.unwatchWorkflowDir();
    if (this.triggerTimer) {
      clearInterval(this.triggerTimer);
      this.triggerTimer = null;
    }
    logger.info('Cron scheduler stopped');
  }

  /** Watch CRON.md for changes and auto-reload jobs. */
  private watchCronFile(): void {
    if (this.watching) return;
    if (!existsSync(CRON_FILE)) return;

    watchFile(CRON_FILE, { interval: 2000 }, () => {
      logger.info('CRON.md changed — reloading jobs');
      try {
        this.reloadJobs();
        scanner.refreshIntegrity(); // CRON.md change is legitimate
        logger.info(`Cron scheduler reloaded: ${this.jobs.length} jobs`);
      } catch (err) {
        logger.error({ err }, 'Failed to reload CRON.md — keeping previous schedule');
      }
    });
    this.watching = true;
  }

  private unwatchCronFile(): void {
    if (!this.watching) return;
    try {
      unwatchFile(CRON_FILE);
    } catch { /* ignore */ }
    this.watching = false;
  }

  /** Watch agents directory for cron/workflow changes and auto-reload. */
  private watchingAgents = false;

  private watchAgentsDir(): void {
    if (this.watchingAgents) return;
    if (!existsSync(AGENTS_DIR)) return;

    watchFile(AGENTS_DIR, { interval: 5000 }, () => {
      logger.info('Agents directory changed — reloading jobs and workflows');
      try {
        this.reloadJobs();
        this.reloadWorkflows();
        scanner.refreshIntegrity();
      } catch (err) {
        logger.error({ err }, 'Failed to reload agent configs');
      }
    });
    this.watchingAgents = true;
  }

  private unwatchAgentsDir(): void {
    if (!this.watchingAgents) return;
    try {
      unwatchFile(AGENTS_DIR);
    } catch { /* ignore */ }
    this.watchingAgents = false;
  }

  reloadJobs(): void {
    // Stop existing scheduled tasks (but NOT the file watcher)
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      logger.debug(`Stopped cron task: ${name}`);
    }
    this.scheduledTasks.clear();

    this.jobs = parseCronJobs();

    // Merge in agent-scoped cron jobs
    const agentJobs = parseAgentCronJobs(AGENTS_DIR);
    if (agentJobs.length > 0) {
      this.jobs.push(...agentJobs);
      logger.info(`Loaded ${agentJobs.length} agent-scoped cron job(s)`);
    }

    if (this.jobs.length === 0) {
      logger.info('No CRON.md found or no jobs defined');
      return;
    }

    // ── Cycle detection for `after` chains (DFS) ──────────────────────
    const jobNames = new Set(this.jobs.map(j => j.name));
    const afterMap = new Map<string, string>(); // child → parent
    for (const def of this.jobs) {
      if (def.after) {
        if (!jobNames.has(def.after)) {
          logger.warn(`Job '${def.name}' references missing parent '${def.after}' — ignoring chain`);
          def.after = undefined;
        } else {
          afterMap.set(def.name, def.after);
        }
      }
    }

    // DFS cycle detection
    const cycledJobs = new Set<string>();
    for (const startName of afterMap.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = startName;
      while (current && afterMap.has(current)) {
        if (visited.has(current)) {
          // Cycle found — disable all jobs in the cycle
          for (const name of visited) cycledJobs.add(name);
          logger.error({ cycle: [...visited] }, `Circular dependency detected — disabling cycled jobs`);
          break;
        }
        visited.add(current);
        current = afterMap.get(current);
      }
    }

    for (const name of cycledJobs) {
      const job = this.jobs.find(j => j.name === name);
      if (job) {
        job.enabled = false;
        job.after = undefined;
        logger.error(`Disabled '${name}' due to circular chain dependency`);
      }
    }

    for (const def of this.jobs) {
      if (def.enabled && !this.disabledJobs.has(def.name)) {
        // Jobs with `after` are triggered by their parent — skip cron scheduling
        if (def.after) {
          logger.info(`Cron job '${def.name}' chained after '${def.after}' — skipping cron schedule`);
          continue;
        }

        if (!cron.validate(def.schedule)) {
          logger.error(`Invalid cron schedule for '${def.name}': ${def.schedule}`);
          continue;
        }

        const task = cron.schedule(def.schedule, () => {
          this.runJob(def).catch((err) => {
            logger.error({ err, job: def.name }, `Cron job '${def.name}' failed`);
          });
        }, { timezone: SYSTEM_TIMEZONE });
        this.scheduledTasks.set(def.name, task);
        logger.info(`Cron job '${def.name}' scheduled: ${def.schedule} (${SYSTEM_TIMEZONE})`);
      }
    }
  }

  private async runJob(job: CronJobDefinition): Promise<void> {
    // Prevent concurrent runs of the same job
    if (this.runningJobs.has(job.name)) {
      logger.info(`Cron job '${job.name}' is already running — skipping this trigger`);
      return;
    }

    // Cooldown for unleashed jobs that completed recently
    const completedAt = this.completedJobs.get(job.name);
    if (completedAt) {
      const cooldownMs = (job.maxHours ?? 6) * 60 * 60 * 1000;
      if (Date.now() - completedAt < cooldownMs) {
        logger.info(`Cron job '${job.name}' completed recently — cooling down, skipping`);
        return;
      }
      this.completedJobs.delete(job.name);
    }

    this.runningJobs.add(job.name);
    this.emitStatusChange();

    try {
      logger.info(`Running cron job: ${job.name}${job.agentSlug ? ` (agent: ${job.agentSlug})` : ''}`);

      // Set agent profile for scoped cron jobs
      const cronSessionKey = `cron:${job.name}`;
      if (job.agentSlug) {
        this.gateway.setSessionProfile(cronSessionKey, job.agentSlug);
      }

      // Unleashed tasks handle their own retries/phases internally — never retry the whole task
      const priorErrors = this.runLog.consecutiveErrors(job.name);
      const maxAttempts = job.mode === 'unleashed'
        ? 1
        : 1 + (job.maxRetries ?? Math.min(priorErrors, BACKOFF_MS.length));

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = new Date();
        try {
          // Standard cron jobs get a 10-minute timeout via SDK AbortController
          const response = await this.gateway.handleCronJob(
            job.name,
            job.prompt,
            job.tier,
            job.maxTurns,
            job.model,
            job.workDir,
            job.mode,
            job.maxHours,
            job.mode !== 'unleashed' ? CRON_STANDARD_TIMEOUT_MS : undefined,
            job.successCriteria,
          );

          // Success — log and dispatch
          const finishedAt = new Date();
          const entry: CronRunEntry = {
            jobName: job.name,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            status: 'ok',
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempt,
            outputPreview: response ? response.slice(0, 200) : undefined,
          };

          if (response && !CronScheduler.isCronNoise(response)) {
            const result = await this.dispatcher.send(response);
            if (!result.delivered) {
              entry.deliveryFailed = true;
              entry.deliveryError = Object.values(result.channelErrors).join('; ').slice(0, 300);
              // Preserve more output when delivery fails so it's recoverable
              entry.outputPreview = response.slice(0, 2000);
              logger.warn({ job: job.name, errors: result.channelErrors }, 'Cron output not delivered to any channel');
            } else if (Object.keys(result.channelErrors).length > 0) {
              // Partial success — some channels failed. Log so broken channels are visible.
              entry.deliveryError = `partial: ${Object.entries(result.channelErrors).map(([ch, e]) => `${ch}: ${e}`).join('; ').slice(0, 300)}`;
              logger.warn({ job: job.name, errors: result.channelErrors }, 'Cron output delivered but some channels failed');
            }
            // Inject into owner's DM session so follow-up conversation has context
            if (DISCORD_OWNER_ID && DISCORD_OWNER_ID !== '0') {
              this.gateway.injectContext(
                `discord:user:${DISCORD_OWNER_ID}`,
                `[Scheduled cron: ${job.name}]`,
                response,
              );
            }
          }

          this.runLog.append(entry);

          // Log to daily note so end-of-day summary has data to work with
          const durationSec = Math.round(entry.durationMs / 1000);
          const preview = response ? response.slice(0, 100).replace(/\n/g, ' ') : 'no output';
          logToDailyNote(`**${job.name}** (${durationSec}s): ${preview}`);

          // Fire dependent chained jobs (async, non-blocking)
          const dependents = this.jobs.filter(j => j.after === job.name && j.enabled && !this.disabledJobs.has(j.name));
          for (const dep of dependents) {
            logger.info(`Chain: '${job.name}' succeeded — triggering '${dep.name}'`);
            this.runJob(dep).catch((err) => {
              logger.error({ err, job: dep.name }, `Chained job '${dep.name}' failed`);
            });
          }

          return; // done
        } catch (err) {
          const finishedAt = new Date();
          const errorType = classifyError(err);

          this.runLog.append({
            jobName: job.name,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            status: attempt < maxAttempts && errorType === 'transient' ? 'retried' : 'error',
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            error: String(err).slice(0, 500),
            errorType,
            attempt,
          });

          // Permanent error — stop immediately
          if (errorType === 'permanent') {
            logger.error({ err, job: job.name }, `Cron job '${job.name}' permanent error — not retrying`);
            await this.dispatcher.send(`${job.name} failed: ${err}`);
            return;
          }

          // Transient — retry with backoff if attempts remain
          if (attempt < maxAttempts) {
            const backoffMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
            logger.warn(
              { job: job.name, attempt, backoffMs },
              `Cron job '${job.name}' transient error — retrying in ${backoffMs / 1000}s`,
            );
            await sleep(backoffMs);
          } else {
            logger.error({ err, job: job.name }, `Cron job '${job.name}' failed after ${attempt} attempt(s)`);
            await this.dispatcher.send(CronScheduler.formatCronError(job.name, err));
          }
        }
      }
    } finally {
      this.runningJobs.delete(job.name);
      this.emitStatusChange();
    }
  }

  async runManual(jobName: string): Promise<string> {
    const job = this.jobs.find((j) => j.name === jobName);
    if (!job) {
      return `Cron job '${jobName}' not found. Use \`!cron list\` to see available jobs.`;
    }

    if (this.runningJobs.has(jobName)) {
      return `Cron job '${jobName}' is already running.`;
    }

    try {
      await this.runJob(job);
      return `*(cron job '${jobName}' completed)*`;
    } catch (err) {
      return CronScheduler.formatCronError(jobName, err);
    }
  }

  /** Filter out cron responses that are truly empty or nothing-to-report. */
  private static isCronNoise(response: string): boolean {
    const trimmed = response.trim();
    if (trimmed === '__NOTHING__') return true;

    // Only treat as noise if the response is short — avoids filtering out
    // substantive responses that happen to start with "No updates, but..."
    if (trimmed.length > 80) return false;

    const lower = trimmed.toLowerCase();
    const noisePatterns = [
      'nothing to report',
      'nothing new to report',
      'all clear',
      'no updates',
      'completing silently',
    ];
    if (noisePatterns.some((p) => lower.startsWith(p) || lower === p)) return true;

    return false;
  }

  /** Format cron error messages for clean notifications. */
  private static formatCronError(jobName: string, err: unknown): string {
    let msg = String(err);
    // Strip "Error: " prefix
    msg = msg.replace(/^Error:\s*/i, '');
    // Strip stack traces
    const stackIdx = msg.indexOf('\n    at ');
    if (stackIdx > 0) msg = msg.slice(0, stackIdx);
    // Replace exit code messages
    msg = msg.replace(/Claude Code process exited with code \d+/i, 'Task could not complete');
    // Truncate
    if (msg.length > 300) msg = msg.slice(0, 297) + '...';
    return `${jobName} failed: ${msg.trim()}`;
  }

  listJobs(): string {
    if (this.jobs.length === 0) {
      this.reloadJobs();
    }

    if (this.jobs.length === 0) {
      return 'No cron jobs configured. Edit `vault/00-System/CRON.md` to add jobs.';
    }

    const lines = ['**Scheduled Cron Jobs:**\n'];
    for (const job of this.jobs) {
      const enabled = job.enabled && !this.disabledJobs.has(job.name);
      const status = enabled ? 'enabled' : 'disabled';
      const modeTag = job.mode === 'unleashed' ? ' [unleashed]' : '';
      const chainTag = job.after ? ` → after "${job.after}"` : '';
      const retryTag = job.maxRetries != null ? ` [max ${job.maxRetries} retries]` : '';
      lines.push(`- **${job.name}** (\`${job.schedule}\`) — ${status}${modeTag}${chainTag}${retryTag}`);
      lines.push(`  _${job.prompt.slice(0, 80)}_`);
    }
    return lines.join('\n');
  }

  getJobNames(): string[] {
    return this.jobs.map((j) => j.name);
  }

  getJob(jobName: string): CronJobDefinition | undefined {
    return this.jobs.find((j) => j.name === jobName);
  }

  isJobRunning(jobName: string): boolean {
    return this.runningJobs.has(jobName);
  }

  getRunningJobs(): string[] {
    return [...this.runningJobs];
  }

  getRunningWorkflowNames(): string[] {
    return [...this.runningWorkflows];
  }

  disableJob(jobName: string): string {
    const job = this.jobs.find((j) => j.name === jobName);
    if (!job) return `Job not found: ${jobName}`;

    this.disabledJobs.add(jobName);
    const task = this.scheduledTasks.get(jobName);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(jobName);
    }
    return `Disabled cron job: ${jobName}`;
  }

  enableJob(jobName: string): string {
    this.disabledJobs.delete(jobName);
    this.completedJobs.delete(jobName);
    this.reloadJobs();
    return `Enabled cron job: ${jobName}`;
  }

  // ── Workflow support ──────────────────────────────────────────────

  reloadWorkflows(): void {
    // Stop existing workflow scheduled tasks
    for (const [name, task] of this.workflowTasks) {
      task.stop();
      logger.debug(`Stopped workflow task: ${name}`);
    }
    this.workflowTasks.clear();

    try {
      this.workflowDefs = parseAllWorkflowsSync(WORKFLOWS_DIR);
    } catch {
      this.workflowDefs = [];
    }

    // Merge in agent-scoped workflows
    if (existsSync(AGENTS_DIR)) {
      try {
        const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true } as any)
          .filter((d: any) => d.isDirectory() && !d.name.startsWith('_'))
          .map((d: any) => d.name);

        for (const slug of dirs) {
          const wfDir = path.join(AGENTS_DIR, slug, 'workflows');
          if (!existsSync(wfDir)) continue;
          try {
            const agentWfs = parseAllWorkflowsSync(wfDir);
            for (const wf of agentWfs) {
              wf.name = `${slug}:${wf.name}`;
              wf.agentSlug = slug;
              this.workflowDefs.push(wf);
            }
          } catch {
            logger.warn(`Failed to parse workflows for agent ${slug}`);
          }
        }
      } catch { /* agents dir not readable */ }
    }

    if (this.workflowDefs.length === 0) {
      logger.debug('No workflows found');
      return;
    }

    // Schedule workflows with cron triggers
    for (const wf of this.workflowDefs) {
      if (!wf.enabled || !wf.trigger.schedule) continue;

      if (!cron.validate(wf.trigger.schedule)) {
        logger.error(`Invalid cron schedule for workflow '${wf.name}': ${wf.trigger.schedule}`);
        continue;
      }

      const task = cron.schedule(wf.trigger.schedule, () => {
        this.runWorkflow(wf.name).catch(err => {
          logger.error({ err, workflow: wf.name }, `Scheduled workflow '${wf.name}' failed`);
        });
      }, { timezone: SYSTEM_TIMEZONE });
      this.workflowTasks.set(wf.name, task);
      logger.info(`Workflow '${wf.name}' scheduled: ${wf.trigger.schedule} (${SYSTEM_TIMEZONE})`);
    }

    logger.info(`Loaded ${this.workflowDefs.length} workflow(s), ${this.workflowTasks.size} scheduled`);
  }

  private watchWorkflowDir(): void {
    if (this.watchingWorkflows) return;
    if (!existsSync(WORKFLOWS_DIR)) return;

    watchFile(WORKFLOWS_DIR, { interval: 2000 }, () => {
      logger.info('Workflows directory changed — reloading');
      try {
        this.reloadWorkflows();
        scanner.refreshIntegrity();
      } catch (err) {
        logger.error({ err }, 'Failed to reload workflows');
      }
    });
    this.watchingWorkflows = true;
  }

  private unwatchWorkflowDir(): void {
    if (!this.watchingWorkflows) return;
    try {
      unwatchFile(WORKFLOWS_DIR);
    } catch { /* ignore */ }
    this.watchingWorkflows = false;
  }

  /** Watch the triggers directory for MCP-initiated job runs and goal work sessions. */
  private watchTriggers(): void {
    mkdirSync(this.triggerDir, { recursive: true });
    mkdirSync(this.goalTriggerDir, { recursive: true });
    this.triggerTimer = setInterval(() => {
      this.processTriggers();
      this.processGoalTriggers();
    }, 3000);
  }

  /** Process any pending trigger files and run the corresponding jobs. */
  private processTriggers(): void {
    if (!existsSync(this.triggerDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.triggerDir).filter(f => f.endsWith('.trigger'));
    } catch { return; }
    for (const file of files) {
      const filePath = path.join(this.triggerDir, file);
      try {
        const jobName = readFileSync(filePath, 'utf-8').trim();
        unlinkSync(filePath);
        if (!jobName) continue;
        logger.info({ jobName }, 'Processing MCP trigger for cron job');
        this.runManual(jobName).then((result) => {
          if (result && !result.includes('not found')) {
            this.dispatcher.send(`🔧 **${jobName}** (triggered):\n\n${result.slice(0, 1500)}`).catch(() => {});
          }
        }).catch((err) => {
          logger.error({ err, jobName }, 'Trigger-initiated job failed');
        });
      } catch (err) {
        logger.warn({ err, file }, 'Failed to process trigger file');
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }

  /** Process any pending goal work trigger files. */
  private processGoalTriggers(): void {
    if (!existsSync(this.goalTriggerDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.goalTriggerDir).filter(f => f.endsWith('.trigger.json'));
    } catch { return; }
    for (const file of files) {
      const filePath = path.join(this.goalTriggerDir, file);
      try {
        const trigger = JSON.parse(readFileSync(filePath, 'utf-8'));
        unlinkSync(filePath);
        if (!trigger.goalId) continue;

        const goalPath = path.join(GOALS_DIR, `${trigger.goalId}.json`);
        if (!existsSync(goalPath)) {
          logger.warn({ goalId: trigger.goalId }, 'Goal trigger references missing goal — skipping');
          continue;
        }
        const goal = JSON.parse(readFileSync(goalPath, 'utf-8'));
        if (goal.status !== 'active') continue;

        logger.info({ goalId: trigger.goalId, title: goal.title, focus: trigger.focus }, 'Processing goal work trigger');

        // Build a cron-like prompt that focuses on the goal
        const prompt =
          `You are working on a focused goal session.\n\n` +
          `## Goal: ${goal.title}\n${goal.description}\n\n` +
          `## Focus for this session\n${trigger.focus}\n\n` +
          (goal.progressNotes?.length > 0
            ? `## Prior progress\n${goal.progressNotes.slice(-5).map((n: string) => `- ${n}`).join('\n')}\n\n`
            : '') +
          (goal.nextActions?.length > 0
            ? `## Planned next actions\n${goal.nextActions.map((a: string) => `- ${a}`).join('\n')}\n\n`
            : '') +
          (goal.blockers?.length > 0
            ? `## Current blockers\n${goal.blockers.map((b: string) => `- ${b}`).join('\n')}\n\n`
            : '') +
          `## Instructions\n` +
          `1. Work on the focus area above. Use tools as needed.\n` +
          `2. When done, use \`goal_update\` to record progress notes, update next actions, and clear resolved blockers.\n` +
          `3. If blocked, add blockers and change status to "blocked".\n` +
          `4. Keep your output concise — summarize what you accomplished.`;

        const jobName = `goal:${goal.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
        this.gateway.handleCronJob(
          jobName,
          prompt,
          2, // tier 2 — logged
          trigger.maxTurns ?? 15,
        ).then((result) => {
          if (result && !CronScheduler.isCronNoise(result)) {
            this.dispatcher.send(`🎯 **Goal work: ${goal.title}**\n\n${result.slice(0, 1500)}`).catch(() => {});
          }
          logToDailyNote(`**Goal work: ${goal.title}** — ${(result || 'completed').slice(0, 100).replace(/\n/g, ' ')}`);
        }).catch((err) => {
          logger.error({ err, goalId: trigger.goalId }, 'Goal work session failed');
        });
      } catch (err) {
        logger.warn({ err, file }, 'Failed to process goal trigger file');
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }

  async runWorkflow(name: string, inputs?: Record<string, string>): Promise<string> {
    const wf = this.workflowDefs.find(w => w.name === name);
    if (!wf) {
      return `Workflow '${name}' not found. Use \`!workflow list\` to see available workflows.`;
    }

    if (this.runningWorkflows.has(name)) {
      return `Workflow '${name}' is already running.`;
    }

    this.runningWorkflows.add(name);
    this.emitStatusChange();
    const startedAt = new Date();
    try {
      logger.info({ workflow: name, inputs }, `Running workflow: ${name}`);
      const response = await this.gateway.handleWorkflow(wf, inputs ?? {});

      if (response && response !== '*(workflow completed — no output)*') {
        await this.dispatcher.send(`**[Workflow: ${name}]**\n\n${response.slice(0, 1500)}`);
        // Inject into owner's DM session
        if (DISCORD_OWNER_ID && DISCORD_OWNER_ID !== '0') {
          this.gateway.injectContext(
            `discord:user:${DISCORD_OWNER_ID}`,
            `[Workflow: ${name}]`,
            response,
          );
        }
      }

      const durationSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
      logToDailyNote(`**Workflow: ${name}** (${durationSec}s): ${(response || 'no output').slice(0, 100).replace(/\n/g, ' ')}`);

      return response;
    } catch (err) {
      logger.error({ err, workflow: name }, `Workflow '${name}' failed`);
      const errMsg = `Workflow '${name}' failed: ${String(err).slice(0, 300)}`;
      await this.dispatcher.send(errMsg);
      return errMsg;
    } finally {
      this.runningWorkflows.delete(name);
      this.emitStatusChange();
    }
  }

  getWorkflowNames(): string[] {
    return this.workflowDefs.map(w => w.name);
  }

  getWorkflow(name: string): WorkflowDefinition | undefined {
    return this.workflowDefs.find(w => w.name === name);
  }

  isWorkflowRunning(name: string): boolean {
    return this.runningWorkflows.has(name);
  }

  listWorkflows(): string {
    if (this.workflowDefs.length === 0) {
      this.reloadWorkflows();
    }

    if (this.workflowDefs.length === 0) {
      return 'No workflows configured. Add workflow files to `vault/00-System/workflows/`.';
    }

    const lines = ['**Workflows:**\n'];
    for (const wf of this.workflowDefs) {
      const status = wf.enabled ? 'enabled' : 'disabled';
      const schedule = wf.trigger.schedule ? ` (\`${wf.trigger.schedule}\`)` : ' (manual)';
      const running = this.runningWorkflows.has(wf.name) ? ' [running]' : '';
      lines.push(`- **${wf.name}**${schedule} — ${status}${running}`);
      if (wf.description) lines.push(`  _${wf.description.slice(0, 80)}_`);
      lines.push(`  Steps: ${wf.steps.map(s => s.id).join(' → ')}`);
    }
    return lines.join('\n');
  }

  // ── Self-Improvement ─────────────────────────────────────────────

  async runSelfImproveLoop(
    config?: Partial<SelfImproveConfig>,
    onProposal?: (experiment: SelfImproveExperiment) => Promise<void>,
  ): Promise<SelfImproveState> {
    const loop = new SelfImproveLoop(this.gateway.assistant, config);
    this.emitStatusChange();
    try {
      return await loop.run(onProposal);
    } finally {
      this.emitStatusChange();
    }
  }

  async applySelfImproveChange(experimentId: string): Promise<string> {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    const result = loop.applyApprovedChange(experimentId);
    this.emitStatusChange();
    return result;
  }

  denySelfImproveChange(experimentId: string): string {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    const result = loop.denyChange(experimentId);
    this.emitStatusChange();
    return result;
  }

  getSelfImproveStatus(): SelfImproveState {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    return loop.loadState();
  }

  getSelfImproveHistory(limit = 10): SelfImproveExperiment[] {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    const log = loop.loadExperimentLog();
    return log.slice(-limit).reverse();
  }

  getSelfImprovePending(): Array<SelfImproveExperiment & { before: string }> {
    const loop = new SelfImproveLoop(this.gateway.assistant);
    return loop.getPendingChanges();
  }
}
