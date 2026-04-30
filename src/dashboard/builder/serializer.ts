/**
 * Builder serializer.
 *
 * Two responsibilities:
 *
 * 1. Unified read/write of crons + workflows as WorkflowDefinition objects
 *    so the visual canvas can edit both with one shape. CRON.md entries
 *    round-trip as virtual single-step workflows; multi-step workflow
 *    files round-trip via the existing workflow-runner format.
 *
 * 2. Convert WorkflowDefinition ⇄ Drawflow's canvas data shape so the
 *    frontend can drop the JSON straight into drawflow.import().
 *
 * Backwards-compatible: existing CRON.md and workflow files are unchanged
 * unless edited through this module, and edits preserve unrelated fields.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';

import { CRON_FILE, WORKFLOWS_DIR, AGENTS_DIR } from '../../config.js';
import { snapshotWorkflow } from './snapshots.js';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
  CronJobDefinition,
  BuilderWorkflowSummary,
  WorkflowOriginKind,
} from '../../types.js';

// ── ID scheme ───────────────────────────────────────────────────────
//
// Global:        `cron:<key>` / `workflow:<key>`
// Agent-scoped:  `cron@<slug>:<key>` / `workflow@<slug>:<key>`
// `@` is reserved (slugs and workflow keys are kebab-case `[a-z0-9-]+`),
// so it cleanly distinguishes scoped ids from global ones without
// breaking any existing global id parser.

const CRON_ID_PREFIX = 'cron:';
const WORKFLOW_ID_PREFIX = 'workflow:';
const CRON_AGENT_PREFIX = 'cron@';
const WORKFLOW_AGENT_PREFIX = 'workflow@';

export function cronId(name: string, agentSlug?: string): string {
  if (agentSlug) return CRON_AGENT_PREFIX + agentSlug + ':' + name;
  return CRON_ID_PREFIX + name;
}

export function workflowId(filename: string, agentSlug?: string): string {
  const base = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  if (agentSlug) return WORKFLOW_AGENT_PREFIX + agentSlug + ':' + base;
  return WORKFLOW_ID_PREFIX + base;
}

export type ParsedBuilderId =
  | { origin: WorkflowOriginKind; scope: 'global'; key: string }
  | { origin: WorkflowOriginKind; scope: 'agent'; agentSlug: string; key: string };

export function parseBuilderId(id: string): ParsedBuilderId | null {
  if (id.startsWith(CRON_AGENT_PREFIX)) {
    const rest = id.slice(CRON_AGENT_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 1 || colon === rest.length - 1) return null;
    return { origin: 'cron', scope: 'agent', agentSlug: rest.slice(0, colon), key: rest.slice(colon + 1) };
  }
  if (id.startsWith(WORKFLOW_AGENT_PREFIX)) {
    const rest = id.slice(WORKFLOW_AGENT_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 1 || colon === rest.length - 1) return null;
    return { origin: 'workflow', scope: 'agent', agentSlug: rest.slice(0, colon), key: rest.slice(colon + 1) };
  }
  if (id.startsWith(CRON_ID_PREFIX)) return { origin: 'cron', scope: 'global', key: id.slice(CRON_ID_PREFIX.length) };
  if (id.startsWith(WORKFLOW_ID_PREFIX)) return { origin: 'workflow', scope: 'global', key: id.slice(WORKFLOW_ID_PREFIX.length) };
  return null;
}

// ── Agent path helpers ──────────────────────────────────────────────

function agentCronFile(slug: string): string {
  return path.join(AGENTS_DIR, slug, 'CRON.md');
}

function agentWorkflowsDir(slug: string): string {
  return path.join(AGENTS_DIR, slug, 'workflows');
}

function listAgentSlugs(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  try {
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

// ── List ────────────────────────────────────────────────────────────

export function listAllForBuilder(): BuilderWorkflowSummary[] {
  const out: BuilderWorkflowSummary[] = [];

  // Global crons from CRON.md
  for (const job of readCronJobsFromFile(CRON_FILE)) {
    out.push({
      id: cronId(job.name),
      origin: 'cron',
      scope: 'global',
      name: job.name,
      description: '',
      enabled: job.enabled,
      schedule: job.schedule,
      stepCount: 1,
      sourceFile: CRON_FILE,
      agentSlug: job.agentSlug,
    });
  }

  // Global workflows from workflows dir
  if (existsSync(WORKFLOWS_DIR)) {
    for (const file of readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'))) {
      try {
        const wf = parseWorkflowFile(path.join(WORKFLOWS_DIR, file));
        out.push({
          id: workflowId(file),
          origin: 'workflow',
          scope: 'global',
          name: wf.name,
          description: wf.description,
          enabled: wf.enabled,
          schedule: wf.trigger.schedule,
          stepCount: wf.steps.length,
          sourceFile: wf.sourceFile,
          agentSlug: wf.agentSlug,
        });
      } catch {
        // Skip unparseable workflow files
      }
    }
  }

  // Agent-scoped crons + workflows from <AGENTS_DIR>/<slug>/...
  for (const slug of listAgentSlugs()) {
    const cronFile = agentCronFile(slug);
    for (const job of readCronJobsFromFile(cronFile)) {
      out.push({
        id: cronId(job.name, slug),
        origin: 'cron',
        scope: 'agent',
        name: job.name,
        description: '',
        enabled: job.enabled,
        schedule: job.schedule,
        stepCount: 1,
        sourceFile: cronFile,
        agentSlug: slug,
      });
    }

    const wfDir = agentWorkflowsDir(slug);
    if (existsSync(wfDir)) {
      for (const file of readdirSync(wfDir).filter(f => f.endsWith('.md'))) {
        try {
          const wf = parseWorkflowFile(path.join(wfDir, file));
          out.push({
            id: workflowId(file, slug),
            origin: 'workflow',
            scope: 'agent',
            name: wf.name,
            description: wf.description,
            enabled: wf.enabled,
            schedule: wf.trigger.schedule,
            stepCount: wf.steps.length,
            sourceFile: wf.sourceFile,
            agentSlug: slug,
          });
        } catch {
          // Skip unparseable workflow files
        }
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Read ────────────────────────────────────────────────────────────

export function readWorkflow(id: string): WorkflowDefinition | null {
  const parsed = parseBuilderId(id);
  if (!parsed) return null;

  if (parsed.origin === 'cron') {
    const cronFile = parsed.scope === 'agent' ? agentCronFile(parsed.agentSlug) : CRON_FILE;
    const slug = parsed.scope === 'agent' ? parsed.agentSlug : undefined;
    const job = readCronJobsFromFile(cronFile).find(j => j.name === parsed.key);
    if (!job) return null;
    return cronJobToWorkflow(slug ? { ...job, agentSlug: slug } : job, { sourceFile: cronFile });
  }

  const wfDir = parsed.scope === 'agent' ? agentWorkflowsDir(parsed.agentSlug) : WORKFLOWS_DIR;
  const file = path.join(wfDir, parsed.key + '.md');
  if (!existsSync(file)) return null;
  try {
    const wf = parseWorkflowFile(file);
    if (parsed.scope === 'agent' && !wf.agentSlug) wf.agentSlug = parsed.agentSlug;
    return wf;
  } catch {
    return null;
  }
}

function readCronJobsFromFile(cronFile: string): CronJobDefinition[] {
  if (!existsSync(cronFile)) return [];
  const raw = readFileSync(cronFile, 'utf-8');
  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    return [];
  }
  const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
  const jobs: CronJobDefinition[] = [];
  for (const job of jobDefs) {
    const name = String(job.name ?? '');
    const schedule = String(job.schedule ?? '');
    const prompt = String(job.prompt ?? '');
    if (!name || !schedule || !prompt) continue;
    jobs.push({
      name,
      schedule,
      prompt,
      enabled: job.enabled !== false,
      tier: Number(job.tier ?? 1),
      maxTurns: job.max_turns != null ? Number(job.max_turns) : undefined,
      model: job.model != null ? String(job.model) : undefined,
      workDir: job.work_dir != null ? String(job.work_dir) : undefined,
      mode: job.mode === 'unleashed' ? 'unleashed' : 'standard',
      maxHours: job.max_hours != null ? Number(job.max_hours) : undefined,
      maxRetries: job.max_retries != null ? Number(job.max_retries) : undefined,
      after: job.after != null ? String(job.after) : undefined,
      successCriteria: Array.isArray(job.success_criteria)
        ? (job.success_criteria as unknown[]).map(c => String(c))
        : undefined,
      alwaysDeliver: job.always_deliver === true ? true : undefined,
      context: job.context != null ? String(job.context) : undefined,
      preCheck: job.pre_check != null ? String(job.pre_check) : undefined,
      agentSlug: typeof job.agentSlug === 'string'
        ? job.agentSlug
        : typeof job.agent_slug === 'string'
        ? (job.agent_slug as string)
        : undefined,
    });
  }
  return jobs;
}

function parseWorkflowFile(filePath: string): WorkflowDefinition {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  if (data.type !== 'workflow') {
    throw new Error(`Not a workflow file (type=${String(data.type)}): ${filePath}`);
  }

  const name = String(data.name ?? path.basename(filePath, '.md'));
  const description = String(data.description ?? '');
  const enabled = data.enabled !== false;

  const triggerRaw = (data.trigger ?? {}) as Record<string, unknown>;
  const trigger = {
    schedule: triggerRaw.schedule ? String(triggerRaw.schedule) : undefined,
    manual: triggerRaw.manual !== false,
  };

  const inputs: WorkflowDefinition['inputs'] = {};
  if (data.inputs && typeof data.inputs === 'object') {
    for (const [key, val] of Object.entries(data.inputs as Record<string, unknown>)) {
      const v = val as Record<string, unknown>;
      inputs[key] = {
        type: (v.type === 'number' ? 'number' : 'string'),
        default: v.default != null ? String(v.default) : undefined,
        description: v.description ? String(v.description) : undefined,
      };
    }
  }

  const stepsRaw = (data.steps ?? []) as Array<Record<string, unknown>>;
  const steps: WorkflowStep[] = stepsRaw.map((s, i) => {
    const step: WorkflowStep = {
      id: String(s.id ?? `step-${i + 1}`),
      prompt: String(s.prompt ?? ''),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      tier: Number(s.tier ?? 1),
      maxTurns: Number(s.maxTurns ?? 15),
      model: s.model != null ? String(s.model) : undefined,
      workDir: s.workDir != null ? String(s.workDir) : undefined,
    };
    const kind = s.kind as WorkflowStepKind | undefined;
    if (kind && kind !== 'prompt') step.kind = kind;
    if (s.mcp && typeof s.mcp === 'object') step.mcp = s.mcp as WorkflowStep['mcp'];
    if (s.channel && typeof s.channel === 'object') step.channel = s.channel as WorkflowStep['channel'];
    if (s.transform && typeof s.transform === 'object') step.transform = s.transform as WorkflowStep['transform'];
    if (s.conditional && typeof s.conditional === 'object') step.conditional = s.conditional as WorkflowStep['conditional'];
    if (s.loop && typeof s.loop === 'object') step.loop = s.loop as WorkflowStep['loop'];
    if (s.canvas && typeof s.canvas === 'object') {
      const c = s.canvas as { x?: unknown; y?: unknown };
      if (typeof c.x === 'number' && typeof c.y === 'number') step.canvas = { x: c.x, y: c.y };
    }
    return step;
  });

  const synthesis = (data.synthesis as { prompt?: unknown } | undefined)?.prompt
    ? { prompt: String((data.synthesis as { prompt: unknown }).prompt) }
    : undefined;

  return {
    name,
    description,
    enabled,
    trigger,
    inputs,
    steps,
    synthesis,
    sourceFile: filePath,
    agentSlug: typeof data.agentSlug === 'string' ? (data.agentSlug as string) : undefined,
  };
}

// ── Cron ⇄ Workflow ─────────────────────────────────────────────────

export function cronJobToWorkflow(
  job: CronJobDefinition,
  opts: { sourceFile?: string } = {},
): WorkflowDefinition {
  const step: WorkflowStep = {
    id: 'main',
    prompt: job.prompt,
    dependsOn: [],
    tier: job.tier,
    maxTurns: job.maxTurns ?? 15,
    model: job.model,
    workDir: job.workDir,
    kind: 'prompt',
  };
  return {
    name: job.name,
    description: '',
    enabled: job.enabled,
    trigger: { schedule: job.schedule, manual: false },
    inputs: {},
    steps: [step],
    sourceFile: opts.sourceFile ?? CRON_FILE,
    agentSlug: job.agentSlug,
  };
}

/** True if a workflow is shaped like a CRON.md entry (single prompt step + cron schedule). */
export function isCronShape(wf: WorkflowDefinition): boolean {
  return (
    wf.steps.length === 1 &&
    (wf.steps[0].kind ?? 'prompt') === 'prompt' &&
    !!wf.trigger.schedule
  );
}

