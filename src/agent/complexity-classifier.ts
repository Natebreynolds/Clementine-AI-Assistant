/**
 * Clementine TypeScript — Lightweight complexity classifier.
 *
 * Deterministic regex + length heuristics that decide whether a user
 * message is "complex" enough to warrant planning-before-acting. No
 * LLM call — gate is cheap enough to run on every message.
 *
 * When complex, the gateway injects a "plan-first" system-prompt
 * directive so the agent proposes a numbered plan and waits for
 * confirmation before diving in. Not perfect — the LLM still decides
 * what "plan" means — but much more consistent than a generic
 * SOUL.md directive that the model ignores half the time.
 */

export interface ComplexityVerdict {
  complex: boolean;
  /**
   * High-confidence subset of `complex`. When true, the task is ambitious
   * enough that the gateway should route it straight to deep/background
   * execution instead of running a main-agent turn that would almost
   * certainly get auto-escalated after burning tool calls.
   */
  deepWorthy: boolean;
  reason: string;
  signals: string[];
}

/**
 * Explicit phrasings that essentially request a long-running background job.
 * Triggers deepWorthy on their own, regardless of other signals.
 */
const DEEP_MODE_ASKS = [
  /\b(deeply|extensively|thoroughly)\s+(research|analy[sz]e|investigate|audit|review)\b/i,
  /\bcomprehensive(ly)?\s+(research|analy[sz]is|report|audit)\b/i,
  /\bgo\s+(do|handle|tackle)\s+this\b/i,
  /\brun\s+in\s+the\s+background\b/i,
  /\bdeep\s+(mode|dive|work)\b/i,
  /\bbackground\s+(task|work|job)\b/i,
  /\btake\s+your\s+time\b/i,
];

/**
 * Action verbs that signal the user is asking Clementine to DO things
 * (as opposed to asking questions or making small talk). Multiple
 * action verbs in one message is a strong complexity signal.
 */
const ACTION_VERBS = [
  'send', 'create', 'run', 'schedule', 'update', 'delete', 'add', 'remove',
  'draft', 'write', 'post', 'publish', 'deploy', 'build', 'edit', 'move',
  'rename', 'archive', 'restore', 'assign', 'delegate', 'email', 'message',
  'invite', 'book', 'cancel', 'notify', 'alert', 'set up', 'tear down',
  'process', 'review', 'approve', 'reject',
  'extract', 'fetch', 'pull', 'gather', 'compile', 'summarize', 'analyze',
  'generate', 'produce', 'export', 'import', 'upload', 'download', 'sync',
];

/**
 * Chain markers — "do X and then Y" explicitly encode a multi-step
 * task. A single occurrence in a DO-type message is a clear signal.
 */
const CHAIN_MARKERS = [
  /\band\s+then\b/i,
  /,\s+then\b/i,          // "X, then Y"
  /\bfirst\b[\s\S]{0,80}\bthen\b/i,
  /\bafter\s+(that|which)\b/i,
  /\bonce\s+(that|you)\b.*,/i,
  /\bnext\b.*,/i,
];

/**
 * Phrasings that explicitly ask for plan-first behavior. Triggers
 * regardless of other heuristics.
 */
