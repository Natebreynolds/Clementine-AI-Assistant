# Codebase Concerns

**Analysis Date:** 2026-03-27

## Tech Debt

**Monolithic Dashboard File:**
- Issue: `src/cli/dashboard.ts` at 11,091 lines is the largest file in the codebase and contains mixed concerns (HTML generation, API routing, cron management, session auth, metrics computation, memory search)
- Files: `src/cli/dashboard.ts`
- Impact: High complexity makes changes risky. Difficult to test individual features. Single point of failure for web UI. Hard to maintain naming conventions and keep structure consistent.
- Fix approach: Split into separate modules: `dashboard-api.ts`, `dashboard-html.ts`, `dashboard-cron-handler.ts`, `dashboard-auth.ts`. Each handles one concern. Refactor HTML generation to template strings or a separate file.

**Large File Concentration:**
- Issue: 5 files exceed 1,500 lines (`dashboard.ts` 11K+, `mcp-server.ts` 5.5K, `assistant.ts` 3.1K, `store.ts` 2.2K, `discord.ts` 2K, `cli/index.ts` 2K)
- Files: `src/cli/dashboard.ts`, `src/tools/mcp-server.ts`, `src/agent/assistant.ts`, `src/memory/store.ts`, `src/channels/discord.ts`, `src/cli/index.ts`
- Impact: Cognitive load. Harder to grasp full control flow. More merge conflicts. Refactoring becomes risky.
- Fix approach: Extract reusable functions and sub-modules. Use barrel files for related concerns. For `mcp-server.ts`, separate tool definitions from server bootstrap.

**No Application Test Coverage:**
- Issue: Zero test files in `src/`. Vitest is configured but unused. Entire system relies on manual integration testing via daemon startup and Discord/Slack channels.
- Files: None (no tests exist)
- Impact: Refactoring is risky. Regressions in core agent behavior, memory store queries, cron scheduler, or security scanner go undetected until production. New features compound risk.
- Fix approach: Add unit tests for core modules: memory store queries, security scanner, token estimation, cron parsing. Add integration tests for agent/gateway interactions. Target 50% coverage of critical paths first.

**Implicit Concurrency Model:**
- Issue: Session-level locking uses `lock?: Promise<void>` in gateway but no explicit mutex/semaphore for multi-agent scenarios. Cron scheduler and heartbeat can both attempt to run jobs concurrently. SQLite WAL mode handles DB concurrency but business logic has no coordination.
- Files: `src/gateway/router.ts` (SessionState.lock), `src/gateway/cron-scheduler.ts`, `src/gateway/heartbeat-scheduler.ts`
- Impact: Race conditions in session updates, duplicate job executions, memory extraction conflicts, state corruption.
- Fix approach: Implement explicit lock management (semaphore/mutex per session). Document which operations require holding locks. Add warnings when lock contention is high.

**Silent Error Swallowing:**
- Issue: Many `.catch(() => {})` patterns suppress errors completely. Examples: `sendOrUpdateStatusEmbed().catch(() => {})`, `dispatcher.send(...).catch(() => {})`, `this.flush().catch(() => {})` throughout channels and cron scheduler.
- Files: `src/channels/slack-utils.ts`, `src/channels/discord-agent-bot.ts`, `src/gateway/cron-scheduler.ts`, `src/gateway/heartbeat-scheduler.ts`
- Impact: Silent failures. Channels silently stop sending messages. Cron jobs appear to complete but notifications never land. Debugging becomes painful — logs don't record failures.
- Fix approach: Log all caught errors with context (channel, operation, reason). Replace bare `.catch(() => {})` with `.catch(err => logger.warn({ err }, 'Operation failed: X'))`. Periodically check error logs in heartbeat.

## Known Bugs

**Telegram Voice Message Placeholder:**
- Symptoms: Users sending voice messages to Telegram bot receive "Voice messages are not yet supported" instead of transcription.
- Files: `src/channels/telegram.ts:247`
- Trigger: Any voice message sent to bot in Telegram.
- Workaround: Users must type text instead of voice.
- Root cause: STT integration stub exists but not implemented (requires Groq Whisper API).

**CRON.md YAML Parse Failure Recovery:**
- Symptoms: If CRON.md frontmatter becomes malformed, the scheduler logs "keeping previous jobs" but doesn't actually reload — uses stale in-memory state instead.
- Files: `src/gateway/cron-scheduler.ts:104-108`
- Trigger: User manually edits CRON.md with invalid YAML syntax.
- Workaround: Fix the YAML, restart daemon.
- Root cause: Parse error returns empty array, but scheduler doesn't re-read from last valid checkpoint.

