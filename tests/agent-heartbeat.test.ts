import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHeartbeatScheduler } from '../src/gateway/agent-heartbeat-scheduler.js';
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
});
