/**
 * claim-verification — detect when an agent claims to have done
 * something but the run's tool-call history shows no matching action.
 *
 * Why this exists (1.18.187)
 * ──────────────────────────
 * On 2026-05-11 a bg task was diagnosed where Clementine said "The
 * site is live again at https://X.netlify.app — all 100 coaches with
 * search/filter/sort intact" — but the live URL returned HTTP 404,
 * and the run had zero tool calls matching a deploy. She had
 * confabulated success from a recall summary of a PRIOR task.
 *
 * The bg-task framework's `markDone` had no verification: it accepted
 * the agent's claim verbatim and stamped status='done'. Downstream,
 * the "Recently completed background work" recall block then
 * re-injected that hallucinated "done" claim into the next session's
 * prompt, perpetuating the lie.
 *
 * This module breaks the cycle by inspecting the result text for
 * active-voice action claims ("I deployed X", "I sent the email")
 * and cross-referencing against the run's event log
 * (~/.clementine/events/<runId>.jsonl). When a claim has no matching
 * evidence, the task is flagged for owner review instead of stamped
 * `done`.
 *
 * Pure functions where possible; one I/O call to read the event log.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { RunEvent } from '../types.js';

// ── Verb → required tool patterns ────────────────────────────────────

interface ClaimRule {
  /** Regex matching first-person active-voice claims of this verb. */
  pattern: RegExp;
  /** Short label for the claim type (used in flags). */
  label: string;
  /** Tool-call patterns that count as evidence. At least one must match. */
  evidenceMatchers: Array<{ kind: 'toolName' | 'bashCommand'; pattern: RegExp; describe: string }>;
}

/**
 * Claim rules ordered by specificity. Each rule has a verb pattern
 * (first-person active voice with optional adverbs/modifiers) and
 * the set of tool-call shapes that count as evidence for it.
 *
 * Pattern shape: `\bI\s+(have\s+)?(verb-tensed)\b`
 *
 * Active voice + first person is required — "X is deployed" or
 * "the site has been deployed" don't trigger (those are status
 * references, not action claims).
 */
const CLAIM_RULES: ClaimRule[] = [
  {
    label: 'deploy',
    pattern: /\bI\s+(?:have\s+)?(?:just\s+|now\s+)?(?:deployed|published|pushed|launched|uploaded)\b/i,
    evidenceMatchers: [
      { kind: 'bashCommand', pattern: /\bnetlify\s+deploy\b/i, describe: 'netlify deploy' },
      { kind: 'bashCommand', pattern: /\bvercel\s+(?:--prod|deploy)\b/i, describe: 'vercel deploy' },
      { kind: 'bashCommand', pattern: /\bgh-pages\b/i, describe: 'gh-pages publish' },
      { kind: 'bashCommand', pattern: /\bgit\s+push\b/i, describe: 'git push' },
      { kind: 'bashCommand', pattern: /\brsync\b/i, describe: 'rsync upload' },
      { kind: 'bashCommand', pattern: /\baws\s+s3\s+(?:cp|sync)\b/i, describe: 'aws s3 upload' },
      { kind: 'bashCommand', pattern: /\bcurl\s+.*-X\s+(?:POST|PUT)\b/i, describe: 'curl POST/PUT (API deploy)' },
      { kind: 'toolName', pattern: /^mcp__.*__(?:deploy|publish|upload)/i, describe: 'MCP deploy tool' },
      { kind: 'toolName', pattern: /^project_deploy$/i, describe: 'project_deploy tool' },
    ],
  },
  {
    label: 'send',
    pattern: /\bI\s+(?:have\s+)?(?:just\s+)?(?:sent|emailed|messaged|posted|notified)\b/i,
    evidenceMatchers: [
      { kind: 'toolName', pattern: /^mcp__.*__(?:send|reply|create_message|post|notify)/i, describe: 'integration send tool' },
      { kind: 'toolName', pattern: /^discord_(?:channel_send|send_dm|reply)/i, describe: 'discord send' },
      { kind: 'toolName', pattern: /^outlook_(?:send|reply)/i, describe: 'outlook send' },
      { kind: 'toolName', pattern: /^gmail_send/i, describe: 'gmail send' },
      { kind: 'toolName', pattern: /^slack_(?:send|post)/i, describe: 'slack post' },
      { kind: 'bashCommand', pattern: /\bcurl\s+.*-X\s+POST\b/i, describe: 'curl POST (webhook)' },
    ],
  },
  {
    label: 'write/create',
    pattern: /\bI\s+(?:have\s+)?(?:just\s+)?(?:created|wrote|saved|built|generated)\s+(?:the|a|an|new)\b/i,
    evidenceMatchers: [
      { kind: 'toolName', pattern: /^Write$/i, describe: 'Write tool' },
      { kind: 'toolName', pattern: /^Edit$/i, describe: 'Edit tool' },
      { kind: 'toolName', pattern: /^NotebookEdit$/i, describe: 'NotebookEdit tool' },
      { kind: 'bashCommand', pattern: />\s*[^\s|;&]+/, describe: 'shell write redirect' },
      { kind: 'bashCommand', pattern: /\bmkdir\b/i, describe: 'mkdir' },
      { kind: 'bashCommand', pattern: /\bcp\b|\bmv\b/i, describe: 'cp/mv' },
      { kind: 'toolName', pattern: /^note_create$/i, describe: 'note_create' },
      { kind: 'toolName', pattern: /^memory_write$/i, describe: 'memory_write' },
    ],
  },
  {
    label: 'merge',
    pattern: /\bI\s+(?:have\s+)?(?:just\s+)?(?:merged|combined|consolidated|joined)\s+(?:the|a|two|all|both)\b/i,
    evidenceMatchers: [
      { kind: 'toolName', pattern: /^Write$/i, describe: 'Write tool (output file)' },
      { kind: 'toolName', pattern: /^Edit$/i, describe: 'Edit tool' },
      { kind: 'bashCommand', pattern: /\b(?:cat|paste|jq|awk)\b.*>\s*[^\s|;&]+/, describe: 'shell merge into file' },
      { kind: 'bashCommand', pattern: /\bgit\s+merge\b/i, describe: 'git merge' },
    ],
  },
];

