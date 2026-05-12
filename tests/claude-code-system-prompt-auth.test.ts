/**
 * 1.18.192 — regression guard for the "Not logged in · Please run /login"
 * SDK auth bug.
 *
 * The Claude Agent SDK accepts `systemPrompt` as either:
 *   - a raw string → "custom prompt" → API-key auth path
 *   - { type: 'preset', preset: 'claude_code', append?: string } → Claude Code
 *     subscription auth path (Max plan, CLAUDE_CODE_OAUTH_TOKEN)
 *
 * Clementine is built for Max-subscriber owners; passing a raw string is a
 * silent auth failure for them. This test pins two things:
 *
 *   1. `claudeCodeSystemPrompt(...)` always returns the preset shape.
 *   2. None of our production direct-`query()` call sites pass a raw string
 *      to `systemPrompt`. Greps the codebase to catch regressions.
 *
 * The grep guard is intentionally strict — if you add a new direct SDK call
 * with `systemPrompt: 'some string'`, this test fails and you must use the
 * helper. If you have a legitimate reason for API-key auth (e.g. a tool
 * that's deliberately bypassing the subscription), allow-list it below.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { claudeCodeSystemPrompt } from '../src/config.js';

describe('claudeCodeSystemPrompt helper', () => {
  it('returns the preset shape for SDK auth', () => {
    const result = claudeCodeSystemPrompt('be terse');
    expect(result.type).toBe('preset');
    expect(result.preset).toBe('claude_code');
    expect(result.append).toBe('be terse');
    // Default — dynamic sections included (working-dir, git status, memory paths)
    expect(result.excludeDynamicSections).toBeUndefined();
  });

  it('supports minimal mode for lightweight Haiku utility calls', () => {
    const result = claudeCodeSystemPrompt('be terse', { minimal: true });
    expect(result.excludeDynamicSections).toBe(true);
  });
});

describe('no raw-string systemPrompt regressions (1.18.192)', () => {
  // Allowed call sites — if anything legitimately uses raw string in the
  // future (e.g. an explicit API-key tool), add its path + reason here.
  const ALLOWED_RAW_STRING_SITES: Array<{ file: string; reason: string }> = [
    // none for now
  ];

  it('no production source uses `systemPrompt: <raw string literal>`', () => {
    const root = path.resolve(__dirname, '..');
    // ripgrep-friendly invocation; falls back to grep if rg isn't available
    let output = '';
    try {
      output = execSync(
        `grep -rn "systemPrompt:" "${root}/src" --include="*.ts" | grep -E "systemPrompt:[[:space:]]*['\\\"\\\`]"`,
        { encoding: 'utf-8' },
      );
    } catch (err: unknown) {
      // grep exits 1 when no matches — that's the success case
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) {
        output = '';
      } else {
        throw err;
      }
    }
    const offenders = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      // Filter to actual literal-string assignments, not function-parameter
      // declarations, type signatures, or interface members.
      .filter((line) => /systemPrompt:\s*['"`]/.test(line))
      .filter((line) => !line.includes('test.ts:'))
      .filter((line) => {
        const file = line.split(':')[0];
        return !ALLOWED_RAW_STRING_SITES.some((entry) => file?.endsWith(entry.file));
      });

    expect(
      offenders,
      `Found raw-string systemPrompt usages — switch them to claudeCodeSystemPrompt(...) ` +
      `so the SDK uses Claude Code subscription auth instead of API-key auth.\n\n` +
      `Offenders:\n${offenders.join('\n')}`,
    ).toHaveLength(0);
  });
});
