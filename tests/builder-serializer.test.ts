/**
 * Builder serializer — cron + workflow ⇄ canvas round-trip.
 *
 * Verifies:
 *  - cronJobToWorkflow produces a single-step prompt workflow
 *  - workflowToDrawflow produces valid Drawflow shape with edges
 *  - drawflowToWorkflow → workflowToDrawflow round-trips
 *  - listAllForBuilder enumerates both crons and workflow files
 *  - saveWorkflow round-trips a workflow file (read → save → read)
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// We need to point CRON_FILE / WORKFLOWS_DIR at a temp dir before importing the serializer.
// Use vi.mock for the config module.
let TMP_DIR = '';
const TMP_CRON = () => path.join(TMP_DIR, 'CRON.md');
const TMP_WORKFLOWS = () => path.join(TMP_DIR, 'workflows');

vi.mock('../src/config.js', () => ({
  get CRON_FILE() { return TMP_CRON(); },
  get WORKFLOWS_DIR() { return TMP_WORKFLOWS(); },
  // The serializer only needs these two.
  BASE_DIR: '/tmp',
}));

import {
  cronJobToWorkflow,
  workflowToDrawflow,
  drawflowToWorkflow,
  listAllForBuilder,
  readWorkflow,
  saveWorkflow,
  cronId,
  workflowId,
  parseBuilderId,
  isCronShape,
} from '../src/dashboard/builder/serializer.js';
import type { CronJobDefinition, WorkflowDefinition, WorkflowStep } from '../src/types.js';

describe('Builder serializer', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'clem-builder-'));
    mkdirSync(TMP_WORKFLOWS(), { recursive: true });
  });

  afterEach(() => {
    if (TMP_DIR && existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('id helpers', () => {
    it('cronId/parseBuilderId round-trip', () => {
      expect(parseBuilderId(cronId('morning-briefing'))).toEqual({
        origin: 'cron',
        key: 'morning-briefing',
      });
    });

    it('workflowId strips .md and parseBuilderId round-trips', () => {
      expect(parseBuilderId(workflowId('daily-digest.md'))).toEqual({
        origin: 'workflow',
        key: 'daily-digest',
      });
    });

    it('parseBuilderId returns null for unknown prefix', () => {
      expect(parseBuilderId('unknown:foo')).toBeNull();
    });
  });

  describe('cronJobToWorkflow', () => {
    it('produces single-step prompt workflow', () => {
      const job: CronJobDefinition = {
        name: 'morning-briefing',
        schedule: '0 8 * * *',
        prompt: 'Brief Nate on overnight activity',
        enabled: true,
        tier: 1,
        model: 'sonnet',
      };
      const wf = cronJobToWorkflow(job);
      expect(wf.name).toBe('morning-briefing');
      expect(wf.trigger.schedule).toBe('0 8 * * *');
      expect(wf.steps).toHaveLength(1);
      expect(wf.steps[0].id).toBe('main');
      expect(wf.steps[0].prompt).toBe('Brief Nate on overnight activity');
      expect(wf.steps[0].kind).toBe('prompt');
      expect(wf.steps[0].dependsOn).toEqual([]);
      expect(isCronShape(wf)).toBe(true);
    });
  });

  describe('workflowToDrawflow', () => {
    it('produces single node with no connections for a cron-shaped workflow', () => {
      const wf = cronJobToWorkflow({
        name: 'test',
        schedule: '0 9 * * *',
        prompt: 'Hello',
        enabled: true,
        tier: 1,
      });
      const df = workflowToDrawflow(wf);
      const nodes = df.drawflow.Home.data;
      expect(Object.keys(nodes)).toHaveLength(1);
      const node = nodes['1'];
      expect(node.name).toBe('Prompt');
      expect(node.inputs.input_1.connections).toEqual([]);
      expect(node.outputs.output_1.connections).toEqual([]);
    });

    it('produces edges from dependsOn for a multi-step workflow', () => {
      const wf: WorkflowDefinition = {
        name: 'multi',
        description: '',
        enabled: true,
        trigger: { manual: true },
        inputs: {},
        steps: [
          stepOf({ id: 'a', prompt: 'a', dependsOn: [] }),
          stepOf({ id: 'b', prompt: 'b', dependsOn: ['a'] }),
          stepOf({ id: 'c', prompt: 'c', dependsOn: ['a', 'b'] }),
        ],
        sourceFile: '',
      };
      const df = workflowToDrawflow(wf);
      const nodes = df.drawflow.Home.data;
      expect(Object.keys(nodes)).toHaveLength(3);
      // step b depends on a → b's input has one connection from node 1
      expect(nodes['2'].inputs.input_1.connections).toEqual([{ node: '1', input: 'output_1' }]);
      // step c depends on a + b → c has two input connections
      expect(nodes['3'].inputs.input_1.connections).toEqual([
        { node: '1', input: 'output_1' },
        { node: '2', input: 'output_1' },
      ]);
      // a's output has connections to b and c
      expect(nodes['1'].outputs.output_1.connections).toContainEqual({ node: '2', output: 'input_1' });
      expect(nodes['1'].outputs.output_1.connections).toContainEqual({ node: '3', output: 'input_1' });
    });

    it('places nodes by wave (column = wave, row distributed)', () => {
      const wf: WorkflowDefinition = {
        name: 'multi',
        description: '',
        enabled: true,
        trigger: { manual: true },
        inputs: {},
        steps: [
          stepOf({ id: 'a', prompt: 'a', dependsOn: [] }),
          stepOf({ id: 'b', prompt: 'b', dependsOn: [] }),
          stepOf({ id: 'c', prompt: 'c', dependsOn: ['a', 'b'] }),
        ],
        sourceFile: '',
      };
      const df = workflowToDrawflow(wf);
      const nodes = df.drawflow.Home.data;
      // a + b in wave 0, c in wave 1
      expect(nodes['1'].pos_x).toBe(nodes['2'].pos_x);
      expect(nodes['3'].pos_x).toBeGreaterThan(nodes['1'].pos_x);
    });
  });

  describe('Drawflow ⇄ workflow round-trip', () => {
    it('round-trips a 3-step workflow with deps and config', () => {
      const wf: WorkflowDefinition = {
        name: 'rt',
        description: 'round trip test',
        enabled: true,
        trigger: { manual: true },
        inputs: {},
        steps: [
          stepOf({ id: 's1', prompt: 'first', dependsOn: [] }),
          stepOf({ id: 's2', prompt: 'second', dependsOn: ['s1'], kind: 'mcp', mcp: { server: 'gmail', tool: 'list_unread' } }),
          stepOf({ id: 's3', prompt: 'third', dependsOn: ['s2'] }),
        ],
        sourceFile: '',
      };

      const df = workflowToDrawflow(wf);
      const back = drawflowToWorkflow(df, wf);

      expect(back.steps).toHaveLength(3);
      expect(back.steps.map(s => s.id)).toEqual(['s1', 's2', 's3']);
      expect(back.steps[1].dependsOn).toEqual(['s1']);
      expect(back.steps[2].dependsOn).toEqual(['s2']);
      expect(back.steps[1].kind).toBe('mcp');
      expect(back.steps[1].mcp).toEqual({ server: 'gmail', tool: 'list_unread' });
      // pos was assigned by the layout, so canvas is set on round-trip
      expect(back.steps[0].canvas).toBeDefined();
    });

    it('preserves prompts when nodes have no data overrides', () => {
      const wf: WorkflowDefinition = {
        name: 'rt2',
        description: '',
        enabled: true,
        trigger: { manual: true },
        inputs: {},
        steps: [stepOf({ id: 's1', prompt: 'preserve me', dependsOn: [] })],
        sourceFile: '',
      };
      const df = workflowToDrawflow(wf);
      const back = drawflowToWorkflow(df, wf);
      expect(back.steps[0].prompt).toBe('preserve me');
    });
  });

  describe('listAllForBuilder', () => {
    it('returns crons from CRON.md and workflows from workflows dir', () => {
      writeFileSync(TMP_CRON(), [
        '---',
        'type: core-system',
        'role: cron-config',
        'jobs:',
        '  - name: cron-a',
        "    schedule: '0 8 * * *'",
        '    prompt: hello',
        '    enabled: true',
        '    tier: 1',
        '  - name: cron-b',
        "    schedule: '0 9 * * *'",
        '    prompt: world',
        '    enabled: false',
        '    tier: 1',
        '---',
      ].join('\n'), 'utf-8');

      writeFileSync(path.join(TMP_WORKFLOWS(), 'wf-x.md'), [
        '---',
        'type: workflow',
        'name: wf-x',
        'description: test workflow',
        'enabled: true',
        'trigger:',
        '  manual: true',
        'steps:',
        '  - id: s1',
        '    prompt: do it',
        '    dependsOn: []',
        '    tier: 1',
        '    maxTurns: 15',
        '---',
        '',
        'Body content here.',
      ].join('\n'), 'utf-8');

      const list = listAllForBuilder();
      const ids = list.map(l => l.id);
      expect(ids).toContain(cronId('cron-a'));
      expect(ids).toContain(cronId('cron-b'));
      expect(ids).toContain(workflowId('wf-x'));

      const cronA = list.find(l => l.id === cronId('cron-a'));
      expect(cronA?.origin).toBe('cron');
      expect(cronA?.schedule).toBe('0 8 * * *');
      expect(cronA?.enabled).toBe(true);

      const wfX = list.find(l => l.id === workflowId('wf-x'));
      expect(wfX?.origin).toBe('workflow');
      expect(wfX?.description).toBe('test workflow');
    });

    it('returns empty array when neither file/dir exists', () => {
      // No setup beyond beforeEach (which mkdir's the workflows dir but not CRON.md)
      const list = listAllForBuilder();
      expect(list).toEqual([]);
    });
  });

  describe('readWorkflow', () => {
    it('reads a cron entry as a virtual single-step workflow', () => {
      writeFileSync(TMP_CRON(), [
        '---',
        'jobs:',
        '  - name: morning-briefing',
        "    schedule: '0 8 * * *'",
        '    prompt: brief me',
        '    enabled: true',
        '    tier: 1',
        '---',
      ].join('\n'), 'utf-8');

      const wf = readWorkflow(cronId('morning-briefing'));
      expect(wf).not.toBeNull();
      expect(wf!.steps).toHaveLength(1);
      expect(wf!.steps[0].prompt).toBe('brief me');
      expect(isCronShape(wf!)).toBe(true);
    });

    it('returns null for missing cron name', () => {
      writeFileSync(TMP_CRON(), '---\njobs: []\n---\n', 'utf-8');
      expect(readWorkflow(cronId('nope'))).toBeNull();
    });

    it('returns null for missing workflow file', () => {
      expect(readWorkflow(workflowId('missing'))).toBeNull();
    });
  });

  describe('saveWorkflow', () => {
    it('saves a cron entry back to CRON.md preserving other entries', () => {
      writeFileSync(TMP_CRON(), [
        '---',
        'jobs:',
        '  - name: alpha',
        "    schedule: '0 8 * * *'",
        '    prompt: alpha-prompt',
        '    enabled: true',
        '    tier: 1',
        '  - name: beta',
        "    schedule: '0 9 * * *'",
        '    prompt: beta-prompt',
        '    enabled: true',
        '    tier: 1',
        '---',
      ].join('\n'), 'utf-8');

      const wf = readWorkflow(cronId('alpha'))!;
      wf.steps[0].prompt = 'alpha-edited';
      const result = saveWorkflow(cronId('alpha'), wf);
      expect(result.ok).toBe(true);

      const written = readFileSync(TMP_CRON(), 'utf-8');
      expect(written).toContain('alpha-edited');
      expect(written).toContain('beta-prompt');  // other entry preserved
    });

    it('rejects saving a cron entry that is no longer cron-shaped', () => {
      writeFileSync(TMP_CRON(), [
        '---',
        'jobs:',
        '  - name: alpha',
        "    schedule: '0 8 * * *'",
        '    prompt: hello',
        '    enabled: true',
        '    tier: 1',
        '---',
      ].join('\n'), 'utf-8');

      const wf = readWorkflow(cronId('alpha'))!;
      wf.steps.push(stepOf({ id: 's2', prompt: 'second', dependsOn: ['main'] }));
      const result = saveWorkflow(cronId('alpha'), wf);
      expect(result.ok).toBe(false);
    });

    it('saves a workflow file round-trippably', () => {
      const wf: WorkflowDefinition = {
        name: 'roundtrip-wf',
        description: 'a test',
        enabled: true,
        trigger: { manual: true },
        inputs: {},
        steps: [
          stepOf({ id: 's1', prompt: 'one', dependsOn: [] }),
          stepOf({ id: 's2', prompt: 'two', dependsOn: ['s1'], kind: 'mcp', mcp: { server: 'gh', tool: 'list_prs' } }),
        ],
        sourceFile: '',
      };

      const result = saveWorkflow(workflowId('roundtrip-wf'), wf);
      expect(result.ok).toBe(true);

      const back = readWorkflow(workflowId('roundtrip-wf'));
      expect(back).not.toBeNull();
      expect(back!.name).toBe('roundtrip-wf');
      expect(back!.steps).toHaveLength(2);
      expect(back!.steps[1].kind).toBe('mcp');
      expect(back!.steps[1].mcp).toEqual({ server: 'gh', tool: 'list_prs' });
      expect(back!.steps[1].dependsOn).toEqual(['s1']);
    });
  });
});

// ── helpers ─────────────────────────────────────────────────────────

function stepOf(partial: Partial<WorkflowStep> & { id: string; prompt: string }): WorkflowStep {
  return {
    id: partial.id,
    prompt: partial.prompt,
    dependsOn: partial.dependsOn ?? [],
    tier: partial.tier ?? 1,
    maxTurns: partial.maxTurns ?? 15,
    model: partial.model,
    workDir: partial.workDir,
    kind: partial.kind,
    mcp: partial.mcp,
    channel: partial.channel,
    transform: partial.transform,
    conditional: partial.conditional,
    loop: partial.loop,
    canvas: partial.canvas,
  };
}
