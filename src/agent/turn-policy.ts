/**
 * Per-turn policy for memory/tool injection.
 *
 * This is intentionally deterministic and conservative: cheap turns get a
 * small prompt, but any sign of memory dependence, tool work, or ambiguity
 * promotes the request to a richer path.
 */

import { routeToolSurface, type ToolRouteDecision } from './tool-router.js';
import type { IntentClassification } from './intent-classifier.js';

export type RetrievalTier = 'none' | 'core' | 'search' | 'full';
export type TurnExecutionMode = 'local' | 'lightweight_llm' | 'tool_llm' | 'background';

export interface TurnPolicy {
  retrievalTier: RetrievalTier;
  disableAllTools: boolean;
  enableTeams: boolean;
  maxTurns?: number;
  effort: 'low' | 'medium' | 'high';
  allowProactiveGoals: boolean;
  fetchLinks: boolean;
  /** Do not resume the prior Claude SDK session for this turn. */
  suppressSessionResume?: boolean;
  /** Do not inject restored/pending/background context for this turn. */
  suppressContextInjection?: boolean;
  reason: string;
}

export interface TurnPolicyInput {
  text: string;
  intent: IntentClassification;
  hasRecentContext: boolean;
  isAutonomous?: boolean;
}

export interface TurnDecision {
  mode: TurnExecutionMode;
  policy: TurnPolicy;
  toolRoute: ToolRouteDecision;
  userVisibleStatus: string;
  reason: string;
}

const URL_RE = /https?:\/\//i;
const MEMORY_REF_RE = /\b(remember|memory|memories|previous|last time|earlier|we discussed|where were we|pick up|continue|you know about me|my preference|preferences|what did i say|what do i like)\b/i;
const GOAL_REF_RE = /\b(goal|goals|objective|objectives|blocker|next action|next step|roadmap|priority|priorities)\b/i;
const LOCAL_TOOL_RE = /\b(repo|repository|code|file|files|folder|directory|path|log|logs|config|build|test|typecheck|lint|npm|git|commit|push|pull|branch|diff|patch|edit|write|implement|fix|refactor|run)\b/i;
const COMPLEX_RE = /\b(multiple|several|many|bulk|batch|parallel|deep mode|background|research|analyze|audit|review|across|end to end|entire)\b/i;
const ADMIN_RE = /\b(self[- ]?update|restart|daemon|npm publish|publish to npm|doctor|integration|credential|env var|environment variable|set up|setup|configure)\b/i;
const STANDALONE_GREETINGS = new Set([
  'hi',
  'hey',
  'hey there',
  'hello',
  'hello there',
  'yo',
  'sup',
  "what's up",
  'whats up',
  'good morning',
  'good afternoon',
  'good evening',
  'morning',
  'gm',
]);

export function isStandaloneGreeting(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/^[^\w']+|[^\w']+$/g, '')
    .replace(/\s+/g, ' ');
  const withoutName = normalized.replace(/\s+clementine$/i, '');
  return STANDALONE_GREETINGS.has(normalized) || STANDALONE_GREETINGS.has(withoutName);
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function isTinyFeedback(text: string, intent: IntentClassification): boolean {
  return intent.type === 'feedback' && wordCount(text) <= 8 && !URL_RE.test(text) && !MEMORY_REF_RE.test(text);
}

function isSimpleQuestion(
  text: string,
  intent: IntentClassification,
  route: ReturnType<typeof routeToolSurface>,
): boolean {
  return intent.type === 'question'
    && wordCount(text) <= 14
    && !URL_RE.test(text)
    && !MEMORY_REF_RE.test(text)
    && !GOAL_REF_RE.test(text)
    && !LOCAL_TOOL_RE.test(text)
    && route.bundles.length === 0
    && !route.fullSurface;
}

