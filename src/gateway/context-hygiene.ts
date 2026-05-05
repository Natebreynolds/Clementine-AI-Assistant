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

// Session-state pruning ceiling. Independent of the SDK's own autocompact —
// this trims OUR in-memory record of the conversation so it doesn't grow
// unbounded over a long-lived chat session. The SDK owns the actual
// context-window dance; we just want a hard ceiling on session bookkeeping.
// Thresholds were tightened earlier (30 / 90K) to compensate for autocompact
// thrash, but the real cause was the over-broad tool surface, not session
// state. With that fixed, this only needs to fire as a safety net.
export const GATEWAY_CONTEXT_COMPACT_EXCHANGES = 100;
export const GATEWAY_CONTEXT_COMPACT_TOKENS = 180_000;

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
