/**
 * 1.18.187 — pin the new turn-context behaviors:
 *  - Active project block (Part B)
 *  - Dispute mode (Part E) suppresses `done` bg-task recall + adds directive
 *  - ⚠ CLAIM NOT VERIFIED warning when bg-task is flagged (Part D feedback)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClementineTurnContext } from '../src/agent/clementine-turn-context.js';
import type { BackgroundTask } from '../src/types.js';

const FIXED_NOW = 1_762_000_000_000;
const NOW = () => FIXED_NOW;

let tmpProject: string;

beforeEach(() => {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-project-'));
});
afterEach(() => {
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

// ── Active project block ─────────────────────────────────────────────

describe('Active project block (1.18.187 Part B)', () => {
  it('renders project path, STATUS.md preview, and layout summary', () => {
    fs.mkdirSync(path.join(tmpProject, '.clementine'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.clementine', 'STATUS.md'),
      '# Product Site\n\nLinked 2026-05-12. First task: HTML report.',
    );
    fs.mkdirSync(path.join(tmpProject, 'sources'), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, 'sources', 'products.csv'), 'col,a\n1,2');
    fs.mkdirSync(path.join(tmpProject, 'output'), { recursive: true });

    const result = buildClementineTurnContext({
      userMessage: 'build me a report',
      sessionKey: 'chat',
      activeProject: {
        path: tmpProject,
        description: 'Product site migration',
        keywords: ['products'],
      },
      now: NOW,
    });

    expect(result.sections.activeProject).toBe(true);
    expect(result.block).toContain('Active project');
    expect(result.block).toContain(tmpProject);
    expect(result.block).toContain('STATUS.md');
    expect(result.block).toContain('Linked 2026-05-12');
    expect(result.block).toContain('sources/');
    expect(result.block).toContain('output/');
  });

  it('renders deploy config when .clementine/deploy.json present', () => {
    fs.mkdirSync(path.join(tmpProject, '.clementine'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.clementine', 'deploy.json'),
      JSON.stringify({
        kind: 'netlify',
        site: 'my-site',
        dir: 'output',
        verifyUrl: 'https://my-site.netlify.app/',
      }),
    );
    const result = buildClementineTurnContext({
      userMessage: 'redeploy',
      sessionKey: 'chat',
      activeProject: { path: tmpProject },
      now: NOW,
    });
    expect(result.block).toContain('Deploy config');
    expect(result.block).toContain('my-site');
    expect(result.block).toContain('project_deploy');
  });

  it('renders custom deploy commands without requiring Netlify', () => {
    fs.mkdirSync(path.join(tmpProject, '.clementine'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.clementine', 'deploy.json'),
      JSON.stringify({
        kind: 'custom',
        command: 'npm run deploy',
        verifyUrl: 'https://example.com/',
      }),
    );
    const result = buildClementineTurnContext({
      userMessage: 'deploy',
      sessionKey: 'chat',
      activeProject: { path: tmpProject },
      now: NOW,
    });
    expect(result.block).toContain('custom');
    expect(result.block).toContain('npm run deploy');
    expect(result.block).toContain('project_deploy');
  });

  it('suggests creating deploy.json when missing', () => {
    const result = buildClementineTurnContext({
      userMessage: 'deploy this',
      sessionKey: 'chat',
      activeProject: { path: tmpProject },
      now: NOW,
    });
    expect(result.block).toContain('No deploy config');
    expect(result.block).toContain('.clementine/deploy.json');
    expect(result.block).toContain('"custom"');
  });

  it('skips the block when activeProject path does not exist', () => {
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'chat',
      activeProject: { path: '/nonexistent/path/x' },
      now: NOW,
    });
    expect(result.sections.activeProject).toBe(false);
  });

  it('skips the block when activeProject is null', () => {
    const result = buildClementineTurnContext({
      userMessage: 'hi',
      sessionKey: 'chat',
      activeProject: null,
      now: NOW,
    });
    expect(result.sections.activeProject).toBe(false);
  });
});

// ── Dispute mode (Part E) ────────────────────────────────────────────

describe('Dispute mode (1.18.187 Part E)', () => {
  it('detects dispute pattern and adds verification posture directive', () => {
    const result = buildClementineTurnContext({
      userMessage: 'its saying site not found when i open it',
      sessionKey: 'chat',
      now: NOW,
    });
    expect(result.sections.disputeDetected).toBe(true);
    expect(result.block).toContain('Dispute mode');
    expect(result.block).toContain('verification posture');
  });

  it('does NOT detect dispute on neutral message', () => {
    const result = buildClementineTurnContext({
      userMessage: 'hi, anything new today?',
      sessionKey: 'chat',
      now: NOW,
    });
    expect(result.sections.disputeDetected).toBe(false);
    expect(result.block).not.toContain('Dispute mode');
  });

  it('suppresses `done` bg tasks under dispute mode', () => {
    const doneTask: BackgroundTask = {
      id: 'bg-done',
      fromAgent: 'clementine',
      prompt: 'deploy the site',
      maxMinutes: 5,
      status: 'done',
      createdAt: new Date(FIXED_NOW - 3 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 2 * 3600_000).toISOString(),
      result: 'Deployed to site.netlify.app',
    };
    const failedTask: BackgroundTask = {
      id: 'bg-failed',
      fromAgent: 'clementine',
      prompt: 'budget thing',
      maxMinutes: 5,
      status: 'failed',
      createdAt: new Date(FIXED_NOW - 5 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 4 * 3600_000).toISOString(),
      error: 'budget cap',
    };
    const listBg = (filter: { status?: string }) => {
      if (filter.status === 'done') return [doneTask];
      if (filter.status === 'failed') return [failedTask];
      return [];
    };
    const result = buildClementineTurnContext({
      userMessage: 'site is broken',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      now: NOW,
    });
    // Dispute fired — done items suppressed, failed items kept.
    expect(result.sections.disputeDetected).toBe(true);
    expect(result.block).not.toContain('Deployed to site.netlify.app');
    expect(result.block).toContain('budget cap');
  });

  it('includes `done` bg tasks normally (no dispute)', () => {
    const doneTask: BackgroundTask = {
      id: 'bg-done',
      fromAgent: 'clementine',
      prompt: 'deploy the site',
      maxMinutes: 5,
      status: 'done',
      createdAt: new Date(FIXED_NOW - 3 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 2 * 3600_000).toISOString(),
      result: 'Deployed to site.netlify.app',
    };
    const listBg = (filter: { status?: string }) => {
      if (filter.status === 'done') return [doneTask];
      return [];
    };
    const result = buildClementineTurnContext({
      userMessage: 'what did you do today?',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      now: NOW,
    });
    expect(result.sections.disputeDetected).toBe(false);
    expect(result.block).toContain('Deployed to site.netlify.app');
  });
});

// ── Flagged bg-task warning (Part D feedback) ────────────────────────

describe('Flagged bg-task warning (1.18.187 Part D feedback)', () => {
  it('marks ⚠ CLAIM NOT VERIFIED on flagged tasks', () => {
    const flaggedTask: BackgroundTask = {
      id: 'bg-flagged',
      fromAgent: 'clementine',
      prompt: 'deploy something',
      maxMinutes: 5,
      status: 'done',
      createdAt: new Date(FIXED_NOW - 1 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 50 * 60_000).toISOString(),
      result: 'I deployed the site successfully.',
      verificationFlag: 'claimed-without-evidence',
      verificationDetails: 'deploy: expected any of {netlify deploy, vercel deploy} — none found',
    };
    const listBg = (filter: { status?: string }) => {
      if (filter.status === 'done') return [flaggedTask];
      return [];
    };
    const result = buildClementineTurnContext({
      userMessage: 'what happened',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      now: NOW,
    });
    expect(result.block).toContain('CLAIM NOT VERIFIED');
  });

  it('does NOT mark unflagged tasks', () => {
    const normalTask: BackgroundTask = {
      id: 'bg-normal',
      fromAgent: 'clementine',
      prompt: 'do thing',
      maxMinutes: 5,
      status: 'done',
      createdAt: new Date(FIXED_NOW - 1 * 3600_000).toISOString(),
      completedAt: new Date(FIXED_NOW - 50 * 60_000).toISOString(),
      result: 'Done.',
    };
    const listBg = (filter: { status?: string }) => {
      if (filter.status === 'done') return [normalTask];
      return [];
    };
    const result = buildClementineTurnContext({
      userMessage: 'what happened',
      sessionKey: 'chat',
      listBackgroundTasks: listBg,
      now: NOW,
    });
    expect(result.block).not.toContain('CLAIM NOT VERIFIED');
  });
});