// ── Save ────────────────────────────────────────────────────────────

export function saveWorkflow(id: string, wf: WorkflowDefinition): { ok: true } | { ok: false; error: string } {
  const parsed = parseBuilderId(id);
  if (!parsed) return { ok: false, error: 'Unknown builder id: ' + id };

  // Snapshot the current state of the source file before overwriting.
  // Best-effort — failures here never block the save.
  const sourceBefore = sourceFileForId(id, parsed);
  if (sourceBefore) {
    try { snapshotWorkflow(id, sourceBefore); } catch { /* */ }
  }

  if (parsed.origin === 'cron') {
    if (!isCronShape(wf)) {
      return { ok: false, error: 'Cron entry must remain a single prompt step with a cron schedule' };
    }
    const cronFile = parsed.scope === 'agent' ? agentCronFile(parsed.agentSlug) : CRON_FILE;
    const slug = parsed.scope === 'agent' ? parsed.agentSlug : undefined;
    return saveCronEntry(parsed.key, wf, { cronFile, agentSlug: slug });
  }

  const wfDir = parsed.scope === 'agent' ? agentWorkflowsDir(parsed.agentSlug) : WORKFLOWS_DIR;
  const slug = parsed.scope === 'agent' ? parsed.agentSlug : undefined;
  return saveWorkflowFile(parsed.key, wf, { dir: wfDir, agentSlug: slug });
}

