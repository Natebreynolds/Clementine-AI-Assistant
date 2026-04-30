import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import matter from 'gray-matter';
import { SelfImproveLoop, classifyFailure } from '../src/agent/self-improve-loop.js';

describe('classifyFailure', () => {
  it('recognizes max-turns as safe-cron-config', () => {
    const r = classifyFailure(['Reached maximum number of turns (8)']);
    expect(r.category).toBe('safe-cron-config');
    expect(r.apply).toBeDefined();
  });

  it('recognizes autocompact thrashing as safe-cron-config', () => {
    const r = classifyFailure(['Autocompact is thrashing: the context refilled to the limit']);
    expect(r.category).toBe('safe-cron-config');
  });

  it('recognizes the old taskBudget rejection as no-op (already fixed in code)', () => {
    const r = classifyFailure(['This model does not support user-configurable task budgets']);
    expect(r.category).toBe('noop');
    expect(r.apply).toBeUndefined();
  });

  it('returns unknown for unrecognized errors', () => {
    const r = classifyFailure(['Something exotic broke unexpectedly']);
    expect(r.category).toBe('unknown');
  });

  it('safely handles empty error list', () => {
    const r = classifyFailure([]);
    expect(r.category).toBe('unknown');
  });
});

describe('classifyFailure recipe.apply (cron mutation)', () => {
  it('switches a non-unleashed job to unleashed mode + sets max_hours', () => {
    const r = classifyFailure(['Reached maximum number of turns (8)']);
    const job: Record<string, unknown> = { name: 'x', schedule: '* * * * *', tier: 2 };
    const changed = r.apply!(job);
    expect(changed).toBe(true);
    expect(job.mode).toBe('unleashed');
    expect(job.max_hours).toBe(1);
  });

  it('is idempotent — already-unleashed-with-max_hours is a no-op', () => {
    const r = classifyFailure(['Reached maximum number of turns (8)']);
    const job: Record<string, unknown> = { name: 'x', mode: 'unleashed', max_hours: 2 };
    const changed = r.apply!(job);
    expect(changed).toBe(false);
    expect(job.mode).toBe('unleashed');
    expect(job.max_hours).toBe(2); // not overwritten
  });

  it('upgrades insufficient max_hours when adding unleashed', () => {
    const r = classifyFailure(['Autocompact is thrashing']);
    const job: Record<string, unknown> = { name: 'x' };
    const changed = r.apply!(job);
    expect(changed).toBe(true);
    expect(job.max_hours).toBe(1);
  });
});

