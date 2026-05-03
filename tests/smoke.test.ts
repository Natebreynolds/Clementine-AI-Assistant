/**
 * Smoke tests for core utilities.
 * These test pure functions that don't require the full system.
 */

import { describe, it, expect } from 'vitest';
import { shellEscape } from '../src/config.js';
import { classifyError, CronScheduler } from '../src/gateway/cron-scheduler.js';
import { classifyChatError } from '../src/gateway/router.js';
import {
  buildContextThrashRecoveryPrompt,
  estimateTokens,
  isAutonomousNothingOutput,
  looksLikeContextThrashText,
  looksLikeNoResponseRequested,
  looksLikeOneMillionContextError,
} from '../src/agent/assistant.js';
import { validateProposal } from '../src/agent/self-improve.js';
import { isCreditBalanceError } from '../src/gateway/credit-guard.js';

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

  it('classifies Claude credit exhaustion as permanent for cron', () => {
    expect(classifyError('Credit balance is too low')).toBe('permanent');
  });
});

// ── autonomous no-op output ─────────────────────────────────────────

describe('autonomous no-op output suppression', () => {
  it('recognizes cron no-op sentinel variants', () => {
    expect(isAutonomousNothingOutput('__NOTHING__')).toBe(true);
    expect(isAutonomousNothingOutput('NOTHING')).toBe(true);
    expect(isAutonomousNothingOutput('__NOTHING__\n\n[MONITORING]')).toBe(true);
    expect(isAutonomousNothingOutput('nothing to report')).toBe(true);
    expect(isAutonomousNothingOutput('No response requested')).toBe(true);
  });

  it('does not suppress substantive output that mentions nothing', () => {
    expect(isAutonomousNothingOutput('Nothing is blocked; I sent 3 emails and updated Salesforce.')).toBe(false);
  });

  it('matches cron scheduler notification noise handling', () => {
    expect(CronScheduler.isCronNoise('NOTHING')).toBe(true);
    expect(CronScheduler.isCronNoise('__NOTHING__\n\n[MONITORING]')).toBe(true);
    expect(CronScheduler.isCronNoise('No updates')).toBe(true);
    expect(CronScheduler.isCronNoise('No response requested')).toBe(true);
    expect(CronScheduler.isCronNoise('No updates, but I did send the brief and saved it to the vault.')).toBe(false);
  });
});

describe('response and provider error sentinels', () => {
  it('detects interactive no-response sentinel text', () => {
    expect(looksLikeNoResponseRequested('No response requested')).toBe(true);
    expect(looksLikeNoResponseRequested('No response requested.')).toBe(true);
    expect(looksLikeNoResponseRequested('No response requested, but I checked it.')).toBe(false);
  });

  it('detects 1M context entitlement errors', () => {
    expect(looksLikeOneMillionContextError('Extra usage is required for 1M context')).toBe(true);
    expect(looksLikeOneMillionContextError('context-1m-2025-08-07')).toBe(true);
  });

  it('detects Claude credit exhaustion errors', () => {
    expect(isCreditBalanceError('Credit balance is too low')).toBe(true);
    expect(isCreditBalanceError('Your account has insufficient credits')).toBe(true);
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
    expect(classifyChatError('Autocompact is thrashing: the context refilled to the limit')).toBe('context_overflow');
    expect(classifyChatError('Extra usage is required for 1M context')).toBe('context_overflow');
  });

  it('classifies auth errors', () => {
    expect(classifyChatError(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyChatError('403 Forbidden')).toBe('auth');
    expect(classifyChatError('invalid api key')).toBe('auth');
  });

  it('classifies billing/credit errors', () => {
    expect(classifyChatError('Credit balance is too low')).toBe('billing');
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

// ── context-thrash recovery helpers ─────────────────────────────────

describe('context-thrash recovery helpers', () => {
  it('recognizes SDK autocompact thrash text', () => {
    expect(looksLikeContextThrashText('Autocompact is thrashing: the context refilled to the limit')).toBe(true);
    expect(looksLikeContextThrashText('regular context summary')).toBe(false);
  });

  it('builds a recovery prompt that preserves intent and narrows cron diagnostics', () => {
    const prompt = buildContextThrashRecoveryPrompt('Fix Ross market leader follow up', 'Autocompact is thrashing');
    expect(prompt).toContain('Fix Ross market leader follow up');
    expect(prompt).toContain('tail -80');
    expect(prompt).toContain('status.json');
    expect(prompt).toContain('progress.jsonl');
    expect(prompt).toContain('Do not read full run logs');
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

// ── validateProposal ────────────────────────────────────────────────

describe('validateProposal', () => {
  it('rejects empty proposals', () => {
    const result = validateProposal('soul', 'SOUL.md', '   ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('accepts valid markdown without frontmatter', () => {
    const result = validateProposal('soul', 'SOUL.md', '# Soul\n\nBe helpful.');
    expect(result.valid).toBe(true);
  });

  it('accepts valid YAML frontmatter', () => {
    const content = '---\ntitle: Test\n---\n\n# Content';
    const result = validateProposal('soul', 'SOUL.md', content);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid YAML frontmatter', () => {
    const content = '---\ntitle: [invalid yaml\n---\n\n# Content';
    const result = validateProposal('cron', 'CRON.md', content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('YAML');
  });

  it('validates cron jobs have required fields', () => {
    const valid = '---\njobs:\n  - name: test\n    schedule: "0 8 * * *"\n    prompt: Do something\n---\n';
    expect(validateProposal('cron', 'CRON.md', valid).valid).toBe(true);

    const missing = '---\njobs:\n  - name: test\n    schedule: "0 8 * * *"\n---\n';
    const result = validateProposal('cron', 'CRON.md', missing);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing required fields');
  });

  it('rejects cron jobs field that is not an array', () => {
    const content = '---\njobs: not-an-array\n---\n';
    const result = validateProposal('cron', 'CRON.md', content);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be an array');
  });

  it('rejects deprecated source area (Phase 1 quarantine)', () => {
    const result = validateProposal('source', 'index.ts', 'const x = 1;');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('deprecated');
  });
});
