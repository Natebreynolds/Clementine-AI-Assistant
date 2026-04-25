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

import { existsSync, mkdirSync, readFileSync, unlinkSync, type FSWatcher, watch } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { AGENTS_DIR, BASE_DIR } from '../config.js';
import { listAllGoals } from '../tools/shared.js';
import type { AgentManager } from '../agent/agent-manager.js';
import { AgentHeartbeatScheduler, type AgentHeartbeatGateway } from './agent-heartbeat-scheduler.js';

const logger = pino({ name: 'clementine.agent-heartbeat-manager' });

const OUTER_TICK_MS = 60_000;
/**
 * After a watched event fires, wait this long before actually waking the
 * agent. Coalesces filesystem storms (a burst of file writes from one
 * action shouldn't trigger N wake-ups).
 */
const WAKE_DEBOUNCE_MS = 3_000;

export class AgentHeartbeatManager {
  private readonly agentManager: AgentManager;
  private readonly gateway: AgentHeartbeatGateway | null;
  private readonly schedulers = new Map<string, AgentHeartbeatScheduler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;

  // Per-directory fs.watch handles, indexed by slug for cleanup
  private readonly perAgentWatchers = new Map<string, FSWatcher>();
  private goalTriggerWatcher: FSWatcher | null = null;
  private wakeDirWatcher: FSWatcher | null = null;
  // Debounce wake-ups per slug so a burst of file events fires one tick.
  private readonly pendingWakes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(agentManager: AgentManager, gateway?: AgentHeartbeatGateway) {
    this.agentManager = agentManager;
    this.gateway = gateway ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconcile();
    this.setupWatchers();
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
    this.teardownWatchers();
    this.schedulers.clear();
    logger.info('Agent heartbeat manager stopped');
  }

  /**
   * Set up fs.watch on the directories that signal real work for an agent:
   *
   * - per-agent tasks dir (delegated tasks land here)
   * - goal-triggers dir (any goal trigger; we route to the owner)
   * - wake-sentinels dir (explicit wake_agent calls)
   *
   * On a relevant change, schedule a debounced wake for the matching
   * scheduler. Failures here are non-fatal — polling still works.
   */
  private setupWatchers(): void {
    // Per-agent task dirs
    for (const [slug] of this.schedulers) {
      this.watchAgentTasks(slug);
    }

    // Goal-triggers (one trigger per goal; we resolve owner → slug at fire time)
    const triggerDir = path.join(BASE_DIR, 'cron', 'goal-triggers');
    try {
      mkdirSync(triggerDir, { recursive: true });
      this.goalTriggerWatcher = watch(triggerDir, (eventType, filename) => {
        if (eventType !== 'rename' || !filename || !filename.endsWith('.trigger.json')) return;
        // Trigger filenames are idempotencyKey-based — we don't have a slug here,
        // so wake any agent whose goal might match. Cheap enough: reconcile with
        // listAllGoals once and wake the affected owners.
        this.handleGoalTriggerEvent(filename);
      });
    } catch (err) {
      logger.warn({ err, triggerDir }, 'Failed to watch goal-triggers — falling back to polling');
    }

    // Wake sentinels (F3): wake_agent tool writes BASE_DIR/heartbeat/wake/<slug>.json
    const wakeDir = path.join(BASE_DIR, 'heartbeat', 'wake');
    try {
      mkdirSync(wakeDir, { recursive: true });
      this.wakeDirWatcher = watch(wakeDir, (eventType, filename) => {
        if (eventType !== 'rename' || !filename) return;
        if (!filename.endsWith('.json')) return;
        const slug = filename.replace(/\.json$/, '');
        // Consume the sentinel + wake the agent. Best-effort delete so the
        // same sentinel can't fire repeatedly.
        const sentinelPath = path.join(wakeDir, filename);
        if (existsSync(sentinelPath)) {
          try { unlinkSync(sentinelPath); } catch { /* ignore */ }
        }
        this.scheduleWake(slug, 'wake-sentinel');
      });
    } catch (err) {
      logger.warn({ err, wakeDir }, 'Failed to watch wake-sentinels — wake_agent tool will be slower');
    }
  }

