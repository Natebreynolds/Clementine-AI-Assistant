import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dispatchWebhookActions,
  loadWebhookActionConfig,
  logWebhookEvent,
  recentWebhookEvents,
  renderTemplate,
  ruleMatches,
  type WebhookActionRule,
} from '../src/agent/webhook-actions.js';

describe('webhook-actions matcher', () => {
  it('matches an empty rule against any payload (match-all)', () => {
    const rule: WebhookActionRule = { do: 'wake_agent', agent: 'a' };
    expect(ruleMatches(rule, { anything: 'goes' })).toBe(true);
    expect(ruleMatches(rule, {})).toBe(true);
  });

  it('matches exact field values (string, number, boolean)', () => {
    const rule: WebhookActionRule = {
      do: 'wake_agent',
      agent: 'a',
      match: { action: 'opened', priority: 3, urgent: true },
    };
    expect(ruleMatches(rule, { action: 'opened', priority: 3, urgent: true })).toBe(true);
    expect(ruleMatches(rule, { action: 'closed', priority: 3, urgent: true })).toBe(false);
  });

  it('uses dot-paths for nested fields', () => {
    const rule: WebhookActionRule = {
      do: 'wake_agent',
      agent: 'a',
      match: { 'pull_request.state': 'open', 'sender.login': 'natebreynolds' },
    };
    expect(ruleMatches(rule, {
      pull_request: { state: 'open' },
      sender: { login: 'natebreynolds' },
    })).toBe(true);
    expect(ruleMatches(rule, {
      pull_request: { state: 'closed' },
      sender: { login: 'natebreynolds' },
    })).toBe(false);
  });

  it('supports "*" wildcard for "field present, any value"', () => {
    const rule: WebhookActionRule = {
      do: 'wake_agent',
      agent: 'a',
      match: { 'pull_request': '*' },
    };
    expect(ruleMatches(rule, { pull_request: { id: 1 } })).toBe(true);
    expect(ruleMatches(rule, { pull_request: 'anything' })).toBe(true);
    expect(ruleMatches(rule, { issue: { id: 1 } })).toBe(false);
    expect(ruleMatches(rule, { pull_request: null })).toBe(false);
  });

  it('returns false for missing nested paths (no exception)', () => {
    const rule: WebhookActionRule = {
      do: 'wake_agent',
      agent: 'a',
      match: { 'a.b.c.d': 'x' },
    };
    expect(ruleMatches(rule, {})).toBe(false);
    expect(ruleMatches(rule, { a: 1 })).toBe(false);
    expect(ruleMatches(rule, { a: { b: null } })).toBe(false);
  });

  it('coerces loosely (1 == "1") so JSON-string ints still match', () => {
    const rule: WebhookActionRule = { do: 'wake_agent', agent: 'a', match: { count: 5 } };
    expect(ruleMatches(rule, { count: '5' })).toBe(true);
    expect(ruleMatches(rule, { count: 5 })).toBe(true);
    expect(ruleMatches(rule, { count: 6 })).toBe(false);
  });
});

describe('webhook-actions template renderer', () => {
  it('substitutes {{ field }} from payload', () => {
    expect(renderTemplate('Hello {{ name }}', { name: 'Ross' })).toBe('Hello Ross');
  });

  it('handles dot-path interpolation', () => {
    expect(renderTemplate('PR #{{ pull_request.number }} opened', {
      pull_request: { number: 42 },
    })).toBe('PR #42 opened');
  });

  it('renders missing fields as empty strings', () => {
    expect(renderTemplate('Hello {{ missing.path }}!', {})).toBe('Hello !');
  });

  it('JSON-stringifies object values (caller asked for the whole sub-tree)', () => {
    expect(renderTemplate('Data: {{ obj }}', { obj: { a: 1, b: 'x' } })).toBe('Data: {"a":1,"b":"x"}');
  });

  it('ignores unbalanced template syntax', () => {
    expect(renderTemplate('Hello {{ name', { name: 'X' })).toBe('Hello {{ name');
    expect(renderTemplate('Hello }} name', { name: 'X' })).toBe('Hello }} name');
  });
});

