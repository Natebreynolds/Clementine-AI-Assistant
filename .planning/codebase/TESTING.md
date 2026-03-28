# Testing Patterns

**Analysis Date:** 2026-03-27

## Test Framework

**Runner:**
- Vitest 4.1.1
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in expect API (compatible with Jest/Chai patterns)

**Run Commands:**
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode with rerun on file changes
```

## Test File Organization

**Location:**
- Tests co-located in `tests/` directory at project root (separate from `src/`)
- Not following src-side test pattern (no `.test.ts` or `.spec.ts` files in `src/`)

**Naming:**
- `{name}.test.ts` pattern (e.g., `smoke.test.ts`)

**Directory Structure:**
```
tests/
├── smoke.test.ts     # Core utility smoke tests
└── [future test files]
```

## Test Structure

**Suite Organization:**
From `tests/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('shellEscape', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
  });

  it('escapes single quotes within strings', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });
});

describe('classifyError', () => {
  it('classifies rate limit errors as transient', () => {
    expect(classifyError(new Error('429 Too Many Requests'))).toBe('transient');
    expect(classifyError('rate limit exceeded')).toBe('transient');
  });
});
```

**Patterns:**
- `describe()` blocks group related tests by function or module
- `it()` defines individual test cases with descriptive names
- Test names describe expected behavior: "wraps simple strings in single quotes"
- One primary assertion per test case; multiple assertions if testing same happy path

**Setup/Teardown:**
- No global setup/teardown observed in current test suite
- No fixtures or factories implemented
- Tests are pure: no shared state between tests

## Test Coverage

**Current Tests:**
- `tests/smoke.test.ts` covers pure utility functions across multiple modules
  - `shellEscape()` from `src/config.ts` — 5 test cases
  - `classifyError()` from `src/gateway/cron-scheduler.ts` — 4 test cases
  - `classifyChatError()` from `src/gateway/router.ts` — 5 test cases
  - `estimateTokens()` from `src/agent/assistant.ts` — 4 test cases
  - `validateProposal()` from `src/agent/self-improve.ts` — 6 test cases

**Coverage Approach:**
- Smoke tests only — validates core pure functions
- No integration tests implemented
- No mocking or fixtures
- No e2e tests configured
- No coverage reporting tool configured

**What's NOT Tested:**
- Async operations (agents, channels, gateway)
- Database interactions (MemoryStore)
- External API calls (Discord, Slack, Telegram, Claude)
- File I/O operations
- Class methods requiring initialization
- Error recovery paths
- State mutation and side effects

## Test Types

**Unit Tests:**
- Scope: Pure functions (no I/O, no dependencies)
- Approach: Direct function calls, immediate assertions
- Example: `estimateTokens()` tests verify token counting logic with known inputs
- Current count: ~24 test cases in single file

**Integration Tests:**
- Not implemented
- Would require: mocked channels, test fixtures, database setup

**E2E Tests:**
- Not implemented
- Would require: test Discord/Slack/Telegram accounts, real API keys

## Testing Patterns in Detail

**Pattern 1: Testing error classification (regex matching)**
```typescript
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

  it('classifies unknown errors as permanent', () => {
    expect(classifyError(new Error('TypeError: cannot read'))).toBe('permanent');
    expect(classifyError('invalid JSON')).toBe('permanent');
  });
});
```
- Tests verify regex patterns match expected error messages
- Covers both Error objects and string messages
- Tests both positive (matches) and negative (falls through) cases

**Pattern 2: Testing string transformations (shell escaping)**
```typescript
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
});
```
- Tests cover edge cases: empty, special chars, quotes, command substitution
- String matching with escaped characters

**Pattern 3: Testing tokenization logic (heuristic estimation)**
```typescript
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
    const proseEstimate = estimateTokens(prose);
    const codeEstimate = estimateTokens(code);
    expect(codeEstimate).toBeGreaterThan(5);
    expect(proseEstimate).toBeGreaterThan(5);
  });

  it('handles multiline text', () => {
    const text = 'line 1\nline 2\nline 3\nline 4';
    const estimate = estimateTokens(text);
    expect(estimate).toBeGreaterThan(5);
  });
});
```
- Tests use range assertions (`toBeGreaterThan`, `toBeLessThan`) for heuristics
- No exact values tested since estimation is approximate
- Comment explains expected calculation

**Pattern 4: Testing YAML/Frontmatter validation**
```typescript
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
});
```
- Tests verify both success and failure validation paths
- Tests check error message content with `toContain()`
- Tests specific data structure requirements (cron jobs array, required fields)

## Assertion Patterns

**Common assertions:**
```typescript
expect(value).toBe(expectedValue);           // Exact equality
expect(result.valid).toBe(true);              // Boolean
expect(result.error).toContain('text');       // String containment
expect(estimate).toBeGreaterThan(5);          // Range assertions
expect(estimate).toBeLessThan(20);
```

## Mocking

**Framework:** Not used (no mocking in current test suite)

**Why not mocked:**
- Smoke tests focus on pure functions only
- No external dependencies in tested functions
- Dependencies are standard Node.js/TypeScript libraries
- No database or network calls in tested code

**Future mocking needs:**
- Would need to mock Pino logger for integration tests
- Would need to mock file I/O (fs module)
- Would need to mock external APIs (Claude SDK, Discord.js, etc.)
- Would use Vitest's built-in mocking (vi.mock, vi.fn)

## Coverage

**Requirements:** No coverage threshold enforced

**Current gaps:**
- Zero coverage for: channels, gateway, agent, memory, security modules
- Only 24 tests covering ~5 small utility functions
- No critical path tests (message routing, cron execution, memory search)
- No error recovery tests

**To improve coverage:**
- Add tests for Gateway session management
- Add tests for CronScheduler parsing and execution
- Add tests for MemoryStore CRUD operations (with test DB)
- Add tests for error classification across multiple error types
- Add tests for team communication patterns
- Mock external APIs for integration testing

## Test Execution

**Current CI/CD:**
- No automated test runs observed
- No pre-commit hooks running tests
- No CI pipeline configured (GitHub Actions not set up)

**Local testing:**
- Run `npm test` to execute all tests once
- Run `npm run test:watch` during development
- No watch exclusions configured

---

*Testing analysis: 2026-03-27*
