import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentHeartbeatScheduler,
  computeNextInterval,
  type AgentHeartbeatGateway,
} from '../src/gateway/agent-heartbeat-scheduler.js';
import type { AgentManager } from '../src/agent/agent-manager.js';
import type { AgentHeartbeatState, AgentProfile } from '../src/types.js';

function makeAgentManager(overrides: Partial<{ runnable: boolean; profile: AgentProfile | null }> = {}): AgentManager {
  const profile: AgentProfile = {
    slug: 'test-agent',
    name: 'Test Agent',
    tier: 1,
    description: 'fixture',
    systemPromptBody: '',
    status: 'active',
  };
  return {
    get: () => overrides.profile === undefined ? profile : overrides.profile,
    isRunnable: () => overrides.runnable ?? true,
    listAll: () => overrides.profile === null ? [] : [profile],
  } as unknown as AgentManager;
}

describe('AgentHeartbeatScheduler (cheap path)', () => {
  let baseDir: string;
  let agentsDir: string;
  const slug = 'test-agent';

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-ahb-'));
    agentsDir = path.join(baseDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes state on the first tick and reports the agent as not-yet-due thereafter', async () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager(), { baseDir, agentsDir });
    const before = new Date('2026-04-25T10:00:00Z');

    expect(sched.isDue(before)).toBe(true); // fresh state defaults to due

    const state = await sched.tick(before);

    expect(state.lastTickAt).toBe(before.toISOString());
    expect(new Date(state.nextCheckAt).getTime()).toBeGreaterThan(before.getTime());
    expect(state.silentTickCount).toBe(0); // first tick = "change" from empty fingerprint
    expect(sched.isDue(before)).toBe(false); // immediately after, not due

    const persisted = JSON.parse(readFileSync(path.join(baseDir, 'heartbeat', 'agents', slug, 'state.json'), 'utf-8')) as AgentHeartbeatState;
    expect(persisted.fingerprint).toBe(state.fingerprint);
  });

  it('increments silentTickCount when nothing has changed between ticks', async () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager(), { baseDir, agentsDir });
    const t1 = new Date('2026-04-25T10:00:00Z');
    const t2 = new Date('2026-04-25T11:00:00Z');

    await sched.tick(t1);
    const second = await sched.tick(t2);

    expect(second.silentTickCount).toBe(1);
  });

  it('detects a pending delegated task as a signal change', async () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager(), { baseDir, agentsDir });
    const t1 = new Date('2026-04-25T10:00:00Z');
    const t2 = new Date('2026-04-25T11:00:00Z');

    await sched.tick(t1);

    // Drop a pending task into the agent's tasks dir
    const tasksDir = path.join(agentsDir, slug, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      path.join(tasksDir, 'task-1.json'),
      JSON.stringify({ id: 'task-1', status: 'pending', task: 'demo', fromAgent: 'clementine', expectedOutput: 'demo' }),
    );

    const after = await sched.tick(t2);
    expect(after.silentTickCount).toBe(0);
    expect(after.lastSignalSummary).toMatch(/pendingTasks/);
  });

  it('ignores non-pending tasks (only pending counts as a signal)', async () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager(), { baseDir, agentsDir });
    const t1 = new Date('2026-04-25T10:00:00Z');
    const t2 = new Date('2026-04-25T11:00:00Z');

    const tasksDir = path.join(agentsDir, slug, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      path.join(tasksDir, 'task-done.json'),
      JSON.stringify({ id: 'task-done', status: 'completed', task: 'old work' }),
    );

    await sched.tick(t1);
    const second = await sched.tick(t2);
    expect(second.silentTickCount).toBe(1); // completed task is not a fresh signal
  });

  it('skips tick gracefully when the agent is not runnable (paused/error)', async () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager({ runnable: false }), { baseDir, agentsDir });
    const t1 = new Date('2026-04-25T10:00:00Z');
    const state = await sched.tick(t1);
    expect(state.lastTickAt).toBe(t1.toISOString());
    // Fingerprint should remain unset since we didn't scan
    expect(state.fingerprint).toBe('');
  });

  it('honors setNextCheckIn within the [5min, 12h] bounds', () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager(), { baseDir, agentsDir });
    const now = new Date('2026-04-25T10:00:00Z');

    sched.setNextCheckIn(1, now); // below MIN_INTERVAL_MIN — should clamp to 5
    let state = sched.loadState();
    expect(new Date(state.nextCheckAt).getTime() - now.getTime()).toBe(5 * 60_000);

    sched.setNextCheckIn(99 * 60, now); // above MAX_INTERVAL_MIN — should clamp to 12h
    state = sched.loadState();
    expect(new Date(state.nextCheckAt).getTime() - now.getTime()).toBe(12 * 60 * 60_000);
  });

  it('markDue() bypasses the MIN clamp and makes isDue() true immediately', async () => {
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManager(), { baseDir, agentsDir });
    // Establish a non-due baseline by ticking once (sets nextCheckAt = now + 30min)
    const t1 = new Date('2026-04-25T10:00:00Z');
    await sched.tick(t1);
    expect(sched.isDue(t1)).toBe(false);

    sched.markDue(t1);
    expect(sched.isDue(t1)).toBe(true);

    const state = sched.loadState();
    // nextCheckAt should be exactly t1 (or earlier), NOT clamped to t1+5min
    expect(new Date(state.nextCheckAt).getTime()).toBeLessThanOrEqual(t1.getTime());
  });
});