export function decideTurnPolicy(input: TurnPolicyInput): TurnPolicy {
  const text = input.text.trim();
  const intent = input.intent;
  const wc = wordCount(text);
  const route = routeToolSurface(text);
  const hasUrl = URL_RE.test(text);
  const referencesMemory = MEMORY_REF_RE.test(text);
  const referencesGoals = GOAL_REF_RE.test(text);
  const localToolWork = LOCAL_TOOL_RE.test(text);
  const adminWork = ADMIN_RE.test(text);
  const routedTools = route.fullSurface || route.bundles.length > 0;
  const complex = COMPLEX_RE.test(text) || wc >= 40;
  const taskLike = intent.type === 'task' || localToolWork || adminWork || routedTools;

  if (input.isAutonomous) {
    return {
      retrievalTier: 'full',
      disableAllTools: false,
      enableTeams: true,
      effort: 'high',
      allowProactiveGoals: true,
      fetchLinks: hasUrl,
      reason: 'autonomous',
    };
  }

  if (route.fullSurface) {
    return {
      retrievalTier: 'full',
      disableAllTools: false,
      enableTeams: true,
      maxTurns: intent.suggestedMaxTurns,
      effort: 'high',
      allowProactiveGoals: true,
      fetchLinks: hasUrl,
      reason: 'explicit-full-surface',
    };
  }

  if (isStandaloneGreeting(text)) {
    return {
      retrievalTier: 'none',
      disableAllTools: true,
      enableTeams: false,
      maxTurns: 2,
      effort: 'low',
      allowProactiveGoals: false,
      fetchLinks: false,
      suppressSessionResume: true,
      suppressContextInjection: true,
      reason: 'standalone-greeting',
    };
  }

  if (intent.type === 'casual' && !hasUrl && !referencesMemory && !routedTools && !localToolWork) {
    return {
      retrievalTier: 'none',
      disableAllTools: true,
      enableTeams: false,
      maxTurns: 3,
      effort: 'low',
      allowProactiveGoals: false,
      fetchLinks: false,
      reason: 'casual-fast-path',
    };
  }

  if (isTinyFeedback(text, intent) && !taskLike) {
    return {
      retrievalTier: 'none',
      disableAllTools: true,
      enableTeams: false,
      maxTurns: 3,
      effort: 'low',
      allowProactiveGoals: false,
      fetchLinks: false,
      reason: 'feedback-fast-path',
    };
  }

  if (isSimpleQuestion(text, intent, route)) {
    return {
      retrievalTier: 'none',
      disableAllTools: true,
      enableTeams: false,
      maxTurns: 4,
      effort: 'low',
      allowProactiveGoals: false,
      fetchLinks: false,
      reason: 'simple-question-fast-path',
    };
  }

  if (referencesMemory || intent.type === 'followup' || intent.type === 'correction') {
    const needsFull = taskLike || complex || hasUrl;
    return {
      retrievalTier: needsFull ? 'full' : 'search',
      disableAllTools: false,
      enableTeams: false,
      maxTurns: Math.min(intent.suggestedMaxTurns, needsFull ? 12 : 8),
      effort: needsFull ? 'medium' : 'low',
      allowProactiveGoals: referencesGoals || taskLike,
      fetchLinks: hasUrl,
      reason: needsFull ? 'memory-plus-task' : 'memory-continuity',
    };
  }

  if (taskLike || hasUrl || referencesGoals) {
    return {
      retrievalTier: complex || routedTools || adminWork ? 'full' : 'search',
      disableAllTools: false,
      enableTeams: complex,
      maxTurns: intent.suggestedMaxTurns,
      effort: complex ? 'high' : intent.suggestedEffort,
      allowProactiveGoals: true,
      fetchLinks: hasUrl,
      reason: complex ? 'complex-task' : 'task-or-tool-request',
    };
  }

  if (input.hasRecentContext) {
    return {
      retrievalTier: 'core',
      disableAllTools: false,
      enableTeams: false,
      maxTurns: Math.min(intent.suggestedMaxTurns, 6),
      effort: 'low',
      allowProactiveGoals: false,
      fetchLinks: false,
      reason: 'recent-context-core',
    };
  }

  return {
    retrievalTier: 'core',
    disableAllTools: false,
    enableTeams: false,
    maxTurns: Math.min(intent.suggestedMaxTurns, 6),
    effort: 'low',
    allowProactiveGoals: false,
    fetchLinks: false,
    reason: 'safe-core-default',
  };
}

export function decideTurn(input: TurnPolicyInput): TurnDecision {
  const policy = decideTurnPolicy(input);
  const toolRoute = routeToolSurface(input.text);
  const text = input.text.trim();
  const wantsBackground = /\b(background|deep mode|keep working|don't stop|dont stop|run in the background|autonomous)\b/i.test(text);
  const explicitWork = /\b(work|task|do|run|fix|implement|audit|research|analy[sz]e|review|build|ship|finish|complete|continue|handle)\b/i.test(text);
  const needsTools = !policy.disableAllTools || toolRoute.fullSurface || toolRoute.bundles.length > 0;
  const backgroundRequested = wantsBackground && needsTools && (explicitWork || policy.enableTeams || policy.retrievalTier === 'full');

  let mode: TurnExecutionMode;
  if (input.isAutonomous || backgroundRequested) {
    mode = 'background';
  } else if (policy.disableAllTools && policy.retrievalTier === 'none') {
    mode = 'lightweight_llm';
  } else {
    mode = 'tool_llm';
  }

  const userVisibleStatus = mode === 'background'
    ? 'working in background'
    : mode === 'lightweight_llm'
      ? 'answering'
      : toolRoute.bundles.length > 0 || toolRoute.fullSurface
        ? 'checking tools'
        : 'thinking';

  return {
    mode,
    policy,
    toolRoute,
    userVisibleStatus,
    reason: policy.reason,
  };
}
