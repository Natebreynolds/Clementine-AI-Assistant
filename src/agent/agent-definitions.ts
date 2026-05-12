/**
 * Clementine TypeScript — AgentDefinition factory.
 *
 * The canonical Claude Agent SDK pattern is to pass `agents: { ... }`
 * to `query()`, where each entry is an `AgentDefinition`. Claude routes
 * subwork to subagents based on each definition's `description` field.
 *
 * Today's Clementine has multiple parallel orchestration paths
 * (PlanOrchestrator, runUnleashedTask phases, fanout-policy directive,
 * pre-LLM plan routing). This file is the start of consolidating all
 * of that into the SDK-native subagent pattern.
 *
 * Usage:
 *   const agents = buildAgentMap({ profileManager, isAutonomous: false });
 *   query({ prompt, options: { agents, ... } })
 *
 * Phase 1 (1.18.43): this file is created but not wired into production
 * yet. The dashboard's /api/runagent/test endpoint exercises it for
 * verification before any real migration.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../types.js';
import type { AgentManager } from './agent-manager.js';

export interface BuildAgentMapOptions {
  /** Source of hired-agent profiles. When undefined, only the system subagents are returned. */
  profileManager?: AgentManager;
  /** When true, restrict the surface to safe-for-cron subagents (no chat-only ones). */
  isAutonomous?: boolean;
  /** Active agent slug — when set, hired agents OTHER than this one still get definitions
   *  but the active one's profile-as-system-prompt is handled by the caller. */
  activeAgentSlug?: string;
}

const PLANNER_PROMPT = [
  'You are a task planner for Clementine. You receive a multi-step request from the parent agent.',
  '',
  'Your job: decompose the request into ATOMIC, parallel-safe steps, then return a JSON plan.',
  '',
  'Output ONLY a JSON object (no markdown fences, no prose):',
  '{',
  '  "steps": [',
  '    { "id": "step-1", "description": "...", "subagent": "researcher|cron-fixer|...|null", "prompt": "...", "model": "haiku|sonnet", "dependsOn": [] }',
  '  ],',
  '  "synthesisHint": "How the parent should combine step outputs"',
  '}',
  '',
  'Rules:',
  '- 2-8 steps. Atomic = completes in 5-30 tool calls.',
  '- MAXIMIZE parallelism: independent steps have empty dependsOn.',
  '- Pick the right subagent per step:',
  '  - `researcher` for per-item lookups (1 lead, 1 account, 1 file): model=haiku',
  '  - `cron-fixer` for diagnose-and-apply on broken cron jobs: model=sonnet',
  '  - null (parent runs the step) for synthesis or when no specialist fits',
  '- Each step prompt is SELF-CONTAINED — the sub agent sees no parent history.',
  '- End each step prompt with "Deliver: <one-line return shape>".',
].join('\n');

const RESEARCHER_PROMPT = [
  'You are a per-item research specialist. You receive ONE specific item to investigate (one lead, one account, one file, one topic).',
  '',
  'Use your bounded tools to gather the requested information. Return a ONE-PARAGRAPH summary in the format the parent specified.',
  '',
  'NEVER return raw tool output, full lists, or unbounded data. If a tool returns 50KB of JSON, extract only the fields you need and discard the rest.',
  '',
  'If you cannot find the requested data, say so in one line. Do not speculate.',
].join('\n');

/**
 * 1.18.197 — discovery subagent. The owner asked Clementine to be the
 * ORCHESTRATOR, not the worker. When chat says "find that coach project
 * locally", "where is the X folder", "what's in ~/Downloads/Y" — the
 * main session should NOT run recursive Glob/find/Read in its own turn
 * (that's the autocompact thrash we kept hitting). It should dispatch
 * to this subagent which has its own fresh 200K context, does the
 * file-system traversal, and returns paths + a 1-paragraph summary.
 *
 * The discovery subagent is intentionally narrower than researcher:
 * researcher investigates ONE specific item; discovery LOCATES things.
 *
 * Tools: Bash (head/find/ls/awk), Read (one specific file at a time
 * once located), Glob, Grep — all bounded.
 *
 * NOT included: Edit, Write, mutating MCP tools. Pure read-only.
 */
