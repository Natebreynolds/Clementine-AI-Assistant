/**
 * Per-agent heartbeat scheduler — one instance per specialist agent
 * (Ross, Sasha, Nora, etc.). Runs autonomously alongside Clementine's
 * own HeartbeatScheduler.
 *
 * Phase 2 — cheap path only. No LLM call. The tick loads state, scans
 * three signals (pending delegated tasks, recent goal updates, recent
 * cron completions), updates fingerprint, and persists state.
 *
 * Phase 3 will add the LLM-path tick (assistant.heartbeat() with the
 * agent's profile) when the fingerprint indicates a real signal change.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { AGENTS_DIR, BASE_DIR } from '../config.js';
import { listAllGoals } from '../tools/shared.js';
import type { AgentHeartbeatState } from '../types.js';
import type { AgentManager } from '../agent/agent-manager.js';

const logger = pino({ name: 'clementine.agent-heartbeat' });

const DEFAULT_INTERVAL_MIN = 30;
const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 12 * 60;

export interface AgentHeartbeatOptions {
  /** Override the base directory for test isolation. Defaults to config.BASE_DIR. */
  baseDir?: string;
  /** Override the agents directory for test isolation. Defaults to config.AGENTS_DIR. */
  agentsDir?: string;
}

export class AgentHeartbeatScheduler {
  private readonly slug: string;
  private readonly agentManager: AgentManager;
  private readonly baseDir: string;
  private readonly agentsDir: string;
  private readonly stateFile: string;

  constructor(slug: string, agentManager: AgentManager, opts: AgentHeartbeatOptions = {}) {
    this.slug = slug;
    this.agentManager = agentManager;
    this.baseDir = opts.baseDir ?? BASE_DIR;
    this.agentsDir = opts.agentsDir ?? AGENTS_DIR;
    this.stateFile = path.join(this.baseDir, 'heartbeat', 'agents', slug, 'state.json');
  }

  /** Read persisted state, or return a fresh state ready to tick now. */
  loadState(): AgentHeartbeatState {
    try {
      if (existsSync(this.stateFile)) {
        const raw = JSON.parse(readFileSync(this.stateFile, 'utf-8')) as Partial<AgentHeartbeatState>;
        return {
          slug: this.slug,
          lastTickAt: String(raw.lastTickAt ?? ''),
          nextCheckAt: String(raw.nextCheckAt ?? new Date().toISOString()),
          silentTickCount: Number(raw.silentTickCount ?? 0),
          fingerprint: String(raw.fingerprint ?? ''),
          ...(raw.lastSignalSummary ? { lastSignalSummary: raw.lastSignalSummary } : {}),
        };
      }
    } catch (err) {
      logger.warn({ err, slug: this.slug }, 'Failed to load agent heartbeat state — starting fresh');
    }
    return {
      slug: this.slug,
      lastTickAt: '',
      nextCheckAt: new Date().toISOString(),
      silentTickCount: 0,
      fingerprint: '',
    };
  }