// ── Public API ───────────────────────────────────────────────────────

export type VerificationVerdict =
  | { ok: true; reason: 'no-claims' }
  | { ok: true; reason: 'evidence-found'; matchedClaims: Array<{ label: string; evidence: string }> }
  | { ok: false; reason: 'claimed-without-evidence'; missingEvidence: Array<{ label: string; expectedAnyOf: string[] }> };

export interface VerifyOptions {
  /** Path to the events directory. Defaults to ~/.clementine/events. */
  eventsDir?: string;
  /** Pre-loaded events (for tests). When set, eventsDir is ignored. */
  events?: RunEvent[];
}

/**
 * Verify that a bg-task's result text matches the tool calls actually
 * made during the run.
 *
 * @param resultText   The text the agent produced as the final response.
 * @param runId        The run id; used to find the event log on disk.
 * @param opts         Test injection: pre-loaded events or alt directory.
 * @returns            A verdict object the caller (markDone) can use to
 *                     decide whether to stamp `done` or flag the task.
 */
export function verifyTaskClaims(
  resultText: string,
  runId: string | undefined,
  opts: VerifyOptions = {},
): VerificationVerdict {
  const text = String(resultText ?? '');
  if (!text.trim()) return { ok: true, reason: 'no-claims' };

  // 1. Find all claim rules whose pattern matches the result text.
  const triggeredRules: ClaimRule[] = CLAIM_RULES.filter((r) => r.pattern.test(text));
  if (triggeredRules.length === 0) {
    // No first-person active-voice action claims — nothing to verify.
    // (Pure status reports like "the file is at /x/y/z" pass through.)
    return { ok: true, reason: 'no-claims' };
  }

  // 2. Load the run's event log to inspect tool calls.
  const events = opts.events ?? loadEvents(runId, opts.eventsDir);

  // 3. For each triggered rule, check whether ANY matching evidence
  // exists in the event log. If at least one rule has zero evidence,
  // the verdict is claimed-without-evidence.
  const matched: Array<{ label: string; evidence: string }> = [];
  const missing: Array<{ label: string; expectedAnyOf: string[] }> = [];
  for (const rule of triggeredRules) {
    const hit = findEvidence(events, rule);
    if (hit) {
      matched.push({ label: rule.label, evidence: hit });
    } else {
      missing.push({
        label: rule.label,
        expectedAnyOf: rule.evidenceMatchers.map((m) => m.describe),
      });
    }
  }

  if (missing.length > 0) {
    return { ok: false, reason: 'claimed-without-evidence', missingEvidence: missing };
  }
  return { ok: true, reason: 'evidence-found', matchedClaims: matched };
}

// ── Internals ────────────────────────────────────────────────────────

function loadEvents(runId: string | undefined, eventsDir?: string): RunEvent[] {
  if (!runId) return [];
  const dir = eventsDir ?? path.join(BASE_DIR, 'events');
  const safe = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const file = path.join(dir, `${safe}.jsonl`);
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const out: RunEvent[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line) as RunEvent); }
      catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

function findEvidence(events: RunEvent[], rule: ClaimRule): string | null {
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    const toolName = String(event.toolName ?? '');
    // Match against tool name patterns.
    for (const m of rule.evidenceMatchers) {
      if (m.kind === 'toolName' && m.pattern.test(toolName)) {
        return `${m.describe} (tool: ${toolName})`;
      }
    }
    // For Bash tool calls, inspect the command argument.
    if (toolName === 'Bash' && event.toolInput) {
      const cmd = extractBashCommand(event.toolInput);
      if (cmd) {
        for (const m of rule.evidenceMatchers) {
          if (m.kind === 'bashCommand' && m.pattern.test(cmd)) {
            return `${m.describe} (Bash: ${cmd.slice(0, 80)})`;
          }
        }
      }
    }
  }
  return null;
}

function extractBashCommand(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const obj = toolInput as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command;
  return null;
}