const DISCOVERY_PROMPT = [
  'You are the file-system discovery specialist. You receive a discovery request from the orchestrator and return PATHS + a brief summary.',
  '',
  'Your job: locate things. NOT read full contents. NOT analyze in depth.',
  '',
  'Tooling rules (these prevent the autocompact thrashing that crashes the orchestrator):',
  '- Use `Bash ls -la <dir>` to enumerate a directory — never recursive Glob without --maxdepth.',
  '- Use `Bash find <dir> -maxdepth 3 -name "*.csv"` (or similar) to find files matching a pattern.',
  '- Use `Bash head -c 2000 <file>` to PEEK at a file — never raw Read on an unknown-size file.',
  '- Use `Bash wc -l <file>` to size-check before any Read.',
  '- Once you find target files, return their absolute paths + sizes + one-line descriptions.',
  '- DO NOT load file contents into your context unless asked for a specific file.',
  '',
  'Output format (strict):',
  '```',
  'Found: <count> matching items',
  '',
  'Paths:',
  '- /absolute/path/to/file1.csv (12KB, 340 rows) — appears to be coach roster',
  '- /absolute/path/to/file2.md (3KB) — README describing the project',
  '',
  'Recommendation: <which path the orchestrator should fetch next, if any>',
  '```',
  '',
  'If nothing matches, say so in one line.',
  '',
  'You are bounded by max 15 turns. Use them wisely — list, scope, summarize, return.',
].join('\n');

const CRON_FIXER_PROMPT = [
  'You are the cron-fix specialist. You diagnose and apply fixes to broken cron jobs.',
  '',
  'Workflow:',
  '1. If you already know the job name (parent named it, or notification context names it), call `cron_diagnose` first — it returns the bounded recent-run summary, phase status, and inferred root cause in one shot. If you need a list of currently failing jobs, call `list_broken_jobs` instead.',
  '2. For each job the user/parent asked about, check the proposed fix:',
  '   - confidence=high + risk=low + autoApply=true → call `apply_broken_job_fix`.',
  '   - Otherwise → describe the diagnosis and ask the parent for explicit approval before any manual repair.',
  '3. After applying a fix, the verification system auto-rolls-back if the next 3 runs do not improve. You do NOT need to monitor manually.',
  '',
  'Return: a one-paragraph summary of what you applied (or what is blocking apply), per job.',
].join('\n');

/** Build a routing-signal description for a hired agent.
 *  The SDK uses descriptions for auto-routing — they must be imperative
 *  ("Use for: ..."), not narrative prose. Otherwise the main agent
 *  has nothing to match user phrasings against. */
function buildHiredAgentDescription(p: AgentProfile): string {
  const role = p.role ?? p.description ?? `${p.name}, a hired agent`;
  const slug = p.slug;
  const capabilities = (p.routingHints && p.routingHints.length > 0)
    ? p.routingHints.join(', ')
    : (p.description ?? '').slice(0, 200);
  return [
    `Delegate to ${p.name} (${slug}).`,
    capabilities ? `Use for: ${capabilities}.` : '',
    `Role: ${role}.`,
    'Spawn this subagent when the user names them, asks a question in their domain, or asks Clementine to "have <name> do X".',
  ].filter(Boolean).join(' ');
}

/** Map a hired-agent profile to an AgentDefinition.
 *  Used when Clementine wants to delegate to Ross/Sasha/Nora etc. */