  saveState(state: AgentHeartbeatState): void {
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.warn({ err, slug: this.slug }, 'Failed to save agent heartbeat state — non-fatal');
    }
  }

  /** True if the agent is due for a tick. */
  isDue(now: Date = new Date()): boolean {
    const state = this.loadState();
    if (!state.nextCheckAt) return true;
    return new Date(state.nextCheckAt).getTime() <= now.getTime();
  }

  /**
   * Compute a cheap fingerprint of "anything material to this agent."
   * Three signals: pending delegated tasks, latest goal update, latest
   * cron run timestamp. Sync filesystem reads — bounded and small.
   */
  private buildFingerprint(): { fingerprint: string; signals: Record<string, string | number> } {
    const signals: Record<string, string | number> = { slug: this.slug };

    // 1. Pending delegated task count
    try {
      const tasksDir = path.join(this.agentsDir, this.slug, 'tasks');
      if (existsSync(tasksDir)) {
        const files = readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
        let pendingCount = 0;
        for (const file of files) {
          try {
            const task = JSON.parse(readFileSync(path.join(tasksDir, file), 'utf-8'));
            if (task && task.status === 'pending') pendingCount++;
          } catch { /* skip malformed */ }
        }
        signals.pendingTasks = pendingCount;
      } else {
        signals.pendingTasks = 0;
      }
    } catch {
      signals.pendingTasks = 0;
    }

    // 2. Latest goal updatedAt for this agent's goals
    try {
      let latest = '';
      for (const { goal, owner } of listAllGoals()) {
        if (owner !== this.slug) continue;
        const updatedAt = goal.updatedAt ?? '';
        if (updatedAt > latest) latest = updatedAt;
      }
      signals.latestGoalUpdate = latest;
    } catch {
      signals.latestGoalUpdate = '';
    }

    // 3. Latest cron run for any of this agent's crons (file mtime is enough)
    try {
      const runsDir = path.join(this.baseDir, 'cron', 'runs');
      let latestMs = 0;
      if (existsSync(runsDir)) {
        const prefix = `${this.slug}:`;
        for (const file of readdirSync(runsDir)) {
          if (!file.endsWith('.jsonl')) continue;
          if (!file.startsWith(prefix) && !file.startsWith(this.slug + '_')) continue;
          try {
            const mtime = statSync(path.join(runsDir, file)).mtimeMs;
            if (mtime > latestMs) latestMs = mtime;
          } catch { /* skip */ }
        }
      }
      signals.latestCronRunMs = latestMs;
    } catch {
      signals.latestCronRunMs = 0;
    }

    const fingerprint = createHash('sha1')
      .update(JSON.stringify(signals))
      .digest('hex')
      .slice(0, 16);
    return { fingerprint, signals };
  }

  /**
   * Cheap-path tick. Returns the new state. P3 will branch into an LLM
   * call when the fingerprint changed; for now we just observe and log.
   */
  async tick(now: Date = new Date()): Promise<AgentHeartbeatState> {
    const profile = this.agentManager.get(this.slug);
    if (!profile) {
      // Agent was removed mid-flight — return a state that won't tick again soon.
      return {
        slug: this.slug,
        lastTickAt: now.toISOString(),
        nextCheckAt: new Date(now.getTime() + MAX_INTERVAL_MIN * 60_000).toISOString(),
        silentTickCount: 0,
        fingerprint: '',
        lastSignalSummary: 'agent profile not found',
      };
    }
    if (!this.agentManager.isRunnable(this.slug)) {
      logger.debug({ slug: this.slug, status: profile.status }, 'Agent not runnable — skipping tick');
      const next = new Date(now.getTime() + DEFAULT_INTERVAL_MIN * 60_000);
      const prior = this.loadState();
      const state: AgentHeartbeatState = {
        ...prior,
        slug: this.slug,
        lastTickAt: now.toISOString(),
        nextCheckAt: next.toISOString(),
      };
      this.saveState(state);
      return state;
    }

    const prior = this.loadState();
    const { fingerprint, signals } = this.buildFingerprint();
    const changed = fingerprint !== prior.fingerprint;
    const next = new Date(now.getTime() + DEFAULT_INTERVAL_MIN * 60_000);

    const state: AgentHeartbeatState = {
      slug: this.slug,
      lastTickAt: now.toISOString(),
      nextCheckAt: next.toISOString(),
      silentTickCount: changed ? 0 : prior.silentTickCount + 1,
      fingerprint,
      ...(changed
        ? { lastSignalSummary: `signal change: ${JSON.stringify(signals)}`.slice(0, 240) }
        : prior.lastSignalSummary
          ? { lastSignalSummary: prior.lastSignalSummary }
          : {}),
    };
    this.saveState(state);

    if (changed) {
      logger.info({ slug: this.slug, signals, fingerprint }, 'Agent heartbeat: signal change detected (LLM path is P3)');
    } else {
      logger.debug({ slug: this.slug, silentTicks: state.silentTickCount }, 'Agent heartbeat: silent tick');
    }
    return state;
  }

  /** Schedule the next check explicitly. Clamped to [MIN, MAX] minutes. */
  setNextCheckIn(minutes: number, now: Date = new Date()): void {
    const clamped = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, Math.floor(minutes)));
    const prior = this.loadState();
    const state: AgentHeartbeatState = {
      ...prior,
      slug: this.slug,
      nextCheckAt: new Date(now.getTime() + clamped * 60_000).toISOString(),
    };
    this.saveState(state);
  }

  getSlug(): string {
    return this.slug;
  }
}
