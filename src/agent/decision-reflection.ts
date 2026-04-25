/**
 * Clementine TypeScript — Per-agent decision-loop reflection.
 *
 * Reads an agent's slice of the proactive decision ledger and produces
 * a calibration report:
 *
 *   - How many decisions per action (act_now / queue / ask_user / snooze / ignore)
 *   - Of those, how many had recorded outcomes
 *   - Success rate (advanced / withOutcomes) per action
 *   - Top signal sources by volume
 *   - Plain-English patterns + concrete tuning suggestions
 *
 * The report is meant to land in the agent's working-memory so it
 * shapes their next heartbeat tick — they read their own track record
 * and self-correct without code changes.
 *
 * Pure analysis: no I/O side effects. The MCP tool wrapper handles
 * file writes (history) and working-memory updates separately.
 */

import { recentDecisions } from './proactive-ledger.js';
import type { ProactiveAction, ProactiveDecision, ProactiveSource } from './proactive-engine.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ActionBucket {
  decided: number;
  withOutcomes: number;
  advanced: number;
  blocked: number;
  failed: number;
  /** advanced / withOutcomes * 100, or null if no outcomes recorded yet. */
  successRatePct: number | null;
}

export interface DecisionReflection {
  slug: string;
  windowDays: number;
  totalDecisions: number;
  byAction: Record<ProactiveAction, ActionBucket>;
  topSources: Array<{ source: ProactiveSource; count: number }>;
  patterns: string[];
  suggestions: string[];
  generatedAt: string;
}

// ── Constants ────────────────────────────────────────────────────────

const ALL_ACTIONS: ProactiveAction[] = ['act_now', 'queue', 'ask_user', 'snooze', 'ignore'];
const LOW_SUCCESS_THRESHOLD = 50; // < 50% success → flag as miscalibrated
const HIGH_VOLUME_THRESHOLD = 20; // > 20 decisions in window → "active loop"
const DORMANT_THRESHOLD = 0;       // 0 decisions → "dormant"

function emptyBucket(): ActionBucket {
  return { decided: 0, withOutcomes: 0, advanced: 0, blocked: 0, failed: 0, successRatePct: null };
}

function emptyByAction(): Record<ProactiveAction, ActionBucket> {
  const out = {} as Record<ProactiveAction, ActionBucket>;
  for (const a of ALL_ACTIONS) out[a] = emptyBucket();
  return out;
}

// ── Analysis ─────────────────────────────────────────────────────────

/**
 * Read the ledger, filter by agent + window, compute the calibration
 * stats. Returns a DecisionReflection ready to format.
 *
 * Agent matching: a record belongs to `slug` when context.owner === slug
 * OR context.goalId resolves to a goal whose owner is slug. For now we
 * match only on context.owner — slug-by-goal is more expensive (would
 * need listAllGoals) and not worth it until owner is consistently set.
 */