/** Resolve the on-disk file path for a builder id. */
export function sourceFileForId(id: string, parsedHint?: ParsedBuilderId): string | null {
  const parsed = parsedHint ?? parseBuilderId(id);
  if (!parsed) return null;
  if (parsed.origin === 'cron') {
    return parsed.scope === 'agent' ? agentCronFile(parsed.agentSlug) : CRON_FILE;
  }
  const dir = parsed.scope === 'agent' ? agentWorkflowsDir(parsed.agentSlug) : WORKFLOWS_DIR;
  return path.join(dir, parsed.key + '.md');
}

/**
 * Strip an `<agentSlug>:` prefix the UI may have stored in `wf.name` when
 * editing an agent-scoped entity. The on-disk name is always the bare key —
 * the slug lives in the file path, not the name.
 */
function stripAgentPrefix(name: string, agentSlug: string | undefined): string {
  if (!agentSlug) return name;
  const prefix = agentSlug + ':';
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function saveCronEntry(
  originalName: string,
  wf: WorkflowDefinition,
  opts: { cronFile: string; agentSlug?: string },
): { ok: true } | { ok: false; error: string } {
  const { cronFile, agentSlug } = opts;
  if (!existsSync(cronFile)) return { ok: false, error: 'CRON.md does not exist: ' + cronFile };
  const raw = readFileSync(cronFile, 'utf-8');
  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    return { ok: false, error: 'CRON.md YAML parse error: ' + (err as Error).message };
  }
  const jobs = Array.isArray(parsed.data.jobs) ? [...(parsed.data.jobs as Array<Record<string, unknown>>)] : [];
  const idx = jobs.findIndex(j => String(j.name ?? '') === originalName);
  if (idx === -1) return { ok: false, error: 'Cron entry not found: ' + originalName };

  const step = wf.steps[0];
  const prev = jobs[idx];
  const updated: Record<string, unknown> = {
    ...prev,
    name: stripAgentPrefix(wf.name, agentSlug),
    schedule: wf.trigger.schedule,
    prompt: step.prompt,
    enabled: wf.enabled,
    tier: step.tier,
  };
  if (step.maxTurns != null) updated.max_turns = step.maxTurns;
  if (step.model != null) updated.model = step.model;
  if (step.workDir != null) updated.work_dir = step.workDir;
  // Agent slug for global crons that are bound to a specific agent (legacy
  // shape). For agent-dir crons the slug lives in the path, not the entry.
  if (!agentSlug && wf.agentSlug) updated.agentSlug = wf.agentSlug;

  jobs[idx] = updated;
  parsed.data.jobs = jobs;
  const out = matter.stringify(parsed.content ?? '', parsed.data);
  writeFileSync(cronFile, out, 'utf-8');
  return { ok: true };
}

