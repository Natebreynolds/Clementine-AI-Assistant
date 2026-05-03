import { describe, expect, it } from 'vitest';
import {
  claudeCodeDisableOneMillionForModel,
  normalizeClaudeModelForOneMillionContext,
  usesOneMillionContext,
} from '../src/config.js';

describe('Claude Code 1M context mode', () => {
  it('allows Opus 1M in auto mode while forcing Sonnet to standard context', () => {
    expect(claudeCodeDisableOneMillionForModel('claude-opus-4-7', 'auto')).toBeUndefined();
    expect(claudeCodeDisableOneMillionForModel('claude-sonnet-4-6', 'auto')).toBe('1');
    expect(usesOneMillionContext('claude-opus-4-7', 'auto')).toBe(true);
    expect(usesOneMillionContext('claude-sonnet-4-6', 'auto')).toBe(false);
  });

  it('strips accidental Sonnet [1m] suffixes in auto mode', () => {
    expect(normalizeClaudeModelForOneMillionContext('claude-sonnet-4-6[1m]', 'auto')).toBe('claude-sonnet-4-6');
    expect(normalizeClaudeModelForOneMillionContext('claude-opus-4-7[1m]', 'auto')).toBe('claude-opus-4-7[1m]');
  });

  it('forces every model back to 200K in off mode', () => {
    expect(claudeCodeDisableOneMillionForModel('claude-opus-4-7', 'off')).toBe('1');
    expect(normalizeClaudeModelForOneMillionContext('claude-opus-4-7[1m]', 'off')).toBe('claude-opus-4-7');
    expect(usesOneMillionContext('claude-opus-4-7', 'off')).toBe(false);
  });
});