  /** Watch a single agent's tasks directory. Idempotent. */
  private watchAgentTasks(slug: string): void {
    if (this.perAgentWatchers.has(slug)) return;
    const tasksDir = path.join(AGENTS_DIR, slug, 'tasks');
    try {
      mkdirSync(tasksDir, { recursive: true });
      const watcher = watch(tasksDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        // Both 'rename' (create/delete) and 'change' can indicate new work
        this.scheduleWake(slug, `task-${eventType}:${filename}`);
      });
      this.perAgentWatchers.set(slug, watcher);
    } catch (err) {
      logger.debug({ err, slug, tasksDir }, 'Could not watch agent tasks dir — will rely on polling');
    }
  }

  private teardownWatchers(): void {
    for (const [, w] of this.perAgentWatchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.perAgentWatchers.clear();
    try { this.goalTriggerWatcher?.close(); } catch { /* ignore */ }
    this.goalTriggerWatcher = null;
    try { this.wakeDirWatcher?.close(); } catch { /* ignore */ }
    this.wakeDirWatcher = null;
    for (const [, t] of this.pendingWakes) clearTimeout(t);
    this.pendingWakes.clear();
  }

  /** Debounced wake — coalesce a burst of events into one markDue call. */
  private scheduleWake(slug: string, reason: string): void {
    const existing = this.pendingWakes.get(slug);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pendingWakes.delete(slug);
      const scheduler = this.schedulers.get(slug);
      if (!scheduler) return;
      scheduler.markDue();
      logger.info({ slug, reason }, 'Agent heartbeat: woken by event');
      // Don't await — let the next outerTick (within ≤60s, or instant when
      // we trigger one ourselves) actually run the tick.
      this.outerTick().catch((err) => logger.warn({ err, slug }, 'Triggered tick after wake failed'));
    }, WAKE_DEBOUNCE_MS);
    this.pendingWakes.set(slug, t);
  }

  /** Goal trigger landed — wake the owning agent. Non-Clementine owners only. */
  private handleGoalTriggerEvent(filename: string): void {
    try {
      // We don't yet know which goal id the trigger references without reading
      // the file (idempotencyKey-named). Read it, find the owner, wake them.
      const triggerPath = path.join(BASE_DIR, 'cron', 'goal-triggers', filename);
      if (!existsSync(triggerPath)) return; // file was already consumed by cron-scheduler
      const trigger = JSON.parse(readFileSync(triggerPath, 'utf-8')) as { goalId?: string };
      if (!trigger.goalId) return;
      const lookup = listAllGoals().find((g) => g.goal && g.goal.id === trigger.goalId);
      if (!lookup || !lookup.owner || lookup.owner === 'clementine') return;
      this.scheduleWake(lookup.owner, `goal-trigger:${trigger.goalId}`);
    } catch (err) {
      logger.debug({ err, filename }, 'Failed to handle goal-trigger event — non-fatal');
    }
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
        // Start watching this agent's tasks dir if we're already running
        if (this.running) this.watchAgentTasks(slug);
        logger.info({ slug }, 'Agent heartbeat: registered scheduler');
      }
    }
    // Remove gone-or-paused
    for (const slug of [...this.schedulers.keys()]) {
      if (!activeSet.has(slug)) {
        this.schedulers.delete(slug);
        const watcher = this.perAgentWatchers.get(slug);
        if (watcher) {
          try { watcher.close(); } catch { /* ignore */ }
          this.perAgentWatchers.delete(slug);
        }
        const pending = this.pendingWakes.get(slug);
        if (pending) {
          clearTimeout(pending);
          this.pendingWakes.delete(slug);
        }
        logger.info({ slug }, 'Agent heartbeat: deregistered scheduler');
      }
    }
  }

  /**
   * One outer-loop tick. Reconcile the registry, then fire all due agents
   * concurrently. Each agent's tick is isolated by profile + idempotency-keyed
   * filesystem writes, so parallel execution is safe — and 3+ specialists no
   * longer queue behind each other.
   */
  private async outerTick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return; // prior outer tick still in flight — skip
    this.ticking = true;
    try {
      this.reconcile();
      const due: Array<{ slug: string; scheduler: AgentHeartbeatScheduler }> = [];
      for (const [slug, scheduler] of this.schedulers) {
        if (scheduler.isDue(now)) due.push({ slug, scheduler });
      }
      if (due.length === 0) return;
      await Promise.all(
        due.map(async ({ slug, scheduler }) => {
          try {
            await scheduler.tick(now);
          } catch (err) {
            logger.warn({ err, slug }, 'Agent heartbeat tick failed — continuing');
          }
        }),
      );
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
