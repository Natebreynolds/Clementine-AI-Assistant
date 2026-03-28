/**
 * Delegation API routes — extracted from dashboard.ts
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
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { DelegatedTask } from '../../types.js';
import type { Gateway } from '../../gateway/router.js';

export interface DelegationsRouterDeps {
  agentsBase: string;
  getGateway: () => Promise<Gateway>;
  broadcastEvent: (event: { type: string; data?: unknown }) => void;
}

export function readAllDelegations(agentsBase: string): (DelegatedTask & { _agentDir: string })[] {
  const all: (DelegatedTask & { _agentDir: string })[] = [];
  if (!existsSync(agentsBase)) return all;
  for (const slug of readdirSync(agentsBase).filter(d => !d.startsWith('_') && statSync(path.join(agentsBase, d)).isDirectory())) {
    const delDir = path.join(agentsBase, slug, 'delegations');
    if (!existsSync(delDir)) continue;
    for (const f of readdirSync(delDir).filter(f => f.endsWith('.json'))) {
      try {
        const task = JSON.parse(readFileSync(path.join(delDir, f), 'utf-8')) as DelegatedTask;
        all.push({ ...task, _agentDir: slug });
      } catch { continue; }
    }
  }
  return all;
}

export function delegationsRouter(deps: DelegationsRouterDeps): Router {
  const router = Router();
  const { agentsBase, getGateway, broadcastEvent } = deps;

  router.get('/', (_req, res) => {
    try {
      let delegations = readAllDelegations(agentsBase);
      const agent = _req.query.agent as string | undefined;
      const status = _req.query.status as string | undefined;
      const goalId = _req.query.goalId as string | undefined;
      if (agent) delegations = delegations.filter(d => d.toAgent === agent || d.fromAgent === agent);
      if (status) delegations = delegations.filter(d => d.status === status);
      if (goalId) delegations = delegations.filter(d => d.goalId === goalId);
      res.json({ ok: true, delegations });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.post('/', express.json(), (req, res) => {
    try {
      const { fromAgent, toAgent, task, expectedOutput, goalId } = req.body;
      if (!toAgent || !task) { res.status(400).json({ ok: false, error: 'toAgent and task are required' }); return; }
      const id = Math.random().toString(16).slice(2, 10);
      const delDir = path.join(agentsBase, toAgent, 'delegations');
      if (!existsSync(delDir)) mkdirSync(delDir, { recursive: true });
      const delegation: DelegatedTask = {
        id, fromAgent: fromAgent || 'clementine', toAgent, task,
        expectedOutput: expectedOutput || '', status: 'pending',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        goalId: goalId || undefined,
      };
      writeFileSync(path.join(delDir, `${id}.json`), JSON.stringify(delegation, null, 2));
      res.json({ ok: true, delegation });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.put('/:id', express.json(), (req, res) => {
    try {
      const all = readAllDelegations(agentsBase);
      const found = all.find(d => d.id === req.params.id);
      if (!found) { res.status(404).json({ ok: false, error: 'Delegation not found' }); return; }
      const filePath = path.join(agentsBase, found._agentDir, 'delegations', `${found.id}.json`);
      const { status, result, task, expectedOutput } = req.body;
      if (status !== undefined) found.status = status;
      if (result !== undefined) found.result = result;
      if (task !== undefined) found.task = task;
      if (expectedOutput !== undefined) found.expectedOutput = expectedOutput;
      found.updatedAt = new Date().toISOString();
      const { _agentDir, ...clean } = found;
      writeFileSync(filePath, JSON.stringify(clean, null, 2));
      res.json({ ok: true, delegation: clean });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.delete('/:id', (_req, res) => {
    try {
      const all = readAllDelegations(agentsBase);
      const found = all.find(d => d.id === _req.params.id);
      if (!found) { res.status(404).json({ ok: false, error: 'Delegation not found' }); return; }
      unlinkSync(path.join(agentsBase, found._agentDir, 'delegations', `${found.id}.json`));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.post('/:id/execute', async (req, res) => {
    try {
      const all = readAllDelegations(agentsBase);
      const found = all.find(d => d.id === req.params.id);
      if (!found) { res.status(404).json({ ok: false, error: 'Delegation not found' }); return; }
      if (found.status === 'in_progress') { res.json({ ok: false, error: 'Already executing' }); return; }

      const filePath = path.join(agentsBase, found._agentDir, 'delegations', `${found.id}.json`);
      const { _agentDir, ...clean } = found;
      clean.status = 'in_progress';
      clean.updatedAt = new Date().toISOString();
      writeFileSync(filePath, JSON.stringify(clean, null, 2));

      res.json({ ok: true, message: 'Delegation execution started' });
      broadcastEvent({ type: 'delegation_started', data: { id: found.id, toAgent: found.toAgent } });

      const prompt = `You have been delegated the following task:\n\n## Task\n${found.task}\n\n## Expected Output\n${found.expectedOutput || 'Complete the task to the best of your ability.'}\n\nComplete this task now.`;
      getGateway().then(gw =>
        gw.handleCronJob(`delegation:${found.id}`, prompt, 2, 15)
      ).then(result => {
        clean.status = 'completed';
        clean.result = result;
        clean.updatedAt = new Date().toISOString();
        writeFileSync(filePath, JSON.stringify(clean, null, 2));
        broadcastEvent({ type: 'delegation_complete', data: { id: found.id, toAgent: found.toAgent, status: 'completed' } });
      }).catch(err => {
        clean.status = 'pending';
        clean.updatedAt = new Date().toISOString();
        writeFileSync(filePath, JSON.stringify(clean, null, 2));
        broadcastEvent({ type: 'delegation_complete', data: { id: found.id, toAgent: found.toAgent, status: 'error', error: String(err) } });
      });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  return router;
}
