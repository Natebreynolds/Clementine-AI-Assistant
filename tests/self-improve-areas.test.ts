/**
 * Phase 5 — self-improve area additions: advisor-rule + prompt-override.
 * Plus: source area is rejected up front (deprecated).
 */
import { describe, expect, it } from 'vitest';
import { validateProposal, promptOverridePathForTarget } from '../src/agent/self-improve.js';

describe('validateProposal — advisor-rule', () => {
  const goodYaml = [
    'schemaVersion: 1',
    'id: my-rule',
    'description: a rule',
    'priority: 100',
    'when:',
    '  - kind: noRecentRuns',
    'then:',
    '  - kind: setModel',
    '    model: sonnet',
  ].join('\n');

  it('accepts a well-formed advisor rule whose id matches target', () => {
    const r = validateProposal('advisor-rule', 'my-rule', goodYaml);
    expect(r.valid).toBe(true);
  });

  it('rejects when id does not match target', () => {
    const r = validateProposal('advisor-rule', 'expected-id', goodYaml);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('id must match');
  });

  it('rejects target that is not kebab-case', () => {
    const r = validateProposal('advisor-rule', 'NotKebab', goodYaml);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('kebab-case');
  });

  it('rejects body missing schemaVersion: 1', () => {
    const yaml = 'id: my-rule\ndescription: x\npriority: 100\nwhen: []\nthen: []';
    const r = validateProposal('advisor-rule', 'my-rule', yaml);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('schemaVersion');
  });

  it('rejects body missing when[]', () => {
    const yaml = 'schemaVersion: 1\nid: my-rule\ndescription: x\npriority: 100\nthen: []';
    const r = validateProposal('advisor-rule', 'my-rule', yaml);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('when[]');
  });

  it('rejects unparseable YAML', () => {
    const r = validateProposal('advisor-rule', 'broken', '{ not: valid }: : :');
    expect(r.valid).toBe(false);
  });
});

describe('validateProposal — prompt-override', () => {
  it('accepts global', () => {
    const r = validateProposal('prompt-override', 'global', 'some markdown body');
    expect(r.valid).toBe(true);
  });

  it('accepts agent:<slug>', () => {
    const r = validateProposal('prompt-override', 'agent:ross-the-sdr', 'body');
    expect(r.valid).toBe(true);
  });

  it('accepts job:<jobName>', () => {
    const r = validateProposal('prompt-override', 'job:market-leader-followup', 'body');
    expect(r.valid).toBe(true);
  });

  it('rejects malformed target', () => {
    const r = validateProposal('prompt-override', 'something-else', 'body');
    expect(r.valid).toBe(false);
  });

  it('rejects oversized content (>20KB)', () => {
    const huge = 'x'.repeat(20_001);
    const r = validateProposal('prompt-override', 'global', huge);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('20KB');
  });
});

describe('validateProposal — source area is deprecated', () => {
  it('rejects source proposals up front (Phase 1 quarantine)', () => {
    const r = validateProposal('source', 'agent/foo.ts', 'export const x = 1;');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('deprecated');
  });
});

describe('promptOverridePathForTarget', () => {
  it('global → _global.md', () => {
    expect(promptOverridePathForTarget('global')).toMatch(/_global\.md$/);
  });

  it('agent:<slug> → agents/<slug>.md', () => {
    expect(promptOverridePathForTarget('agent:ross-the-sdr')).toMatch(/agents\/ross-the-sdr\.md$/);
  });

  it('job:<jobName> → jobs/<jobName>.md', () => {
    expect(promptOverridePathForTarget('job:market-leader-followup')).toMatch(/jobs\/market-leader-followup\.md$/);
  });

  it('rejects path traversal in scopeKey', () => {
    expect(promptOverridePathForTarget('job:../../../etc/passwd')).toBeNull();
  });

  it('rejects malformed targets', () => {
    expect(promptOverridePathForTarget('agent')).toBeNull();          // no colon
    expect(promptOverridePathForTarget('agent:')).toBeNull();         // empty key
    expect(promptOverridePathForTarget('something:weird')).toBeNull();// unknown scope
  });
});