describe('webhook-actions dispatch', () => {
  let baseDir: string;
  let configPath: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-wha-'));
    configPath = path.join(baseDir, 'webhook-actions.json');
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('dispatches wake_agent by writing a wake sentinel file', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: [
          {
            source: 'github',
            secret: 'test',
            on: [
              {
                match: { action: 'opened', pull_request: '*' },
                do: 'wake_agent',
                agent: 'ross-the-sdr',
                reason: 'PR #{{ pull_request.number }} opened by {{ sender.login }}',
              },
            ],
          },
        ],
      }),
    );

    const result = dispatchWebhookActions(
      'github',
      {
        action: 'opened',
        pull_request: { number: 7, title: 'Add thing' },
        sender: { login: 'natebreynolds' },
      },
      { configPath, baseDir },
    );

    expect(result.matched).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.errors).toEqual([]);

    const sentinel = path.join(baseDir, 'heartbeat', 'wake', 'ross-the-sdr.json');
    expect(existsSync(sentinel)).toBe(true);
    const written = JSON.parse(readFileSync(sentinel, 'utf-8'));
    expect(written.targetSlug).toBe('ross-the-sdr');
    expect(written.fromSlug).toBe('webhook:github');
    expect(written.reason).toBe('PR #7 opened by natebreynolds');
  });

  it('dispatches start_background_task by creating a task with rendered prompt', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: [
          {
            source: 'salesforce',
            secret: 'test',
            on: [
              {
                match: { event: 'opportunity_updated' },
                do: 'start_background_task',
                agent: 'sasha-the-cmo',
                prompt: 'Opportunity {{ Opportunity.Name }} changed (stage: {{ Opportunity.StageName }}). Refresh the brief.',
                maxMinutes: 45,
              },
            ],
          },
        ],
      }),
    );

    const result = dispatchWebhookActions(
      'salesforce',
      {
        event: 'opportunity_updated',
        Opportunity: { Name: 'Acme Renewal', StageName: 'Negotiation' },
      },
      { configPath, baseDir },
    );

    expect(result.matched).toBe(1);
    expect(result.dispatched).toBe(1);
    // Background task should have been written under baseDir/background-tasks
    const bgDir = path.join(baseDir, 'background-tasks');
    const files = readdirSync(bgDir).filter((f: string) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const task = JSON.parse(readFileSync(path.join(bgDir, files[0]), 'utf-8'));
    expect(task.fromAgent).toBe('sasha-the-cmo');
    expect(task.prompt).toBe('Opportunity Acme Renewal changed (stage: Negotiation). Refresh the brief.');
    expect(task.maxMinutes).toBe(45);
    expect(task.status).toBe('pending');
  });

  it('skips rules that do not match and reports 0 dispatched', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: [
          {
            source: 'github',
            secret: 'test',
            on: [
              { match: { action: 'opened' }, do: 'wake_agent', agent: 'a' },
              { match: { action: 'closed' }, do: 'wake_agent', agent: 'b' },
            ],
          },
        ],
      }),
    );

    const result = dispatchWebhookActions('github', { action: 'opened' }, { configPath, baseDir });
    expect(result.matched).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.log[0].rule.agent).toBe('a');
  });

  it('returns an error when no config exists for the source', () => {
    writeFileSync(configPath, JSON.stringify({ hooks: [] }));
    const result = dispatchWebhookActions('unknown', {}, { configPath, baseDir });
    expect(result.matched).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(result.errors[0]).toMatch(/No webhook-action config/);
  });

  it('flags start_background_task rules missing a prompt', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: [
          {
            source: 'x',
            secret: 'test',
            on: [{ do: 'start_background_task', agent: 'sasha' }],
          },
        ],
      }),
    );
    const result = dispatchWebhookActions('x', {}, { configPath, baseDir });
    expect(result.matched).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.errors[0]).toMatch(/no `prompt` template/);
  });
});

describe('webhook-actions event log', () => {
  let logDir: string;
  let logPath: string;

  beforeEach(() => {
    logDir = mkdtempSync(path.join(tmpdir(), 'clementine-whlog-'));
    logPath = path.join(logDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it('appends events and reads them back newest-first', () => {
    logWebhookEvent({
      timestamp: '2026-04-25T10:00:00.000Z',
      source: 'github',
      verified: true,
      matched: 1,
      dispatched: 1,
      errors: [],
      payloadPreview: 'pr opened',
    }, { logPath, logDir });
    logWebhookEvent({
      timestamp: '2026-04-25T11:00:00.000Z',
      source: 'salesforce',
      verified: false,
      matched: 0,
      dispatched: 0,
      errors: ['HMAC mismatch'],
      payloadPreview: '...',
    }, { logPath, logDir });

    const recent = recentWebhookEvents(50, { logPath });
    expect(recent.length).toBe(2);
    expect(recent[0].source).toBe('salesforce');
    expect(recent[1].source).toBe('github');
  });
});

describe('webhook-actions config loader', () => {
  let configPath: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-whcfg-'));
    configPath = path.join(dir, 'webhook-actions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty config when file missing', () => {
    const cfg = loadWebhookActionConfig({ configPath });
    expect(cfg.hooks).toEqual([]);
  });

  it('returns empty config when JSON is malformed', () => {
    writeFileSync(configPath, 'not valid json');
    const cfg = loadWebhookActionConfig({ configPath });
    expect(cfg.hooks).toEqual([]);
  });
});
