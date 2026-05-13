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
This is a task — work through it like a capable assistant who owns the outcome.

**Assess scope first**: Before diving in, quickly assess whether this is a 2-minute task or a 20-minute job.
- **Simple task** (one file, one API call, one edit): Just do it. No need to explain the plan.
- **Multi-step task** (several items to process, research + action, multiple files): Tell the user what you're going to do, then use sub-agents (Agent tool) to parallelize the work. Example: "This touches 3 accounts — I'll spin up research on each in parallel and have results in a few minutes."
- **Complex/long task**: Offer to run it in the background: "This is going to take some real work. Want me to kick it off in deep mode? I'll keep you posted as I go."

**During execution**: Narrate findings and decisions, not tool calls. If something unexpected happens, explain what you're doing about it.
**End**: Summarize what you did and suggest natural next steps.

**Parallelization**: When processing multiple items (prospects, files, accounts), ALWAYS use the Agent tool to spawn sub-agents that work in parallel. Don't process 10 things one at a time when you can batch them across 3-5 sub-agents.`;

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

// ── Message shape: simple / multi-step / unknown (1.18.191) ──────────
//
// Orthogonal to the type axis above (question/task/feedback/casual/...).
// The shape axis answers: "is this a single ask or a chain of work?"
//
// Used by:
//   1. clementine-turn-context.ts — gate which sections inject for
//      simple vs multi-step messages (token optimization). Simple
//      messages get a much leaner per-turn block.
//   2. router.ts — trigger plan-mode (planRequest + user approval +
//      orchestrated chained execution) for multi-step requests BEFORE
//      chat tries to do them all natively and overflows.
//
// Heuristic only — no LLM call. Runs on every chat turn so cost matters.

export type MessageShape =
  /** Single ask, single response. "what time is it", "remind me to call X". */
  | 'simple'
  /** Multiple distinct actions across phases. "send 25 emails after
   *  scraping data from Salesforce and SEO sources, then summarize". */
  | 'multi-step'
  /** Ambiguous — falls through to today's full chat path (safe default). */
  | 'unknown';

export interface MessageShapeResult {
  shape: MessageShape;
  score: number;
  reasons: string[];
}

/** Action verbs that strongly suggest "do work" rather than "answer". */
const SHAPE_ACTION_VERBS = [
  'send', 'create', 'build', 'generate', 'write', 'draft', 'compose',
  'publish', 'deploy', 'upload', 'post', 'push',
  'scrape', 'fetch', 'pull', 'extract', 'gather', 'collect',
  'convert', 'merge', 'combine', 'transform', 'consolidate', 'aggregate',
  'schedule', 'queue', 'run', 'execute', 'process',
  'email', 'message', 'notify', 'alert', 'reply', 'forward',
  'import', 'export', 'sync', 'backup',
];

const SHAPE_SEQUENCE_MARKERS: RegExp[] = [
  /\band\s+then\b/i,
  /\b(?:after|once|when)\s+(?:that|you|done|finished|complete)/i,
  /\b(?:then|next|finally|last)\s*[,]?\s+\w+/i,
  /\bfollowed\s+by\b/i,
  /\b(?:step|phase)\s+\d+/i,
];

const SHAPE_BATCH_MARKERS: RegExp[] = [
  /\b(?:for|on|to)\s+each\b/i,
  /\b\d{2,}\s+\w+/, // "25 emails", "100 records"
  /\beach\s+of\s+(?:them|the)\b/i,
  /\b(?:all|every)\s+(?:of\s+)?(?:them|the\s+\w+)/i,
  /\b(?:bulk|batch|mass)\b/i,
];

const SHAPE_NUMBERED_LIST = /\n\s*\d+[.)]\s+\w+/;

const SHAPE_DOMAIN_MARKERS: RegExp[] = [
  /\bsalesforce\b/i, /\bgmail\b/i, /\boutlook\b/i, /\bslack\b/i,
  /\bdiscord\b/i, /\bnetlify\b/i, /\bvercel\b/i, /\bgithub\b/i,
  /\bsupabase\b/i, /\bairtable\b/i, /\bhubspot\b/i, /\bnotion\b/i,
  /\blinkedin\b/i, /\bcalendar\b/i, /\bdrive\b/i, /\bsheets\b/i,
];

/**
 * Classify a chat message's structural shape (simple / multi-step).
 *
 * Scoring (sum of triggered signals):
 *   - 2+ shape-action verbs: +1
 *   - 3+ shape-action verbs: +2 cumulatively
 *   - each sequence marker ("and then", "after that"): +1 (up to +2)
 *   - batch marker ("for each", "25 emails"): +1
 *   - numbered list: +2
 *   - 2+ distinct integration domains in same message: +1
 *   - length > 200 chars: +1
 *   - length > 500 chars: +2 cumulatively
 *
 * Decision:
 *   - score >= threshold (default 3) → 'multi-step'
 *   - score === 0 AND <= 1 action verb AND length <= 200 → 'simple'
 *   - otherwise → 'unknown' (today's chat path, no change)
 */
