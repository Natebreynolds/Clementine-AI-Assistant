# Coding Conventions

**Analysis Date:** 2026-03-27

## Naming Patterns

**Files:**
- `camelCase.ts` for most modules (e.g., `assistant.ts`, `router.ts`, `dashboard.ts`)
- `UPPER_CASE.md` for configuration files (e.g., `SOUL.md`, `CRON.md`, `MEMORY.md`)
- Hyphenated names for complex features: `discord-bot-manager.ts`, `slack-agent-bot.ts`, `cron-scheduler.ts`
- Index files: `index.ts` for module entry points

**Functions:**
- `camelCase` for all function declarations: `estimateTokens()`, `classifyError()`, `sanitizeResponse()`
- Private/internal functions: no special prefix, but often scoped within classes or at module level
- Factory/constructor functions: PascalCase when exported as classes (e.g., `PersonalAssistant`, `Gateway`, `MemoryStore`)
- Helper functions: descriptive verbs like `getSession()`, `createRelease()`, `logToDailyNote()`

**Variables:**
- `camelCase` for all variable declarations: `sessionKey`, `lastAccessedAt`, `sourceFile`
- `UPPER_CASE` for constants and configuration: `CHAT_TIMEOUT_MS`, `STREAM_EDIT_INTERVAL`, `DISCORD_MSG_LIMIT`
- `_privateProperty` convention not strictly used; privacy enforced by class member scope
- Temporary/loop variables: single letters acceptable (`ms`, `i`) in tight scopes

**Types:**
- `PascalCase` for interfaces: `SessionState`, `ChannelMessage`, `AgentProfile`, `SessionProvenance`
- `PascalCase` for type aliases: `ChatErrorKind`, `Lane`, `OnTextCallback`, `CronEmbedType`
- Discriminated union types: `'offline' | 'connecting' | 'online' | 'error'` for status enums
- Generic parameters: single letters acceptable (`T`, `K`, `V`)

## Code Style

**Formatting:**
- No explicit formatter configured (Prettier absent from dependencies)
- Lines observed at ~80-120 characters typically
- Semicolons required at statement ends
- Single quotes for strings (observed throughout codebase)
- Double quotes acceptable in JSON and when escaping content

**Linting:**
- No ESLint config detected; TypeScript `strict: true` mode enforces type safety
- TypeScript compiler flags enforce best practices:
  - `noUnusedLocals: true` — unused variables cause errors
  - `noUnusedParameters: true` — unused parameters cause errors
  - `strict: true` — implicit any forbidden, null checks required
  - `forceConsistentCasingInFileNames: true` — case-sensitive imports

**Indentation:**
- 2-space indentation throughout (observed in all TypeScript files)
- Consistent bracket placement: opening braces on same line (Allman style not used)

## Import Organization

**Order:**
1. Node.js built-in modules (`import fs from 'node:fs'`)
2. Third-party packages (`import pino from 'pino'`)
3. Local modules from relative paths (`import { config } from '../config.js'`)
4. Type imports with `import type` for type-only imports (`import type { SessionData } from '../types.js'`)

**Path Aliases:**
- No path aliases configured; all imports use relative paths
- ESM only (`"type": "module"` in package.json)
- File extensions required: `.js` at end of relative imports (e.g., `from '../config.js'`)
- Directory imports use `index.ts` files as implicit entry points

**Example import pattern:**
```typescript
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { SessionData, SessionProvenance } from '../types.js';
import { Gateway } from '../gateway/router.js';
```

## Error Handling

