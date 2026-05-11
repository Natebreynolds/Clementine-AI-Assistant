import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('background task MCP tools', () => {
  const originalHome = process.env.CLEMENTINE_HOME;
  const originalAgent = process.env.CLEMENTINE_TEAM_AGENT;
  const originalSessionKey = process.env.CLEMENTINE_SESSION_KEY;
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (originalHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = originalHome;
    if (originalAgent === undefined) delete process.env.CLEMENTINE_TEAM_AGENT;
    else process.env.CLEMENTINE_TEAM_AGENT = originalAgent;
    if (originalSessionKey === undefined) delete process.env.CLEMENTINE_SESSION_KEY;
    else process.env.CLEMENTINE_SESSION_KEY = originalSessionKey;
    vi.resetModules();
  });

  it('attaches the active chat session key when the agent queues background work', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-bg-tool-'));
    process.env.CLEMENTINE_HOME = dir;
    process.env.CLEMENTINE_TEAM_AGENT = 'ross-the-sdr';
    process.env.CLEMENTINE_SESSION_KEY = 'discord:user:123';
    vi.resetModules();

    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, _description: string, _schema: unknown, handler: (input: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    };

    const { registerBackgroundTaskTools } = await import('../src/tools/background-task-tools.js');
    const { listBackgroundTasks } = await import('../src/agent/background-tasks.js');
    registerBackgroundTaskTools(server as never);

    await handlers.get('start_background_task')?.({
      prompt: 'Research stale Salesforce contacts and draft outreach.',
      max_minutes: 20,
    });

    const tasks = listBackgroundTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fromAgent).toBe('ross-the-sdr');
    expect(tasks[0].sessionKey).toBe('discord:user:123');
    expect(tasks[0].maxMinutes).toBe(20);
  });
});