describe('computeNextInterval (adaptive cadence)', () => {
  it('acted ticks return the active-mode interval (10 min)', () => {
    expect(computeNextInterval({ kind: 'acted', silentStreak: 0, isActiveHours: true })).toBe(10);
  });

  it('quiet ticks return the quiet interval (60 min)', () => {
    expect(computeNextInterval({ kind: 'quiet', silentStreak: 0, isActiveHours: true })).toBe(60);
  });

  it('silent ticks back off exponentially', () => {
    expect(computeNextInterval({ kind: 'silent', silentStreak: 1, isActiveHours: true })).toBe(30);
    expect(computeNextInterval({ kind: 'silent', silentStreak: 2, isActiveHours: true })).toBe(60);
    expect(computeNextInterval({ kind: 'silent', silentStreak: 3, isActiveHours: true })).toBe(120);
    expect(computeNextInterval({ kind: 'silent', silentStreak: 4, isActiveHours: true })).toBe(240);
    expect(computeNextInterval({ kind: 'silent', silentStreak: 5, isActiveHours: true })).toBe(480);
    // Caps at the last entry (720), not unbounded
    expect(computeNextInterval({ kind: 'silent', silentStreak: 100, isActiveHours: true })).toBe(720);
  });

  it('off-hours multiplies the interval by 4 (capped at MAX 12h = 720)', () => {
    // acted: 10 * 4 = 40
    expect(computeNextInterval({ kind: 'acted', silentStreak: 0, isActiveHours: false })).toBe(40);
    // quiet: 60 * 4 = 240
    expect(computeNextInterval({ kind: 'quiet', silentStreak: 0, isActiveHours: false })).toBe(240);
    // silent[3] = 120 * 4 = 480
    expect(computeNextInterval({ kind: 'silent', silentStreak: 3, isActiveHours: false })).toBe(480);
    // silent[5] = 480 * 4 = 1920, capped at 720
    expect(computeNextInterval({ kind: 'silent', silentStreak: 5, isActiveHours: false })).toBe(720);
  });

  it('override always wins (still clamped to [5, 720])', () => {
    expect(computeNextInterval({ kind: 'override', silentStreak: 0, isActiveHours: true, overrideMin: 15 })).toBe(15);
    // Below MIN clamps up to 5
    expect(computeNextInterval({ kind: 'override', silentStreak: 0, isActiveHours: true, overrideMin: 1 })).toBe(5);
    // Above MAX clamps down to 720
    expect(computeNextInterval({ kind: 'override', silentStreak: 0, isActiveHours: true, overrideMin: 9999 })).toBe(720);
    // Even off-hours: override doesn't get the 4x multiplier
    expect(computeNextInterval({ kind: 'override', silentStreak: 0, isActiveHours: false, overrideMin: 30 })).toBe(30);
  });
});

describe('AgentHeartbeatScheduler.parseLlmTickOutput', () => {
  it('extracts NEXT_CHECK directive in minutes', () => {
    expect(AgentHeartbeatScheduler.parseLlmTickOutput('All quiet. [NEXT_CHECK: 60m]')).toEqual({
      nextCheckMinutes: 60,
      summary: 'All quiet.',
    });
  });

  it('returns undefined when directive is absent', () => {
    const out = AgentHeartbeatScheduler.parseLlmTickOutput('Nothing to do here.');
    expect(out.nextCheckMinutes).toBeUndefined();
    expect(out.summary).toBe('Nothing to do here.');
  });

  it('strips the directive from the summary even when malformed', () => {
    const out = AgentHeartbeatScheduler.parseLlmTickOutput('Did the thing. [NEXT_CHECK: 15] more notes');
    expect(out.nextCheckMinutes).toBe(15);
    expect(out.summary).toBe('Did the thing.  more notes');
  });
});

