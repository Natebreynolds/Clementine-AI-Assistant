import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), 'clem-test-goals-' + Date.now());
const GOALS_DIR = path.join(TEST_DIR, 'goals');

beforeEach(() => {
  mkdirSync(GOALS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Goal CRUD', () => {
  it('creates a goal JSON file with required fields', () => {
    const id = 'test001';
    const goal = {
      id,
      title: 'Test Goal',
      description: 'A test goal',
      status: 'active',
      owner: 'clementine',
      priority: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progressNotes: [],
      nextActions: ['Do something'],
      blockers: [],
      reviewFrequency: 'weekly',
      linkedCronJobs: [],
    };
    writeFileSync(path.join(GOALS_DIR, `${id}.json`), JSON.stringify(goal, null, 2));

    expect(existsSync(path.join(GOALS_DIR, `${id}.json`))).toBe(true);
    const loaded = JSON.parse(readFileSync(path.join(GOALS_DIR, `${id}.json`), 'utf-8'));
    expect(loaded.title).toBe('Test Goal');
    expect(loaded.priority).toBe('high');
    expect(loaded.nextActions).toEqual(['Do something']);
  });

  it('updates goal fields without losing existing data', () => {
    const id = 'test002';
    const original = {
      id,
      title: 'Original',
      description: 'Desc',
      status: 'active',
      owner: 'clementine',
      priority: 'medium',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      progressNotes: ['Note 1'],
      nextActions: [],
      blockers: [],
      reviewFrequency: 'weekly',
      linkedCronJobs: ['job-a'],
    };
    const goalPath = path.join(GOALS_DIR, `${id}.json`);
    writeFileSync(goalPath, JSON.stringify(original, null, 2));

    // Simulate update
    const existing = JSON.parse(readFileSync(goalPath, 'utf-8'));
    existing.title = 'Updated Title';
    existing.priority = 'high';
    existing.updatedAt = new Date().toISOString();
    writeFileSync(goalPath, JSON.stringify(existing, null, 2));

    const loaded = JSON.parse(readFileSync(goalPath, 'utf-8'));
    expect(loaded.title).toBe('Updated Title');
    expect(loaded.priority).toBe('high');
    expect(loaded.progressNotes).toEqual(['Note 1']);
    expect(loaded.linkedCronJobs).toEqual(['job-a']);
    expect(loaded.description).toBe('Desc');
  });

  it('deletes a goal file', () => {
    const id = 'test003';
    const goalPath = path.join(GOALS_DIR, `${id}.json`);
    writeFileSync(goalPath, JSON.stringify({ id, title: 'Delete me' }));

    expect(existsSync(goalPath)).toBe(true);
    rmSync(goalPath);
    expect(existsSync(goalPath)).toBe(false);
  });
});

describe('Goal cron approval', () => {
  it('appends approved crons to CRON.md and updates linkedCronJobs', () => {
    const matter = require('gray-matter');
    const cronFile = path.join(TEST_DIR, 'CRON.md');
    writeFileSync(cronFile, '---\njobs:\n  - name: existing-job\n    schedule: "0 9 * * *"\n    prompt: do stuff\n    enabled: true\n    tier: 1\n---\n');

    const goalFile = path.join(GOALS_DIR, 'g1.json');
    writeFileSync(goalFile, JSON.stringify({
      id: 'g1', title: 'Test', linkedCronJobs: ['existing-job'],
    }, null, 2));

    // Simulate approval
    const cronRaw = readFileSync(cronFile, 'utf-8');
    const parsed = matter(cronRaw);
    const jobs = parsed.data.jobs || [];
    const existingNames = new Set(jobs.map((j: any) => j.name));

    const proposals = [
      { name: 'new-job', schedule: '0 10 * * 1-5', prompt: 'new task', tier: 1 },
      { name: 'existing-job', schedule: '0 9 * * *', prompt: 'dupe', tier: 1 },
    ];

    const added: string[] = [];
    for (const c of proposals) {
      if (existingNames.has(c.name)) continue;
      jobs.push({ name: c.name, schedule: c.schedule, prompt: c.prompt, enabled: true, tier: c.tier });
      added.push(c.name);
    }
    parsed.data.jobs = jobs;
    writeFileSync(cronFile, matter.stringify(parsed.content, parsed.data));

    const goal = JSON.parse(readFileSync(goalFile, 'utf-8'));
    for (const name of added) {
      if (!goal.linkedCronJobs.includes(name)) goal.linkedCronJobs.push(name);
    }
    writeFileSync(goalFile, JSON.stringify(goal, null, 2));

    // Verify
    expect(added).toEqual(['new-job']);
    const updatedCron = matter(readFileSync(cronFile, 'utf-8'));
    expect(updatedCron.data.jobs.length).toBe(2);
    expect(updatedCron.data.jobs[1].name).toBe('new-job');

    const updatedGoal = JSON.parse(readFileSync(goalFile, 'utf-8'));
    expect(updatedGoal.linkedCronJobs).toEqual(['existing-job', 'new-job']);
  });
});
