import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetNotifiedForTesting, checkAgentBudget } from '../src/agent/budget-enforcement.js';
import type { AgentProfile } from '../src/types.js';
import type { MemoryStore } from '../src/memory/store.js';

// Tiny stub — only the method we care about.
function fakeStore(monthlyCents: number): MemoryStore {
  return { getMonthlyCostCents: () => monthlyCents } as unknown as MemoryStore;
}

function fakeProfile(slug: string, budgetCents: number | undefined): AgentProfile {
  return {
    slug,
    name: slug,
    tier: 1,
    description: '',
    systemPromptBody: '',
    status: 'active',
    budgetMonthlyCents: budgetCents,
  } as AgentProfile;
}

beforeEach(() => {
  _resetNotifiedForTesting();
});

afterEach(() => {
  _resetNotifiedForTesting();
});

describe('checkAgentBudget', () => {
  it('allows when no profile is supplied (Clementine herself)', () => {
    const r = checkAgentBudget(null, fakeStore(99999));
    expect(r.allowed).toBe(true);
  });

  it('allows when no budget is set (unlimited)', () => {
    const r = checkAgentBudget(fakeProfile('agent-x', undefined), fakeStore(50000));
    expect(r.allowed).toBe(true);
  });

  it('allows when budget is 0 (treated as unlimited)', () => {
    const r = checkAgentBudget(fakeProfile('agent-x', 0), fakeStore(50000));
    expect(r.allowed).toBe(true);
  });

  it('allows when spend is below the limit', () => {
    const r = checkAgentBudget(fakeProfile('agent-x', 1000), fakeStore(500));
    expect(r.allowed).toBe(true);
    expect(r.spentCents).toBe(500);
    expect(r.limitCents).toBe(1000);
  });

  it('blocks when spend reaches the limit', () => {
    const r = checkAgentBudget(fakeProfile('agent-x', 1000), fakeStore(1000));
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('hit its monthly budget');
    expect(r.message).toContain('agent-x');
  });

  it('blocks when spend exceeds the limit', () => {
    const r = checkAgentBudget(fakeProfile('agent-x', 1000), fakeStore(1500));
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('$15.00 of $10.00');
  });

  it('allows when memoryStore is missing — fail-open, never silently block', () => {
    const r = checkAgentBudget(fakeProfile('agent-x', 1000), null);
    expect(r.allowed).toBe(true);
  });
});
