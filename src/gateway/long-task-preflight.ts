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

function recentContextFailures(recentRuns: CronRunEntry[]): string[] {
  const reasons: string[] = [];
  for (const run of recentRuns.slice(0, 5)) {
    const health = classifyRunHealth(run);
    if (health.status === 'context_overflow') reasons.push('recent run hit context overflow');
    if (health.status === 'prompt_too_large') reasons.push('recent run hit prompt-too-large');
  }
  return [...new Set(reasons)];
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
