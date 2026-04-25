/**
 * Owns the lifecycle of all per-agent heartbeat schedulers.
 *
 * Boots at daemon start, scans the AgentManager's active list, spawns one
 * AgentHeartbeatScheduler per agent. An outer 60s interval iterates the
 * registry and fires `tick()` on any agent whose nextCheckAt is due.
 *
 * Reconciliation runs each outer tick: agents added to AGENTS_DIR start
 * heartbeats automatically; agents removed (or paused/terminated) drop
 * out. Per-agent failures are caught so one buggy agent can't crash the
 * daemon or stall others.
 */

import pino from 'pino';
import type { AgentManager } from '../agent/agent-manager.js';
import { AgentHeartbeatScheduler, type AgentHeartbeatGateway } from './agent-heartbeat-scheduler.js';

const logger = pino({ name: 'clementine.agent-heartbeat-manager' });

const OUTER_TICK_MS = 60_000;

export class AgentHeartbeatManager {
  private readonly agentManager: AgentManager;
  private readonly gateway: AgentHeartbeatGateway | null;
  private readonly schedulers = new Map<string, AgentHeartbeatScheduler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;

  constructor(agentManager: AgentManager, gateway?: AgentHeartbeatGateway) {
    this.agentManager = agentManager;
    this.gateway = gateway ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconcile();
    // Run an immediate tick so schedulers boot up without a 60s delay.
    this.outerTick().catch((err) => logger.error({ err }, 'Initial agent heartbeat tick failed'));
    this.timer = setInterval(() => {
      this.outerTick().catch((err) => logger.error({ err }, 'Agent heartbeat outer tick failed'));
    }, OUTER_TICK_MS);
    logger.info({ agents: this.schedulers.size }, 'Agent heartbeat manager started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.schedulers.clear();
    logger.info('Agent heartbeat manager stopped');
  }

  /** Add/remove schedulers to match the current AgentManager listing. */
  private reconcile(): void {
    let active: string[] = [];
    try {
      active = this.agentManager
        .listAll()
        .filter((p) => p.slug !== 'clementine' && this.agentManager.isRunnable(p.slug))
        .map((p) => p.slug);
    } catch (err) {
      logger.warn({ err }, 'Failed to list agents during reconcile — keeping current set');
      return;
    }
    const activeSet = new Set(active);

    // Add new
    for (const slug of active) {
      if (!this.schedulers.has(slug)) {
        this.schedulers.set(
          slug,
          new AgentHeartbeatScheduler(slug, this.agentManager, this.gateway ? { gateway: this.gateway } : {}),
        );
        logger.info({ slug }, 'Agent heartbeat: registered scheduler');
      }
    }
    // Remove gone-or-paused
    for (const slug of [...this.schedulers.keys()]) {
      if (!activeSet.has(slug)) {
        this.schedulers.delete(slug);
        logger.info({ slug }, 'Agent heartbeat: deregistered scheduler');
      }
    }
  }

  /**
   * One outer-loop tick. Reconcile the registry, then fire agents whose
   * nextCheckAt has come due. Runs serially to avoid races on shared
   * state (goals dir, cron runs dir).
   */
  private async outerTick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return; // prior outer tick still in flight — skip
    this.ticking = true;
    try {
      this.reconcile();
      for (const [slug, scheduler] of this.schedulers) {
        try {
          if (!scheduler.isDue(now)) continue;
          await scheduler.tick(now);
        } catch (err) {
          logger.warn({ err, slug }, 'Agent heartbeat tick failed — continuing');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Diagnostic helper for the dashboard / CLI. */
  getStatus(): Array<{ slug: string; nextCheckAt: string; lastTickAt: string; silentTickCount: number }> {
    const out: Array<{ slug: string; nextCheckAt: string; lastTickAt: string; silentTickCount: number }> = [];
    for (const [slug, scheduler] of this.schedulers) {
      const state = scheduler.loadState();
      out.push({
        slug,
        nextCheckAt: state.nextCheckAt,
        lastTickAt: state.lastTickAt,
        silentTickCount: state.silentTickCount,
      });
    }
    return out;
  }

  /** Look up a scheduler — useful for CLI commands like "tick this agent now." */
  getScheduler(slug: string): AgentHeartbeatScheduler | null {
    return this.schedulers.get(slug) ?? null;
  }
}
