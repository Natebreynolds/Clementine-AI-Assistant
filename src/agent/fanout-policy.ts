/**
 * Sub-agent fan-out policy for autonomous tasks.
 *
 * Why: even with a small tool surface, a single agent context can fill
 * within a few turns when tool responses are large (Outlook list dumps,
 * web search results, file reads, multi-prospect research). The SDK's
 * autocompact then has nothing to compact and aborts with
 * `rapid_refill_breaker`. The fix matching how Claude Code is designed:
 * spawn sub-agents that each handle a slice of work in their own
 * isolated context and return only a compact summary back to the parent.
 *
 * The Agent tool already exists in the SDK. The problem is timing —
 * agents tend to discover the need for fan-out only after thrashing.
 * This module front-loads the directive: scan the task description for
 * signals that fan-out will be needed, and inject a strong, explicit
 * mandate at the top of the prompt.
 *
 * Two outputs:
 *  - buildAlwaysOnParallelizationHint()
 *      Short reminder injected into every autonomous prompt. Cheap.
 *  - buildFanoutDirective(detectFanoutSignals(text).signals)
 *      Stronger, explicit fan-out contract. Only injected when signals
 *      indicate the task is genuinely multi-item or broad-scope.
 */

export interface FanoutSignal {
  /** Why fan-out matters for this task. Surfaced in the directive. */
  reason: string;
  /** The pattern that matched. Used for telemetry. */
  pattern: string;
}

export interface FanoutSignalReport {
  needsFanout: boolean;
  signals: FanoutSignal[];
}

/**
 * Detect patterns that strongly predict fan-out is needed. Conservative
 * by design — false positives waste a few hundred tokens per turn; false
 * negatives let the agent thrash. Tune for false positives.
 */
export function detectFanoutSignals(text: string): FanoutSignalReport {
  const signals: FanoutSignal[] = [];
  const lower = text.toLowerCase();

  const checks: Array<{ pattern: string; re: RegExp; reason: string }> = [
    {
      pattern: 'multi_item_iteration',
      re: /\b(for each|for every|process each|iterate over|loop through|across all|across each)\b/,
      reason: 'task explicitly iterates over multiple items — process them in parallel sub-agents, not one at a time in this conversation',
    },
    {
      pattern: 'collective_with_quantifier',
      re: /\b(all|every|each)\s+(prospects?|accounts?|leads?|contacts?|customers?|deals?|emails?|messages?|threads?|files?|records?|rows?|tasks?|items?|results?|pages?|articles?|posts?|repos?|repositories|projects?)\b/,
      reason: 'task spans every item in a collection — fan out by batching items across sub-agents',
    },
    {
      pattern: 'numeric_collection',
      re: /\b\d{2,}\s+(prospects?|accounts?|leads?|contacts?|customers?|deals?|emails?|messages?|threads?|files?|records?|rows?|items?|results?|pages?|articles?)\b/,
      reason: 'task names a numeric count of items (10+) — split into batches of 3-5 per sub-agent',
    },
    {
      pattern: 'comprehensive_research',
      re: /\b(comprehensive|exhaustive|deep[- ]dive|deep dive|full audit|competitive intel|market map|content intel|brief|landscape|panorama)\b/,
      reason: 'broad-scope research task — each step (news, search, brand, competitor, social) should run in its own sub-agent so the parent context stays clean',
    },
    {
      pattern: 'broad_scan_or_crawl',
      re: /\b(scan all|crawl|backfill|inventory|migrate|refactor)\b.{0,80}\b(all|entire|every|full)\b/s,
      reason: 'broad scan/crawl — partition by directory, date range, or ID range and fan out per partition',
    },
    {
      pattern: 'long_history_pull',
      re: /\b(last|past)\s+\d+\s+(days|weeks|months)|\bsince\s+(yesterday|last week|last month)\b/,
      reason: 'pulling a history range that is likely to return many items — sub-agents per day/week chunk',
    },
    {
      pattern: 'multiple_steps',
      re: /\b(steps?|phases?|stages?)\s*[:0-9]/,
      reason: 'task has explicit multi-step structure — each step in its own sub-agent, parent only sees the step summaries',
    },
  ];

  for (const check of checks) {
    if (check.re.test(lower)) {
      signals.push({ pattern: check.pattern, reason: check.reason });
    }
  }

  return {
    needsFanout: signals.length > 0,
    signals,
  };
}

/**
 * Always-on parallelization reminder. Short, designed to ride along in
 * every autonomous prompt without inflating token cost.
 */
export function buildAlwaysOnParallelizationHint(): string {
  return [
    '## Sub-agent fan-out',
    'When you process multiple items, spawn ONE Agent sub-agent per batch of 3–5 items. Sub-agents return ONE-LINE summaries (no raw tool output). Do not iterate sequentially in this conversation — that fills your context and aborts the run.',
  ].join('\n');
}

/**
 * Strong fan-out contract injected when detector matches. Designed to be
 * unambiguous: failing to fan out on these patterns *will* crash the run.
 */
export function buildFanoutDirective(signals: FanoutSignal[]): string {
  if (signals.length === 0) return '';

  const reasonLines = signals
    .map((s, i) => `${i + 1}. ${s.reason}`)
    .join('\n');

  return [
    '## Sub-agent fan-out is MANDATORY for this task',
    '',
    'Preflight detected patterns that will fill the context window if you run them sequentially in this conversation:',
    '',
    reasonLines,
    '',
    '### Required pattern',
    '',
    'Use the `Agent` tool to spawn parallel sub-agents. Each sub-agent runs in its own isolated context, so big tool responses live and die there — your context only sees the summary.',
    '',
    '- **Batch size**: 3–5 items per sub-agent (or one slice of work per sub-agent for research tasks)',
    '- **Sub-agent prompt MUST include**: the narrow task, the exact return format (e.g. `Return ONE LINE: <id> | <status> | <next-action>`), and an explicit "do not include raw tool output" directive',
    '- **Parent context keeps**: only the sub-agent return strings, not their tool transcripts',
    '',
    'If you anticipate a single tool call returning more than ~5 KB of text (full email lists, web search result pages, large database queries, file dumps), wrap THAT call in an Agent invocation too. The sub-agent runs the tool, extracts only the fields you need, and returns those.',
    '',
    'Failing to fan out on this task will cause the SDK to abort with `rapid_refill_breaker` and the run will be lost.',
  ].join('\n');
}

/**
 * Convenience: detect signals and return the directive string in one
 * call. Returns empty string when no fan-out is indicated.
 */
export function buildFanoutDirectiveForText(text: string): { directive: string; report: FanoutSignalReport } {
  const report = detectFanoutSignals(text);
  return {
    directive: buildFanoutDirective(report.signals),
    report,
  };
}
