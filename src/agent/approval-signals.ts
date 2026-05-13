/**
 * Owner-approval feedback loop for self-improve proposals (1.18.161).
 *
 * Background: the self-improve hypothesizer generates 1-3 proposals each
 * cycle. The owner approves or denies each one in the dashboard. Today
 * that decision is recorded only as a status change on the experiment row
 * — the *implicit signal* ("this kind of fix is good / bad") is lost.
 *
 * This module captures the signal as an append-only JSONL log
 * (`~/.clementine/self-improve/approval-signals.jsonl`) and exposes
 * `formatForHypothesizer()` so the next cycle's prompt includes:
 *
 *   ## Owner approval signals (recent)
 *   APPROVED (do more like this):
 *   - cron/insight-check: "Apply lean mode to reduce prompt size"
 *   - agent/marketing-agent: "Add explicit citation requirement to system prompt"
 *
 *   DENIED (avoid these patterns):
 *   - workflow/email-gen: "Replace template with LLM generation"  ← user note: "too generic; loses voice"
 *
 * The hypothesizer reads this and biases future proposals — favoring
 * patterns the owner has approved, avoiding patterns they've denied.
 *
 * Closed-loop autonomy: the system learns from human feedback without
 * needing the human to write rules. Just react to proposals as usual.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/** Where the append-only signals log lives. */
function signalsLogPath(): string {
  return path.join(BASE_DIR, 'self-improve', 'approval-signals.jsonl');
}

export interface ApprovalSignal {
  /** ISO timestamp of the decision. */
  ts: string;
  /** Self-improve experiment ID this decision applies to. */
  experimentId: string;
  /** The area the proposal targeted (cron, agent, skill, soul, etc.). */
  area: string;
  /** The specific target (e.g., "insight-check", "marketing-agent"). */
  target: string;
  /** The proposal's one-sentence hypothesis (truncated to 200 chars). */
  hypothesis: string;
  /** Owner's decision. */
  decision: 'approved' | 'denied';
  /** Optional free-text note from the owner explaining the decision. */
  noteFromOwner?: string;
}

/** Append a new signal to the log. Best-effort — never throws to the caller. */
export function recordApprovalSignal(signal: Omit<ApprovalSignal, 'ts'>): void {
  try {
    const file = signalsLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const entry: ApprovalSignal = {
      ts: new Date().toISOString(),
      ...signal,
      // Truncate hypothesis to keep the log compact + searchable.
      hypothesis: (signal.hypothesis || '').slice(0, 200),
    };
    appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch { /* never block the apply/deny path on telemetry */ }
}

/**
 * Read the most recent N signals from the log. Returns newest-first.
 * Defaults to 50 — enough for the hypothesizer to see patterns, not so
 * many that we bloat its prompt.
 */
export function getRecentApprovalSignals(limit = 50): ApprovalSignal[] {
  const file = signalsLogPath();
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    const recent: ApprovalSignal[] = [];
    for (let i = lines.length - 1; i >= 0 && recent.length < limit; i--) {
      try {
        recent.push(JSON.parse(lines[i]) as ApprovalSignal);
      } catch { /* skip malformed lines */ }
    }
    return recent;
  } catch {
    return [];
  }
}

/**
 * Render a recent-signals prompt block for the hypothesizer. Returns the
 * empty string when there are no signals (so the prompt stays clean for
 * fresh installs). Caps at the most recent 8 of each kind to keep the
 * block compact.
 */
export function formatApprovalSignalsForHypothesizer(): string {
  const signals = getRecentApprovalSignals(40);
  if (signals.length === 0) return '';

  const approved = signals.filter(s => s.decision === 'approved').slice(0, 8);
  const denied = signals.filter(s => s.decision === 'denied').slice(0, 8);
  if (approved.length === 0 && denied.length === 0) return '';

  const fmt = (s: ApprovalSignal): string => {
    const note = s.noteFromOwner ? `  ← owner note: "${s.noteFromOwner.slice(0, 120)}"` : '';
    return `- ${s.area}/${s.target}: "${s.hypothesis}"${note}`;
  };

  const parts: string[] = ['### Owner approval signals (recent)'];
  if (approved.length > 0) {
    parts.push('APPROVED (do more like these):');
    parts.push(approved.map(fmt).join('\n'));
  }
  if (denied.length > 0) {
    parts.push('DENIED (avoid these patterns):');
    parts.push(denied.map(fmt).join('\n'));
  }
  parts.push(
    'Bias today\'s proposals toward the approved patterns and away from the denied ones. ' +
    'If a denied pattern reflects a misunderstanding (e.g. you proposed the wrong target), ' +
    'reframe — don\'t just avoid the area entirely.',
  );
  return parts.join('\n') + '\n\n';
}
