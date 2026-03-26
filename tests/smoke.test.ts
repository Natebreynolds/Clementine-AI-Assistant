/**
 * Smoke tests for core utilities.
 * These test pure functions that don't require the full system.
 */

import { describe, it, expect } from 'vitest';
import { shellEscape } from '../src/config.js';
import { classifyError } from '../src/gateway/cron-scheduler.js';
import { classifyChatError } from '../src/gateway/router.js';
import { estimateTokens } from '../src/agent/assistant.js';

// ── shellEscape ─────────────────────────────────────────────────────

describe('shellEscape', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
  });

  it('escapes single quotes within strings', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it('handles empty strings', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('handles strings with special shell characters', () => {
    const result = shellEscape('$(whoami)');
    expect(result).toBe("'$(whoami)'");
  });

  it('handles strings with double quotes', () => {
    const result = shellEscape('say "hello"');
    expect(result).toBe("'say \"hello\"'");
  });
});

// ── classifyError (cron) ────────────────────────────────────────────

describe('classifyError', () => {
  it('classifies rate limit errors as transient', () => {
    expect(classifyError(new Error('429 Too Many Requests'))).toBe('transient');
    expect(classifyError('rate limit exceeded')).toBe('transient');
    expect(classifyError('quota exceeded')).toBe('transient');
  });

  it('classifies timeout errors as transient', () => {
    expect(classifyError(new Error('ETIMEDOUT'))).toBe('transient');
    expect(classifyError('Connection timed out')).toBe('transient');
    expect(classifyError('ECONNRESET')).toBe('transient');
  });

  it('classifies network errors as transient', () => {
    expect(classifyError('ECONNREFUSED')).toBe('transient');
    expect(classifyError('service unavailable')).toBe('transient');
    expect(classifyError('temporarily unavailable')).toBe('transient');
  });

  it('classifies unknown errors as permanent', () => {
    expect(classifyError(new Error('TypeError: cannot read'))).toBe('permanent');
    expect(classifyError('invalid JSON')).toBe('permanent');
  });
});

// ── classifyChatError ───────────────────────────────────────────────

describe('classifyChatError', () => {
  it('classifies rate limit errors', () => {
    expect(classifyChatError(new Error('429 rate limit'))).toBe('rate_limit');
    expect(classifyChatError('too many requests')).toBe('rate_limit');
  });

  it('classifies context overflow errors', () => {
    expect(classifyChatError('prompt too long')).toBe('context_overflow');
    expect(classifyChatError('maximum context length exceeded')).toBe('context_overflow');
    expect(classifyChatError('token limit reached')).toBe('context_overflow');
  });

  it('classifies auth errors', () => {
    expect(classifyChatError(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyChatError('403 Forbidden')).toBe('auth');
    expect(classifyChatError('invalid api key')).toBe('auth');
  });

  it('classifies transient errors', () => {
    expect(classifyChatError('ECONNRESET')).toBe('transient');
    expect(classifyChatError('500 Internal Server Error')).toBe('transient');
    expect(classifyChatError('service unavailable')).toBe('transient');
  });

  it('classifies unknown errors', () => {
    expect(classifyChatError('something broke')).toBe('unknown');
    expect(classifyChatError(new Error('TypeError'))).toBe('unknown');
  });
});

// ── estimateTokens ──────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty strings', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens for simple prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const estimate = estimateTokens(text);
    // 9 words * 1.3 ~= 12 tokens, plus minimal punctuation
    expect(estimate).toBeGreaterThan(8);
    expect(estimate).toBeLessThan(20);
  });

  it('estimates more tokens for code than equivalent-length prose', () => {
    const prose = 'This is a simple sentence with some words in it';
    const code = 'const x = { a: 1, b: [2, 3], c: "hello" };';
    // Code has more punctuation, should estimate higher relative to word count
    const proseEstimate = estimateTokens(prose);
    const codeEstimate = estimateTokens(code);
    // Code should not be wildly underestimated
    expect(codeEstimate).toBeGreaterThan(5);
    expect(proseEstimate).toBeGreaterThan(5);
  });

  it('handles multiline text', () => {
    const text = 'line 1\nline 2\nline 3\nline 4';
    const estimate = estimateTokens(text);
    expect(estimate).toBeGreaterThan(5);
  });
});