export function classifyMessageShape(
  text: string,
  opts: { threshold?: number } = {},
): MessageShapeResult {
  const reasons: string[] = [];
  let score = 0;

  if (!text || !text.trim()) {
    return { shape: 'simple', score: 0, reasons: ['empty'] };
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = new Set(
    lower.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean),
  );

  // Action verbs
  const matchedVerbs: string[] = [];
  for (const verb of SHAPE_ACTION_VERBS) {
    if (words.has(verb)) matchedVerbs.push(verb);
  }
  if (matchedVerbs.length >= 2) {
    score += 1;
    reasons.push(`2+ action verbs (${matchedVerbs.slice(0, 4).join(', ')})`);
  }
  if (matchedVerbs.length >= 3) {
    score += 1;
    reasons.push('3+ action verbs');
  }

  // Sequence markers
  for (const rx of SHAPE_SEQUENCE_MARKERS) {
    const matches = lower.match(new RegExp(rx.source, 'gi'));
    if (matches && matches.length > 0) {
      score += Math.min(matches.length, 2);
      reasons.push(`sequence marker: ${matches[0]}`);
      break;
    }
  }

  // Batch markers
  for (const rx of SHAPE_BATCH_MARKERS) {
    if (rx.test(trimmed)) {
      score += 1;
      reasons.push('batch marker (for each / N items / bulk)');
      break;
    }
  }

  // Numbered list
  if (SHAPE_NUMBERED_LIST.test(trimmed)) {
    score += 2;
    reasons.push('numbered list');
  }

  // Cross-domain
  let domainCount = 0;
  for (const rx of SHAPE_DOMAIN_MARKERS) {
    if (rx.test(trimmed)) domainCount += 1;
  }
  if (domainCount >= 2) {
    score += 1;
    reasons.push(`${domainCount} integration domains mentioned`);
  }

  // Length
  if (trimmed.length > 200) {
    score += 1;
    reasons.push(`length > 200 (${trimmed.length})`);
  }
  if (trimmed.length > 500) {
    score += 1;
    reasons.push(`length > 500`);
  }

  // Decision
  const threshold = opts.threshold ?? 3;
  let shape: MessageShape;
  if (score >= threshold) {
    shape = 'multi-step';
  } else if (score === 0 && matchedVerbs.length <= 1 && trimmed.length <= 200) {
    shape = 'simple';
  } else {
    shape = 'unknown';
  }

  return { shape, score, reasons };
}

// ── Plan approval detection (1.18.191) ───────────────────────────────

/**
 * Detect whether the user's message is approving / revising / canceling
 * a pending plan. Used by the chat-side plan-mode state machine when
 * `sess.planAwaitingApproval` is set.
 *
 * Conservative: only short, clearly-affirmative messages qualify as
 * approval. "yes but also do X" is NOT approval — it's a revision
 * request and the state machine should re-plan with the feedback.
 */
export type PlanApprovalSignal = 'approve' | 'revise' | 'cancel' | 'other';

const APPROVE_RE = /^(?:yes|y|yep|yeah|yup|sure|ok|okay|approve|approved|go|go ahead|run it|do it|sounds good|lgtm|ship it|👍|✅)[\s.!]*$/i;
const CANCEL_RE = /^(?:cancel|stop|nvm|nevermind|never\s*mind|forget it|don['']?t|abort|kill it)\b/i;
const REVISE_RE = /\b(?:but|except|instead|change|modify|add(?:\s+also)?|remove|skip|swap|wait|actually|hold on)\b/i;

export function detectPlanApproval(message: string): PlanApprovalSignal {
  if (!message) return 'other';
  const text = message.trim();
  if (!text) return 'other';

  if (CANCEL_RE.test(text)) return 'cancel';
  if (text.length <= 30 && APPROVE_RE.test(text)) return 'approve';
  if (text.length > 30 || REVISE_RE.test(text)) return 'revise';
  return 'other';
}

/**
 * 1.18.193 — plan-mode opt-in detector.
 *
 * Plan-mode used to auto-trigger when `classifyMessageShape` flagged a
 * message as 'multi-step'. That was too aggressive — prior long-running
 * work (38 Bash calls in one chat session) would have been routed through
 * the planner unnecessarily. Comparison vs friend's 1.18.62 install showed
 * the auto-route was the main behavior divergence.
 *
 * Now plan-mode is opt-in via explicit owner intent:
 *   - Message starts with `/plan` (case-insensitive)
 *   - Message contains the `[plan-mode]` token anywhere
 *
 * The chat-overflow recovery path (queueBackgroundTaskAfterContextOverflow)
 * still routes to the planner when the SDK session ACTUALLY overflows —
 * that's a separate escape hatch, not an auto-trigger.
 *
 * Returns `{ requested: true, cleaned }` if the owner asked for plan mode,
 * where `cleaned` is the message with the trigger token stripped.
 * Returns `{ requested: false }` otherwise.
 */
export type PlanModeRequest =
  | { requested: true; cleaned: string }
  | { requested: false };

const PLAN_MODE_TRIGGER = /^\s*\/plan\b|\[plan-mode\]/i;

export function detectPlanModeRequest(message: string): PlanModeRequest {
  if (!message || !PLAN_MODE_TRIGGER.test(message)) return { requested: false };
  const cleaned = message
    .replace(/^\s*\/plan\b\s*/i, '')
    .replace(/\[plan-mode\]/gi, '')
    .trim();
  return { requested: true, cleaned };
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
