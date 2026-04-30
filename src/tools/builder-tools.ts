/**
 * Clementine — Builder MCP tools.
 *
 * Agent-facing surface for managing workflows + crons on the visual
 * canvas. Read, edit, validate, and dry-run. Actual execution lives
 * separately in the runner (Phase 2+).
 *
 * Outputs are terse plain text by default for prompt efficiency; pass
 * `verbose: true` to get the underlying JSON for debugging.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { textResult } from './shared.js';
import {
  listAllForBuilder,
  readWorkflow,
  saveWorkflow,
  cronId,
  workflowId,
  parseBuilderId,
  isCronShape,
  sourceFileForId,
} from '../dashboard/builder/serializer.js';
import { validateWorkflow } from '../dashboard/builder/validation.js';
import { dryRunWorkflow } from '../dashboard/builder/dry-run.js';
import { emitBuilderEvent } from '../dashboard/builder/events.js';
import { listSnapshots, restoreSnapshot } from '../dashboard/builder/snapshots.js';
import { discoverMcpServers, loadToolInventory } from '../agent/mcp-bridge.js';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepMcpConfig,
  WorkflowStepChannelConfig,
  WorkflowStepTransformConfig,
  WorkflowStepConditionalConfig,
  WorkflowStepLoopConfig,
} from '../types.js';

const STEP_KINDS = ['prompt', 'mcp', 'channel', 'transform', 'conditional', 'loop'] as const;

const stepShape = z.object({
  id: z.string().describe('Step id (unique within workflow)'),
  prompt: z.string().describe('Prompt for the agent (required for kind=prompt; can be a description for other kinds)'),
  dependsOn: z.array(z.string()).default([]).describe('Step ids this step depends on'),
  tier: z.number().min(1).max(5).default(1),
  maxTurns: z.number().min(1).default(15),
  model: z.string().optional(),
  workDir: z.string().optional(),
  kind: z.enum(STEP_KINDS).optional().describe('Default: prompt'),
  mcp: z.object({ server: z.string(), tool: z.string(), inputs: z.record(z.string(), z.unknown()).optional() }).optional(),
  channel: z.object({ channel: z.enum(['discord', 'slack', 'telegram', 'whatsapp', 'email', 'webhook']), target: z.string(), content: z.string() }).optional(),
  transform: z.object({ expression: z.string() }).optional(),
  conditional: z.object({ condition: z.string(), trueNext: z.array(z.string()).optional(), falseNext: z.array(z.string()).optional() }).optional(),
  loop: z.object({ items: z.string(), bodyStepIds: z.array(z.string()) }).optional(),
});

export function registerBuilderTools(server: McpServer): void {

// ── Discovery ──────────────────────────────────────────────────────────

server.tool(
  'workflow_list',
  'List all workflows and crons visible in the Builder. Returns one per line: id|name|origin|owner|enabled|schedule|stepCount. Owner is "global" or "@<agentSlug>".',
  {
    enabledOnly: z.boolean().optional().describe('If true, return only enabled workflows'),
    owner: z.string().optional().describe('Filter by owner: "global", "<agentSlug>", or "@<agentSlug>". Omit to include all.'),
    verbose: z.boolean().optional(),
  },
  async ({ enabledOnly, owner, verbose }) => {
    const ownerFilter = owner ? owner.replace(/^@/, '') : null;
    const items = listAllForBuilder().filter(i => {
      if (enabledOnly && !i.enabled) return false;
      if (ownerFilter == null) return true;
      if (ownerFilter === 'global') return i.scope === 'global';
      return i.scope === 'agent' && i.agentSlug === ownerFilter;
    });
    if (verbose) return textResult(JSON.stringify(items, null, 2));
    if (items.length === 0) return textResult('(no workflows or crons found)');
    return textResult(items.map(i => {
      const ownerCol = i.scope === 'agent' ? '@' + (i.agentSlug ?? '?') : 'global';
      return `${i.id}|${i.name}|${i.origin}|${ownerCol}|${i.enabled ? 'on' : 'off'}|${i.schedule ?? '-'}|${i.stepCount}step${i.stepCount === 1 ? '' : 's'}`;
    }).join('\n'));
  },
);

server.tool(
  'workflow_read',
  'Read a workflow as canonical JSON. Use this before editing — patches reference current step ids.',
  {
    id: z.string().describe('Builder id (e.g., cron:morning-briefing or workflow:daily-digest)'),
  },
  async ({ id }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    return textResult(JSON.stringify(wf, null, 2));
  },
);

server.tool(
  'workflow_search',
  'Search workflows + crons by name or content (substring, case-insensitive).',
  { query: z.string() },
  async ({ query }) => {
    const q = query.toLowerCase();
    const items = listAllForBuilder();
    const matches: string[] = [];
    for (const i of items) {
      if (i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q)) {
        matches.push(`${i.id}|${i.name}|${i.origin}`);
        continue;
      }
      const wf = readWorkflow(i.id);
      if (wf && wf.steps.some(s => s.prompt.toLowerCase().includes(q))) {
        matches.push(`${i.id}|${i.name}|${i.origin} (matched in step prompt)`);
      }
    }
    return textResult(matches.length === 0 ? `(no matches for "${query}")` : matches.join('\n'));
  },
);

server.tool(
  'workflow_list_mcp_tools',
  'List MCP servers and their tools. Use to fill in mcp-step configs (server + tool name).',
  {},
  async () => {
    const servers = discoverMcpServers();
    const inv = loadToolInventory();
    const lines: string[] = [];
    for (const s of servers) {
      const enabled = s.enabled ? 'on' : 'off';
      const toolNames = inv?.tools?.filter(t => t.startsWith(`mcp__${s.name}__`)).map(t => t.split('__')[2]) ?? [];
      const toolList = toolNames.length ? toolNames.join(', ') : '(no tools cached)';
      lines.push(`${s.name} [${enabled}]: ${toolList}`);
    }
    return textResult(lines.length === 0 ? '(no MCP servers configured)' : lines.join('\n'));
  },
);

server.tool(
  'workflow_list_channels',
  'List configured channels (Discord/Slack/Telegram/WhatsApp/Email/Webhook). Tells you which channel kinds are wired up.',
  {},
  async () => {
    const channels = ['discord', 'slack', 'telegram', 'whatsapp', 'email', 'webhook'];
    const lines = channels.map(c => `${c}: ${channelHint(c)}`);
    return textResult(lines.join('\n'));
  },
);

// ── Validation ─────────────────────────────────────────────────────────

server.tool(
  'workflow_validate',
  'Run static validation on a workflow. Returns errors + warnings. Cheap — no execution.',
  { id: z.string() },
  async ({ id }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    const result = validateWorkflow(wf);
    if (result.issues.length === 0) return textResult('OK — no issues');
    return textResult(formatIssues(result.issues));
  },
);

server.tool(
  'workflow_dry_run',
  'Walk a workflow without executing. Shows what each step would do, in topological order, with rough cost estimate. Use for long-running jobs to preview safely.',
  { id: z.string() },
  async ({ id }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    const r = dryRunWorkflow(wf);
    const lines: string[] = [];
    lines.push(r.ok ? `DRY RUN: ${wf.name}` : `DRY RUN (validation failed): ${wf.name}`);
    if (r.validationIssues.length) lines.push(formatIssues(r.validationIssues));
    for (const s of r.steps) {
      lines.push(`[wave ${s.wave}] ${s.description}`);
      for (const w of s.warnings) lines.push(`  ⚠ ${w}`);
    }
    if (r.estimatedTokens) {
      lines.push(`Rough estimate: ~${r.estimatedTokens.total.toLocaleString()} tokens across ${r.estimatedTokens.promptSteps} prompt step(s).`);
    }
    for (const note of r.notes) lines.push(note);
    return textResult(lines.join('\n'));
  },
);

// ── Mutations ──────────────────────────────────────────────────────────

server.tool(
  'workflow_save',
  'Save a workflow (full replace). Validates before writing — rejects on errors unless `force: true`. Use this when you need to change many fields atomically; for small edits prefer the targeted tools (workflow_add_node etc.).',
  {
    id: z.string(),
    workflow: z.object({
      name: z.string(),
      description: z.string().default(''),
      enabled: z.boolean().default(true),
      trigger: z.object({ schedule: z.string().optional(), manual: z.boolean().optional() }).default({ manual: true }),
      inputs: z.record(z.string(), z.object({ type: z.enum(['string', 'number']), default: z.string().optional(), description: z.string().optional() })).default({}),
      steps: z.array(stepShape),
      synthesis: z.object({ prompt: z.string() }).optional(),
      agentSlug: z.string().optional(),
    }),
    force: z.boolean().optional().describe('Bypass validation errors (warnings always ignored)'),
  },
  async ({ id, workflow, force }) => {
    const existing = readWorkflow(id);
    if (!existing) return textResult(`Not found: ${id}`);
    const next: WorkflowDefinition = {
      ...workflow,
      steps: workflow.steps.map(s => normalizeStep(s)),
      sourceFile: existing.sourceFile,
    };
    const v = validateWorkflow(next);
    if (!v.ok && !force) {
      return textResult('Save rejected — validation errors:\n' + formatIssues(v.issues) + '\nPass force: true to override.');
    }
    const result = saveWorkflow(id, next);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: next } });
    return textResult(`Saved ${id}.${v.issues.length ? ' Warnings:\n' + formatIssues(v.issues.filter(i => i.severity === 'warning')) : ''}`);
  },
);

server.tool(
  'workflow_create',
  'Create a new workflow file (multi-step) under vault/00-System/workflows/. Returns its builder id.',
  {
    name: z.string().describe('Workflow name (also derived as the file slug)'),
    description: z.string().default(''),
    schedule: z.string().optional().describe('Cron expression (omit for manual-only)'),
    initialPrompt: z.string().optional().describe('First-step prompt; defaults to a placeholder'),
  },
  async ({ name, description, schedule, initialPrompt }) => {
    const slug = slugify(name);
    const wf: WorkflowDefinition = {
      name,
      description,
      enabled: true,
      trigger: { schedule, manual: !schedule },
      inputs: {},
      steps: [{
        id: 's1',
        prompt: initialPrompt ?? 'Describe what this workflow should do.',
        dependsOn: [],
        tier: 1,
        maxTurns: 15,
      }],
      sourceFile: '',
    };
    const id = workflowId(slug);
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Create failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:created', workflowId: id, payload: { workflow: wf } });
    return textResult(`Created ${id}.`);
  },
);

server.tool(
  'workflow_set_enabled',
  'Enable or disable a workflow/cron without other changes.',
  { id: z.string(), enabled: z.boolean() },
  async ({ id, enabled }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    if (wf.enabled === enabled) return textResult(`Already ${enabled ? 'enabled' : 'disabled'}.`);
    wf.enabled = enabled;
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:enabled-changed', workflowId: id, payload: { enabled } });
    return textResult(`${id} → ${enabled ? 'enabled' : 'disabled'}`);
  },
);

server.tool(
  'workflow_set_schedule',
  'Change a workflow/cron schedule. Pass schedule=null to make it manual-only.',
  { id: z.string(), schedule: z.string().nullable() },
  async ({ id, schedule }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    wf.trigger = schedule ? { schedule, manual: false } : { manual: true };
    const v = validateWorkflow(wf);
    if (!v.ok) return textResult('Schedule change rejected: ' + formatIssues(v.issues.filter(i => i.severity === 'error')));
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: wf } });
    return textResult(`Schedule for ${id} → ${schedule ?? 'manual'}`);
  },
);

server.tool(
  'workflow_add_node',
  'Append a new step to a workflow.',
  {
    id: z.string(),
    step: stepShape,
  },
  async ({ id, step }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    if (wf.steps.some(s => s.id === step.id)) return textResult(`Step id "${step.id}" already exists in ${id}`);
    wf.steps.push(normalizeStep(step));
    if (isCronShape(wf) === false && parseBuilderId(id)?.origin === 'cron') {
      return textResult('Cron entries must remain single-step. Use workflow_create to make a multi-step workflow instead.');
    }
    const v = validateWorkflow(wf);
    if (!v.ok) return textResult('Add rejected: ' + formatIssues(v.issues.filter(i => i.severity === 'error')));
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: wf } });
    return textResult(`Added step "${step.id}" to ${id}`);
  },
);

server.tool(
  'workflow_update_node',
  'Update an existing step in place (partial fields allowed).',
  {
    id: z.string(),
    stepId: z.string(),
    patch: stepShape.partial(),
  },
  async ({ id, stepId, patch }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    const idx = wf.steps.findIndex(s => s.id === stepId);
    if (idx === -1) return textResult(`Step "${stepId}" not found in ${id}`);
    const next = normalizeStep({ ...wf.steps[idx], ...patch, id: patch.id ?? stepId });
    wf.steps[idx] = next;
    const v = validateWorkflow(wf);
    if (!v.ok) return textResult('Update rejected: ' + formatIssues(v.issues.filter(i => i.severity === 'error')));
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: wf } });
    return textResult(`Updated step "${stepId}" in ${id}`);
  },
);

server.tool(
  'workflow_remove_node',
  'Remove a step + any edges referencing it.',
  { id: z.string(), stepId: z.string() },
  async ({ id, stepId }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    if (!wf.steps.some(s => s.id === stepId)) return textResult(`Step "${stepId}" not found in ${id}`);
    if (parseBuilderId(id)?.origin === 'cron') return textResult('Cron entries must remain single-step; cannot remove the only step.');
    wf.steps = wf.steps.filter(s => s.id !== stepId).map(s => ({ ...s, dependsOn: s.dependsOn.filter(d => d !== stepId) }));
    const v = validateWorkflow(wf);
    if (!v.ok) return textResult('Remove rejected: ' + formatIssues(v.issues.filter(i => i.severity === 'error')));
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: wf } });
    return textResult(`Removed step "${stepId}" from ${id}`);
  },
);

server.tool(
  'workflow_connect',
  'Add an edge from one step to another (sets `to.dependsOn += [from]`).',
  { id: z.string(), from: z.string(), to: z.string() },
  async ({ id, from, to }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    if (from === to) return textResult('Cannot connect a step to itself');
    const fromStep = wf.steps.find(s => s.id === from);
    const toStep = wf.steps.find(s => s.id === to);
    if (!fromStep || !toStep) return textResult(`Both steps must exist (from=${from}, to=${to})`);
    if (toStep.dependsOn.includes(from)) return textResult(`Edge ${from} → ${to} already exists`);
    toStep.dependsOn.push(from);
    const v = validateWorkflow(wf);
    if (!v.ok) {
      // roll back
      toStep.dependsOn = toStep.dependsOn.filter(d => d !== from);
      return textResult('Connect rejected (would introduce cycle or other error): ' + formatIssues(v.issues.filter(i => i.severity === 'error')));
    }
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: wf } });
    return textResult(`Connected ${from} → ${to}`);
  },
);

server.tool(
  'workflow_disconnect',
  'Remove an edge between two steps.',
  { id: z.string(), from: z.string(), to: z.string() },
  async ({ id, from, to }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    const toStep = wf.steps.find(s => s.id === to);
    if (!toStep) return textResult(`Step ${to} not found`);
    if (!toStep.dependsOn.includes(from)) return textResult(`No edge ${from} → ${to}`);
    toStep.dependsOn = toStep.dependsOn.filter(d => d !== from);
    const result = saveWorkflow(id, wf);
    if (!result.ok) return textResult('Save failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { workflow: wf } });
    return textResult(`Disconnected ${from} → ${to}`);
  },
);

server.tool(
  'workflow_rename',
  'Rename a workflow. Workflow files are renamed on disk; cron entries keep the same file but update the name field.',
  { id: z.string(), newName: z.string() },
  async ({ id, newName }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    const origin = parseBuilderId(id)?.origin;
    if (origin === 'cron') {
      wf.name = newName;
      const result = saveWorkflow(id, wf);
      if (!result.ok) return textResult('Rename failed: ' + result.error);
      const newId = cronId(newName);
      emitBuilderEvent({ type: 'workflow:renamed', workflowId: id, payload: { newId } });
      return textResult(`Renamed (cron): ${id} → ${newId}`);
    }
    // Workflow file rename: write new file, delete old.
    const newId = workflowId(slugify(newName));
    if (newId === id) {
      wf.name = newName;
      const result = saveWorkflow(id, wf);
      return textResult(result.ok ? `Renamed (label only): ${id}` : `Failed: ${result.error}`);
    }
    wf.name = newName;
    const newSave = saveWorkflow(newId, wf);
    if (!newSave.ok) return textResult('Rename failed (writing new file): ' + newSave.error);
    // Delete old file
    try {
      const { unlinkSync, existsSync } = await import('node:fs');
      if (existsSync(wf.sourceFile)) unlinkSync(wf.sourceFile);
    } catch (err) {
      return textResult(`New file written but old file delete failed: ${(err as Error).message}`);
    }
    emitBuilderEvent({ type: 'workflow:renamed', workflowId: id, payload: { newId } });
    return textResult(`Renamed: ${id} → ${newId}`);
  },
);

server.tool(
  'workflow_duplicate',
  'Create a copy of a workflow with a new name.',
  { id: z.string(), newName: z.string() },
  async ({ id, newName }) => {
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    const slug = slugify(newName);
    const newId = workflowId(slug);
    const copy: WorkflowDefinition = { ...wf, name: newName, sourceFile: '' };
    const result = saveWorkflow(newId, copy);
    if (!result.ok) return textResult('Duplicate failed: ' + result.error);
    emitBuilderEvent({ type: 'workflow:created', workflowId: newId, payload: { workflow: copy } });
    return textResult(`Duplicated ${id} → ${newId}`);
  },
);

server.tool(
  'workflow_history',
  'List recent saved snapshots of a workflow (newest first). Last 20 are kept. Use to find a point to restore.',
  { id: z.string() },
  async ({ id }) => {
    const list = listSnapshots(id);
    if (list.length === 0) return textResult('(no snapshots yet)');
    return textResult(list.map(s => `${s.filename}|${s.ts}|${s.size}b`).join('\n'));
  },
);

server.tool(
  'workflow_restore',
  'Restore a workflow from a snapshot. The current state is itself snapshotted before overwrite, so the restore is reversible. Use workflow_history to find the snapshot filename first.',
  { id: z.string(), snapshotFilename: z.string() },
  async ({ id, snapshotFilename }) => {
    const sourceFile = sourceFileForId(id);
    if (!sourceFile) return textResult(`Unknown id: ${id}`);
    const result = restoreSnapshot(id, snapshotFilename, sourceFile);
    if (!result.ok) return textResult('Restore failed: ' + (result.error ?? 'unknown'));
    emitBuilderEvent({ type: 'workflow:patched', workflowId: id, payload: { restoredFrom: snapshotFilename } });
    return textResult(`Restored ${id} from ${snapshotFilename}`);
  },
);

server.tool(
  'workflow_delete',
  'Delete a workflow file (multi-step workflows only). Cron entries are removed via workflow_set_enabled or by editing CRON.md directly.',
  { id: z.string() },
  async ({ id }) => {
    const parsed = parseBuilderId(id);
    if (!parsed) return textResult(`Bad id: ${id}`);
    if (parsed.origin === 'cron') return textResult('Use workflow_set_enabled false to disable a cron, or delete the CRON.md entry manually.');
    const wf = readWorkflow(id);
    if (!wf) return textResult(`Not found: ${id}`);
    try {
      const { unlinkSync, existsSync } = await import('node:fs');
      if (existsSync(wf.sourceFile)) unlinkSync(wf.sourceFile);
    } catch (err) {
      return textResult(`Delete failed: ${(err as Error).message}`);
    }
    emitBuilderEvent({ type: 'workflow:deleted', workflowId: id });
    return textResult(`Deleted ${id}`);
  },
);

}

// ── helpers ────────────────────────────────────────────────────────────

function normalizeStep(s: z.infer<typeof stepShape>): WorkflowStep {
  const step: WorkflowStep = {
    id: s.id,
    prompt: s.prompt,
    dependsOn: s.dependsOn ?? [],
    tier: s.tier ?? 1,
    maxTurns: s.maxTurns ?? 15,
    model: s.model,
    workDir: s.workDir,
    kind: s.kind,
    mcp: s.mcp as WorkflowStepMcpConfig | undefined,
    channel: s.channel as WorkflowStepChannelConfig | undefined,
    transform: s.transform as WorkflowStepTransformConfig | undefined,
    conditional: s.conditional as WorkflowStepConditionalConfig | undefined,
    loop: s.loop as WorkflowStepLoopConfig | undefined,
  };
  return step;
}

function formatIssues(issues: Array<{ severity: string; code: string; stepId?: string; message: string }>): string {
  return issues.map(i => `${i.severity.toUpperCase()} [${i.code}]${i.stepId ? ' (' + i.stepId + ')' : ''}: ${i.message}`).join('\n');
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'workflow';
}

function channelHint(channel: string): string {
  // Quick description of where each channel lives. Real introspection of token presence
  // happens in the dashboard Settings → Channels tab; here we just describe shape.
  switch (channel) {
    case 'discord': return 'guild + user channels via DISCORD_BOT_TOKEN; target = channel id or user id';
    case 'slack': return 'workspace via SLACK_BOT_TOKEN; target = #channel or @user';
    case 'telegram': return 'bot via TELEGRAM_BOT_TOKEN; target = chat id';
    case 'whatsapp': return 'Twilio WhatsApp; target = E.164 phone number';
    case 'email': return 'SMTP/Outlook; target = email address';
    case 'webhook': return 'arbitrary HTTP POST; target = URL';
    default: return '';
  }
}
