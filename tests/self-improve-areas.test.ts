/**
 * Phase 5 — self-improve area additions: advisor-rule + prompt-override.
 * Plus: source area is rejected up front (deprecated).
 */
import { describe, expect, it } from 'vitest';
import {
  buildUserModelMarkdown,
  normalizeUserModelSlots,
  promptOverridePathForTarget,
  reconcileSelfImproveStateSnapshot,
  sanitizeUserModelFrontmatter,
  shouldAppendPlateauMarker,
  shouldSkipSelfImproveForPlateau,
  validateProposal,
} from '../src/agent/self-improve.js';
import type { SelfImproveState } from '../src/types.js';

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

describe('self-improve state reconciliation', () => {
  function state(overrides: Partial<SelfImproveState> = {}): SelfImproveState {
    return {
      status: 'idle',
      lastRunAt: '',
      currentIteration: 0,
      totalExperiments: 0,
      baselineMetrics: { feedbackPositiveRatio: 1, cronSuccessRate: 1, avgResponseQuality: 0 },
      pendingApprovals: 0,
      ...overrides,
    };
  }

  it('clears stale running state and records a diagnostic', () => {
    const started = new Date('2026-05-01T00:00:00.000Z').toISOString();
    const out = reconcileSelfImproveStateSnapshot(
      state({ status: 'running', lastRunAt: started, currentIteration: 3 }),
      0,
      {
        nowMs: Date.parse('2026-05-01T02:00:00.000Z'),
        maxDurationMs: 60 * 60 * 1000,
        graceMs: 0,
      },
    );
    expect(out.changed).toBe(true);
    expect(out.state.status).toBe('failed');
    expect(out.state.currentIteration).toBe(0);
    expect(out.state.lastDiagnostic).toContain('Stale self-improve run cleared');
  });

  it('reconciles pending approval drift without changing healthy status', () => {
    const out = reconcileSelfImproveStateSnapshot(state({ pendingApprovals: 4 }), 1);
    expect(out.changed).toBe(true);
    expect(out.state.pendingApprovals).toBe(1);
    expect(out.state.status).toBe('idle');
  });
});

describe('self-improve plateau helpers', () => {
  const plateau = {
    startedAt: '2026-05-01T00:00:00.000Z',
    finishedAt: '2026-05-01T00:05:00.000Z',
    reason: 'Plateau: no novel improvement area remaining',
    hypothesis: 'No new hypothesis — diversity constraint exhausted',
  };

  it('skips when no evidence is newer than the latest plateau', () => {
    const out = shouldSkipSelfImproveForPlateau([plateau], {
      feedbackCreatedAt: ['2026-04-30T23:00:00.000Z'],
      triggerCount: 0,
    });
    expect(out.skip).toBe(true);
  });

  it('does not skip when fresh evidence exists or user model needs seeding', () => {
    expect(shouldSkipSelfImproveForPlateau([plateau], {
      feedbackCreatedAt: ['2026-05-01T01:00:00.000Z'],
    }).skip).toBe(false);
    expect(shouldSkipSelfImproveForPlateau([plateau], {
      triggerCount: 1,
      triggerUpdatedAt: ['2026-05-01T01:00:00.000Z'],
    }).skip).toBe(false);
    expect(shouldSkipSelfImproveForPlateau([plateau], {
      userModelNeedsSeed: true,
    }).skip).toBe(false);
  });

  it('does not treat stale trigger count alone as fresh evidence', () => {
    expect(shouldSkipSelfImproveForPlateau([plateau], {
      triggerCount: 1,
    }).skip).toBe(true);
  });

  it('dedupes plateau markers within the configured window', () => {
    expect(shouldAppendPlateauMarker([plateau], Date.parse('2026-05-01T12:00:00.000Z'))).toBe(false);
    expect(shouldAppendPlateauMarker([plateau], Date.parse('2026-05-02T01:00:01.000Z'))).toBe(true);
  });
});

describe('user model synthesis helpers', () => {
  it('normalizes only supported populated slots', () => {
    const slots = normalizeUserModelSlots({
      user_facts: ' Nathan prefers concise updates ',
      goals: ['ship Clementine', 'reduce latency'],
      unsupported: 'ignore me',
      relationships: '',
    });
    expect(slots.user_facts).toBe('Nathan prefers concise updates');
    expect(slots.goals).toContain('- ship Clementine');
    expect(slots).not.toHaveProperty('unsupported');
    expect(slots.relationships).toBeUndefined();
  });

  it('builds a markdown artifact while keeping DB slots as source of truth', () => {
    const md = buildUserModelMarkdown('confidence_scores:\n  communication: 0.8', {
      user_facts: 'Nathan is technical.',
      agent_persona: 'Be direct.',
    }, '2026-05-01T00:00:00.000Z');
    expect(md).toContain('last_updated: "2026-05-01T00:00:00.000Z"');
    expect(md).toContain('DB-backed user_model_blocks table is the prompt source of truth');
    expect(md).toContain('## user_facts');
  });

  it('sanitizes model-returned frontmatter before writing the user model artifact', () => {
    const yaml = sanitizeUserModelFrontmatter([
      '```yaml',
      '---',
      'confidence_scores:',
      '  communication: 0.8',
      'last_updated: "2024-01-01T00:00:00.000Z"',
      '---',
      '```',
    ].join('\n'));

    expect(yaml).toBe('confidence_scores:\n  communication: 0.8');

    const md = buildUserModelMarkdown(yaml, {}, '2026-05-01T00:00:00.000Z');
    expect(md.match(/^---$/gm)).toHaveLength(2);
    expect(md.match(/last_updated:/g)).toHaveLength(1);
  });
});