describe('AgentHeartbeatScheduler (LLM tick path)', () => {
  let baseDir: string;
  let agentsDir: string;
  const slug = 'test-agent';

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-ahb-llm-'));
    agentsDir = path.join(baseDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function makeAgentManagerLocal(): AgentManager {
    const profile: AgentProfile = {
      slug: 'test-agent',
      name: 'Test Agent',
      tier: 1,
      description: 'fixture',
      systemPromptBody: '',
      status: 'active',
    };
    return {
      get: () => profile,
      isRunnable: () => true,
      listAll: () => [profile],
    } as unknown as AgentManager;
  }

  it('does NOT call the LLM on the very first tick (empty prior fingerprint)', async () => {
    const handleCronJob = vi.fn(async () => 'ok [NEXT_CHECK: 60m]');
    const gateway: AgentHeartbeatGateway = { handleCronJob };
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManagerLocal(), { baseDir, agentsDir, gateway });

    await sched.tick(new Date('2026-04-25T10:00:00Z'));
    expect(handleCronJob).not.toHaveBeenCalled();
  });

  it('calls the LLM when the fingerprint changes after the first tick', async () => {
    const handleCronJob = vi.fn(async () => 'all quiet [NEXT_CHECK: 60m]');
    const gateway: AgentHeartbeatGateway = { handleCronJob };
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManagerLocal(), { baseDir, agentsDir, gateway });

    // First tick — establishes baseline fingerprint, no LLM call
    await sched.tick(new Date('2026-04-25T10:00:00Z'));
    expect(handleCronJob).not.toHaveBeenCalled();

    // Drop a pending task → fingerprint changes
    const tasksDir = path.join(agentsDir, slug, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      path.join(tasksDir, 'task-1.json'),
      JSON.stringify({ id: 'task-1', status: 'pending', task: 'do thing', fromAgent: 'clementine', expectedOutput: 'done' }),
    );

    await sched.tick(new Date('2026-04-25T10:30:00Z'));
    expect(handleCronJob).toHaveBeenCalledTimes(1);
    const [jobName, , , , , , , , , , agentSlug] = handleCronJob.mock.calls[0];
    expect(jobName).toBe(`heartbeat:${slug}`);
    expect(agentSlug).toBe(slug);
  });

  it('honors [NEXT_CHECK: Xm] directive from LLM output to schedule next tick', async () => {
    const handleCronJob = vi.fn(async () => 'busy [NEXT_CHECK: 10m]');
    const gateway: AgentHeartbeatGateway = { handleCronJob };
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManagerLocal(), { baseDir, agentsDir, gateway });

    await sched.tick(new Date('2026-04-25T10:00:00Z'));
    const tasksDir = path.join(agentsDir, slug, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      path.join(tasksDir, 't1.json'),
      JSON.stringify({ id: 't1', status: 'pending', task: 'x', fromAgent: 'c', expectedOutput: 'y' }),
    );
    const now = new Date('2026-04-25T10:30:00Z');
    const after = await sched.tick(now);

    const elapsedMs = new Date(after.nextCheckAt).getTime() - now.getTime();
    expect(elapsedMs).toBe(10 * 60_000);
  });

  it('falls back to quiet cadence when LLM tick throws (active hours)', async () => {
    const handleCronJob = vi.fn(async () => { throw new Error('rate limited'); });
    const gateway: AgentHeartbeatGateway = { handleCronJob };
    const sched = new AgentHeartbeatScheduler(slug, makeAgentManagerLocal(), { baseDir, agentsDir, gateway });

    // Use local-time Dates (no 'Z') so the active-hours check is deterministic
    // regardless of machine timezone — both ticks fire at 3pm local, which is
    // inside the default 08:00–22:00 window.
    await sched.tick(new Date('2026-04-25T15:00:00'));
    const tasksDir = path.join(agentsDir, slug, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      path.join(tasksDir, 't1.json'),
      JSON.stringify({ id: 't1', status: 'pending', task: 'x', fromAgent: 'c', expectedOutput: 'y' }),
    );

    const now = new Date('2026-04-25T15:30:00');
    const after = await sched.tick(now);
    // LLM tick errored but classifier treats it as 'quiet' → 60 min
    expect(new Date(after.nextCheckAt).getTime() - now.getTime()).toBe(60 * 60_000);
    expect(after.lastSignalSummary).toMatch(/llm tick error/);
    expect(after.lastTickKind).toBe('quiet');
  });
});
