/**
 * Workflow API routes — extracted from dashboard.ts
 */
import { Router } from 'express';
import express from 'express';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Gateway } from '../../gateway/router.js';

export interface WorkflowsRouterDeps {
  workflowsDir: string;
  workflowRunsDir: string;
  agentsBase: string;
  getGateway: () => Promise<Gateway>;
  broadcastEvent: (event: { type: string; data?: unknown }) => void;
  cachedAsync: <T>(key: string, ttlMs: number, compute: () => Promise<T>) => Promise<T>;
}

export function workflowsRouter(deps: WorkflowsRouterDeps): Router {
  const router = Router();
  const { workflowsDir, workflowRunsDir, agentsBase, getGateway, broadcastEvent, cachedAsync } = deps;

  router.get('/', async (_req, res) => {
    try {
      const workflows = await cachedAsync('workflows', 10_000, async () => {
        const { parseAllWorkflows } = await import('../../agent/workflow-runner.js');
        const wfs: Array<Record<string, unknown>> = [];
        if (existsSync(workflowsDir)) {
          for (const wf of parseAllWorkflows(workflowsDir)) {
            wfs.push({ ...wf, scope: 'global' });
          }
        }
        if (existsSync(agentsBase)) {
          for (const slug of readdirSync(agentsBase).filter(d => !d.startsWith('_'))) {
            const wfDir = path.join(agentsBase, slug, 'workflows');
            if (!existsSync(wfDir)) continue;
            for (const wf of parseAllWorkflows(wfDir)) {
              wfs.push({ ...wf, agentSlug: slug, scope: slug });
            }
          }
        }
        return wfs;
      });
      res.json({ ok: true, workflows });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.post('/:name/run', express.json(), async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name);
      const { parseAllWorkflows } = await import('../../agent/workflow-runner.js');
      const allWfs = [];
      if (existsSync(workflowsDir)) allWfs.push(...parseAllWorkflows(workflowsDir));
      if (existsSync(agentsBase)) {
        for (const slug of readdirSync(agentsBase).filter(d => !d.startsWith('_'))) {
          const wfDir = path.join(agentsBase, slug, 'workflows');
          if (existsSync(wfDir)) allWfs.push(...parseAllWorkflows(wfDir));
        }
      }
      const wf = allWfs.find(w => w.name === name);
      if (!wf) { res.status(404).json({ ok: false, error: 'Workflow not found: ' + name }); return; }

      const inputs = req.body.inputs || {};
      res.json({ ok: true, message: `Workflow '${name}' triggered` });
      broadcastEvent({ type: 'workflow_triggered', data: { name } });

      getGateway().then(gw => gw.handleWorkflow(wf, inputs)).then(result => {
        broadcastEvent({ type: 'workflow_complete', data: { name, status: 'ok', preview: (result || '').slice(0, 300) } });
      }).catch(err => {
        broadcastEvent({ type: 'workflow_complete', data: { name, status: 'error', error: String(err) } });
      });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.get('/:name/runs', (_req, res) => {
    try {
      const name = decodeURIComponent(_req.params.name);
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const logFile = path.join(workflowRunsDir, `${safe}.jsonl`);
      if (!existsSync(logFile)) { res.json({ ok: true, runs: [] }); return; }
      const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
      const runs = lines.slice(-20).reverse().map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.json({ ok: true, runs });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  return router;
}
