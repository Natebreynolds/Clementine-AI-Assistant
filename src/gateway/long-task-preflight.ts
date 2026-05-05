import {
  currentClaudePlan,
  currentOneMillionContextMode,
  MODELS,
  planIncludesSubscriptionOpusOneMillion,
  usesOneMillionContext,
  type ClaudePlan,
  type OneMillionContextMode,
} from '../config.js';
import type { CronJobDefinition, CronRunEntry, LongTaskPreflightSnapshot, LongTaskRisk, LongTaskRoute } from '../types.js';
import { classifyRunHealth } from './job-health.js';

const STANDARD_CONTEXT_TOKENS = 200_000;
const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;
const TOKEN_CHAR_RATIO = 4;

export interface LongTaskPreflightDecision extends LongTaskPreflightSnapshot {
  projectedContextTokens: number;
  modelOverride?: string;
  modeOverride?: CronJobDefinition['mode'];
  maxHoursOverride?: number;
  recommendations: string[];
  shouldSkipBeforeRun: boolean;
  approvalModelOverride?: string;
}

export interface LongTaskPreflightOptions {
  claudePlan?: ClaudePlan;
  oneMillionMode?: OneMillionContextMode;
  opusModel?: string;
  sonnetModel?: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHAR_RATIO);
}

function modelHasOneMillion(model: string | undefined, mode: OneMillionContextMode, plan: ClaudePlan): boolean {
  return usesOneMillionContext(model, mode, plan);
}

function sonnetOneMillionModel(sonnetModel = MODELS.sonnet): string {
  return /\[1m\]/i.test(sonnetModel) ? sonnetModel : `${sonnetModel}[1m]`;
}

function opusOneMillionModel(opusModel = MODELS.opus): string {
  return /\[1m\]/i.test(opusModel) ? opusModel : `${opusModel}[1m]`;
}

function isOpusModel(model: string | undefined): boolean {
  return /\bopus\b|claude-opus/i.test(String(model ?? ''));
}

function isSonnetOneMillionModel(model: string | undefined, mode: OneMillionContextMode, plan: ClaudePlan): boolean {
  return /\bsonnet\b|claude-sonnet/i.test(String(model ?? '')) && modelHasOneMillion(model, mode, plan);
}

