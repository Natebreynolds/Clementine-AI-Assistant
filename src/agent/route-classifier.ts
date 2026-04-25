/**
 * Clementine TypeScript — Team-routing classifier.
 *
 * Decides whether a user message addressed to Clementine should be
 * delegated to a specialist agent (Ross, Sasha, Nora, etc.) or handled
 * by Clementine herself.
 *
 * CRITICAL safety rail: this classifier is ONLY invoked when the user
 * is talking TO Clementine. Direct-to-agent messages (agent bot DMs,
 * agent-scoped channels) bypass routing entirely — the session-key
 * ownership check in gateway/router.ts enforces this before calling
 * classifyRoute. Routing never crosses the boundary between different
 * agent bots.
 *
 * Returns structured decision: {targetAgent, confidence, reasoning}.
 * Caller decides what to do with confidence (auto-delegate, soft-suggest,
 * or stay with Clementine).
 */

import pino from 'pino';

import type { AgentProfile } from '../types.js';
import type { Gateway } from '../gateway/router.js';

const logger = pino({ name: 'clementine.route-classifier' });

export interface RouteDecision {
  targetAgent: string;   // slug, or 'clementine' for no routing
  confidence: number;    // 0-1
  reasoning: string;
}

// ── LRU cache for repeated messages ──────────────────────────────────
// Same text + same available-agents set → same decision. Skips the
// Haiku LLM call entirely on cache hit (saves 1-2 seconds per repeat).
// Bounded by both size and TTL so stale rosters can't cause wrong routes.
const ROUTE_CACHE_MAX = 100;
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  decision: RouteDecision | null; // null = "stay with Clementine"
  expiresAt: number;
}

// Insertion-ordered Map = LRU when we delete-and-reinsert on hit.
const routeCache = new Map<string, CacheEntry>();

function cacheKey(text: string, agents: AgentProfile[]): string {
  // Trim + normalize whitespace so trailing-newline variations of the
  // same message hit the same cache entry.
  const normText = text.replace(/\s+/g, ' ').trim();
  // Sort slugs so order doesn't matter; include count to invalidate on
  // hire/fire (the agents array changes shape).
  const slugFingerprint = agents.map(a => a.slug).sort().join(',');
  return `${slugFingerprint}::${normText}`;
}

function cacheGet(key: string, now: number): CacheEntry | null {
  const entry = routeCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    routeCache.delete(key);
    return null;
  }
  // LRU touch: remove + re-insert to move to end of insertion order
  routeCache.delete(key);
  routeCache.set(key, entry);
  return entry;
}

function cachePut(key: string, decision: RouteDecision | null, now: number): void {
  routeCache.set(key, { decision, expiresAt: now + ROUTE_CACHE_TTL_MS });
  while (routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest === undefined) break;
    routeCache.delete(oldest);
  }
}

/** Test-only: reset the cache between runs. */
export function _resetRouteCache(): void {
  routeCache.clear();
}

/**
 * Direct-imperative guardrail.
 *
 * When the user is explicitly instructing Clementine to do the work herself
 * — "I need you to…", "you need to…", "use the CLI…", "stop/wait" —
 * routing to a specialist is almost always wrong. The user knows who they
 * are talking to and is asking *her* to act. Delegating here produces the
 * "every message spawns a team task" cascade that leaves the user waiting
 * and shouting "Stop".
 *
 * This check runs before the LLM classifier and the explicit-mention fast
 * path, so even "Nora, I need you to do X" stays with Clementine when Nate
 * is DMing Clementine (the `isRoutable` gate already guarantees the session
 * belongs to Clementine).
 */
const DIRECT_IMPERATIVE_PATTERNS: RegExp[] = [
  /\bi (need|want|would like) you to\b/i,
  /\byou (need to|should|gotta|have to|must)\b/i,
  /\b(please )?(use|run|execute|call|invoke|query|check|pull|grab|fetch|look up|lookup|search) (the )?(sf|salesforce|cli|bash|sdk|api|db|database)\b/i,
  /^(stop|wait|hold on|nevermind|never mind|cancel)\b/i,
];

export function isDirectImperative(userMessage: string): { match: boolean; pattern?: string } {
  const text = userMessage.trim();
  for (const re of DIRECT_IMPERATIVE_PATTERNS) {
    const m = text.match(re);
    if (m) return { match: true, pattern: m[0] };
  }
  return { match: false };
}