function saveWorkflowFile(
  key: string,
  wf: WorkflowDefinition,
  opts: { dir: string; agentSlug?: string },
): { ok: true } | { ok: false; error: string } {
  const { dir, agentSlug } = opts;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key + '.md');

  // Preserve body content if the file exists; otherwise empty body.
  let body = '';
  if (existsSync(file)) {
    try {
      const existing = matter(readFileSync(file, 'utf-8'));
      body = existing.content ?? '';
    } catch {
      body = '';
    }
  }

  const data: Record<string, unknown> = {
    type: 'workflow',
    name: stripAgentPrefix(wf.name, agentSlug),
    description: wf.description,
    enabled: wf.enabled,
    trigger: wf.trigger,
  };
  // Agent slug for legacy global workflows that target a specific agent.
  // For agent-dir workflows the slug lives in the path, not the frontmatter.
  if (!agentSlug && wf.agentSlug) data.agentSlug = wf.agentSlug;
  if (Object.keys(wf.inputs).length > 0) data.inputs = wf.inputs;
  data.steps = wf.steps.map(serializeStep);
  if (wf.synthesis) data.synthesis = wf.synthesis;

  const out = matter.stringify(body, data);
  writeFileSync(file, out, 'utf-8');
  return { ok: true };
}

function serializeStep(step: WorkflowStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: step.id,
    prompt: step.prompt,
    dependsOn: step.dependsOn,
    tier: step.tier,
    maxTurns: step.maxTurns,
  };
  if (step.model) out.model = step.model;
  if (step.workDir) out.workDir = step.workDir;
  const kind = step.kind ?? 'prompt';
  if (kind !== 'prompt') out.kind = kind;
  if (step.mcp) out.mcp = step.mcp;
  if (step.channel) out.channel = step.channel;
  if (step.transform) out.transform = step.transform;
  if (step.conditional) out.conditional = step.conditional;
  if (step.loop) out.loop = step.loop;
  if (step.canvas) out.canvas = step.canvas;
  return out;
}