export function analyzeAgentDecisions(
  slug: string,
  windowDays = 7,
  opts?: { ledgerPath?: string; now?: Date },
): DecisionReflection {
  const now = opts?.now ?? new Date();
  const sinceMs = windowDays * 24 * 60 * 60 * 1000;
  const records = recentDecisions(
    { sinceMs },
    opts?.ledgerPath ? { filePath: opts.ledgerPath, now } : { now },
  );

  // Filter to records relevant to this agent. Inclusion rule:
  //   - context.owner === slug (preferred — explicitly attributed)
  //   - else if slug === 'clementine': include records with no owner
  //     (the daemon's own decisions default to no-owner)
  const isClementine = slug === 'clementine';
  const mine = records.filter((r) => {
    const owner = r.context.owner;
    if (owner) return owner === slug;
    return isClementine; // unowned → Clementine
  });

  // Outcome records share the original decision's id and have an
  // `outcome` field. Index by id so we can pair decisions with their
  // outcomes in one pass.
  const outcomeById = new Map<string, ActionBucket['advanced'] | string>();
  for (const r of mine) {
    if (r.outcome) outcomeById.set(r.id, r.outcome.status);
  }

  const byAction = emptyByAction();
  const sourceCounts = new Map<ProactiveSource, number>();
  let totalDecisions = 0;

  for (const r of mine) {
    if (r.outcome) continue; // outcomes are indexed; only count original decisions here
    totalDecisions++;
    const action = r.decision.action;
    const bucket = byAction[action];
    bucket.decided++;

    const outcomeStatus = outcomeById.get(r.id);
    if (outcomeStatus !== undefined) {
      bucket.withOutcomes++;
      if (outcomeStatus === 'advanced') bucket.advanced++;
      else if (typeof outcomeStatus === 'string' && outcomeStatus.startsWith('blocked-')) bucket.blocked++;
      else if (outcomeStatus === 'failed') bucket.failed++;
    }

    const src = r.decision.source;
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
  }

  // Compute success rates
  for (const a of ALL_ACTIONS) {
    const b = byAction[a];
    b.successRatePct = b.withOutcomes > 0 ? Math.round((b.advanced / b.withOutcomes) * 100) : null;
  }

  const topSources = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const { patterns, suggestions } = derivePatterns({ slug, totalDecisions, byAction, topSources, windowDays });

  return {
    slug,
    windowDays,
    totalDecisions,
    byAction,
    topSources,
    patterns,
    suggestions,
    generatedAt: now.toISOString(),
  };
}

/**
 * Derive plain-English patterns + tuning suggestions from the stats.
 * Each pattern is a one-line observation; each suggestion is concrete
 * advice the agent (or human) can act on.
 */
function derivePatterns(input: {
  slug: string;
  totalDecisions: number;
  byAction: Record<ProactiveAction, ActionBucket>;
  topSources: Array<{ source: ProactiveSource; count: number }>;
  windowDays: number;
}): { patterns: string[]; suggestions: string[] } {
  const patterns: string[] = [];
  const suggestions: string[] = [];

  if (input.totalDecisions === DORMANT_THRESHOLD) {
    patterns.push(`No decisions recorded in the last ${input.windowDays} days.`);
    suggestions.push(
      'Agent is dormant. Either no signals are reaching the heartbeat, or every signal is being deduped. Check the proactive ledger directly to confirm.',
    );
    return { patterns, suggestions };
  }

  if (input.totalDecisions >= HIGH_VOLUME_THRESHOLD) {
    patterns.push(`High decision volume: ${input.totalDecisions} decisions in ${input.windowDays} days.`);
  }

  const actNow = input.byAction.act_now;
  if (actNow.withOutcomes >= 3 && (actNow.successRatePct ?? 100) < LOW_SUCCESS_THRESHOLD) {
    patterns.push(
      `act_now success rate is ${actNow.successRatePct}% (${actNow.advanced}/${actNow.withOutcomes}). Low — many autonomous actions did not advance.`,
    );
    suggestions.push(
      'Raise the urgency threshold for act_now (in proactive-engine.ts decideGoalAdvancement / decideDailyPlanPriority) — currently firing too aggressively. Consider requiring urgency >= 5 instead of >= 4.',
    );
  }

  const queue = input.byAction.queue;
  if (queue.withOutcomes >= 3 && (queue.successRatePct ?? 100) < LOW_SUCCESS_THRESHOLD) {
    patterns.push(
      `Queued items are not landing: ${queue.advanced}/${queue.withOutcomes} advanced (${queue.successRatePct}%).`,
    );
    suggestions.push(
      'Queued work is going stale. Review the work-queue dwell time — items may be timing out before the heartbeat runs them.',
    );
  }

  if (queue.decided > actNow.decided * 3 && actNow.decided > 0) {
    patterns.push(
      `Queue-heavy bias: ${queue.decided} queued vs ${actNow.decided} act_now. The engine is being conservative.`,
    );
    suggestions.push(
      'If most queued items eventually advance manually, consider lowering the queue→act_now threshold or expanding act_now eligibility.',
    );
  }

  const blockedTotal = ALL_ACTIONS.reduce((sum, a) => sum + input.byAction[a].blocked, 0);
  if (blockedTotal >= 3) {
    patterns.push(`${blockedTotal} decisions ended blocked (waiting on user/external).`);
    suggestions.push(
      'Frequent blocking suggests the agent is hitting questions only the owner can answer. Review whether earlier ask_user prompts would clear the blockage faster.',
    );
  }

  const askUserCount = input.byAction.ask_user.decided;
  if (askUserCount === 0 && actNow.decided + queue.decided >= 5) {
    patterns.push('Zero ask_user decisions despite active autonomous work.');
    suggestions.push(
      'Agent never asked for owner input over the window. Either everything is unambiguously autonomous (good) or the agent is over-deciding without clarity (suspect when blocked outcomes are non-trivial).',
    );
  }

  const failedTotal = ALL_ACTIONS.reduce((sum, a) => sum + input.byAction[a].failed, 0);
  if (failedTotal >= 3) {
    patterns.push(`${failedTotal} decisions ended in failed outcomes.`);
    suggestions.push(
      'Multiple failures — check cron logs for the failing job names. May indicate a tool that needs maintenance, a budget cap being hit, or a misconfigured trigger.',
    );
  }

  if (patterns.length === 0) {
    patterns.push('No notable patterns detected — calibration looks healthy for this window.');
  }

  return { patterns, suggestions };
}

