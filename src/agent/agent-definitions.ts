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

const CRON_FIXER_PROMPT = [
  'You are the cron-fix specialist. You diagnose and apply fixes to broken cron jobs.',
  '',
  'Workflow:',
  '1. Call `list_broken_jobs` to see what is currently broken with their cached diagnoses.',
  '2. For each job the user/parent asked about, check the proposed fix:',
  '   - confidence=high + risk=low + autoApply=true → call `apply_broken_job_fix`.',
  '   - Otherwise → describe the diagnosis and ask the parent for explicit approval.',
  '3. After applying a fix, the verification system auto-rolls-back if the next 3 runs do not improve. You do NOT need to monitor manually.',
  '',
  'Return: a one-paragraph summary of what you applied (or what is blocking apply), per job.',
].join('\n');

/** Map a hired-agent profile to an AgentDefinition.
 *  Used when Clementine wants to delegate to Ross/Sasha/Nora etc. */
function profileToAgentDefinition(p: AgentProfile): AgentDefinition {
  return {
    description: p.description ?? `${p.name} (hired agent: ${p.slug})`,
    prompt: p.systemPromptBody ?? `You are ${p.name}.`,
    // Honor explicit allowlist when present; otherwise inherit from parent.
    ...(p.team?.allowedTools?.length ? { tools: p.team.allowedTools } : {}),
    // Hired agents keep their configured model (Sonnet by default).
    ...(p.model ? { model: p.model } : { model: 'sonnet' }),
    // Effort: hired agents do real work, default medium. Caller can override.
    effort: 'medium',
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
  map['planner'] = {
    description: 'Decompose a multi-step user request into atomic, parallel-safe steps. Use for "research these N items", "build a comprehensive X", "for each Y do Z", or any request that obviously involves multiple distinct sub-tasks. Returns a JSON plan; the parent then executes the steps (often by spawning more subagents per step).',
    prompt: PLANNER_PROMPT,
    model: 'opus',
    tools: [], // pure reasoning, no tools
    effort: 'high',
    maxTurns: 1,
  };

  // Researcher: haiku, per-item investigation. Cheap fan-out target.
  map['researcher'] = {
    description: 'Investigate ONE specific item (one lead, one account, one file, one topic) and return a one-paragraph summary. Use for per-item parallel work spawned by the planner. Cheap and fast.',
    prompt: RESEARCHER_PROMPT,
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'],
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
