/**
 * 1.18.190 — bg-planner tests.
 *
 * Pin three contracts:
 *   1. planRequest produces a valid Plan from a structured-JSON LLM response
 *   2. parsePlannerResponse handles common LLM wrappers (markdown fences,
 *      prose-wrapped JSON, etc.) defensively
 *   3. savePlan / loadPlan round-trip through disk (project-scoped + global)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planRequest,
  parsePlannerResponse,
  savePlan,
  loadPlan,
  plansDir,
  planFile,
  PlanGenerationError,
  type Plan,
} from '../src/agent/bg-planner.js';

// ── planRequest (LLM-driven decomposition) ──────────────────────────

describe('planRequest', () => {
  it('produces a valid Plan from a clean JSON response', async () => {
    const fakeLlm = async () => JSON.stringify({
      steps: [
        { title: 'Find the catalog project', scope: 'Run project_discover, link the match', expectedTools: ['project_discover', 'project_link'], deliverable: 'project linked' },
        { title: 'Read source data', scope: 'Bash head/awk on the CSV', expectedTools: ['Bash'], deliverable: '/path/to/sources/catalog.csv summarized' },
        { title: 'Build HTML', scope: 'Write output/index.html', expectedTools: ['Write'], deliverable: 'output/index.html' },
        { title: 'Deploy', scope: 'project_deploy', expectedTools: ['project_deploy'], deliverable: 'https://x.netlify.app' },
        { title: 'Verify', scope: 'curl the URL, expect 200', expectedTools: ['Bash'], deliverable: 'HTTP 200 confirmation' },
      ],
      estimatedCostUsd: 0.45,
      notes: 'Project needs to be linked first',
    });

    const plan = await planRequest({
      userRequest: 'build me an HTML report for catalog and deploy',
      llmCall: fakeLlm,
    });

    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[0]?.title).toBe('Find the catalog project');
    expect(plan.steps[0]?.expectedTools).toContain('project_discover');
    expect(plan.steps[0]?.status).toBe('pending');
    expect(plan.steps[0]?.index).toBe(0);
    expect(plan.steps[4]?.index).toBe(4);
    expect(plan.estimatedCostUsd).toBe(0.45);
    expect(plan.notes).toContain('linked');
    expect(plan.userRequest).toBe('build me an HTML report for catalog and deploy');
    expect(plan.chainId).toMatch(/^chain-/);
    expect(plan.id).toMatch(/^plan-/);
    expect(plan.status).toBe('pending');
  });

  it('caps at 12 steps when the LLM over-decomposes', async () => {
    const tooManySteps = Array.from({ length: 20 }, (_, i) => ({
      title: `Step ${i}`,
      scope: 'something',
      expectedTools: [],
    }));
    const fakeLlm = async () => JSON.stringify({ steps: tooManySteps });
    const plan = await planRequest({ userRequest: 'do everything', llmCall: fakeLlm });
    expect(plan.steps).toHaveLength(12);
  });

  it('throws PlanGenerationError when LLM returns no parseable JSON', async () => {
    const fakeLlm = async () => 'Sorry, I cannot decompose this.';
    await expect(
      planRequest({ userRequest: 'whatever', llmCall: fakeLlm }),
    ).rejects.toThrow(PlanGenerationError);
  });

  it('throws PlanGenerationError when JSON has empty steps array', async () => {
    const fakeLlm = async () => JSON.stringify({ steps: [] });
    await expect(
      planRequest({ userRequest: 'whatever', llmCall: fakeLlm }),
    ).rejects.toThrow(PlanGenerationError);
  });

  it('includes project context when an active project is set', async () => {
    let capturedUserPrompt = '';
    const fakeLlm = async (userPrompt: string) => {
      capturedUserPrompt = userPrompt;
      return JSON.stringify({
        steps: [{ title: 'Do thing', scope: 'thing', expectedTools: [] }],
      });
    };
    await planRequest({
      userRequest: 'continue work on catalog',
      project: {
        path: '/Users/me/Projects/catalog',
        description: '100 product records migration',
        keywords: ['catalog'],
      },
      llmCall: fakeLlm,
    });
    expect(capturedUserPrompt).toContain('/Users/me/Projects/catalog');
    expect(capturedUserPrompt).toContain('100 product records migration');
  });

  it('preserves originatingSessionKey on the Plan', async () => {
    const fakeLlm = async () => JSON.stringify({
      steps: [{ title: 'Do thing', scope: 'thing', expectedTools: [] }],
    });
    const plan = await planRequest({
      userRequest: 'do thing',
      originatingSessionKey: 'discord:user:abc',
      llmCall: fakeLlm,
    });
    expect(plan.originatingSessionKey).toBe('discord:user:abc');
  });
});

// ── parsePlannerResponse (defensive JSON parsing) ────────────────────

describe('parsePlannerResponse', () => {
  it('parses pure JSON', () => {
    const result = parsePlannerResponse('{"steps":[{"title":"X"}]}');
    expect(result?.steps).toHaveLength(1);
  });

  it('strips ```json fences', () => {
    const text = '```json\n{"steps":[{"title":"X"}]}\n```';
    const result = parsePlannerResponse(text);
    expect(result?.steps).toHaveLength(1);
  });

  it('strips bare ``` fences', () => {
    const text = '```\n{"steps":[{"title":"X"}]}\n```';
    const result = parsePlannerResponse(text);
    expect(result?.steps).toHaveLength(1);
  });

  it('extracts the JSON block when the LLM adds prose', () => {
    const text = 'Here is your plan:\n\n{"steps":[{"title":"X"}]}\n\nLet me know.';
    const result = parsePlannerResponse(text);
    expect(result?.steps).toHaveLength(1);
  });

  it('returns null on garbage', () => {
    expect(parsePlannerResponse('not json at all')).toBeNull();
    expect(parsePlannerResponse('')).toBeNull();
    expect(parsePlannerResponse('   ')).toBeNull();
  });

  it('returns null on JSON that is not an object', () => {
    expect(parsePlannerResponse('[1,2,3]')).toBeNull();
    expect(parsePlannerResponse('"just a string"')).toBeNull();
  });
});

// ── savePlan / loadPlan (disk persistence) ───────────────────────────

describe('plan persistence', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-plan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  function makePlan(): Plan {
    return {
      id: 'plan-abc',
      chainId: 'chain-xyz',
      userRequest: 'do thing',
      createdAt: new Date().toISOString(),
      steps: [
        { index: 0, title: 'Step 1', scope: 'do it', expectedTools: ['Read'], status: 'pending' },
      ],
      status: 'pending',
    };
  }

  it('saves to .clementine/plans/<id>.json inside the project', () => {
    const plan: Plan = { ...makePlan(), projectPath: tmpProject };
    const file = savePlan(plan, tmpProject);
    expect(file).toBe(path.join(tmpProject, '.clementine', 'plans', 'plan-abc.json'));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('loadPlan round-trips through disk', () => {
    const plan: Plan = { ...makePlan(), projectPath: tmpProject };
    savePlan(plan, tmpProject);
    const loaded = loadPlan('plan-abc', tmpProject);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('plan-abc');
    expect(loaded?.userRequest).toBe('do thing');
    expect(loaded?.steps).toHaveLength(1);
  });

  it('plansDir defaults to BASE_DIR/plans when no project is set', () => {
    const dir = plansDir();
    expect(dir).toMatch(/plans$/);
    expect(dir).not.toContain(tmpProject);
  });

  it('planFile sanitizes the id (no path traversal)', () => {
    const f = planFile('../../../etc/passwd', tmpProject);
    expect(f).not.toContain('..');
    expect(f).toMatch(/etc_passwd\.json$/);
  });

  it('loadPlan returns null for non-existent plans', () => {
    const loaded = loadPlan('does-not-exist', tmpProject);
    expect(loaded).toBeNull();
  });

  it('loadPlan returns null for corrupt JSON without throwing', () => {
    fs.mkdirSync(path.join(tmpProject, '.clementine', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, '.clementine', 'plans', 'corrupt.json'), 'not json {{{');
    const loaded = loadPlan('corrupt', tmpProject);
    expect(loaded).toBeNull();
  });
});