// ── Drawflow adapter ────────────────────────────────────────────────

/** Drawflow node shape (subset we use). */
interface DrawflowNode {
  id: number;
  name: string;
  data: Record<string, unknown>;
  class: string;
  html: string;
  typenode: boolean;
  inputs: { input_1: { connections: Array<{ node: string; input: string }> } };
  outputs: { output_1: { connections: Array<{ node: string; output: string }> } };
  pos_x: number;
  pos_y: number;
}

export interface DrawflowExport {
  drawflow: {
    Home: {
      data: Record<string, DrawflowNode>;
    };
  };
}

const COL_WIDTH = 260;
const ROW_HEIGHT = 140;

export function workflowToDrawflow(wf: WorkflowDefinition): DrawflowExport {
  // Wave-based default layout: x = wave * COL_WIDTH, y = position-in-wave * ROW_HEIGHT.
  const waveOf = computeWaves(wf.steps);
  const perWave: Record<number, number> = {};
  const stepIdToNumeric: Record<string, number> = {};
  wf.steps.forEach((s, i) => { stepIdToNumeric[s.id] = i + 1; });

  const data: Record<string, DrawflowNode> = {};
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    const numericId = i + 1;
    const wave = waveOf[step.id] ?? 0;
    const idxInWave = perWave[wave] ?? 0;
    perWave[wave] = idxInWave + 1;

    const x = step.canvas?.x ?? wave * COL_WIDTH + 50;
    const y = step.canvas?.y ?? idxInWave * ROW_HEIGHT + 50;

    const inputConnections = step.dependsOn.map(depId => ({
      node: String(stepIdToNumeric[depId] ?? ''),
      input: 'output_1',
    })).filter(c => c.node);

    data[String(numericId)] = {
      id: numericId,
      name: nodeNameForKind(step.kind ?? 'prompt'),
      data: stepToNodeData(step),
      class: 'cl-node cl-node-' + (step.kind ?? 'prompt'),
      html: '',
      typenode: false,
      inputs: { input_1: { connections: inputConnections } },
      outputs: { output_1: { connections: [] } },
      pos_x: x,
      pos_y: y,
    };
  }

  // Fill in output connections from input connections (Drawflow needs both directions).
  for (const [nodeIdStr, node] of Object.entries(data)) {
    for (const conn of node.inputs.input_1.connections) {
      const src = data[conn.node];
      if (src) {
        src.outputs.output_1.connections.push({ node: nodeIdStr, output: 'input_1' });
      }
    }
  }

  return { drawflow: { Home: { data } } };
}

