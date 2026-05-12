import { describe, expect, it } from 'vitest';

// Guard for the "budgets set to zero in the dashboard, but a cron job still
// hits the $1.00 cap one minute later" bug. The fix wires the dashboard's
// .env writer through setEnvOverride, and BUDGET became live getters that
// re-read the env cache on every access. This test pins the new contract.

import { BUDGET, setEnvOverride } from '../src/config.js';

describe('BUDGET hot-reload via setEnvOverride', () => {
  it('reflects setEnvOverride changes on the very next access', () => {
    const originalEnv = process.env.BUDGET_CRON_T2_USD;
    try {
      // Whatever the daemon booted with — we don't assume.
      const before = BUDGET.cronT2;
      expect(typeof before).toBe('number');

      // Simulate the dashboard "remove caps" preset writing 0.
      setEnvOverride('BUDGET_CRON_T2_USD', '0');
      expect(BUDGET.cronT2).toBe(0);

      // Simulate the user raising the cap to $2.50 a moment later.
      setEnvOverride('BUDGET_CRON_T2_USD', '2.5');
      expect(BUDGET.cronT2).toBe(2.5);

      // And dropping it to zero again.
      setEnvOverride('BUDGET_CRON_T2_USD', '0');
      expect(BUDGET.cronT2).toBe(0);
    } finally {
      // Restore so we don't leak into other tests.
      setEnvOverride('BUDGET_CRON_T2_USD', originalEnv ?? '');
    }
  });

  it('keeps live getters for every BUDGET key', () => {
    const originals = {
      cronT1: process.env.BUDGET_CRON_T1_USD,
      cronT2: process.env.BUDGET_CRON_T2_USD,
      chat: process.env.BUDGET_CHAT_USD,
      heartbeat: process.env.BUDGET_HEARTBEAT_USD,
    };
    try {
      setEnvOverride('BUDGET_CRON_T1_USD', '0');
      setEnvOverride('BUDGET_CRON_T2_USD', '0');
      setEnvOverride('BUDGET_CHAT_USD', '0');
      setEnvOverride('BUDGET_HEARTBEAT_USD', '0');

      expect(BUDGET.cronT1).toBe(0);
      expect(BUDGET.cronT2).toBe(0);
      expect(BUDGET.chat).toBe(0);
      expect(BUDGET.heartbeat).toBe(0);
    } finally {
      setEnvOverride('BUDGET_CRON_T1_USD', originals.cronT1 ?? '');
      setEnvOverride('BUDGET_CRON_T2_USD', originals.cronT2 ?? '');
      setEnvOverride('BUDGET_CHAT_USD', originals.chat ?? '');
      setEnvOverride('BUDGET_HEARTBEAT_USD', originals.heartbeat ?? '');
    }
  });
});
