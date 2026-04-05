/**
 * Clementine TypeScript — Intent Classifier & Response Strategy Router.
 *
 * Lightweight heuristic classifier that determines message intent BEFORE
 * the main SDK query, enabling dynamic tuning of maxTurns, effort level,
 * and response formatting guidance.
 */

// ── Types ─────────────────────────────────────────────────────────────

export type IntentType =
  | 'question'
  | 'task'
  | 'feedback'
  | 'casual'
  | 'followup'
  | 'correction';

export type ResponseStrategy =
  | 'brief-answer'
  | 'structured-response'
  | 'plan-and-execute'
  | 'acknowledge-and-adapt'
  | 'conversational';

export interface IntentClassification {
  type: IntentType;
  confidence: number; // 0-1
  suggestedStrategy: ResponseStrategy;
  /** Suggested maxTurns for this intent type */
  suggestedMaxTurns: number;
  /** Suggested effort level for the SDK */
  suggestedEffort: 'low' | 'medium' | 'high';
}

// ── Constants ─────────────────────────────────────────────────────────

const QUESTION_STARTERS = /^(what|who|where|when|why|how|is|are|was|were|do|does|did|can|could|would|should|will|which|have|has|tell me)\b/i;
const ACTION_VERBS = /\b(create|write|send|update|deploy|build|fix|add|remove|delete|install|configure|set up|draft|schedule|implement|refactor|change|move|rename|edit|modify|generate|make|run|execute|push|pull|check|review|analyze|search|find|fetch|get|list|show)\b/i;
const FEEDBACK_POSITIVE = /^(thanks|thank you|ty|thx|great|perfect|nice|awesome|love it|good job|well done|excellent|looks good|lgtm|cool|sweet|beautiful|brilliant|exactly|yes|yep|yeah|correct|right|ok)\b/i;
const FEEDBACK_NEGATIVE = /^(no|nope|wrong|not right|that's not|that isn't|ugh|nah|bad|incorrect|stop|don't|actually no|wait no)\b/i;
const CORRECTION_PATTERNS = /\b(actually|instead|rather|not that|I meant|I said|what I wanted|correction|try again|redo|no I|that's wrong)\b/i;
const CASUAL_PATTERNS = /^(hi|hey|hello|good morning|good afternoon|good evening|sup|yo|what's up|howdy|morning|gm|gn|good night)\b/i;

// ── Classifier ────────────────────────────────────────────────────────

/**
 * Classify a user message's intent using heuristics.
 *
 * @param text - The user's raw message
 * @param recentExchanges - Recent conversation history for followup detection
 */
export function classifyIntent(
  text: string,
  recentExchanges?: Array<{ user: string; assistant: string }>,
): IntentClassification {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const endsWithQuestion = trimmed.endsWith('?');
  const hasRecentContext = (recentExchanges?.length ?? 0) > 0;

  // Score each intent type
  const scores: Record<IntentType, number> = {
    question: 0,
    task: 0,
    feedback: 0,
    casual: 0,
    followup: 0,
    correction: 0,
  };

  // ── Question signals ──
  if (endsWithQuestion) scores.question += 0.4;
  if (QUESTION_STARTERS.test(trimmed)) scores.question += 0.35;
  if (wordCount < 15 && endsWithQuestion) scores.question += 0.15;

  // ── Task signals ──
  if (ACTION_VERBS.test(trimmed)) scores.task += 0.35;
  if (wordCount > 20) scores.task += 0.1; // Longer messages tend to be tasks
  if (trimmed.includes('\n') || trimmed.includes('```')) scores.task += 0.15; // Multi-line or code blocks
  if (/\b(please|can you|could you|I need|I want)\b/i.test(trimmed)) scores.task += 0.2;
  // If it has action verbs AND doesn't end with ?, lean toward task over question
  if (ACTION_VERBS.test(trimmed) && !endsWithQuestion) scores.task += 0.15;

  // ── Feedback signals ──
  if (FEEDBACK_POSITIVE.test(trimmed)) scores.feedback += 0.5;
  if (FEEDBACK_NEGATIVE.test(trimmed)) scores.feedback += 0.4;
  if (wordCount <= 5) scores.feedback += 0.15; // Short messages are often feedback

  // ── Casual signals ──
  if (CASUAL_PATTERNS.test(trimmed)) scores.casual += 0.6;
  if (wordCount <= 3 && !endsWithQuestion && !ACTION_VERBS.test(trimmed)) scores.casual += 0.2;

  // ── Correction signals ──
  if (CORRECTION_PATTERNS.test(trimmed) && hasRecentContext) scores.correction += 0.5;
  if (FEEDBACK_NEGATIVE.test(trimmed) && hasRecentContext && wordCount > 5) {
    scores.correction += 0.3; // Negative feedback + more detail = likely correction
    scores.feedback -= 0.2; // Reduce feedback score
  }

  // ── Followup signals ──
  if (hasRecentContext) {
    const lastAssistant = recentExchanges![recentExchanges!.length - 1]?.assistant ?? '';
    // References to previous response content
    if (/\b(that|this|it|those|these|the one|above|earlier)\b/i.test(trimmed)) {
      scores.followup += 0.25;
    }
    // Short messages in active conversation are likely followups
    if (wordCount < 10 && !CASUAL_PATTERNS.test(trimmed)) {
      scores.followup += 0.15;
    }
    // If the assistant asked a question and the user responds briefly
    if (lastAssistant.endsWith('?') && wordCount < 20) {
      scores.followup += 0.3;
    }
  }

  // ── Pick winner ──
  let bestType: IntentType = 'question';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as [IntentType, number][]) {
    if (score > bestScore) {
      bestType = type;
      bestScore = score;
    }
  }

  // Default fallback: if no strong signal, classify based on simple heuristics
  if (bestScore < 0.2) {
    if (endsWithQuestion) bestType = 'question';
    else if (wordCount > 15) bestType = 'task';
    else bestType = 'question'; // Safe default
    bestScore = 0.3;
  }

  const confidence = Math.min(bestScore, 1);

  return {
    type: bestType,
    confidence,
    suggestedStrategy: intentToStrategy(bestType),
    suggestedMaxTurns: intentToMaxTurns(bestType),
    suggestedEffort: intentToEffort(bestType),
  };
}

// ── Strategy Mapping ──────────────────────────────────────────────────

function intentToStrategy(intent: IntentType): ResponseStrategy {
  switch (intent) {
    case 'question': return 'brief-answer';
    case 'task': return 'plan-and-execute';
    case 'feedback': return 'acknowledge-and-adapt';
    case 'casual': return 'conversational';
    case 'followup': return 'brief-answer';
    case 'correction': return 'acknowledge-and-adapt';
  }
}

function intentToMaxTurns(intent: IntentType): number {
  switch (intent) {
    case 'question': return 8;
    case 'task': return 15;
    case 'feedback': return 3;
    case 'casual': return 3;
    case 'followup': return 8;
    case 'correction': return 10;
  }
}

function intentToEffort(intent: IntentType): 'low' | 'medium' | 'high' {
  switch (intent) {
    case 'question': return 'medium';
    case 'task': return 'high';
    case 'feedback': return 'low';
    case 'casual': return 'low';
    case 'followup': return 'medium';
    case 'correction': return 'medium';
  }
}

// ── Response Strategy Guidance ────────────────────────────────────────

/**
 * Generate system prompt guidance text based on the response strategy.
 * Injected into the system prompt to steer the agent's response style.
 */
export function getStrategyGuidance(strategy: ResponseStrategy): string {
  switch (strategy) {
    case 'brief-answer':
      return `## Response Style: Direct Answer
Respond concisely — 1-3 sentences for simple questions, a short paragraph with key details for complex ones.
If you know the answer, give it immediately — no preamble.
If you need to look something up, say what you're checking and why ("Let me check memory for that — I think we discussed it last week"), then share what you found.`;

    case 'structured-response':
      return `## Response Style: Structured
Use headers, bullet points, or numbered lists for clarity.
Start with a brief summary, then provide details.
Include a "Next Steps" or "Summary" section at the end if applicable.`;

    case 'plan-and-execute':
      return `## Response Style: Agentic Execution
This is a task — work through it like a capable assistant who narrates their process.

**Start**: Briefly acknowledge what you're going to do. If it's complex, sketch the approach in 1-2 lines.
**During**: After each tool call or batch of calls, share what you found or what changed before moving to the next step. Narrate decision points and recovery ("That didn't have what I expected — trying X instead").
**End**: Summarize what you did, what changed, and anything worth noting. Suggest 1-2 natural next steps if they'd be useful.

Don't narrate trivial tool calls ("Reading file X...") — narrate *findings* and *decisions*.`;

    case 'acknowledge-and-adapt':
      return `## Response Style: Adaptive
The user is giving feedback or correcting you. Acknowledge it briefly and naturally.
If it's positive feedback: a brief "glad that worked" type response. Don't be effusive.
If it's a correction: acknowledge what was wrong, explain briefly what you understand now, then fix it or adjust. Show that you understood the correction, don't just say "sorry."`;

    case 'conversational':
      return `## Response Style: Casual
Keep it natural and brief. Match the user's energy.
No tool calls needed. Just be conversational.
If there's relevant context from recent work or pending items, briefly mention it.`;
  }
}

/**
 * Generate a follow-up suggestion prompt suffix based on completed work.
 *
 * @param toolCallCount - Number of tool calls made during the query
 * @param responseLength - Length of the response text
 * @param hasActiveGoals - Whether there are relevant active goals
 * @param pendingWorkItems - Number of pending items in the work queue
 */
export function buildFollowUpContext(opts: {
  toolCallCount: number;
  responseLength: number;
  hasActiveGoals: boolean;
  pendingWorkItems: number;
}): string | null {
  // Only suggest follow-ups after substantive work
  if (opts.toolCallCount < 5 || opts.responseLength < 200) return null;

  const parts: string[] = [];

  if (opts.hasActiveGoals) {
    parts.push('There are active goals that may relate to this work.');
  }
  if (opts.pendingWorkItems > 0) {
    parts.push(`There are ${opts.pendingWorkItems} pending work items in the queue.`);
  }

  if (parts.length === 0) return null;

  return `\n\n[POST_WORK_CONTEXT: ${parts.join(' ')} Consider suggesting 1-2 natural next steps as questions, if they'd be genuinely useful. Don't force it.]`;
}
