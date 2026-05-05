/**
 * Conversation context policy.
 *
 * Decides what Clementine should know silently, what she may surface, and
 * when she should search prior conversation before asking the user to repeat
 * themselves. This keeps operational context available without turning casual
 * replies into status dumps.
 */

import type { ActiveContextItem, ActiveContextSnapshot } from './active-context.js';

export type ContextTurnIntent =
  | 'greeting'
  | 'ack'
  | 'status'
  | 'repair_request'
  | 'followup'
  | 'memory_correction'
  | 'work_request'
  | 'general_chat';

export type RequiredRetrieval = 'none' | 'event' | 'transcript';

export interface ContextPolicyDecision {
  turnIntent: ContextTurnIntent;
  silentContextBlocks: string[];
  visibleOpening: string | null;
  proactiveSurface: ActiveContextItem[];
  requiredRetrieval: RequiredRetrieval;
  retrievalQueries: string[];
  debugReasons: string[];
}

export interface ContextPolicyInput {
  text: string;
  activeContext?: ActiveContextSnapshot | null;
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'along', 'also', 'because', 'being', 'could',
  'does', 'doing', 'done', 'from', 'have', 'help', 'here', 'issue', 'just',
  'like', 'look', 'make', 'more', 'need', 'please', 'problem', 'that', 'their',
  'there', 'thing', 'this', 'those', 'what', 'when', 'where', 'which', 'with',
  'would', 'your',
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:._/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeVagueContextReference(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return /\b(this|that|it|the issue|the problem|the failure|the alert|what happened|what broke|last time|earlier|previous|we discussed|you said|i said)\b/i.test(normalized)
    || /^(how|what)\s+(do|should|can|would)\s+(we|you|i)?\s*(fix|repair|solve|handle|do)\b/i.test(normalized);
}

export function classifyContextTurn(text: string): ContextTurnIntent {
  const trimmed = text.trim();
  const normalized = normalize(trimmed);
  if (!normalized) return 'general_chat';

  if (/^(hi|hey|hello|yo|sup|good morning|good afternoon|good evening)( clementine)?[!. ]*$/.test(normalized)) {
    return 'greeting';
  }
  if (/^(ok|okay|k|thanks|thank you|thx|ty|got it|sounds good|perfect|cool|nice)[!. ]*$/.test(normalized)) {
    return 'ack';
  }
  if (/^(status|debug status|what is running|what's running|what are you working on|how's it coming along|how is it coming along)\b/.test(normalized)) {
    return 'status';
  }
  if (/\b(no band.?aid|bandaid|chatbot|amateur|memory retrieval|remember|remind(er|ing)?|should have known|should have context|proactive|all knowing|ever evolving|useless information|stale status)\b/i.test(trimmed)) {
    return 'memory_correction';
  }
  if (/\b(fix|repair|solve|diagnose|debug|handle|what broke|why did|why is|failure|failed|failing)\b/i.test(trimmed)) {
    return looksLikeVagueContextReference(trimmed) ? 'repair_request' : 'work_request';
  }
  if (looksLikeVagueContextReference(trimmed)) return 'followup';
  if (/\b(run|create|write|update|implement|change|build|ship|commit|push)\b/i.test(trimmed)) return 'work_request';
  return 'general_chat';
}

function activeContextQueries(activeContext: ActiveContextSnapshot | null | undefined): string[] {
  if (!activeContext?.items.length) return [];
  return activeContext.items
    .slice(0, 4)
    .flatMap((item) => [item.sourceId, item.label, item.detail])
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.slice(0, 180));
}

function lexicalQuery(text: string): string | null {
  const terms = normalize(text)
    .split(' ')
    .filter((term) => term.length >= 4 && !STOPWORDS.has(term))
    .slice(0, 8);
  return terms.length ? terms.join(' ') : null;
}

function buildRetrievalQueries(intent: ContextTurnIntent, text: string, activeContext?: ActiveContextSnapshot | null): string[] {
  const queries: string[] = [];
  const lexical = lexicalQuery(text);
  if (lexical) queries.push(lexical);

  if (intent === 'repair_request' || intent === 'followup' || intent === 'status') {
    queries.push(...activeContextQueries(activeContext));
  }
  if (intent === 'memory_correction') {
    queries.push('assistant behavior preference memory retrieval proactive context no bandaid stale status');
  }

  return [...new Set(queries)]
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, 5);
}

export function decideContextPolicy(input: ContextPolicyInput): ContextPolicyDecision {
  const intent = classifyContextTurn(input.text);
  const activeContext = input.activeContext ?? null;
  const debugReasons: string[] = [`intent:${intent}`];
  const proactiveSurface = (activeContext?.items ?? [])
    .filter((item) => item.greetingEligible && !item.alreadySurfaced && !item.resolved)
    .slice(0, 1);

  let requiredRetrieval: RequiredRetrieval = 'none';
  if (intent === 'status') requiredRetrieval = 'event';
  if (intent === 'repair_request' || intent === 'followup' || intent === 'memory_correction') {
    requiredRetrieval = 'transcript';
  }
  if (requiredRetrieval !== 'none') debugReasons.push(`retrieval:${requiredRetrieval}`);

  const silentContextBlocks: string[] = [];
  if (
    activeContext?.promptBlock
    && intent !== 'greeting'
    && intent !== 'ack'
  ) {
    silentContextBlocks.push(activeContext.promptBlock);
    debugReasons.push('active-context:silent');
  }

  const visibleOpening = intent === 'greeting'
    ? proactiveSurface[0]
      ? activeContext?.greetingLine ?? 'Hey. I am here.'
      : 'Hey. I am here.'
    : null;

  return {
    turnIntent: intent,
    silentContextBlocks,
    visibleOpening,
    proactiveSurface,
    requiredRetrieval,
    retrievalQueries: buildRetrievalQueries(intent, input.text, activeContext),
    debugReasons,
  };
}

