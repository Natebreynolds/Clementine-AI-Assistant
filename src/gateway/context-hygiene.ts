import { estimateTokensApprox } from './turn-ledger.js';

export interface GatewayContextSnapshot {
  sessionKey: string;
  textChars: number;
  exchangeCount: number;
  pendingContextChars?: number;
  recentTranscriptChars?: number;
}

export interface GatewayContextHygieneDecision {
  shouldCompact: boolean;
  reason: string;
  estimatedTokens: number;
}

export const GATEWAY_CONTEXT_COMPACT_EXCHANGES = 30;
export const GATEWAY_CONTEXT_COMPACT_TOKENS = 90_000;

export function assessGatewayContextHygiene(snapshot: GatewayContextSnapshot): GatewayContextHygieneDecision {
  const totalChars = snapshot.textChars + (snapshot.pendingContextChars ?? 0) + (snapshot.recentTranscriptChars ?? 0);
  const estimatedTokens = estimateTokensApprox('x'.repeat(Math.min(totalChars, 400_000)))
    + Math.max(0, Math.ceil((totalChars - 400_000) / 4));
  if (snapshot.exchangeCount >= GATEWAY_CONTEXT_COMPACT_EXCHANGES) {
    return {
      shouldCompact: true,
      reason: `exchange_count_${snapshot.exchangeCount}`,
      estimatedTokens,
    };
  }
  if (estimatedTokens >= GATEWAY_CONTEXT_COMPACT_TOKENS) {
    return {
      shouldCompact: true,
      reason: `estimated_tokens_${estimatedTokens}`,
      estimatedTokens,
    };
  }
  return {
    shouldCompact: false,
    reason: 'within_budget',
    estimatedTokens,
  };
}

export function formatGatewayHygieneAnnotation(decision: GatewayContextHygieneDecision): string {
  return `[Context hygiene: compacted older session context before this turn (${decision.reason}, approx ${decision.estimatedTokens} tokens in visible gateway inputs). Continuity was saved to session summaries and lineage; use transcript_search/memory for exact details.]`;
}