const EXPLICIT_PLAN_ASKS = [
  /\bpropose\s+a\s+plan\b/i,
  /\bwhat\s+(would|'d)\s+be\s+your\s+approach\b/i,
  /\bplan\s+(this|it)\s+out\b/i,
  /\blay\s+out\s+(a|the)\s+plan\b/i,
  /\bwalk\s+me\s+through\s+(what|how)\b/i,
];

function countActionVerbs(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const v of ACTION_VERBS) {
    const re = new RegExp(`\\b${v.replace(/\s+/g, '\\s+')}\\b`, 'g');
    const matches = lower.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Rough entity count — quoted strings, @mentions, and capitalized
 * multi-word phrases that look like proper nouns. Not perfect;
 * designed to catch cases like "email John, Sarah, and Mike".
 */
function countEntities(text: string): number {
  let count = 0;
  // Quoted strings
  count += (text.match(/"[^"]{2,60}"/g) ?? []).length;
  count += (text.match(/'[^']{2,60}'/g) ?? []).length;
  // @mentions
  count += (text.match(/@\w+/g) ?? []).length;
  // Comma-separated name lists (e.g., "John, Sarah, and Mike")
  const listMatch = text.match(/(?:[A-Z][a-z]{1,20},\s+){2,}(?:and\s+)?[A-Z][a-z]{1,20}/);
  if (listMatch) count += 3;
  return count;
}

/**
 * Classify complexity. Pure function — no LLM, no I/O.
 */
export function classifyComplexity(text: string): ComplexityVerdict {
  if (!text || typeof text !== 'string') return { complex: false, deepWorthy: false, reason: 'empty', signals: [] };
  const trimmed = text.trim();

  // Skip commands and very short messages
  if (trimmed.length < 30) return { complex: false, deepWorthy: false, reason: 'too short', signals: [] };
  if (trimmed.startsWith('!') || trimmed.startsWith('/')) return { complex: false, deepWorthy: false, reason: 'command', signals: [] };

  // Signal 0: explicit deep-mode ask — short-circuits both gates.
  for (const re of DEEP_MODE_ASKS) {
    if (re.test(trimmed)) {
      return { complex: true, deepWorthy: true, reason: 'explicit deep-mode ask', signals: ['deep-mode-ask'] };
    }
  }

  const signals: string[] = [];

  // Signal 1: explicit ask for plan-first
  for (const re of EXPLICIT_PLAN_ASKS) {
    if (re.test(trimmed)) {
      return { complex: true, deepWorthy: false, reason: 'user explicitly asked for a plan', signals: ['explicit-plan-ask'] };
    }
  }

  // Signal 2: multiple action verbs
  const verbs = countActionVerbs(trimmed);
  if (verbs >= 3) signals.push(`${verbs} action verbs`);

  // Signal 3: chain markers
  let hasChain = false;
  for (const re of CHAIN_MARKERS) {
    if (re.test(trimmed)) { signals.push('chain marker'); hasChain = true; break; }
  }

  // Signal 4: multiple entities
  const entities = countEntities(trimmed);
  if (entities >= 3) signals.push(`${entities} entities`);

  // Signal 5: long message with at least one action verb (big scope, not just a question)
  const isLong = trimmed.length > 400 && verbs >= 1;
  if (isLong) signals.push('long + action');

  // Gate: at least 2 signals fire, OR a single high-confidence signal
  // (chain markers, explicit-plan-ask, or 3+ action verbs).
  const highConfidenceSingles = [verbs >= 3, hasChain];
  const complex = highConfidenceSingles.some(Boolean) || signals.length >= 2;

  // deepWorthy raises the bar: multiple strong signals AND sustained scope.
  // Specifically, any TWO of {3+ verbs, chain marker, long+action, 3+ entities}.
  const strongCount = [
    verbs >= 3,
    hasChain,
    isLong,
    entities >= 3,
  ].filter(Boolean).length;
  const deepWorthy = strongCount >= 2;

  if (complex) {
    return {
      complex: true,
      deepWorthy,
      reason: deepWorthy ? 'deep-worthy: multiple strong signals' : (highConfidenceSingles.some(Boolean) ? 'strong single signal' : 'multiple signals'),
      signals,
    };
  }

  return { complex: false, deepWorthy: false, reason: 'below threshold', signals };
}

/**
 * Build a system-prompt directive to inject when a complex message is
 * detected. Prepended to Clementine's normal system prompt for this
 * single query only. Short + declarative — meta-instructions are
 * easier for the model to follow when they're terse.
 */
export function planFirstDirective(): string {
  return [
    '## PLAN BEFORE ACTING',
    '',
    'This request has multiple steps. Before doing any of them:',
    '1. Write a numbered plan (3-7 steps, one line each).',
    '2. Call out anything that needs my decision — which contact, which template, which timing.',
    '3. End with: "Reply **go** to start, or tell me what to change."',
    '4. STOP. Do NOT start executing the plan in this turn.',
    '',
    'When I reply "go" (or equivalent) in the next message, proceed with the plan.',
    'If I edit the plan, revise and ask again.',
    '',
    'SKIP this protocol only if the request is actually a single step disguised as multiple (e.g., "send an email to Sam about the proposal and cc Jordan" is one email, not two).',
  ].join('\n');
}