/**
 * Session keys eligible for routing. Any key NOT in this set is
 * considered agent-scoped or system-scoped and never routes.
 *
 * - `discord:user:{ownerId}` — main bot DM with owner
 * - `discord:channel:{channelId}:{ownerId}` — owner's main channel
 *   (where Clementine's main bot is posted, without an agent slug
 *   embedded in the key)
 * - `slack:user:{userId}` / `slack:dm:{userId}` — Slack DM/owner channel
 * - `dashboard:*` — web dashboard chat
 * - `cli:*` — local CLI chat
 *
 * Rejected prefixes (routing NEVER fires):
 * - `discord:agent:{slug}:*` — direct-to-agent DM
 * - `discord:member:*`, `discord:member-dm:*` — member channels/DMs
 * - Any `discord:channel:{channelId}:{slug}:{userId}` with an agent slug
 *   embedded (5-part form, where position 3 is an agent slug)
 * - `slack:agent:*`, `slack:channel:*:{slug}:*`
 * - `team:*` — inter-agent messages travel via team-bus, never route
 */
export function isRoutable(sessionKey: string, _ownerAgentSlugs: Set<string>): boolean {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');

  // Structural rule: any 5+ part channel key has an agent slug embedded
  // (e.g. `discord:channel:{channelId}:{slug}:{userId}`). We reject this
  // regardless of whether the slug appears in a passed-in roster — the
  // ownerAgentSlugs list can be stale during agent-hire/rename events,
  // and the key SHAPE is the safer source of truth.
  //
  // `_ownerAgentSlugs` is kept in the signature for future use but the
  // current implementation is structure-only.

  // Agent-bot DMs and member sessions are always agent-scoped
  if (parts[0] === 'discord') {
    const kind = parts[1];
    if (kind === 'agent' || kind === 'member' || kind === 'member-dm') return false;
    // Any 5+ part channel key → agent-scoped, never route
    if (kind === 'channel' && parts.length >= 5) return false;
    // discord:user:* and the 4-part discord:channel:{channelId}:{userId} pass
    return kind === 'user' || (kind === 'channel' && parts.length === 4);
  }

  if (parts[0] === 'slack') {
    const kind = parts[1];
    if (kind === 'agent') return false;
    // Any 5+ part channel key → agent-scoped
    if (kind === 'channel' && parts.length >= 5) return false;
    return kind === 'user' || kind === 'dm' || (kind === 'channel' && parts.length === 4);
  }

  if (parts[0] === 'telegram') return parts[1] === 'user' || /^\d+$/.test(parts[1] ?? '');
  if (parts[0] === 'dashboard') return true;
  if (parts[0] === 'cli') return true;

  // Anything else (team:*, cron:*, heartbeat-triggered, etc.) — no routing
  return false;
}

