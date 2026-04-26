import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFix } from '../src/gateway/fix-applier.js';
import type { AutoApplyAdvisorRule, AutoApplyPromptOverride } from '../src/gateway/failure-diagnostics.js';

describe('applyFix dispatch — kind: advisor-rule', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-fix-rule-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes a valid YAML rule to ~/.clementine/advisor-rules/user/<id>.yaml', () => {
    const autoApply: AutoApplyAdvisorRule = {
      kind: 'advisor-rule',
      ruleId: 'test-rule',
      yamlContent: [
        'schemaVersion: 1',
        'id: test-rule',
        'description: A test rule',
        'priority: 100',
        'when:',
        '  - kind: noRecentRuns',
        'then:',
        '  - kind: setModel',
        '    model: sonnet',
      ].join('\n'),
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(true);
    const written = path.join(baseDir, 'advisor-rules', 'user', 'test-rule.yaml');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf-8')).toContain('id: test-rule');
  });

  it('rejects YAML body whose id does not match ruleId', () => {
    const autoApply: AutoApplyAdvisorRule = {
      kind: 'advisor-rule',
      ruleId: 'declared-id',
      yamlContent: 'schemaVersion: 1\nid: different-id\ndescription: x\npriority: 1\nwhen: []\nthen: []',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('id must match');
  });

  it('rejects body that does not parse as YAML', () => {
    const autoApply: AutoApplyAdvisorRule = {
      kind: 'advisor-rule',
      ruleId: 'broken',
      yamlContent: 'not: { valid yaml',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(false);
  });

  it('rejects body missing schemaVersion', () => {
    const autoApply: AutoApplyAdvisorRule = {
      kind: 'advisor-rule',
      ruleId: 'no-schema',
      yamlContent: 'id: no-schema\ndescription: x\npriority: 1\nwhen: []\nthen: []',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('schemaVersion');
  });

  it('dry-run does not write', () => {
    const autoApply: AutoApplyAdvisorRule = {
      kind: 'advisor-rule',
      ruleId: 'dry-test',
      yamlContent: 'schemaVersion: 1\nid: dry-test\ndescription: x\npriority: 1\nwhen: []\nthen: []',
    };
    const result = applyFix('any-job', autoApply, { baseDir, dryRun: true });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(baseDir, 'advisor-rules', 'user', 'dry-test.yaml'))).toBe(false);
  });
});

describe('applyFix dispatch — kind: prompt-override', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-fix-prompt-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes a global override to _global.md', () => {
    const autoApply: AutoApplyPromptOverride = {
      kind: 'prompt-override',
      scope: 'global',
      content: 'Global guidance.',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(true);
    const written = path.join(baseDir, 'prompt-overrides', '_global.md');
    expect(readFileSync(written, 'utf-8')).toBe('Global guidance.');
  });

  it('writes an agent override to agents/<slug>.md', () => {
    const autoApply: AutoApplyPromptOverride = {
      kind: 'prompt-override',
      scope: 'agent',
      scopeKey: 'ross-the-sdr',
      content: 'Ross-specific rule.',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(true);
    const written = path.join(baseDir, 'prompt-overrides', 'agents', 'ross-the-sdr.md');
    expect(readFileSync(written, 'utf-8')).toBe('Ross-specific rule.');
  });

  it('writes a job override to jobs/<jobName>.md', () => {
    const autoApply: AutoApplyPromptOverride = {
      kind: 'prompt-override',
      scope: 'job',
      scopeKey: 'market-leader-followup',
      content: 'Use batches of 50.',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(true);
    const written = path.join(baseDir, 'prompt-overrides', 'jobs', 'market-leader-followup.md');
    expect(readFileSync(written, 'utf-8')).toBe('Use batches of 50.');
  });

  it('rejects scopeKey containing path separators', () => {
    const autoApply: AutoApplyPromptOverride = {
      kind: 'prompt-override',
      scope: 'job',
      scopeKey: '../../../etc/passwd',
      content: 'pwned',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('cannot contain');
  });

  it('rejects scope=agent without scopeKey', () => {
    const autoApply: AutoApplyPromptOverride = {
      kind: 'prompt-override',
      scope: 'agent',
      content: 'no scope key',
    };
    const result = applyFix('any-job', autoApply, { baseDir });
    expect(result.ok).toBe(false);
  });
});

describe('applyFix dispatch — back-compat with kind-less cron objects', () => {
  it('treats absent kind as cron', () => {
    // Build an auto-apply object the OLD shape (no kind), pass to dispatch.
    // This exercises the back-compat path; cron file resolution will fail
    // (no fixture CRON.md), but we just want to confirm dispatch chose the
    // cron path and not a different kind.
    const result = applyFix('nonexistent-job', { operations: [{ op: 'set', field: 'max_turns', value: 10 }] } as any);
    // Result is "No CRON.md found" — that's the cron path failing,
    // which proves dispatch went to applyCronFix (not advisor-rule or prompt-override).
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/CRON\.md|not found/i);
  });
});
