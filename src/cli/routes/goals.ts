/**
 * Goals API routes — extracted from dashboard.ts
 */
import { Router } from 'express';
import express from 'express';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Gateway } from '../../gateway/router.js';

export interface GoalsRouterDeps {
  goalsDir: string;
  cronRunsDir: string;
  vaultDir: string;
  cronFile: string;
  getGateway: () => Promise<Gateway>;
}

export function goalsRouter(deps: GoalsRouterDeps): Router {
  const router = Router();
  const { goalsDir, cronRunsDir, vaultDir, cronFile, getGateway } = deps;

  // List goals with contributions + delegations
  router.get('/progress', (_req, res) => {
    if (!existsSync(goalsDir)) { res.json({ goals: [] }); return; }
    try {
      const files = readdirSync(goalsDir).filter(f => f.endsWith('.json'));
      const goals = files.map(f => {
        try {
          const goal = JSON.parse(readFileSync(path.join(goalsDir, f), 'utf-8'));
          const agentContributions: Record<string, { runs: number; successes: number; lastRun?: string }> = {};
          if (goal.linkedCronJobs?.length && existsSync(cronRunsDir)) {
            for (const jobName of goal.linkedCronJobs) {
              const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
              const logFile = path.join(cronRunsDir, `${safe}.jsonl`);
              if (!existsSync(logFile)) continue;
              const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
              for (const line of lines.slice(-20)) {
                try {
                  const entry = JSON.parse(line);
                  const agent = entry.agentSlug || jobName;
                  if (!agentContributions[agent]) agentContributions[agent] = { runs: 0, successes: 0 };
                  agentContributions[agent].runs++;
                  if (entry.status === 'ok') agentContributions[agent].successes++;
                  agentContributions[agent].lastRun = entry.finishedAt;
                } catch { continue; }
              }
            }
          }
          const delegationsDir = path.join(vaultDir, '00-System', 'agents');
          const delegations: Array<{ agent: string; task: string; status: string }> = [];
          if (existsSync(delegationsDir)) {
            try {
              for (const agentDir of readdirSync(delegationsDir)) {
                const tasksDir = path.join(delegationsDir, agentDir, 'delegations');
                if (!existsSync(tasksDir)) continue;
                for (const tf of readdirSync(tasksDir).filter(tf => tf.endsWith('.json'))) {
                  try {
                    const task = JSON.parse(readFileSync(path.join(tasksDir, tf), 'utf-8'));
                    if (task.goalId === goal.id) {
                      delegations.push({ agent: task.toAgent || agentDir, task: task.task || tf, status: task.status || 'pending' });
                    }
                  } catch { continue; }
                }
              }
            } catch { /* ignore */ }
          }
          return { ...goal, agentContributions, delegations };
        } catch { return null; }
      }).filter(Boolean);
      res.json({ goals });
    } catch { res.json({ goals: [] }); }
  });

  // Create goal
  router.post('/', express.json(), (req, res) => {
    try {
      if (!existsSync(goalsDir)) mkdirSync(goalsDir, { recursive: true });
      const id = Math.random().toString(16).slice(2, 10);
      const { title, description, owner, priority, status, targetDate, linkedCronJobs, nextActions, blockers, reviewFrequency } = req.body;
      if (!title) { res.status(400).json({ ok: false, error: 'Title is required' }); return; }
      const goal = {
        id, title, description: description || '', status: status || 'active',
        owner: owner || 'clementine', priority: priority || 'medium',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        progressNotes: [], nextActions: nextActions || [], blockers: blockers || [],
        reviewFrequency: reviewFrequency || 'weekly', linkedCronJobs: linkedCronJobs || [],
        targetDate: targetDate || undefined,
      };
      writeFileSync(path.join(goalsDir, `${id}.json`), JSON.stringify(goal, null, 2));
      res.json({ ok: true, goal });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Update goal
  router.put('/:id', express.json(), (req, res) => {
    try {
      const goalPath = path.join(goalsDir, `${req.params.id}.json`);
      if (!existsSync(goalPath)) { res.status(404).json({ ok: false, error: 'Goal not found' }); return; }
      const existing = JSON.parse(readFileSync(goalPath, 'utf-8'));
      const { title, description, owner, priority, status, targetDate, linkedCronJobs, nextActions, blockers, reviewFrequency } = req.body;
      if (title !== undefined) existing.title = title;
      if (description !== undefined) existing.description = description;
      if (owner !== undefined) existing.owner = owner;
      if (priority !== undefined) existing.priority = priority;
      if (status !== undefined) existing.status = status;
      if (targetDate !== undefined) existing.targetDate = targetDate;
      if (linkedCronJobs !== undefined) existing.linkedCronJobs = linkedCronJobs;
      if (nextActions !== undefined) existing.nextActions = nextActions;
      if (blockers !== undefined) existing.blockers = blockers;
      if (reviewFrequency !== undefined) existing.reviewFrequency = reviewFrequency;
      existing.updatedAt = new Date().toISOString();
      writeFileSync(goalPath, JSON.stringify(existing, null, 2));
      res.json({ ok: true, goal: existing });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Delete goal
  router.delete('/:id', (_req, res) => {
    try {
      const goalPath = path.join(goalsDir, `${_req.params.id}.json`);
      if (!existsSync(goalPath)) { res.status(404).json({ ok: false, error: 'Goal not found' }); return; }
      unlinkSync(goalPath);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Generate cron proposals from goal
  router.post('/:id/generate-crons', async (req, res) => {
    try {
      const goalPath = path.join(goalsDir, `${req.params.id}.json`);
      if (!existsSync(goalPath)) { res.status(404).json({ ok: false, error: 'Goal not found' }); return; }
      const goal = JSON.parse(readFileSync(goalPath, 'utf-8'));
      const prompt = `You are analyzing a goal and proposing automated scheduled tasks (cron jobs) to make progress on it.

## Goal: ${goal.title}
${goal.description || ''}

## Current Status: ${goal.status || 'active'}
## Priority: ${goal.priority || 'medium'}
## Owner: ${goal.owner || 'clementine'}
${goal.nextActions?.length ? `## Next Actions:\n${goal.nextActions.map((a: string) => `- ${a}`).join('\n')}` : ''}
${goal.blockers?.length ? `## Blockers:\n${goal.blockers.map((b: string) => `- ${b}`).join('\n')}` : ''}
${goal.linkedCronJobs?.length ? `## Already Linked Cron Jobs:\n${goal.linkedCronJobs.map((j: string) => `- ${j}`).join('\n')}` : ''}

## Instructions
Propose 1-3 NEW cron jobs that would make automated progress on this goal. For each job, provide:
- name: A short slug (lowercase, hyphens, no spaces)
- schedule: A cron expression (e.g., "0 9 * * 1-5" for weekdays 9am)
- prompt: The detailed task prompt the agent should execute when this job runs
- tier: 1 (quick, under 10 min) or 2 (thorough, can take longer)
- rationale: Why this job helps the goal

Respond ONLY with valid JSON:
{"proposals":[{"name":"...","schedule":"...","prompt":"...","tier":1,"rationale":"..."}]}`;

      const gw = await getGateway();
      const response = await gw.handleMessage('dashboard:cron-gen', prompt);
      let proposals: unknown[] = [];
      try {
        const jsonMatch = response.match(/\{[\s\S]*"proposals"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          proposals = parsed.proposals || [];
        }
      } catch {
        res.json({ ok: false, error: 'Could not parse LLM response', raw: response.slice(0, 1000) });
        return;
      }
      res.json({ ok: true, proposals, goalId: goal.id, goalTitle: goal.title });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Approve cron proposals
  router.post('/:id/approve-crons', express.json(), (req, res) => {
    try {
      const goalPath = path.join(goalsDir, `${req.params.id}.json`);
      if (!existsSync(goalPath)) { res.status(404).json({ ok: false, error: 'Goal not found' }); return; }
      const goal = JSON.parse(readFileSync(goalPath, 'utf-8'));
      const crons: Array<{ name: string; schedule: string; prompt: string; tier: number }> = req.body.crons || [];
      if (crons.length === 0) { res.status(400).json({ ok: false, error: 'No crons to approve' }); return; }

      const cronRaw = existsSync(cronFile) ? readFileSync(cronFile, 'utf-8') : '---\njobs: []\n---\n';
      const parsed = matter(cronRaw);
      const jobs: Array<Record<string, unknown>> = parsed.data.jobs || [];
      const existingNames = new Set(jobs.map(j => j.name));
      const added: string[] = [];
      for (const c of crons) {
        if (existingNames.has(c.name)) continue;
        jobs.push({ name: c.name, schedule: c.schedule, prompt: c.prompt, enabled: true, tier: c.tier || 1 });
        added.push(c.name);
      }
      if (added.length > 0) {
        parsed.data.jobs = jobs;
        writeFileSync(cronFile, matter.stringify(parsed.content, parsed.data));
        if (!goal.linkedCronJobs) goal.linkedCronJobs = [];
        for (const name of added) {
          if (!goal.linkedCronJobs.includes(name)) goal.linkedCronJobs.push(name);
        }
        goal.updatedAt = new Date().toISOString();
        writeFileSync(goalPath, JSON.stringify(goal, null, 2));
      }
      res.json({ ok: true, added, skipped: crons.length - added.length });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  return router;
}
