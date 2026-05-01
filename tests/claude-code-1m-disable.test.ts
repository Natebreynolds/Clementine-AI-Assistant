/**
 * Verifies that importing config sets CLAUDE_CODE_DISABLE_1M_CONTEXT in
 * process.env. The bundled Claude Code CLI honors this env var to skip
 * auto-attaching the context-1m-2025-08-07 beta header — which gates on
 * extra-usage entitlement and breaks queries for users without it.
 */

import { describe, expect, it } from 'vitest';

describe('CLAUDE_CODE_DISABLE_1M_CONTEXT propagation', () => {
  it('is set to a truthy value in process.env after config import', async () => {
    await import('../src/config.js');
    const v = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    expect(v).toBeDefined();
    expect(v).not.toBe('');
    expect(v).not.toBe('0');
    expect(v).not.toBe('false');
  });
});
