/**
 * Workflow API routes — extracted from dashboard.ts
 */
import { Router } from 'express';
import express from 'express';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
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

  /**
   * 1.18.142 — Migrate a workflow into a vanilla Anthropic skill folder.
   *
   * Skills are subsuming workflows. To let users move at their own pace
   * without breaking the workflow runtime, this endpoint converts ONE
   * workflow at a time and renames the original .md → .md.migrated so
   * the workflow runner stops picking it up but the file is still on
   * disk for rollback.
   *
   * Conversion: workflow.name → skill name (slugified to Anthropic
   * regex), workflow.description → skill description, raw workflow
   * markdown body → skill procedure body (steps + synthesis prompt are
   * preserved as documentation; runtime is the SDK reading the body).
   * Frontmatter is rebuilt from scratch by writeSkill, so legacy
   * workflow YAML doesn't leak into the new skill.
   */
  router.post('/:name/migrate-to-skill', express.json(), async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name);
      const { parseAllWorkflows } = await import('../../agent/workflow-runner.js');
      const { writeSkill } = await import('../../agent/skill-store.js');
      const matter = (await import('gray-matter')).default;

      // Find the workflow across global + agent scopes
      const candidates: Array<{ wf: ReturnType<typeof parseAllWorkflows>[number]; agentSlug?: string }> = [];
      if (existsSync(workflowsDir)) {
        for (const wf of parseAllWorkflows(workflowsDir)) {
          if (wf.name === name) candidates.push({ wf });
        }
      }
      if (existsSync(agentsBase)) {
        for (const slug of readdirSync(agentsBase).filter(d => !d.startsWith('_'))) {
          const wfDir = path.join(agentsBase, slug, 'workflows');
          if (!existsSync(wfDir)) continue;
          for (const wf of parseAllWorkflows(wfDir)) {
            if (wf.name === name) candidates.push({ wf, agentSlug: slug });
          }
        }
      }
      if (candidates.length === 0) { res.status(404).json({ ok: false, error: 'Workflow not found: ' + name }); return; }
      const { wf, agentSlug } = candidates[0];

      // Slugify the workflow name to the Anthropic regex
      const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
        res.status(400).json({ ok: false, error: `Workflow name "${name}" cannot be slugified to Anthropic regex` });
        return;
      }

      // Build the skill body from the workflow's raw markdown body. The
      // workflow runner's frontmatter is dropped — writeSkill rebuilds
      // a clementine.* block from scratch. Steps and synthesis live as
      // markdown for the SDK to read directly.
      const raw = readFileSync(wf.sourceFile, 'utf-8');
      const parsed = matter(raw);
      const body = parsed.content.trim() || `Migrated from workflow "${name}". Add a procedure here.`;
      const description = wf.description || `Migrated from workflow ${name}`;

      let written;
      try {
        written = writeSkill({
          name: slug,
          title: wf.name,
          description,
          body,
          source: 'imported',
          agentSlug,
        });
      } catch (err) {
        res.status(409).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
        return;
      }

      // Rename the original .md → .md.migrated so parseAllWorkflows
      // stops picking it up. File stays on disk for rollback.
      const migratedPath = wf.sourceFile + '.migrated';
      try {
        renameSync(wf.sourceFile, migratedPath);
      } catch (err) {
        // Skill is already written; surface the rename failure but don't
        // roll back — the user can manually delete the .md if needed.
        res.json({
          ok: true,
          skill: written,
          warning: `Skill created but original workflow file rename failed: ${String(err)}`,
        });
        return;
      }

      broadcastEvent({ type: 'workflow_migrated', data: { workflowName: name, skillSlug: slug, agentSlug } });
      res.json({ ok: true, skill: written, originalRenamedTo: migratedPath });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
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
