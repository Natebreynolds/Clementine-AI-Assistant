/**
 * PRD §9 / Phase 4c: 11-category failure classifier.
 *
 * Maps a CronRunEntry to one of the PRD-canonical failure buckets so the
 * dashboard's Run list filter and Run detail viewer can group failures
 * meaningfully. Sits ABOVE the existing job-health.ts classifier (which
 * still produces the lower-level kind used by self-improve and the
 * advisor) — this module re-buckets job-health output into PRD vocabulary.
 *
 * Source signals consulted, in priority order:
 *  1. CronRunEntry.terminalReason — most precise, comes straight from SDK.
 *  2. job-health classifyRunHealth — already has rate_limit / auth / context_overflow / etc.
 *  3. error string heuristics — last resort.
 *
 * Returns null when the run is not a failure (status='ok').
 */

import type { CronRunEntry, RunFailureCategory } from '../types.js';
import { classifyRunHealth } from './job-health.js';

/** Returns the PRD-canonical failure bucket, or null if the run succeeded. */
export function classifyRunFailure(entry: CronRunEntry): RunFailureCategory | null {
  // Non-failures don't get a category.
  if (entry.status === 'ok') return null;
  if (entry.status === 'skipped') return null;
  if (entry.status === 'running') return null;

  // 'cancelled' is its own status today; map directly.
  if (entry.status === 'cancelled' as unknown) return 'cancelled';

  // Lost = daemon-boot sweep closed an orphaned 'running' entry.
  // Treated as infrastructure_error per PRD §9 — the daemon crashed.
  if (entry.status === 'lost') return 'infrastructure_error';

  // Timeout status maps directly.
  if (entry.status === 'timeout') return 'tool_timeout';

  // Inspect terminalReason (SDK-reported termination) first — it's the
  // most precise signal we have.
  switch (entry.terminalReason) {
    case 'max_turns':
      return 'agent_loop_error';
    case 'prompt_too_long':
      return 'context_error';
    case 'rapid_refill_breaker':
      return 'context_error';
    case 'blocking_limit':
      return 'tool_error';
    case 'image_error':
      return 'model_output_error';
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'cancelled';
    case 'stop_hook_prevented':
    case 'hook_stopped':
      return 'prompt_error';
    case 'tool_deferred':
      return 'tool_error';
    case 'model_error':
      return 'model_error';
    // 'completed' should never land here (status would be 'ok')
    default:
      // Fall through to job-health + error string heuristics
      break;
  }

  // High-precedence error-string patterns that should be classified
  // BEFORE handing to job-health (which collapses "permission denied" into
  // tool_scope, but PRD §9 says hook-blocked permission denials are
  // prompt_error). Order matters here.
  const earlyBlob = ((entry.error ?? '') + ' ' + (entry.outputPreview ?? '')).toLowerCase();
  if (/permission denied|policy violation|prompt[- ]injection|guardrail|blocked by hook/.test(earlyBlob)) {
    return 'prompt_error';
  }
  if (/^cancel|user (?:interrupt|abort|stopped)/.test(earlyBlob)) {
    return 'cancelled';
  }
  if (/subagent|sub[- ]agent failed|delegated agent/.test(earlyBlob)) {
    return 'subagent_error';
  }

  // Use the existing health classifier for buckets it already knows about.
  // We use a stripped-down entry to avoid coupling to the full type.
  try {
    const health = classifyRunHealth(entry);
    switch (health.status) {
      case 'usage_blocked':
      case 'auth':
      case 'rate_limited':
        return 'model_error';
      case 'context_overflow':
      case 'prompt_too_large':
        return 'context_error';
      case 'tool_scope':
        return 'tool_error';
      case 'partial':
        // delivery-failed runs surface as tool_error in the new taxonomy
        return 'tool_error';
      case 'failed':
        // Disambiguate via error string below
        break;
      case 'unknown':
      default:
        break;
    }
  } catch {
    // job-health threw — proceed with heuristics
  }

  // Error-string heuristics. Last-resort. Order matters: more specific
  // patterns first so the catch-all doesn't swallow them.
  const blob = ((entry.error ?? '') + ' ' + (entry.outputPreview ?? '')).toLowerCase();
  if (!blob.trim()) return 'infrastructure_error';

  if (/refusal|cannot (?:assist|help|comply)|i (?:can'?t|am unable)/.test(blob)) return 'model_output_error';
  if (/invalid (?:tool|function) (?:call|input|json)|malformed tool|tool .* invalid arguments/.test(blob)) return 'model_output_error';
  if (/permission denied|policy violation|prompt[- ]injection|guardrail|blocked by hook/.test(blob)) return 'prompt_error';
  if (/tool .* time(d)? ?out|exceeded .* deadline|tool deadline/.test(blob)) return 'tool_timeout';
  if (/schema|validation failed|did not validate|does not match schema/.test(blob)) return 'schema_error';
  if (/context|too long|maximum context|exceeds.*tokens|input is too long/.test(blob)) return 'context_error';
  if (/subagent|sub[- ]agent failed|delegated agent/.test(blob)) return 'subagent_error';
  if (/cancel|user (?:interrupt|abort|stopped)/.test(blob)) return 'cancelled';
  if (/oom|out of memory|enospc|enoent|enotfound|spawn .*ENOENT|process .* exited|terminated/.test(blob)) return 'infrastructure_error';
  if (/401|403|unauthor|forbidden|invalid api key|api[- ]key/.test(blob)) return 'model_error';
  if (/429|rate.?limit|quota/.test(blob)) return 'model_error';
  if (/credit|billing|usage limit/.test(blob)) return 'model_error';
  if (/(network|fetch|connect).*(fail|reset|refused|timeout)/.test(blob)) return 'infrastructure_error';

  // Default catch-all — the run failed but the cause isn't explicit.
  return 'tool_error';
}

/** Human-readable label for a failure category — surfaced on dashboards. */
export function failureCategoryLabel(cat: RunFailureCategory): string {
  switch (cat) {
    case 'model_error':         return 'Model API';
    case 'model_output_error':  return 'Bad LLM output';
    case 'tool_error':          return 'Tool failed';
    case 'tool_timeout':        return 'Tool timeout';
    case 'schema_error':        return 'Schema mismatch';
    case 'context_error':       return 'Context exceeded';
    case 'prompt_error':        return 'Blocked by policy';
    case 'agent_loop_error':    return 'Loop limit';
    case 'subagent_error':      return 'Subagent failed';
    case 'infrastructure_error':return 'Infrastructure';
    case 'cancelled':           return 'Cancelled';
  }
}

/** Color hint for the dashboard pill. Returns a CSS var name. */
export function failureCategoryColor(cat: RunFailureCategory): string {
  switch (cat) {
    case 'cancelled':           return 'var(--text-muted)';
    case 'tool_timeout':
    case 'agent_loop_error':
    case 'context_error':       return 'var(--yellow)';
    case 'prompt_error':
    case 'schema_error':        return 'var(--purple)';
    case 'model_error':
    case 'model_output_error':  return 'var(--accent)';
    case 'infrastructure_error':return 'var(--red)';
    case 'tool_error':
    case 'subagent_error':      return 'var(--red)';
  }
}
