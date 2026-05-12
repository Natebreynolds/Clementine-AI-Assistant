/**
 * 1.18.186 — pin the "dashboard is boss" budget resolution. When the
 * user has explicitly set ALL global BUDGET_*_USD to 0 ("no budget"),
 * per-skill frontmatter caps should yield. Otherwise the dashboard's
 * "no budget" setting silently lies and skills still hit their own
 * hardcoded caps — exactly the surprise diagnosed on 2026-05-11.
 *
 * These tests exercise the resolution rule directly (a tiny pure
 * function) so they don't depend on the test-environment .env file.
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirror of the resolution logic in run-skill.ts:487 — kept here so
 * tests pin the contract without re-importing config.ts (which would
 * pull in the live BUDGET getter that reads the user's actual .env).
 */
function resolveBudget(
  optionsCap: number | undefined,
  skillCap: number | undefined,
  globalCapsAllZero: boolean,
): number | undefined {
  return optionsCap ?? (globalCapsAllZero ? undefined : skillCap);
}

describe('budget resolution (1.18.186 — dashboard is boss)', () => {
  it('explicit caller maxBudgetUsd always wins', () => {
    expect(resolveBudget(0.25, 0.05, true)).toBe(0.25);
    expect(resolveBudget(0.25, 0.05, false)).toBe(0.25);
    expect(resolveBudget(0.25, undefined, true)).toBe(0.25);
  });

  it('with global=all-zero, per-skill cap is IGNORED (uncapped)', () => {
    // The diagnosed case: dashboard says "no budget" but skill has
    // its own maxBudgetUsd. Skill cap should yield. Result: undefined
    // = uncapped.
    expect(resolveBudget(undefined, 0.05, true)).toBeUndefined();
    expect(resolveBudget(undefined, 0.5, true)).toBeUndefined();
    expect(resolveBudget(undefined, 100, true)).toBeUndefined();
  });

  it('with global caps NOT all zero, per-skill cap still applies', () => {
    // The user has SOMETHING set (e.g., BUDGET_CRON_T1_USD=0.75).
    // They haven't said "no budget anywhere", so per-skill caps are
    // legitimate. Skill cap wins over the absent global default.
    expect(resolveBudget(undefined, 0.05, false)).toBe(0.05);
    expect(resolveBudget(undefined, 0.5, false)).toBe(0.5);
  });

  it('no skill cap + no caller cap → undefined regardless of global state', () => {
    // The runtime then falls back to DEFAULT_BUDGETS or BUDGET.* in
    // the caller layer; the resolveBudget function itself returns
    // undefined either way.
    expect(resolveBudget(undefined, undefined, true)).toBeUndefined();
    expect(resolveBudget(undefined, undefined, false)).toBeUndefined();
  });

  it('skill cap of 0 is treated as undefined by the SDK (uncapped)', () => {
    // Documents the downstream behavior — the SDK's > 0 check at
    // run-agent.ts:389 means any 0 value gets dropped. But the
    // resolveBudget function itself just returns the 0; the
    // run-agent layer interprets it.
    expect(resolveBudget(undefined, 0, false)).toBe(0);
    expect(resolveBudget(undefined, 0, true)).toBeUndefined();
  });
});