**Dashboard Session Cleanup Race:**
- Symptoms: Expired session cleanup runs every 10 minutes but doesn't atomically sync with active requests. Session might be deleted while request is in-flight.
- Files: `src/cli/dashboard.ts:1077-1082`
- Trigger: Session expires just as user clicks submit.
- Workaround: Retry login.
- Root cause: Map iteration is not locked during cleanup.

## Security Considerations

**Subprocess Shell Injection in Pre-Check:**
- Risk: `cron_scheduler.ts` executes `job.preCheck` via `execSync(job.preCheck, ...)` without shell escaping. Malicious CRON.md entry can execute arbitrary commands.
- Files: `src/gateway/cron-scheduler.ts:663`
- Current mitigation: Scanner checks CRON.md before parsing, but pre_check field is not scanned.
- Recommendations: Use `shell: false` with argv array, or validate pre_check is a simple boolean expression (not full command).

**Environment Variable Leakage in Subprocess:**
- Risk: Dashboard dashboard.ts calls `execSync('git rev-parse ...')` with default env — inherits all process.env including secrets if improperly set.
- Files: `src/cli/dashboard.ts:1103-1105`
- Current mitigation: buildSafeEnv() for agent subprocesses, but not applied consistently to all shell commands.
- Recommendations: Apply sanitized env to all execSync calls in dashboard.ts and index.ts.

**MCP Tool Input Validation Missing:**
- Risk: MCP tools read user-supplied inputs (memory_write, note_create) with minimal validation. Prompt injection in memory extraction could bypass injection scanner since it's run after the fact.
- Files: `src/tools/mcp-server.ts`, `src/agent/assistant.ts` (AUTO_MEMORY_PROMPT)
- Current mitigation: Security scanner flags injections post-fact, but tools are already executed.
- Recommendations: Validate tool inputs before execution, not after. Implement schema validation for all MCP tool parameters.

**Hardcoded Credentials in env.example:**
- Risk: `.env.example` visible in repo may contain placeholder tokens that hint at required formats (API key patterns, model names, token lengths).
- Files: `.env.example`
- Current mitigation: Repository is private.
- Recommendations: Keep `.env.example` stripped of patterns. Use documentation instead.

## Performance Bottlenecks

**Token Estimation Heuristic:**
- Problem: `estimateTokens()` uses character count heuristic (1.3 words per token) which is inaccurate for code/JSON. Estimates can be off by 20-30%, causing context overflow errors even when space remains.
- Files: `src/agent/assistant.ts:82-91`
- Cause: Heuristic doesn't account for punctuation, whitespace heavy content, or language-specific tokenization.
- Improvement path: Use Anthropic's official tokenizer library if available, or fetch real token counts from API responses and train a better model.

**Memory Search Full Table Scan:**
- Problem: FTS5 searches in `searchFts()` have no filtering before results. Large vault (10K+ chunks) returns all matches, then Python script re-ranks. High latency for broad queries.
- Files: `src/memory/store.ts` (searchFts method), `src/tools/mcp-server.ts` (memory_search tool)
- Cause: No pre-filtering by recency, agent slug, or salience tier before returning results.
- Improvement path: Add WHERE clauses for salience threshold, date range, agent scope. Implement result pagination with cursor-based fetching. Cache top-N frequently searched queries.

**Cron Scheduler Linear Job Scan:**
- Problem: Every heartbeat tick and cron interval, scheduler re-parses CRON.md from disk and iterates all jobs. With 50+ jobs, this is O(n) per tick.
- Files: `src/gateway/cron-scheduler.ts:99-141` (parseCronJobs)
- Cause: No in-memory cache with file watch. File is read even if unchanged.
- Improvement path: Cache parsed jobs, watch file for changes, invalidate cache only on actual edits. Use file hash or mtime as cache key.

**Dashboard Response Cache Global Map:**
- Problem: `responseCache` in dashboard.ts uses a simple Map with TTL. No size limit — cache can grow unbounded. No eviction policy.
- Files: `src/cli/dashboard.ts:44-63` (cached, cachedAsync)
- Cause: Memory leak potential if many unique cache keys are requested.
- Improvement path: Add LRU eviction. Implement per-endpoint cache size limits. Monitor cache hit rates.

## Fragile Areas

**Assistant Session Rotation Logic:**
- Files: `src/agent/assistant.ts` (session rotation on context overflow)
- Why fragile: Complex state machine (MAX_SESSION_EXCHANGES, SESSION_EXCHANGE_MAX_CHARS, context guard tokens) determines when to rotate. Off-by-one errors or missed edge cases cause sessions to hang or lose conversation context.
- Safe modification: Add unit tests for rotation thresholds. Log rotation decision reasons. Implement dry-run mode to verify rotation without executing.
- Test coverage: No coverage. Add tests for edge cases: session at exactly max exchanges, context at exactly limit, multiple rotations in sequence.