export function drawflowToWorkflow(
  exportData: DrawflowExport,
  base: WorkflowDefinition,
): WorkflowDefinition {
  const nodes = exportData?.drawflow?.Home?.data ?? {};
  const numericToStepId: Record<string, string> = {};
  const orderedNumericIds = Object.keys(nodes).sort((a, b) => Number(a) - Number(b));

  // Read step ids back out of node.data; fall back to step-N if missing.
  for (const nid of orderedNumericIds) {
    const stepData = (nodes[nid].data ?? {}) as { stepId?: string };
    numericToStepId[nid] = stepData.stepId || `step-${nid}`;
  }

  const baseById = new Map(base.steps.map(s => [s.id, s]));
  const steps: WorkflowStep[] = orderedNumericIds.map(nid => {
    const node = nodes[nid];
    const data = node.data as Record<string, unknown>;
    const stepId = numericToStepId[nid];
    const baseStep = baseById.get(stepId);
    const dependsOn: string[] = node.inputs.input_1.connections
      .map(c => numericToStepId[c.node])
      .filter((s): s is string => !!s);

    const next: WorkflowStep = {
      id: stepId,
      prompt: typeof data.prompt === 'string' ? data.prompt : (baseStep?.prompt ?? ''),
      dependsOn,
      tier: typeof data.tier === 'number' ? data.tier : (baseStep?.tier ?? 1),
      maxTurns: typeof data.maxTurns === 'number' ? data.maxTurns : (baseStep?.maxTurns ?? 15),
      model: typeof data.model === 'string' ? data.model : baseStep?.model,
      workDir: typeof data.workDir === 'string' ? data.workDir : baseStep?.workDir,
      kind: (data.kind as WorkflowStepKind | undefined) ?? baseStep?.kind,
      mcp: (data.mcp as WorkflowStep['mcp']) ?? baseStep?.mcp,
      channel: (data.channel as WorkflowStep['channel']) ?? baseStep?.channel,
      transform: (data.transform as WorkflowStep['transform']) ?? baseStep?.transform,
      conditional: (data.conditional as WorkflowStep['conditional']) ?? baseStep?.conditional,
      loop: (data.loop as WorkflowStep['loop']) ?? baseStep?.loop,
      canvas: { x: node.pos_x, y: node.pos_y },
    };
    return next;
  });

  return { ...base, steps };
}

function nodeNameForKind(kind: WorkflowStepKind): string {
  switch (kind) {
    case 'mcp': return 'MCP Tool';
    case 'channel': return 'Channel';
    case 'transform': return 'Transform';
    case 'conditional': return 'Conditional';
    case 'loop': return 'Loop';
    default: return 'Prompt';
  }
}

function stepToNodeData(step: WorkflowStep): Record<string, unknown> {
  const data: Record<string, unknown> = {
    stepId: step.id,
    prompt: step.prompt,
    tier: step.tier,
    maxTurns: step.maxTurns,
    kind: step.kind ?? 'prompt',
  };
  if (step.model) data.model = step.model;
  if (step.workDir) data.workDir = step.workDir;
  if (step.mcp) data.mcp = step.mcp;
  if (step.channel) data.channel = step.channel;
  if (step.transform) data.transform = step.transform;
  if (step.conditional) data.conditional = step.conditional;
  if (step.loop) data.loop = step.loop;
  return data;
}

/** Topological wave numbers (0 = no deps, 1 = depends only on wave 0, ...). */
function computeWaves(steps: WorkflowStep[]): Record<string, number> {
  const wave: Record<string, number> = {};
  const ids = new Set(steps.map(s => s.id));
  const remaining = new Set(steps.map(s => s.id));
  let current = 0;
  // Cap iterations to avoid infinite loops on cyclic/malformed graphs.
  const maxIter = steps.length + 1;
  for (let iter = 0; iter < maxIter && remaining.size > 0; iter++) {
    const ready: string[] = [];
    for (const s of steps) {
      if (!remaining.has(s.id)) continue;
      const depsResolved = s.dependsOn.every(d => !ids.has(d) || (wave[d] != null && wave[d] < current + 1));
      if (depsResolved) ready.push(s.id);
    }
    if (ready.length === 0) {
      // Break cycles: assign remaining to current wave.
      for (const id of remaining) wave[id] = current;
      break;
    }
    for (const id of ready) {
      wave[id] = current;
      remaining.delete(id);
    }
    current++;
  }
  return wave;
}

// ── YAML helper for tests / debug ───────────────────────────────────

/** Stringify a workflow's frontmatter for visual inspection. */
export function workflowFrontmatterString(wf: WorkflowDefinition): string {
  const data: Record<string, unknown> = {
    type: 'workflow',
    name: wf.name,
    description: wf.description,
    enabled: wf.enabled,
    trigger: wf.trigger,
    steps: wf.steps.map(serializeStep),
  };
  if (wf.synthesis) data.synthesis = wf.synthesis;
  if (wf.agentSlug) data.agentSlug = wf.agentSlug;
  return yaml.dump(data);
}