**Patterns:**
- `try-catch` blocks used for error boundaries, especially around file I/O and external API calls
- Error classification functions: `classifyError()` and `classifyChatError()` categorize errors into buckets:
  - `transient` — network issues, timeouts, rate limits (retry-able)
  - `permanent` — logic errors, auth failures, validation errors (don't retry)
  - `context_overflow` — token/context limits (special handling)
  - `rate_limit` — explicit rate limiting (backoff)
  - `unknown` — uncategorized (safe default)

**Error strings as inputs:**
```typescript
export function classifyError(err: unknown): 'transient' | 'permanent' {
  const msg = String(err);
  if (/rate.?limit|\b429\b|timeout/i.test(msg)) return 'transient';
  if (/TypeError|SyntaxError/i.test(msg)) return 'permanent';
  return 'permanent';
}
```

**Silent catch blocks:**
- `catch { /* non-fatal */ }` or `catch { }` used when error is expected and non-critical
- Generally avoided for unexpected errors; logged when truly exceptional

**Example from `src/config.ts`:**
```typescript
try {
  this.conn.exec('ALTER TABLE chunks ADD COLUMN salience REAL DEFAULT 0.0');
} catch {
  // Column already exists
}
```

## Logging

**Framework:** Pino (structured logging library)

**Initialization pattern:**
```typescript
const logger = pino({ name: 'clementine.{module-name}' });
```
- Each module creates its own logger with a namespaced name
- Logger name follows pattern: `clementine.{subsystem}` (e.g., `clementine.discord`, `clementine.gateway`)

**Log levels:**
- `logger.debug()` — detailed diagnostic info (lane slot acquired, timing info)
- `logger.info()` — significant events (bot started, message received)
- `logger.warn()` — unexpected but recoverable conditions (invalid signatures, missing config)
- `logger.error()` — errors that require attention (handler failures, network errors)

**Structured logging pattern:**
```typescript
logger.error({ err, slug: this.config.slug }, 'Slack agent bot start failed');
logger.info(
  { lane, active: this.active[lane], limit: this.limits[lane] },
  'Lane slot acquired'
);
```
- First argument is context object with relevant fields
- Second argument is message string
- Never use string interpolation in message; put data in context object

**No console output:**
- Avoid `console.log()`, `console.error()` — use Pino logger instead
- All observed code uses pino for logging

## Comments

**When to Comment:**
- At module level: file purpose and high-level design (JSDoc header)
- Above complex algorithms or non-obvious logic (e.g., token estimation heuristics)
- At class level: responsibility and behavior (JSDoc class comment)
- Section headers: ASCII dividers before logical sections

**JSDoc/TSDoc:**
- Used sparingly; TypeScript types often provide sufficient documentation
- Function JSDoc: brief description of purpose and edge cases
- Parameter types: documented via TypeScript signatures (not JSDoc)

**Example pattern:**
```typescript
/**
 * Estimate token count using a weighted heuristic.
 * BPE tokenizers average ~4 chars/token for prose, but code, punctuation,
 * and whitespace-heavy content tokenize differently.
 */
export function estimateTokens(text: string): number {
  // Implementation details commented if non-obvious
}
```

**Section dividers:**
```typescript
// ── Token estimation & context window guard ─────────────────────────
// ── Lifecycle ──────────────────────────────────────────────────────
// ── Team system accessors ──────────────────────────────────────────
```
- Used to visually separate major sections within files
- Improves readability in large modules

## Function Design

**Size:** Most functions 10-50 lines; complex algorithms break into helpers

**Parameters:**
- Explicit, named parameters preferred
- Object destructuring for multiple related parameters
- No required positional parameters after optional ones
- Optional parameters use defaults: `maxLen = 1900`

**Return Values:**
- Explicit return types on all exported functions (enforced by TypeScript strict mode)
- Early returns preferred to nested if-else
- Functions that return `Promise` explicitly typed as async

**Example pattern:**
```typescript
export function sanitizeResponse(text: string): string {
  // Validation and early returns
  if (!text) return '';

  // Main logic
  return processed;
}

async function acquireSlot(lane: Lane): Promise<() => void> {
  // Async logic
}
```

## Module Design

**Exports:**
- Named exports preferred: `export function X() {}`, `export class Y {}`
- Default exports avoided (only used in CLI entry point)
- Type exports use `export type` for clarity: `export type Lane = 'chat' | 'cron'`

**Class design:**
- Single responsibility per class
- Private state initialized in constructor
- Public methods for external API
- Static helpers for utility functions (rarely used)

**Example from `src/gateway/router.ts`:**
```typescript
export class Gateway {
  public readonly assistant: PersonalAssistant;

  private approvalResolvers = new Map<...>();
  private sessions = new Map<...>();

  constructor(assistant: PersonalAssistant) {
    this.assistant = assistant;
  }

  private getSession(sessionKey: string): SessionState { }

  async chat(sessionKey: string, text: string): Promise<void> { }
}
```

**Barrel files (index.ts):**
- Not heavily used; most modules import directly from specific files
- Avoids circular dependencies and improves tree-shaking

## Async/Await

**Pattern:**
- Prefer async/await over Promise chains
- Always return Promise from async functions
- Unused Promises should not be created without intent

**Example:**
```typescript
async function processMessage(msg: string): Promise<void> {
  try {
    const result = await assistant.query(msg);
    await saveResult(result);
  } catch (err) {
    logger.error({ err }, 'Processing failed');
  }
}
```

---

*Convention analysis: 2026-03-27*
