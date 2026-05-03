import type { CronRunEntry } from '../types.js';

export type JobHealthKind =
  | 'healthy'
  | 'recovered'
  | 'partial'
  | 'context_overflow'
  | 'auth'
  | 'rate_limited'
  | 'tool_scope'
  | 'prompt_too_large'
  | 'failed'
  | 'unknown';

export interface JobHealthStatus {
  status: JobHealthKind;
  jobName?: string;
  lastRunAt?: string;
  terminalReason?: string;
  evidence: string[];
  recommendedAction: string;
  requiresApproval: boolean;
}

function compactEvidence(...items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const value = item?.trim();
    if (!value) continue;
    const key = value.toLowerCase().slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value.slice(0, 280));
  }
  return result.slice(0, 4);
}

export function classifyRunHealth(entry: CronRunEntry): JobHealthStatus {
  const terminalReason = entry.terminalReason;
  const blob = compactEvidence(
    terminalReason ? `terminalReason=${terminalReason}` : undefined,
    entry.error,
    entry.outputPreview,
    entry.deliveryFailed ? entry.deliveryError ?? 'delivery failed' : undefined,
  ).join('\n').toLowerCase();

  const base = {
    jobName: entry.jobName,
    lastRunAt: entry.startedAt,
    terminalReason,
  };

  if (terminalReason === 'rapid_refill_breaker' || /rapid_refill_breaker|autocompact|context refilled|maximum context|context.?length/.test(blob)) {
    return {
      ...base,
      status: 'context_overflow',
      evidence: compactEvidence(terminalReason ? `terminalReason=${terminalReason}` : undefined, entry.error, entry.outputPreview),
      recommendedAction: 'Bound the job prompt and tool output before retrying. Read small chunks, cap batches, and summarize large integration results.',
      requiresApproval: true,
    };
  }

  if (terminalReason === 'prompt_too_long' || /prompt is too long|prompt too long|input is too long|request too large/.test(blob)) {
    return {
      ...base,
      status: 'prompt_too_large',
      evidence: compactEvidence(terminalReason ? `terminalReason=${terminalReason}` : undefined, entry.error, entry.outputPreview),
      recommendedAction: 'Reduce injected context and add bounded-read guidance before the next run.',
      requiresApproval: true,
    };
  }

  if (/\b(401|403)\b|not authenticated|invalid api key|credential|please run \/login|does not have access|unauthorized|forbidden/.test(blob)) {
    return {
      ...base,
      status: 'auth',
      evidence: compactEvidence(entry.error, entry.outputPreview),
      recommendedAction: 'Refresh the affected integration credentials, then run a small probe.',
      requiresApproval: true,
    };
  }

  if (/rate.?limit|too many requests|429|quota exceeded/.test(blob)) {
    return {
      ...base,
      status: 'rate_limited',
      evidence: compactEvidence(entry.error, entry.outputPreview),
      recommendedAction: 'Back off job cadence or batch size before retrying.',
      requiresApproval: false,
    };
  }

  if (/\b(blocked|task_blocked|task_incomplete)\b|no local bash|permission denied|tool unavailable|missing capability/.test(blob)) {
    return {
      ...base,
      status: 'tool_scope',
      evidence: compactEvidence(entry.error, entry.outputPreview),
      recommendedAction: 'Tighten the job scope so it only uses available tools, or add a prompt override that stops unavailable-tool retries.',
      requiresApproval: true,
    };
  }

  if (entry.status === 'error' || entry.status === 'retried') {
    return {
      ...base,
      status: 'failed',
      evidence: compactEvidence(entry.error, entry.outputPreview, terminalReason ? `terminalReason=${terminalReason}` : undefined),
      recommendedAction: 'Inspect the latest error and current job definition before applying a fix.',
      requiresApproval: true,
    };
  }

  if (entry.deliveryFailed) {
    return {
      ...base,
      status: 'partial',
      evidence: compactEvidence(entry.deliveryError, entry.outputPreview),
      recommendedAction: 'The job ran but delivery failed. Check the outbound channel and retry delivery.',
      requiresApproval: false,
    };
  }

  if (entry.status === 'ok') {
    return {
      ...base,
      status: 'healthy',
      evidence: compactEvidence(entry.outputPreview),
      recommendedAction: 'No action needed.',
      requiresApproval: false,
    };
  }

  return {
    ...base,
    status: 'unknown',
    evidence: compactEvidence(entry.error, entry.outputPreview, terminalReason ? `terminalReason=${terminalReason}` : undefined),
    recommendedAction: 'No clear health signal. Inspect the run log if this repeats.',
    requiresApproval: false,
  };
}

export function isRunHealthFailure(entry: CronRunEntry): boolean {
  const health = classifyRunHealth(entry);
  return !['healthy', 'recovered', 'unknown'].includes(health.status);
}