**Cron Job Retry and Circuit Breaker:**
- Files: `src/gateway/cron-scheduler.ts` (retry logic, circuit breaker, MAX_RETRIES, consErrors state)
- Why fragile: State is stored in memory (no persistence across restarts). If daemon crashes mid-retry, circuit breaker state is lost. Jobs may suddenly retry multiple times on restart.
- Safe modification: Persist circuit breaker state to disk. Add snapshot/restore on startup. Test restart scenarios.
- Test coverage: No coverage. Add tests for: consecutive failures trigger circuit breaker, recovery succeeds after waiting, daemon restart clears retries correctly.

**Prompt Injection Scanner Regex Patterns:**
- Files: `src/security/patterns.ts`, `src/security/scanner.ts`
- Why fragile: Regex-based detection is brittle. Adversarial inputs can bypass by slight variations (unicode tricks, spacing, capitalization). Semantic layer uses fuzzy matching which can have false positives/negatives.
- Safe modification: Treat scanner as first pass only. Log all warnings. Don't rely solely on blocks for security-critical operations. Add manual review step for high-risk operations.
- Test coverage: No coverage. Add adversarial tests: variations of prompt injection patterns, unicode bypasses, leetspeak, homoglyph attacks.

**Agent Profile Tier and Tool Permissions:**
- Files: `src/agent/hooks.ts` (enforceToolPermissions, setProfileTier, setProfileAllowedTools)
- Why fragile: Permissions are set at runtime via callbacks. No validation that profile/tier exist in config. If profile is missing, permission checks silently fail or use defaults.
- Safe modification: Validate profile existence at startup. Add schema validation for tier/allowedTools. Test permission enforcement with missing profiles.
- Test coverage: No coverage. Add tests for: unknown profile fallback, tier boundary conditions, tool list additions/removals.

## Scaling Limits

**Session Memory Consumption:**
- Current capacity: Codebase holds all sessions in memory (Map<string, SessionState>). With 1 session per user + channels, ~100 sessions = ~10-50 MB depending on state size.
- Limit: After ~10,000 concurrent sessions, memory pressure becomes noticeable. Session state includes conversation history (potentially large).
- Scaling path: Move session state to SQLite. Implement lazy loading — only load active session state. Archive old sessions to disk.

**Vault File I/O Pressure:**
- Current capacity: Memory store syncs vault on startup (full scan) + incremental updates. Vault with 10K+ files scans linearly.
- Limit: After ~50K files, sync takes >30 seconds. Heartbeat latency increases. Cron jobs queue up.
- Scaling path: Implement incremental sync with file watches (chokidar or native). Use batch inserts instead of per-file writes. Archive old daily notes.

**MCP Tool Response Size:**
- Current capacity: Tool responses are read entirely into memory, then sent to API. Large memory searches or note_create with huge files can spike memory.
- Limit: Memory searches returning 10K+ chunks × 500 chars each = 5 MB response, repeated N times per agent query.
- Scaling path: Implement streaming responses. Paginate search results. Compress responses. Add size limits with warning logs.

**Context Window Utilization:**
- Current capacity: Agent sessions estimate ~200K token context window (Haiku/Sonnet). With 40 max exchanges at 2K chars each, ~120K tokens in history + system prompt/memory inject takes up ~160K.
- Limit: After 40 exchanges, rotation kicks in. New users or complex queries hit limits faster. Concurrent long-running sessions (plan execution) can exhaust limits.
- Scaling path: Implement token-aware response trimming. Implement dynamic exchange limits based on actual token consumption (not just exchange count). Use prompt caching for system prompt.

## Dependencies at Risk

**better-sqlite3 Native Binding:**
- Risk: `better-sqlite3` requires native compilation. postinstall hook `npm rebuild better-sqlite3` can fail silently. If rebuild fails, database operations fail at runtime with cryptic errors.
- Impact: Dashboard memory search crashes. Cron scheduler fails to record runs. Entire system destabilizes.
- Migration plan: Add explicit error handling in postinstall. Test native compilation during setup (doctor command). Fallback to simple json-file store if compilation fails (degraded mode).

**@anthropic-ai/claude-agent-sdk Stability:**
- Risk: SDK is young (v0.2.81). API changes or regressions in SDK subprocesses can break core agent functionality. No vendor version constraints in package.json (minor version can change).
- Impact: Daemon fails to initialize. Agent queries hang or fail mysteriously.
- Migration plan: Pin SDK to exact version (remove ^). Monitor SDK releases closely. Add SDK version check in doctor command. Test SDK subprocess startup explicitly.

