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
import type { AgentHeartbeatState, AgentProfile } from '../types.js';
import type { AgentManager } from '../agent/agent-manager.js';

const logger = pino({ name: 'clementine.agent-heartbeat' });

const DEFAULT_INTERVAL_MIN = 30;
const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 12 * 60;

/**
 * Minimal gateway surface the scheduler needs for the LLM tick path.
 * Kept narrow so tests can mock it without pulling in the full Gateway.
 */
export interface AgentHeartbeatGateway {
  handleCronJob(
    jobName: string,
    jobPrompt: string,
    tier?: number,
    maxTurns?: number,
    model?: string,
    workDir?: string,
    mode?: 'standard' | 'unleashed',
    maxHours?: number,
    timeoutMs?: number,
    successCriteria?: string[],
    agentSlug?: string,
  ): Promise<string>;
}

export interface AgentHeartbeatOptions {
  /** Override the base directory for test isolation. Defaults to config.BASE_DIR. */
  baseDir?: string;
  /** Override the agents directory for test isolation. Defaults to config.AGENTS_DIR. */
  agentsDir?: string;
  /**
   * Gateway used for the LLM tick path. When omitted, the scheduler runs in
   * cheap-path-only mode (observation + logging, no LLM call). Tests pass
   * mocks here; production passes the real Gateway.
   */
  gateway?: AgentHeartbeatGateway;
}

export class AgentHeartbeatScheduler {
  private readonly slug: string;
  private readonly agentManager: AgentManager;
  private readonly baseDir: string;
  private readonly agentsDir: string;
  private readonly stateFile: string;
  private readonly gateway: AgentHeartbeatGateway | null;

  constructor(slug: string, agentManager: AgentManager, opts: AgentHeartbeatOptions = {}) {
    this.slug = slug;
    this.agentManager = agentManager;
    this.baseDir = opts.baseDir ?? BASE_DIR;
    this.agentsDir = opts.agentsDir ?? AGENTS_DIR;
    this.stateFile = path.join(this.baseDir, 'heartbeat', 'agents', slug, 'state.json');
    this.gateway = opts.gateway ?? null;
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
   * Tick. Loads state, builds fingerprint, decides whether to invoke the
   * LLM path, persists the new state. The LLM call is only made when:
   *
   *   1. The fingerprint changed (something material moved since last tick), AND
   *   2. The prior fingerprint was non-empty (we don't fire LLM on the very
   *      first tick after daemon start — those are noisy and not signal), AND
   *   3. A gateway is wired (opts.gateway). Tests run cheap-path-only.
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

    let nextCheckMinutes = DEFAULT_INTERVAL_MIN;
    let lastSignalSummary: string | undefined;

    const shouldRunLlm = changed && prior.fingerprint !== '' && this.gateway !== null;

    if (shouldRunLlm) {
      try {
        const result = await this.runLlmTick(profile, signals, prior, now);
        nextCheckMinutes = result.nextCheckMinutes ?? DEFAULT_INTERVAL_MIN;
        lastSignalSummary = result.summary?.slice(0, 240);
      } catch (err) {
        logger.warn({ err, slug: this.slug }, 'Agent LLM tick failed — using default cadence');
        lastSignalSummary = `llm tick error: ${String(err).slice(0, 200)}`;
      }
    } else if (changed) {
      lastSignalSummary = `signal change: ${JSON.stringify(signals)}`.slice(0, 240);
    } else {
      lastSignalSummary = prior.lastSignalSummary;
    }

    const clampedMin = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, Math.floor(nextCheckMinutes)));
    const next = new Date(now.getTime() + clampedMin * 60_000);
    const state: AgentHeartbeatState = {
      slug: this.slug,
      lastTickAt: now.toISOString(),
      nextCheckAt: next.toISOString(),
      silentTickCount: changed ? 0 : prior.silentTickCount + 1,
      fingerprint,
      ...(lastSignalSummary ? { lastSignalSummary } : {}),
    };
    this.saveState(state);

    if (changed) {
      logger.info({ slug: this.slug, signals, fingerprint, ranLlm: shouldRunLlm, nextCheckMin: clampedMin }, 'Agent heartbeat tick');
    } else {
      logger.debug({ slug: this.slug, silentTicks: state.silentTickCount }, 'Agent heartbeat: silent tick');
    }
    return state;
  }

  /**
   * Build and dispatch the LLM tick prompt via gateway.handleCronJob.
   * Output already routes to the agent's Discord channel (dispatcher.send
   * is called inside the cron path with the agentSlug).
   */
  private async runLlmTick(
    profile: AgentProfile,
    signals: Record<string, string | number>,
    prior: AgentHeartbeatState,
    now: Date,
  ): Promise<{ nextCheckMinutes: number | undefined; summary: string }> {
    if (!this.gateway) {
      return { nextCheckMinutes: undefined, summary: '' };
    }

    const sinceLastMin = prior.lastTickAt
      ? Math.max(0, Math.round((now.getTime() - new Date(prior.lastTickAt).getTime()) / 60_000))
      : 0;

    const prompt = [
      `[Heartbeat check-in: ${profile.slug}]`,
      '',
      `You are ${profile.name}. ${profile.description}`,
      '',
      `## Routine check-in`,
      `This is your scheduled heartbeat tick (${sinceLastMin}min since last).`,
      `Something in your scope has changed since you last checked in.`,
      '',
      `### Signals`,
      `- Pending delegated tasks: ${signals.pendingTasks ?? 0}`,
      `- Latest goal update: ${signals.latestGoalUpdate || 'none'}`,
      `- Latest cron run: ${signals.latestCronRunMs ? new Date(Number(signals.latestCronRunMs)).toISOString() : 'none'}`,
      '',
      `### Instructions`,
      `1. Quickly scan TASKS.md, your goals, and recent cron output for anything that needs action right now.`,
      `2. If there's a clear next action you can take in 1–2 turns, do it.`,
      `3. If you're blocked, waiting on someone, or it's all-quiet, say so concisely.`,
      `4. End your response with \`[NEXT_CHECK: Xm]\` to set when to check in next (5–720 min). Default 30m. Use shorter intervals during active work, longer during quiet hours.`,
      `5. Keep your response under 3 sentences unless you actually took action.`,
    ].join('\n');

    const jobName = `heartbeat:${this.slug}`;
    const result = await this.gateway.handleCronJob(jobName, prompt, 1, 5, undefined, undefined, 'standard', undefined, undefined, undefined, this.slug);

    const parsed = AgentHeartbeatScheduler.parseLlmTickOutput(result);
    return { nextCheckMinutes: parsed.nextCheckMinutes, summary: parsed.summary };
  }

  /** Parse `[NEXT_CHECK: Xm]` directive from the agent's output. Public for tests. */
  static parseLlmTickOutput(output: string): { nextCheckMinutes: number | undefined; summary: string } {
    const match = output.match(/\[NEXT_CHECK:\s*(\d+)\s*m?\]/i);
    const nextCheckMinutes = match ? parseInt(match[1], 10) : undefined;
    // Strip the directive from the summary so logs don't echo it back
    const summary = output.replace(/\[NEXT_CHECK:[^\]]*\]/gi, '').trim();
    return { nextCheckMinutes, summary };
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