function profileToAgentDefinition(p: AgentProfile): AgentDefinition {
  // Always include `Agent` so the subagent can further fan out, plus
  // core read tools as a baseline. profile.team.allowedTools narrows
  // beyond this when set.
  const baseline = ['Agent', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite'];
  const tools = p.team?.allowedTools?.length
    ? Array.from(new Set(['Agent', ...p.team.allowedTools]))
    : baseline;
  return {
    description: buildHiredAgentDescription(p),
    prompt: p.systemPromptBody ?? `You are ${p.name}.`,
    tools,
    // Hired agents keep their configured model (Sonnet by default).
    ...(p.model ? { model: p.model } : { model: 'sonnet' }),
    // Effort: hired agents do real work, default medium. Profile may override.
    ...(p.effort ? { effort: p.effort } : { effort: 'medium' as const }),
  };
}

/**
 * Build the AgentDefinition map for a runAgent call. Mix of system
 * subagents (planner, researcher, cron-fixer) and hired-agent profiles.
 *
 * The system subagents are intentionally minimal — they exist so Claude
 * can route specific kinds of work cleanly. Add new ones (per the
 * migration plan) as we collapse other orchestration paths.
 */
export function buildAgentMap(opts: BuildAgentMapOptions = {}): Record<string, AgentDefinition> {
  const map: Record<string, AgentDefinition> = {};

  // ── System subagents ────────────────────────────────────────────
  // Planner: opus, no tools, single turn. Used when the parent agent
  // sees a multi-step request and wants a decomposition.
  // Description is imperative + matches real user phrasings — the SDK
  // matches against it for auto-routing, so prose doesn't trigger.
  map['planner'] = {
    description: [
      'Use this subagent BEFORE doing the work whenever the user request',
      'involves 3 or more items, multiple distinct subtasks, or a phrase',
      'like "research my top N", "for each X do Y", "look at all of",',
      '"go through every", "do A, B, and C", or any task that would burn',
      'context if processed serially. The planner returns a JSON plan',
      'with parallel-safe steps; you then spawn researcher/cron-fixer/',
      'hired-agent subagents per step. Always prefer this over doing',
      'multi-item work yourself in the main conversation.',
    ].join(' '),
    prompt: PLANNER_PROMPT,
    model: 'opus',
    tools: [], // pure reasoning, no tools
    effort: 'high',
    maxTurns: 1,
  };

  // Researcher: haiku, per-item investigation. Cheap fan-out target.
  // No Bash — researcher is read-only fanout, must not mutate state.
  map['researcher'] = {
    description: [
      'Use this subagent to investigate ONE specific item — a single',
      'lead, account, file, web page, or topic — and return a',
      'one-paragraph summary. Spawn it in PARALLEL via the Agent tool',
      'with one subagent per item when the planner returns multiple',
      'research steps. Read-only: never mutates state. Cheap (Haiku).',
    ].join(' '),
    prompt: RESEARCHER_PROMPT,
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    effort: 'low',
    maxTurns: 15,
  };

  // Discovery (1.18.197): file-system / project location. Owner's
  // northstar: Clementine orchestrates, doesn't bulk-process. ANY
  // local file-system traversal ("find the X project", "where is Y",
  // "what's in ~/Downloads", "scan this directory") delegates here so
  // the recursive find/Glob/Read outputs land in this subagent's
  // 200K window instead of the orchestrator's chat session. Returns
  // paths + brief summaries — never file contents.
  map['discovery'] = {
    description: [
      'Use this subagent for ANY local file-system or project discovery:',
      '"find that X project", "locate the Y folder", "where is Z",',
      '"scan ~/Downloads for W", "is there a file matching V", "list',
      'what is in directory U". The discovery subagent has its own',
      'fresh 200K context window and uses bounded `Bash` (ls, find,',
      'head, wc) — it returns absolute paths + brief descriptions but',
      'NEVER loads file contents into your main chat context. ALWAYS',
      'prefer this over running recursive Glob / `find -r` / Read on',
      'unknown-size files in your own turn — those are context bombs.',
    ].join(' '),
    prompt: DISCOVERY_PROMPT,
    model: 'haiku',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    effort: 'low',
    maxTurns: 15,
  };

  // Cron-fixer: sonnet, owns the broken-job diagnose+apply path.
  // Tools restricted to the canonical fix path (no parallel mechanisms).
  map['cron-fixer'] = {
    description: 'Diagnose and apply fixes to broken cron jobs. Use when the user says "fix X" referring to a job, asks "what jobs are failing", or asks to re-run/repair a cron. Owns the canonical diagnosis-to-apply flow.',
    prompt: CRON_FIXER_PROMPT,
    model: 'sonnet',
    tools: [
      'mcp__clementine-tools__cron_diagnose',
      'mcp__clementine-tools__list_broken_jobs',
      'mcp__clementine-tools__apply_broken_job_fix',
      'mcp__clementine-tools__cron_list',
      'mcp__clementine-tools__cron_run_history',
      'Read',
      'Grep',
    ],
    effort: 'medium',
    maxTurns: 10,
  };

  // ── Hired-agent profiles ────────────────────────────────────────
  // Each becomes a subagent the main agent can delegate to.
  // The "main" agent for a DM-to-bot session is set by the caller
  // (still uses the profile's identity); these definitions cover the
  // case where Clementine wants to invoke them mid-conversation.
  if (opts.profileManager) {
    const profiles = opts.profileManager.listAll();
    for (const profile of profiles) {
      // Skip clementine herself (she's the main agent, not a subagent)
      if (profile.slug === 'clementine') continue;
      // Skip the active agent (don't make them their own subagent)
      if (opts.activeAgentSlug && profile.slug === opts.activeAgentSlug) continue;
      map[profile.slug] = profileToAgentDefinition(profile);
    }
  }

  return map;
}

/** Type guard helper for callers. */
export function hasAgent(map: Record<string, AgentDefinition>, slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, slug);
}