**node-cron Parse Errors:**
- Risk: Cron expression parsing can fail with unclear errors. Malformed schedules in CRON.md cause scheduler to throw or silently skip job.
- Impact: Jobs don't run. No notification to user. Debugging requires log inspection.
- Migration plan: Validate all cron expressions at CRON.md parse time (not at schedule time). Provide user feedback immediately if schedule is invalid.

## Missing Critical Features

**Webhook Input Validation:**
- Problem: Webhook endpoints (Discord, Slack, Telegram, WhatsApp) accept incoming payloads with minimal schema validation. Malformed or oversized payloads can crash processors or expose internal state.
- Blocks: Reliable channel integration. Safe multi-channel deployment.
- Recommendation: Implement Zod schema validation for all incoming webhook payloads. Add size limits and rate limiting. Return clear error responses.

**Observability and Alerting:**
- Problem: No central error aggregation. Errors are logged to pino (stdout) but not indexed or alerted. Circuit breaker triggers silently. Job failures may go unnoticed for days.
- Blocks: Production reliability. Incident response. Performance monitoring.
- Recommendation: Integrate error tracking (Sentry) and metrics (Prometheus/CloudWatch). Add alerting rules for circuit breaker, job failure rate, context overflow events.

**Job Dependency Resolution:**
- Problem: Cron jobs support `after` field for sequential execution, but no transitive dependency resolution. Job A → B → C may fail if B is slow, leaving C pending forever.
- Blocks: Complex workflows. Unleashed multi-phase execution.
- Recommendation: Implement DAG validation for job dependencies. Add timeout handling for blocked jobs. Implement backoff/retry for dependency resolution.

**Graceful Shutdown:**
- Problem: Daemon stops via SIGTERM but doesn't wait for in-flight cron jobs or agent queries to complete. Long-running unleashed jobs are killed mid-execution.
- Blocks: Data integrity. Job resumption after restart.
- Recommendation: Implement graceful shutdown handler. Drain pending jobs with timeout. Checkpoint job state before exit. Resume jobs on restart.

## Test Coverage Gaps

**Agent Query Error Handling:**
- What's not tested: Error classification (rate_limit vs context_overflow vs transient). Context overflow recovery. Token estimation accuracy.
- Files: `src/agent/assistant.ts`, `src/gateway/router.ts`
- Risk: Context overflow errors go unhandled or misclassified. User receives cryptic message instead of clear explanation.
- Priority: High — affects core user experience.

**Memory Store Concurrency:**
- What's not tested: Concurrent reads/writes. Transaction isolation. WAL mode behavior under load. FTS5 index consistency after concurrent updates.
- Files: `src/memory/store.ts`
- Risk: Silent data corruption. Search results become inconsistent. Salience tracking gets out of sync.
- Priority: High — affects memory reliability.

**Channel Streaming and Message Chunking:**
- What's not tested: Large responses exceeding channel limits. Chunked message reconstruction. Streaming update timing (race between updates and sends).
- Files: `src/channels/discord-agent-bot.ts`, `src/channels/slack-agent-bot.ts`, `src/channels/telegram.ts`
- Risk: Message truncation. Incomplete streaming. Out-of-order chunk delivery.
- Priority: Medium — users will notice incomplete responses.

**Security Scanner Adversarial Cases:**
- What's not tested: Prompt injection bypasses (unicode tricks, encoding, homoglyph attacks). False positives on legitimate text.
- Files: `src/security/scanner.ts`, `src/security/patterns.ts`
- Risk: Injections slip through undetected, or legitimate queries are blocked.
- Priority: High — security-critical.

**Cron Job Failure Scenarios:**
- What's not tested: Job timeout and force-kill. Partial execution persistence (checkpoint/resume). Retry exhaustion. Circuit breaker state recovery after restart.
- Files: `src/gateway/cron-scheduler.ts`
- Risk: Jobs hang forever. Retries don't work. Circuit breaker state lost.
- Priority: High — affects autonomous execution reliability.

**Dashboard Authentication and Session Management:**
- What's not tested: Session fixation. CSRF attacks (although dashboard is token-protected, CORS not explicitly tested). Rate limit bypass. Session cleanup race conditions.
- Files: `src/cli/dashboard.ts`
- Risk: Unauthorized access. Session hijacking. DoS via rate limit bypass.
- Priority: High — web interface security.

---

*Concerns audit: 2026-03-27*