// ── Markdown formatter ───────────────────────────────────────────────

const ACTION_LABELS: Record<ProactiveAction, string> = {
  act_now: 'Doing now',
  queue: 'Queued',
  ask_user: 'Needs you',
  snooze: 'Snoozed',
  ignore: 'Skipped',
};

export function formatReflectionReport(r: DecisionReflection): string {
  const lines: string[] = [];
  lines.push(`# Decision reflection — ${r.slug}`);
  lines.push('');
  lines.push(`Generated: ${r.generatedAt}  `);
  lines.push(`Window: last ${r.windowDays} day(s)  `);
  lines.push(`Total decisions: **${r.totalDecisions}**`);
  lines.push('');

  if (r.totalDecisions === 0) {
    lines.push('## No decisions in window');
    lines.push('');
    for (const p of r.patterns) lines.push(`- ${p}`);
    if (r.suggestions.length > 0) {
      lines.push('');
      lines.push('### Suggestions');
      for (const s of r.suggestions) lines.push(`- ${s}`);
    }
    return lines.join('\n');
  }

  lines.push('## By action');
  lines.push('');
  lines.push('| Action | Decided | Outcomes | Advanced | Blocked | Failed | Success |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const a of ALL_ACTIONS) {
    const b = r.byAction[a];
    if (b.decided === 0) continue;
    const pct = b.successRatePct === null ? '—' : `${b.successRatePct}%`;
    lines.push(`| ${ACTION_LABELS[a]} (${a}) | ${b.decided} | ${b.withOutcomes} | ${b.advanced} | ${b.blocked} | ${b.failed} | ${pct} |`);
  }

  if (r.topSources.length > 0) {
    lines.push('');
    lines.push('## Top sources');
    for (const s of r.topSources) {
      lines.push(`- **${s.source}**: ${s.count}`);
    }
  }

  lines.push('');
  lines.push('## Patterns');
  for (const p of r.patterns) lines.push(`- ${p}`);

  if (r.suggestions.length > 0) {
    lines.push('');
    lines.push('## Suggestions');
    for (const s of r.suggestions) lines.push(`- ${s}`);
  }

  return lines.join('\n');
}

/**
 * Compact summary for working-memory append. Skips the full table and
 * keeps just the patterns + suggestions so the agent's prompt doesn't
 * get bloated with raw stats.
 */
export function formatReflectionSummary(r: DecisionReflection): string {
  const lines: string[] = [];
  lines.push(`### Self-reflection (${r.generatedAt.slice(0, 10)}, last ${r.windowDays}d, ${r.totalDecisions} decisions)`);
  lines.push('');
  for (const p of r.patterns) lines.push(`- ${p}`);
  if (r.suggestions.length > 0) {
    lines.push('');
    lines.push('**Tuning suggestions:**');
    for (const s of r.suggestions) lines.push(`- ${s}`);
  }
  return lines.join('\n');
}

/** Internal type alias used by tests / tool. */
export type { ProactiveDecision };