/** Build the agent roster string for the classifier prompt. */
function formatAgentRoster(agents: AgentProfile[]): string {
  const lines: string[] = [];
  // Clementine is always an option — the "stay with me" target
  lines.push('- **clementine**: generalist assistant, calendar/inbox/planning, meta questions, small talk, anything not clearly a specialist task');
  for (const a of agents) {
    if (a.slug === 'clementine') continue;
    // Use name + description; truncate to keep the prompt tight
    const desc = (a.description ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
    lines.push(`- **${a.slug}** (${a.name}): ${desc}`);
  }
  return lines.join('\n');
}

function buildPrompt(userMessage: string, agents: AgentProfile[]): string {
  return [
    'You are Clementine\'s team dispatcher. Decide which team member should handle an incoming user message.',
    '',
    '## The team:',
    formatAgentRoster(agents),
    '',
    '## The message:',
    userMessage.slice(0, 1500),
    '',
    '## Decision rules',
    '',
    '- Default to **clementine** (the generalist) unless the request clearly matches a specialist agent\'s domain.',
    '- Match on DOMAIN, not keywords. "Help me think about our outbound strategy" is strategic → Clementine. "Send a follow-up to Aaron about the Scorpion audit" is operational outbound → the SDR agent.',
    '- If the user explicitly names an agent ("have Ross do X"), pick that agent at confidence 1.0.',
    '- If the request is meta ("what agents do I have", "how did Ross do this week") → clementine.',
    '- Small talk, greetings, casual chat → clementine.',
    '- Ambiguous or multi-domain requests → clementine with lower confidence (she can delegate herself).',
    '',
    '## Confidence scale',
    '- 0.9-1.0: Explicit address of a specific agent, or a textbook specialist task (e.g., "send a follow-up" → SDR)',
    '- 0.7-0.9: Clear specialist domain but implicit (e.g., "draft a LinkedIn message" → SDR, "write a content brief" → CMO agent)',
    '- 0.4-0.7: Plausibly specialist but could go to Clementine',
    '- <0.4: Generalist task or ambiguous — clementine',
    '',
    '## Output schema (JSON only, no fences):',
    '{',
    '  "targetAgent": "slug (use \\"clementine\\" if no specialist match)",',
    '  "confidence": 0.0-1.0,',
    '  "reasoning": "one short sentence — what signal drove the choice"',
    '}',
  ].join('\n');
}

function parseResponse(raw: string): RouteDecision | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      targetAgent?: unknown;
      confidence?: unknown;
      reasoning?: unknown;
    };
    if (typeof parsed.targetAgent !== 'string') return null;
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return {
      targetAgent: parsed.targetAgent.trim().toLowerCase(),
      confidence,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

/**
 * Classify a user message. Returns null if the call fails — caller
 * should fall back to Clementine handling.
 */
export async function classifyRoute(
  userMessage: string,
  agents: AgentProfile[],
  gateway: Gateway,
): Promise<RouteDecision | null> {
  // Only classify when there's at least one non-clementine agent available.
  const specialists = agents.filter(a => a.slug !== 'clementine');
  if (specialists.length === 0) return null;

  // Direct-imperative guardrail: user is instructing Clementine to act —
  // do not delegate, even if an agent is named.
  const imperative = isDirectImperative(userMessage);
  if (imperative.match) {
    logger.info({ pattern: imperative.pattern }, 'Routing skipped — direct imperative');
    return null;
  }

  // Fast path A — explicit slug or first-name mention. Build this first so
  // we can early-exit the whole classifier when there's a hit, AND to
  // decide whether the cheaper short-message fast-paths below are safe
  // (they're safe only when no specialist was named).
  const trimmed = userMessage.trim();
  for (const a of specialists) {
    const nameLower = a.name.toLowerCase();
    const firstName = nameLower.split(/\s+/)[0]!;
    if (firstName.length < 3) continue;
    const wordRe = new RegExp(`\\b(${firstName}|${a.slug})\\b`, 'i');
    if (wordRe.test(trimmed)) {
      logger.debug({ slug: a.slug, trigger: 'explicit-mention' }, 'Fast-path routing decision');
      return {
        targetAgent: a.slug,
        confidence: 1.0,
        reasoning: `User explicitly addressed ${a.name} by name.`,
      };
    }
  }

  // Fast path B — short messages (≤ 40 chars, no specialist named above)
  // almost always mean "talk to Clementine." Greetings, acknowledgements,
  // "what's up", single-tool asks all fit. Burning a Haiku call to route
  // "ok thanks" or "check my drive" is pure overhead. Returns null so the
  // caller defaults to Clementine without invoking the classifier LLM.
  if (trimmed.length <= 40) {
    logger.debug({ length: trimmed.length, trigger: 'short-message' }, 'Routing skipped — short owner message');
    return null;
  }

  // Fast path C — question-word openers (what/when/who/how/can/does/is/…).
  // These are almost universally questions for the assistant herself
  // rather than delegation requests. Cheap to detect, no LLM call.
  if (/^\s*(what|when|who|where|why|how|can|could|would|should|will|do|does|did|is|are|was|were)\b/i.test(trimmed)) {
    logger.debug({ trigger: 'question-opener' }, 'Routing skipped — question-opener');
    return null;
  }

  // Cache hit short-circuit — same message + same roster as a recent
  // call gets the same decision without firing the Haiku classifier.
  const now = Date.now();
  const key = cacheKey(userMessage, agents);
  const hit = cacheGet(key, now);
  if (hit) {
    logger.debug({ trigger: 'cache-hit', cachedAgent: hit.decision?.targetAgent ?? 'clementine' }, 'Route classifier cache hit');
    return hit.decision;
  }

  // LLM classifier for everything else.
  const prompt = buildPrompt(userMessage, agents);
  let raw: string;
  try {
    raw = await gateway.handleCronJob(
      'route-classify',
      prompt,
      1,        // tier 1
      3,        // maxTurns — classifier doesn't need tools
      'haiku',  // cheap
    );
  } catch (err) {
    logger.warn({ err }, 'Route classifier call failed');
    // Don't cache failures — next call should retry the LLM.
    return null;
  }

  const decision = parseResponse(raw);
  if (!decision) {
    logger.warn({ rawHead: raw.slice(0, 200) }, 'Route classifier returned unparseable response');
    return null;
  }

  // Validate target exists in the roster; if not, treat as Clementine.
  const allSlugs = new Set(agents.map(a => a.slug));
  allSlugs.add('clementine');
  if (!allSlugs.has(decision.targetAgent)) {
    logger.warn({ decision }, 'Classifier returned unknown agent — treating as clementine');
    decision.targetAgent = 'clementine';
    decision.confidence = Math.min(decision.confidence, 0.3);
  }

  cachePut(key, decision, now);
  return decision;
}
