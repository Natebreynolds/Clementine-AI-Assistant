import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOneMillionContextRecovery,
  claudeCodeDisableOneMillionForModel,
  normalizeClaudeModelForOneMillionContext,
  normalizeClaudeSdkOptionsForOneMillionContext,
  usesOneMillionContext,
} from '../src/config.js';

describe('Claude Code 1M context mode', () => {
  afterEach(() => {
    delete process.env.CLEMENTINE_1M_CONTEXT_MODE;
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  });

  it('allows Opus long context in auto mode for included subscription plans', () => {
    expect(claudeCodeDisableOneMillionForModel('claude-opus-4-7', 'auto', 'max')).toBe('0');
    expect(usesOneMillionContext('claude-opus-4-7', 'auto', 'max')).toBe(true);
    expect(usesOneMillionContext('claude-opus-4-7', 'auto', 'team')).toBe(true);
    expect(usesOneMillionContext('claude-opus-4-7', 'auto', 'enterprise')).toBe(true);
  });

  it('does not silently enable Opus 1M for Pro or unknown plans', () => {
    expect(claudeCodeDisableOneMillionForModel('claude-opus-4-7', 'auto', 'pro')).toBe('1');
    expect(claudeCodeDisableOneMillionForModel('claude-opus-4-7', 'auto', 'unknown')).toBe('1');
    expect(usesOneMillionContext('claude-opus-4-7', 'auto', 'pro')).toBe(false);
    expect(usesOneMillionContext('claude-opus-4-7', 'auto', 'unknown')).toBe(false);
    expect(usesOneMillionContext('claude-opus-4-7[1m]', 'auto', 'unknown')).toBe(true);
  });

  it('keeps Sonnet 1M explicit because it can require extra usage', () => {
    expect(claudeCodeDisableOneMillionForModel('claude-sonnet-4-6', 'auto', 'max')).toBe('1');
    expect(usesOneMillionContext('claude-sonnet-4-6', 'auto', 'max')).toBe(false);
    expect(claudeCodeDisableOneMillionForModel('claude-sonnet-4-6[1m]', 'auto', 'max')).toBe('0');
    expect(usesOneMillionContext('claude-sonnet-4-6[1m]', 'auto', 'max')).toBe(true);
  });

  it('preserves explicit Sonnet and Opus [1m] suffixes in auto mode', () => {
    expect(normalizeClaudeModelForOneMillionContext('claude-sonnet-4-6[1m]', 'auto')).toBe('claude-sonnet-4-6[1m]');
    expect(normalizeClaudeModelForOneMillionContext('claude-opus-4-7[1m]', 'auto')).toBe('claude-opus-4-7[1m]');
  });

  it('forces every model back to 200K in off mode', () => {
    expect(claudeCodeDisableOneMillionForModel('claude-opus-4-7', 'off')).toBe('1');
    expect(normalizeClaudeModelForOneMillionContext('claude-opus-4-7[1m]', 'off')).toBe('claude-opus-4-7');
    expect(usesOneMillionContext('claude-opus-4-7', 'off')).toBe(false);
  });

  it('preserves explicit Opus [1m] when 1M mode is forced on', () => {
    expect(normalizeClaudeModelForOneMillionContext('claude-opus-4-7[1m]', 'on')).toBe('claude-opus-4-7[1m]');
  });

  it('normalizes SDK options and MCP subprocess env for explicit Sonnet 1M models', () => {
    process.env.CLEMENTINE_1M_CONTEXT_MODE = 'auto';
    const options = normalizeClaudeSdkOptionsForOneMillionContext({
      model: 'claude-sonnet-4-6[1m]',
      betas: ['context-1m-2025-08-07'],
      env: { EXISTING: 'yes' },
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          env: { TOOL_ENV: 'ok' },
        },
      },
    });

    expect(options.model).toBe('claude-sonnet-4-6[1m]');
    expect(options.betas).toEqual(['context-1m-2025-08-07']);
    expect(options.env).toMatchObject({
      EXISTING: 'yes',
      CLEMENTINE_1M_CONTEXT_MODE: 'auto',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '0',
    });
    expect((options.mcpServers.local as any).env).toMatchObject({
      TOOL_ENV: 'ok',
      CLEMENTINE_1M_CONTEXT_MODE: 'auto',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '0',
    });
  });

  it('persists recovery mode when Claude rejects 1M context', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clementine-1m-recovery-'));
    try {
      writeFileSync(path.join(dir, '.env'), 'CLEMENTINE_1M_CONTEXT_MODE=on\nOTHER=value\n');
      applyOneMillionContextRecovery(dir);
      const env = readFileSync(path.join(dir, '.env'), 'utf-8');
      expect(env).toContain('CLEMENTINE_1M_CONTEXT_MODE=off');
      expect(env).toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT=1');
      expect(env).toContain('OTHER=value');
      expect(process.env.CLEMENTINE_1M_CONTEXT_MODE).toBe('off');
      expect(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
