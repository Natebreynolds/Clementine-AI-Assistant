/**
 * Phase: cron loader duplicate-detection.
 *
 * Pure function test for findDuplicateJobDefinitions. Validates the
 * matching logic that surfaces same-conceptual-job-defined-twice
 * (global + agent-scoped) before it bites the user with diverged prompts.
 */

import { describe, expect, it } from 'vitest';
import { findDuplicateJobDefinitions } from '../src/gateway/cron-scheduler.js';
import type { CronJobDefinition } from '../src/types.js';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    name: 'job',
    schedule: '0 * * * *',
    prompt: 'do thing',
    enabled: true,
    tier: 1,
    ...overrides,
  };
}

describe('findDuplicateJobDefinitions', () => {
  it('returns empty when no global job has agentSlug', () => {
    const global = [makeJob({ name: 'a' }), makeJob({ name: 'b' })];
    const agents = [makeJob({ name: 'ross-the-sdr:c', agentSlug: 'ross-the-sdr' })];
    expect(findDuplicateJobDefinitions(global, agents)).toEqual([]);
  });

  it('returns empty when global agentSlug job has no matching agent definition', () => {
    const global = [makeJob({ name: 'a', agentSlug: 'ross-the-sdr' })];
    const agents = [makeJob({ name: 'ross-the-sdr:b', agentSlug: 'ross-the-sdr' })];
    expect(findDuplicateJobDefinitions(global, agents)).toEqual([]);
  });

  it('flags same bare name in global+agent and reports diverged fields', () => {
    const global = [makeJob({
      name: 'market-leader-followup',
      agentSlug: 'ross-the-sdr',
      schedule: '30 8 * * *',
      enabled: true,
      mode: 'unleashed',
      maxHours: 1,
      prompt: 'short prompt',
    })];
    const agents = [makeJob({
      name: 'ross-the-sdr:market-leader-followup',
      agentSlug: 'ross-the-sdr',
      schedule: '30 8 * * *',
      enabled: false, // diverged
      mode: 'unleashed',
      maxHours: 1,
      prompt: 'much longer prompt with detailed steps', // diverged
    })];
    const dupes = findDuplicateJobDefinitions(global, agents);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.bareName).toBe('market-leader-followup');
    expect(dupes[0]!.agentSlug).toBe('ross-the-sdr');
    expect(dupes[0]!.divergedFields).toContain('enabled');
    expect(dupes[0]!.divergedFields).toContain('prompt');
    // Same fields shouldn't show up
    expect(dupes[0]!.divergedFields).not.toContain('schedule');
    expect(dupes[0]!.divergedFields).not.toContain('mode');
  });

  it('reports zero diverged fields when the two definitions are identical', () => {
    const shared = {
      schedule: '0 9 * * *',
      enabled: true,
      tier: 2,
      mode: 'unleashed' as const,
      maxHours: 2,
      prompt: 'identical',
    };
    const global = [makeJob({ name: 'sync', agentSlug: 'sasha-the-cmo', ...shared })];
    const agents = [makeJob({ name: 'sasha-the-cmo:sync', agentSlug: 'sasha-the-cmo', ...shared })];
    const dupes = findDuplicateJobDefinitions(global, agents);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.divergedFields).toEqual([]);
  });

  it('handles multiple duplicates across different agents', () => {
    const global = [
      makeJob({ name: 'a', agentSlug: 'ross-the-sdr' }),
      makeJob({ name: 'b', agentSlug: 'sasha-the-cmo' }),
    ];
    const agents = [
      makeJob({ name: 'ross-the-sdr:a', agentSlug: 'ross-the-sdr' }),
      makeJob({ name: 'sasha-the-cmo:b', agentSlug: 'sasha-the-cmo' }),
    ];
    const dupes = findDuplicateJobDefinitions(global, agents);
    expect(dupes).toHaveLength(2);
    expect(dupes.map(d => d.agentSlug).sort()).toEqual(['ross-the-sdr', 'sasha-the-cmo']);
  });
});