describe('SelfImproveLoop.tick — end-to-end', () => {
  let baseDir: string;
  let triggersDir: string;
  let pendingDir: string;
  let cronPath: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-sil-'));
    triggersDir = path.join(baseDir, 'triggers');
    pendingDir = path.join(baseDir, 'pending');
    cronPath = path.join(baseDir, 'CRON.md');
    mkdirSync(triggersDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function writeCronFile(jobs: Array<Record<string, unknown>>): void {
    const data = { jobs };
    const content = matter.stringify('# Cron Jobs\n', data);
    writeFileSync(cronPath, content);
  }

  function writeTrigger(jobName: string, errors: string[], consErrors = 5): void {
    writeFileSync(
      path.join(triggersDir, `${jobName}.json`),
      JSON.stringify({
        jobName,
        consecutiveErrors: consErrors,
        recentErrors: errors,
        triggeredAt: new Date().toISOString(),
      }),
    );
  }

  it('auto-applies the unleashed fix and DMs the owning agent', async () => {
    writeCronFile([
      { name: 'market-leader-followup', schedule: '30 8 * * *', tier: 2, agentSlug: 'ross-the-sdr' },
    ]);
    writeTrigger('market-leader-followup', ['Reached maximum number of turns (8)']);

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    const result = await loop.tick();

    expect(result.processed).toBe(1);
    expect(result.applied).toBe(1);

    // CRON.md was updated
    const updated = matter(readFileSync(cronPath, 'utf-8'));
    const job = (updated.data.jobs as Array<Record<string, unknown>>)[0];
    expect(job.mode).toBe('unleashed');
    expect(job.max_hours).toBe(1);

    // Trigger was removed
    expect(existsSync(path.join(triggersDir, 'market-leader-followup.json'))).toBe(false);

    // Agent was DM'd via their bot
    expect(send).toHaveBeenCalledTimes(1);
    const [text, ctx] = send.mock.calls[0];
    expect(ctx?.agentSlug).toBe('ross-the-sdr');
    expect(text).toMatch(/Auto-fixed/);
    expect(text).toMatch(/market-leader-followup/);
  });

  it('treats clementine-owned jobs as un-scoped (Clementine main bot)', async () => {
    writeCronFile([
      { name: 'morning-briefing', schedule: '0 8 * * *', tier: 1 }, // no agentSlug
    ]);
    writeTrigger('morning-briefing', ['Reached maximum number of turns (8)']);

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    await loop.tick();

    const [, ctx] = send.mock.calls[0];
    expect(ctx?.agentSlug).toBeUndefined();
  });

  it('idempotent: trigger is removed even when fix already applied', async () => {
    writeCronFile([
      { name: 'x', schedule: '* * * * *', mode: 'unleashed', max_hours: 2 }, // already unleashed
    ]);
    writeTrigger('x', ['Reached maximum number of turns (8)']);

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    const result = await loop.tick();

    expect(result.processed).toBe(1);
    expect(result.applied).toBe(0); // no apply because already in place
    expect(result.noop).toBe(1);
    expect(existsSync(path.join(triggersDir, 'x.json'))).toBe(false);
    expect(send).not.toHaveBeenCalled(); // no DM for no-op
  });

  it('treats taskBudget rejection as no-op (already fixed in code v1.0.90)', async () => {
    writeCronFile([{ name: 'y', schedule: '* * * * *' }]);
    writeTrigger('y', ['This model does not support user-configurable task budgets']);

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    const result = await loop.tick();

    expect(result.noop).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(path.join(triggersDir, 'y.json'))).toBe(false);
  });

  it('writes a pending-change record + DMs agent for unknown patterns', async () => {
    writeCronFile([
      { name: 'z', schedule: '* * * * *', agentSlug: 'sasha-the-cmo' },
    ]);
    writeTrigger('z', ['Some weird error nobody has classified yet']);

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    const result = await loop.tick();

    expect(result.pending).toBe(1);
    expect(existsSync(pendingDir)).toBe(true);
    const proposals = readdirSync(pendingDir);
    expect(proposals.length).toBe(1);
    const proposal = JSON.parse(readFileSync(path.join(pendingDir, proposals[0]), 'utf-8'));
    expect(proposal.jobName).toBe('z');
    expect(proposal.agentSlug).toBe('sasha-the-cmo');
    expect(proposal.category).toBe('unknown');

    // Trigger removed
    expect(existsSync(path.join(triggersDir, 'z.json'))).toBe(false);

    // Agent DM'd
    expect(send).toHaveBeenCalledTimes(1);
    const [, ctx] = send.mock.calls[0];
    expect(ctx?.agentSlug).toBe('sasha-the-cmo');
  });

  it('handles malformed trigger JSON by removing it without crashing', async () => {
    writeFileSync(path.join(triggersDir, 'bad.json'), 'not json');
    writeCronFile([]);
    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    const result = await loop.tick();
    expect(result.processed).toBe(0); // counted as failed parse, not "successfully processed"
    expect(existsSync(path.join(triggersDir, 'bad.json'))).toBe(false);
  });

  it('event-driven: fires tick within debounce window when a trigger lands', async () => {
    writeCronFile([
      { name: 'event-test', schedule: '* * * * *', agentSlug: 'ross-the-sdr' },
    ]);
    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    // Use a large fallback tickMs so only the watch path can produce results
    const loop = new SelfImproveLoop({ send }, {
      triggersDir, pendingDir, cronPath,
      tickMs: 999_999_999,
    });
    loop.start();
    try {
      // Wait for the initial-on-start tick (boots empty)
      await new Promise((r) => setTimeout(r, 100));
      expect(send).not.toHaveBeenCalled();

      // Drop a trigger — fs.watch should fire, debounce ~2s, then tick
      writeTrigger('event-test', ['Reached maximum number of turns (8)']);

      // 2.5s = enough for debounce + tick
      await new Promise((r) => setTimeout(r, 2500));

      expect(send).toHaveBeenCalled();
      const [text, ctx] = send.mock.calls[0];
      expect(ctx?.agentSlug).toBe('ross-the-sdr');
      expect(text).toMatch(/Auto-fixed/);
    } finally {
      loop.stop();
    }
  });

  it('auto-fixes a job defined in agents/{slug}/CRON.md when trigger names slug+bareName', async () => {
    // Simulate cron-scheduler's view: central CRON.md has no per-agent jobs;
    // agent-scoped CRON.md does. Trigger carries agentSlug + bareName.
    writeCronFile([]); // empty central
    const agentsDir = path.join(baseDir, 'agents');
    mkdirSync(path.join(agentsDir, 'ross-the-sdr'), { recursive: true });
    const agentCronPath = path.join(agentsDir, 'ross-the-sdr', 'CRON.md');
    writeFileSync(
      agentCronPath,
      matter.stringify('# Ross crons\n', {
        jobs: [{ name: 'tradeshow-outreach-am', schedule: '0 9 * * *', tier: 1 }],
      }),
    );
    writeFileSync(
      path.join(triggersDir, 'ross-the-sdr_tradeshow-outreach-am.json'),
      JSON.stringify({
        jobName: 'ross-the-sdr:tradeshow-outreach-am',
        bareName: 'tradeshow-outreach-am',
        agentSlug: 'ross-the-sdr',
        consecutiveErrors: 5,
        recentErrors: ['Reached maximum number of turns (8)'],
        triggeredAt: new Date().toISOString(),
      }),
    );

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, agentsDir, disableWatch: true });
    const result = await loop.tick();

    expect(result.applied).toBe(1);
    // Edit landed in agent-scoped file, not central
    const updatedAgent = matter(readFileSync(agentCronPath, 'utf-8'));
    const job = (updatedAgent.data.jobs as Array<Record<string, unknown>>)[0];
    expect(job.mode).toBe('unleashed');
    expect(job.max_hours).toBe(1);
    // Central CRON.md untouched
    const centralJobs = (matter(readFileSync(cronPath, 'utf-8')).data.jobs ?? []) as Array<unknown>;
    expect(centralJobs.length).toBe(0);
    // DM routed to the agent
    const [text, ctx] = send.mock.calls[0];
    expect(ctx?.agentSlug).toBe('ross-the-sdr');
    expect(text).toMatch(/agents\/ross-the-sdr\/CRON\.md/);
  });

  it('recovers agent slug from prefixed jobName when older trigger lacks agentSlug field', async () => {
    writeCronFile([]);
    const agentsDir = path.join(baseDir, 'agents');
    mkdirSync(path.join(agentsDir, 'sasha-the-cmo'), { recursive: true });
    const agentCronPath = path.join(agentsDir, 'sasha-the-cmo', 'CRON.md');
    writeFileSync(
      agentCronPath,
      matter.stringify('', { jobs: [{ name: 'weekly-content', schedule: '0 9 * * 1' }] }),
    );
    // Old-format trigger: no agentSlug, no bareName, but jobName is prefixed.
    writeFileSync(
      path.join(triggersDir, 'sasha-the-cmo_weekly-content.json'),
      JSON.stringify({
        jobName: 'sasha-the-cmo:weekly-content',
        consecutiveErrors: 4,
        recentErrors: ['Autocompact is thrashing'],
        triggeredAt: new Date().toISOString(),
      }),
    );

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, agentsDir, disableWatch: true });
    const result = await loop.tick();

    expect(result.applied).toBe(1);
    const updated = matter(readFileSync(agentCronPath, 'utf-8'));
    expect((updated.data.jobs as Array<Record<string, unknown>>)[0].mode).toBe('unleashed');
    const [, ctx] = send.mock.calls[0];
    expect(ctx?.agentSlug).toBe('sasha-the-cmo');
  });

  it('escalates as no-op when trigger names a job that no longer exists anywhere', async () => {
    writeCronFile([]);
    const agentsDir = path.join(baseDir, 'agents');
    writeFileSync(
      path.join(triggersDir, 'ghost.json'),
      JSON.stringify({
        jobName: 'ross-the-sdr:deleted-job',
        bareName: 'deleted-job',
        agentSlug: 'ross-the-sdr',
        consecutiveErrors: 3,
        recentErrors: ['Reached maximum number of turns (8)'],
        triggeredAt: new Date().toISOString(),
      }),
    );

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, agentsDir, disableWatch: true });
    const result = await loop.tick();

    expect(result.applied).toBe(0);
    expect(result.noop).toBe(1);
    expect(send).not.toHaveBeenCalled();
    // Trigger still cleared so we don't loop on it
    expect(existsSync(path.join(triggersDir, 'ghost.json'))).toBe(false);
  });

  it('processes multiple triggers in one tick', async () => {
    writeCronFile([
      { name: 'a', agentSlug: 'ross-the-sdr' },
      { name: 'b', agentSlug: 'sasha-the-cmo' },
    ]);
    writeTrigger('a', ['Reached maximum number of turns (8)']);
    writeTrigger('b', ['Autocompact is thrashing']);

    const send = vi.fn(async () => ({ delivered: true, channelErrors: {} }));
    const loop = new SelfImproveLoop({ send }, { triggersDir, pendingDir, cronPath, disableWatch: true });
    const result = await loop.tick();

    expect(result.processed).toBe(2);
    expect(result.applied).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