function broadTaskSignals(text: string): string[] {
  const lower = text.toLowerCase();
  const signals: Array<[RegExp, string]> = [
    [/\b(all|entire|every|full)\b.{0,80}\b(logs?|history|repo|repository|codebase|records?|customers?|emails?|messages?|threads?|exports?)\b/s, 'broad full-history/full-dataset wording'],
    [/\b(audit|comprehensive|deep dive|deep-dive|exhaustive|end-to-end|root cause|market map|competitive intel)\b/, 'comprehensive analysis wording'],
    [/\b(crawl|scrape|backfill|migrate|refactor|inventory|scan)\b.{0,80}\b(all|entire|every|full)\b/s, 'large scan/backfill wording'],
    [/\b(long[- ]running|for hours|overnight|until (it'?s|it is|done|complete)|do not stop)\b/, 'explicit long-running wording'],
    [/\b(raw json|raw export|full transcript|full run log|complete logs?|all logs?)\b/, 'raw large-output wording'],
  ];
  return signals.filter(([re]) => re.test(lower)).map(([, reason]) => reason);
}

const RECENT_CONTEXT_FAILURE_WINDOW_MS = 48 * 60 * 60 * 1000;

function recentContextFailures(recentRuns: CronRunEntry[], now: number = Date.now()): string[] {
  const reasons: string[] = [];
  const cutoff = now - RECENT_CONTEXT_FAILURE_WINDOW_MS;
  for (const run of recentRuns.slice(0, 5)) {
    const startedMs = Date.parse(run.startedAt);
    if (Number.isFinite(startedMs) && startedMs < cutoff) continue;
    const health = classifyRunHealth(run);
    if (health.status === 'context_overflow') reasons.push('recent run hit context overflow');
    if (health.status === 'prompt_too_large') reasons.push('recent run hit prompt-too-large');
  }
  return [...new Set(reasons)];
}

// ── Auto-downgrade unleashed → standard for quiet/probe jobs ──────────
//
// `mode: unleashed` wraps a job in multi-phase machinery: each phase is a
// fresh SDK query with the full system prompt + tool schemas, and the
// orchestrator chains phases until TASK_COMPLETE or max-phases. That
// machinery is essential for genuinely-long tasks (sasha briefs, market
// outreach), but it's pure overhead on quiet probe jobs that finish in
// 1 phase with `__NOTHING__` or a short output.
//
// Detect that pattern from history and downgrade the next run to
// standard mode. Single SDK call, single cache write, fraction of the
// cost. The user's CRON.md `mode: unleashed` becomes a "ceiling" rather
// than a forced floor — actual mode chosen dynamically per-run.
//
// Conservative by design: requires 3+ prior runs of evidence, refuses
// to downgrade if any recent run hit context overflow (the unleashed
// wrapper might be actively saving us), and only triggers on jobs that
// historically complete fast with short or empty output.

const UNLEASHED_DOWNGRADE_SAMPLE_SIZE = 5;
const UNLEASHED_DOWNGRADE_MIN_HISTORY = 3;
const UNLEASHED_DOWNGRADE_QUIET_RATIO = 0.6;
const UNLEASHED_DOWNGRADE_MAX_DURATION_MS = 90_000;
const UNLEASHED_DOWNGRADE_AVG_DURATION_MS = 60_000;
const UNLEASHED_DOWNGRADE_QUIET_PREVIEW_CHARS = 200;

export interface UnleashedDowngradeDecision {
  downgrade: boolean;
  reason: string;
  /** Quiet ratio observed in the sample (for telemetry). */
  quietRatio?: number;
  /** Average duration of recent runs in ms (for telemetry). */
  avgDurationMs?: number;
}

export function shouldDowngradeUnleashed(
  recentRuns: CronRunEntry[],
  now: number = Date.now(),
): UnleashedDowngradeDecision {
  const sample = recentRuns
    .slice(0, UNLEASHED_DOWNGRADE_SAMPLE_SIZE)
    .filter(r => r.status === 'ok' || r.status === 'error');

  if (sample.length < UNLEASHED_DOWNGRADE_MIN_HISTORY) {
    return { downgrade: false, reason: 'insufficient_history' };
  }

  // Refuse to downgrade if any recent run hit a context-window failure —
  // the unleashed multi-phase wrapper might be the only thing keeping
  // this job from thrashing on a single huge SDK query. Pair this guard
  // with the existing fanout-policy directive (1.18.35) so by the next
  // few runs the agent has learned to fan out and the wrapper can be
  // shed safely.
  const cutoff = now - RECENT_CONTEXT_FAILURE_WINDOW_MS;
  const hadOverflow = sample.some(r => {
    const startedMs = Date.parse(r.startedAt);
    if (!Number.isFinite(startedMs) || startedMs < cutoff) return false;
    return r.terminalReason === 'rapid_refill_breaker'
      || r.terminalReason === 'prompt_too_long';
  });
  if (hadOverflow) {
    return { downgrade: false, reason: 'recent_context_overflow_protect_unleashed' };
  }

  // Quiet pattern: most recent runs returned __NOTHING__ or a short
  // output. These jobs don't need multi-phase orchestration.
  const quietCount = sample.filter(r => {
    const preview = (r.outputPreview ?? '').trim();
    if (!preview) return false;
    if (/__nothing__/i.test(preview)) return true;
    return preview.length < UNLEASHED_DOWNGRADE_QUIET_PREVIEW_CHARS;
  }).length;
  const quietRatio = quietCount / sample.length;
  if (quietRatio >= UNLEASHED_DOWNGRADE_QUIET_RATIO) {
    return {
      downgrade: true,
      reason: `quiet_pattern_${Math.round(quietRatio * 100)}pct`,
      quietRatio,
    };
  }

  // Fast-completion pattern: every run finishes well under the standard
  // cron timeout, average is short. Multi-phase wrapper is overhead.
  const durations = sample.map(r => r.durationMs || 0).filter(d => d > 0);
  if (durations.length === sample.length) {
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const allFast = durations.every(d => d < UNLEASHED_DOWNGRADE_MAX_DURATION_MS);
    if (allFast && avgDuration < UNLEASHED_DOWNGRADE_AVG_DURATION_MS) {
      return {
        downgrade: true,
        reason: `fast_completion_avg_${Math.round(avgDuration / 1000)}s`,
        avgDurationMs: Math.round(avgDuration),
      };
    }
  }

  return { downgrade: false, reason: 'workload_warrants_unleashed' };
}

function classifyRisk(args: {
  inputTokens: number;
  projectedTokens: number;
  signalCount: number;
  recentContextIssue: boolean;
  job: CronJobDefinition;
  oneMillionAvailable: boolean;
}): LongTaskRisk {
  const { inputTokens, projectedTokens, signalCount, recentContextIssue, job, oneMillionAvailable } = args;
  if (inputTokens >= 185_000) return 'unsafe';
  if (!oneMillionAvailable && projectedTokens >= 210_000) return 'unsafe';
  if (recentContextIssue || inputTokens >= 120_000 || projectedTokens >= 170_000) return 'huge';
  if ((job.mode === 'unleashed' && signalCount >= 2) || (job.maxHours ?? 0) >= 2) return 'huge';
  if (inputTokens >= 40_000 || projectedTokens >= 90_000 || signalCount >= 2) return 'long';
  if (job.mode === 'unleashed' || (job.maxHours ?? 0) >= 0.5 || (job.maxTurns ?? 0) >= 30) return 'long';
  return 'normal';
}

function routeFor(args: {
  risk: LongTaskRisk;
  model: string | undefined;
  oneMillionMode: OneMillionContextMode;
  claudePlan: ClaudePlan;
  oneMillionAllowed: boolean;
}): LongTaskRoute {
  const { risk, model, oneMillionMode, claudePlan, oneMillionAllowed } = args;
  if (risk === 'normal') return 'standard';
  if (isSonnetOneMillionModel(model, oneMillionMode, claudePlan)) return 'sonnet_1m';
  if (isOpusModel(model) && modelHasOneMillion(model, oneMillionMode, claudePlan)) return 'opus_1m';
  if ((risk === 'huge' || risk === 'unsafe') && oneMillionAllowed) return 'opus_1m';
  if (risk === 'unsafe') return 'split_required';
  return 'checkpointed';
}

export function analyzeLongTaskPreflight(
  job: CronJobDefinition,
  prompt: string,
  recentRuns: CronRunEntry[] = [],
  opts: LongTaskPreflightOptions = {},
): LongTaskPreflightDecision {
  const oneMillionMode = opts.oneMillionMode ?? currentOneMillionContextMode();
  const claudePlan = opts.claudePlan ?? currentClaudePlan();
  const inputTokens = estimateTokens(prompt);
  const signals = broadTaskSignals(`${job.name}\n${job.prompt}\n${job.context ?? ''}\n${prompt}`);
  const recentReasons = recentContextFailures(recentRuns);
  const expectedToolTokens =
    signals.length * 18_000
    + (job.mode === 'unleashed' ? 35_000 : 0)
    + Math.max(0, (job.maxTurns ?? 0) - 20) * 1_500
    + Math.max(0, (job.maxHours ?? 0) - 0.5) * 25_000;
  const projectedContextTokens = inputTokens + expectedToolTokens;
  const currentModel = job.model;
  const explicitLongContext = modelHasOneMillion(currentModel, oneMillionMode, claudePlan);
  const oneMillionAllowed = oneMillionMode === 'on'
    || explicitLongContext
    || (oneMillionMode === 'auto' && planIncludesSubscriptionOpusOneMillion(claudePlan));
  const risk = classifyRisk({
    inputTokens,
    projectedTokens: projectedContextTokens,
    signalCount: signals.length,
    recentContextIssue: recentReasons.length > 0,
    job,
    oneMillionAvailable: oneMillionAllowed,
  });
  const initialRoute = routeFor({ risk, model: currentModel, oneMillionMode, claudePlan, oneMillionAllowed });
  const route = initialRoute === 'checkpointed' && risk === 'huge' && recentReasons.length > 0
    ? 'split_required'
    : initialRoute;
  const targetOpusModel = opusOneMillionModel(opts.opusModel);
  const targetModel = sonnetOneMillionModel(opts.sonnetModel);
  const modelOverride =
    route === 'opus_1m' && !(isOpusModel(currentModel) && modelHasOneMillion(currentModel, oneMillionMode, claudePlan))
      ? targetOpusModel
      : route === 'sonnet_1m' && !isSonnetOneMillionModel(currentModel, oneMillionMode, claudePlan)
        ? targetModel
        : undefined;
  const modeOverride = route !== 'standard' && route !== 'split_required' && job.mode !== 'unleashed'
    ? 'unleashed'
    : undefined;
  const maxHoursFloor = risk === 'huge' || risk === 'unsafe' ? 2 : risk === 'long' ? 1 : undefined;
  const maxHoursOverride = maxHoursFloor && (job.maxHours ?? 0) < maxHoursFloor
    ? maxHoursFloor
    : undefined;
  const contextWindowTokens = route === 'opus_1m' || route === 'sonnet_1m'
    ? ONE_MILLION_CONTEXT_TOKENS
    : STANDARD_CONTEXT_TOKENS;
  const requiresUserRefinement = route === 'split_required';
  const approvalModelOverride = requiresUserRefinement && oneMillionMode !== 'off'
    ? opusOneMillionModel(opts.opusModel)
    : undefined;
  const canProceedWithApproval = approvalModelOverride != null;
  const approvalReason = canProceedWithApproval
    ? 'This run can proceed one time on Opus 1M if the owner approves possible Extra Usage or plan-gated long-context access.'
    : undefined;
  const reasons = [
    `estimated initial prompt: ${inputTokens.toLocaleString()} tokens`,
    ...(projectedContextTokens >= 90_000 ? [`projected working context: ${Math.round(projectedContextTokens).toLocaleString()} tokens`] : []),
    ...signals,
    ...recentReasons,
  ];
  const recommendations = [
    route === 'opus_1m'
      ? 'Run on Opus long context and keep phase checkpoints compact.'
      : route === 'sonnet_1m'
        ? 'Run on explicit Sonnet 1M and keep phase checkpoints compact.'
      : route === 'checkpointed'
        ? 'Run as checkpointed unleashed work with strict batching and summaries.'
        : route === 'split_required'
          ? approvalModelOverride
            ? `Ask the owner to approve a one-time run on ${approvalModelOverride}, or split the task before execution.`
            : 'Split the task before execution or enable a long-context model for this workspace if the account is eligible.'
          : 'Run normally.',
    'Store bulky intermediate data in files/artifacts instead of pasting it into the model context.',
  ];

  return {
    risk,
    route,
    estimatedInputTokens: inputTokens,
    projectedContextTokens,
    contextWindowTokens,
    modelBefore: currentModel,
    modelAfter: modelOverride ?? currentModel,
    modeBefore: job.mode,
    modeAfter: modeOverride ?? job.mode,
    modelOverride,
    modeOverride,
    maxHoursOverride,
    requiresUserRefinement,
    canProceedWithApproval,
    approvalReason,
    approvalModel: approvalModelOverride,
    approvalModelOverride,
    shouldSkipBeforeRun: requiresUserRefinement,
    reasons,
    recommendations,
  };
}

export function formatLongTaskPromptPrefix(decision: LongTaskPreflightDecision): string {
  return [
    '## Long Task Operating Mode',
    `Preflight classified this task as ${decision.risk} and routed it as ${decision.route}.`,
    '',
    'Execution contract:',
    '- Work from explicit checkpoints. End each phase with STATUS SUMMARY, COMPLETED, OPEN ITEMS, ARTIFACTS, and NEXT STEP.',
    '- Keep tool reads bounded. Do not paste full logs, full transcripts, raw exports, or large JSON into the conversation.',
    '- Put bulky intermediate data in files/artifacts and cite file paths plus compact counts or IDs.',
    '- If the task grows beyond the active context window, stop with a split plan instead of retrying broader reads.',
    '',
    `Preflight reasons: ${decision.reasons.slice(0, 5).join('; ')}`,
  ].join('\n');
}

export function compactLongTaskPreflight(decision: LongTaskPreflightDecision): LongTaskPreflightSnapshot {
  return {
    risk: decision.risk,
    route: decision.route,
    estimatedInputTokens: decision.estimatedInputTokens,
    contextWindowTokens: decision.contextWindowTokens,
    modelBefore: decision.modelBefore,
    modelAfter: decision.modelAfter,
    modeBefore: decision.modeBefore,
    modeAfter: decision.modeAfter,
    requiresUserRefinement: decision.requiresUserRefinement,
    canProceedWithApproval: decision.canProceedWithApproval,
    approvalReason: decision.approvalReason,
    approvalModel: decision.approvalModel,
    reasons: decision.reasons.slice(0, 8),
  };
}
