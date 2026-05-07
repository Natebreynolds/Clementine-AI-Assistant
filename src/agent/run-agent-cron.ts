/**
 * Clementine TypeScript — runAgent cron wrapper.
 *
 * Phase 3 of the SDK-canonical migration (see
 * /Users/nathan.reynolds/.claude/plans/sdk-canonical-migration.md).
 *
 * Cron jobs need more than a bare runAgent() call: they get progress
 * continuity, linked goals, delegated tasks, team context, success
 * criteria, and matched skills injected ahead of the job prompt. This
 * file owns that composition for the new (canonical SDK) path. The
 * legacy assistant.ts:runCronJob keeps its inline equivalents so we
 * can ship Phase 3 without touching legacy code.
 *
 * After Phase 3 verifies and we collapse the legacy path, the
 * duplicated helpers here become the single source of truth.
 */

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import {
  BASE_DIR,
  VAULT_DIR,
  CRON_PROGRESS_DIR,
  BUDGET,
} from '../config.js';
import type { AgentProfile } from '../types.js';
import type { AgentManager } from './agent-manager.js';
import type { MemoryStore } from '../memory/store.js';
import { runAgent, type RunAgentResult } from './run-agent.js';
import { buildExtraMcpForRunAgent } from './run-agent-mcp.js';
import { buildAutonomousMemoryContext } from './run-agent-context.js';
import { listAllGoals } from '../tools/shared.js';

const CRON_PROGRESS_PENDING_MAX_ITEMS = 20;
const CRON_PROGRESS_NOTES_MAX_CHARS = 2000;

const logger = pino({ name: 'clementine.run-agent-cron' });

const CRON_CONTEXT_ITEM_MAX = 80;

/** Total number of skill blocks injected into a cron prompt — pinned + auto. */
const MAX_INJECTED_SKILLS = 4;

/**
 * Compute the effective tool allowlist for a cron run.
 *
 * Semantics:
 *   - Both undefined / empty → return undefined. Caller (`runAgent`)
 *     will fall back to `profile.team.allowedTools` then
 *     `CORE_TOOLS_FOR_AGENT_PARENT` — preserving today's behavior for
 *     legacy CRON.md entries with no `allowed_tools` field.
 *   - Job allowlist only → return `['Agent', ...job]` (deduped).
 *     Bare tricks (no agentSlug) hit this path too.
 *   - Profile allowlist only → return undefined (let runAgent thread it
 *     through its own profile path; no need to duplicate work here).
 *   - Both → intersection ∪ {Agent}. When intersection is empty the
 *     result is just `['Agent']` — degenerate but valid (subagent
 *     delegation is the one thing every cron must always be able to do).
 */
export function computeEffectiveAllowedTools(
  jobAllow: string[] | undefined,
  profileAllow: string[] | undefined,
): string[] | undefined {
  if (!jobAllow?.length) return undefined;
  let result: string[];
  if (profileAllow?.length) {
    const jobSet = new Set(jobAllow);
    result = profileAllow.filter(t => jobSet.has(t));
  } else {
    result = [...jobAllow];
  }
  if (!result.includes('Agent')) result.unshift('Agent');
  return Array.from(new Set(result));
}

/**
 * Compute the effective MCP server map for a cron run by intersecting the
 * trick's `allowedMcpServers` with the already-resolved server map from
 * `buildExtraMcpForRunAgent` (which has already applied the profile
 * allowlist). Returns the unchanged input map when the trick has no
 * MCP allowlist set.
 */
export function applyMcpAllowlist<T>(
  servers: Record<string, T>,
  jobAllowedMcpServers: string[] | undefined,
): Record<string, T> {
  if (!jobAllowedMcpServers?.length) return servers;
  const allow = new Set(jobAllowedMcpServers);
  return Object.fromEntries(
    Object.entries(servers).filter(([name]) => allow.has(name)),
  ) as Record<string, T>;
}

function capContextItem(s: string): string {
  if (!s) return '';
  return s.length <= CRON_CONTEXT_ITEM_MAX ? s : s.slice(0, CRON_CONTEXT_ITEM_MAX - 3) + '...';
}

function capContextBlock(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

/**
 * Build the previous-progress block from the cron progress JSON file.
 * Lets the agent continue where the prior run left off without re-doing
 * work it already completed.
 */
function buildProgressContext(jobName: string): string {
  try {
    const safeJob = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const progressFile = path.join(CRON_PROGRESS_DIR, `${safeJob}.json`);
    if (!fs.existsSync(progressFile)) return '';
    const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    const parts: string[] = [`## Previous Progress (run #${progress.runCount}, ${progress.lastRunAt})`];
    if (progress.completedItems?.length > 0) {
      parts.push(`Completed: ${progress.completedItems.slice(-10).map(capContextItem).join(', ')}`);
    }
    if (progress.pendingItems?.length > 0) {
      const pendingItems = progress.pendingItems.slice(0, CRON_PROGRESS_PENDING_MAX_ITEMS).map(capContextItem);
      const suffix = progress.pendingItems.length > CRON_PROGRESS_PENDING_MAX_ITEMS
        ? ` (${progress.pendingItems.length - CRON_PROGRESS_PENDING_MAX_ITEMS} more omitted)`
        : '';
      parts.push(`Pending: ${pendingItems.join(', ')}${suffix}`);
    }
    if (progress.notes) {
      parts.push(`Notes: ${capContextBlock(progress.notes, CRON_PROGRESS_NOTES_MAX_CHARS)}`);
    }
    return parts.join('\n') + '\n\n' +
      'Continue from where you left off. Use `cron_progress_write` at the end to save what you completed and what\'s pending.\n\n';
  } catch {
    return '';
  }
}

/** Build the linked-goals block for jobs that contribute to active goals. */
function buildGoalContext(jobName: string): string {
  try {
    const linkedGoals = listAllGoals()
      .map(({ goal }) => goal)
      .filter(g => g && g.status === 'active' && g.linkedCronJobs?.includes(jobName));
    if (linkedGoals.length === 0) return '';
    const goalLines = linkedGoals.map(g => {
      const goalRecord = g as { id: string; title: string; description: string; nextActions?: string[]; progressNotes?: string[] };
      const nextAct = goalRecord.nextActions?.length ? ` Next: ${goalRecord.nextActions[0]}` : '';
      const recentProgress = goalRecord.progressNotes?.length
        ? ` Last progress: ${goalRecord.progressNotes[goalRecord.progressNotes.length - 1]}`
        : '';
      return `- **${goalRecord.title}** (${goalRecord.id}): ${goalRecord.description.slice(0, 100)}${nextAct}${recentProgress}`;
    });
    return `## Active Goals Linked to This Job\n${goalLines.join('\n')}\n\n` +
      'After completing your work, update goal progress with `goal_update` if you made meaningful progress.\n\n';
  } catch {
    return '';
  }
}

/** Build the delegated-tasks block for hired agents that have pending team requests. */
function buildDelegationContext(agentSlug: string | undefined): string {
  if (!agentSlug) return '';
  try {
    const tasksDir = path.join(VAULT_DIR, '00-System', 'agents', agentSlug, 'tasks');
    if (!fs.existsSync(tasksDir)) return '';
    const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    type PendingTask = { id: string; fromAgent: string; task: string; expectedOutput: string; status?: string };
    const pendingTasks = taskFiles
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8')) as PendingTask | null; }
        catch { return null; }
      })
      .filter((t): t is PendingTask => t !== null && t.status === 'pending');
    if (pendingTasks.length === 0) return '';
    const taskLines = pendingTasks.map(t =>
      `- [${t.id}] From ${t.fromAgent}: ${t.task.slice(0, 150)} (expected: ${t.expectedOutput.slice(0, 80)})`
    );
    return `## Delegated Tasks Waiting\n${taskLines.join('\n')}\n\n` +
      'Work on these delegated tasks in addition to your scheduled task. ' +
      'Mark them in_progress/completed by editing the task JSON when done.\n\n';
  } catch {
    return '';
  }
}

/** Build the team-comms block: pending requests + recent messages for this agent. */
function buildTeamContext(agentSlug: string | undefined): string {
  if (!agentSlug) return '';
  try {
    const teamLogPath = path.join(BASE_DIR, 'logs', 'team-comms.jsonl');
    if (!fs.existsSync(teamLogPath)) return '';
    const teamLines = fs.readFileSync(teamLogPath, 'utf-8').trim().split('\n').filter(Boolean);
    type TeamMsg = { fromAgent: string; toAgent: string; content: string; protocol?: string; response?: string };
    const recentForAgent = teamLines
      .slice(-50)
      .map(l => { try { return JSON.parse(l) as TeamMsg; } catch { return null; } })
      .filter((m): m is TeamMsg => m !== null && (m.toAgent === agentSlug || m.fromAgent === agentSlug))
      .slice(-5);
    const pendingRequests = recentForAgent.filter(m =>
      m.protocol === 'request' && m.toAgent === agentSlug && !m.response,
    );
    if (pendingRequests.length === 0 && recentForAgent.length === 0) return '';
    const parts: string[] = ['## Team Context'];
    if (pendingRequests.length > 0) {
      parts.push('### REPLY NEEDED — Pending Requests');
      for (const r of pendingRequests) {
        parts.push(`- From ${r.fromAgent}: ${r.content.slice(0, 200)}`);
      }
      parts.push('Address these requests before your main task.');
    }
    if (recentForAgent.length > 0) {
      parts.push('### Recent Team Messages');
      for (const m of recentForAgent) {
        const dir = m.fromAgent === agentSlug ? 'sent to' : 'from';
        const other = m.fromAgent === agentSlug ? m.toAgent : m.fromAgent;
        parts.push(`- ${dir} ${other}: ${m.content.slice(0, 100)}`);
      }
    }
    return parts.join('\n') + '\n\n';
  } catch {
    return '';
  }
}

/** Build the success-criteria block from job spec. */
function buildCriteriaContext(successCriteria?: string[]): string {
  if (!successCriteria?.length) return '';
  return `## Success Criteria\nYour output will be verified against these criteria:\n` +
    successCriteria.map(c => `- ${c}`).join('\n') + '\n\n';
}

export interface SkillContextResult {
  /** The rendered "Learned Procedures" block (or empty string when no skills loaded). */
  text: string;
  /** Skills actually injected — the dashboard records this on the run log. */
  applied: Array<{ name: string; source: 'pinned' | 'auto'; score?: number }>;
  /** Pinned slugs that didn't resolve (deleted/renamed/suppressed). Logged + surfaced. */
  missing: string[];
}

/**
 * Build the matched-skills block (procedures learned from prior successful runs).
 * Pinned skills load first via exact-slug lookup; remaining slots fill from
 * the keyword/semantic auto-match. Total cap = `MAX_INJECTED_SKILLS`. Pins
 * that don't resolve are surfaced via `missing[]` (warned, never fatal) so
 * the dashboard can flag broken references.
 *
 * Exported only for testability — the production caller is `runAgentCron`.
 */
export async function buildSkillContext(
  jobName: string,
  jobPrompt: string,
  agentSlug: string | undefined,
  pinnedSkills: string[] | undefined,
  memoryStore?: MemoryStore | null,
): Promise<SkillContextResult> {
  const applied: SkillContextResult['applied'] = [];
  const missing: string[] = [];
  try {
    const { searchSkills, recordSkillUse, loadSkillByName } = await import('./skill-extractor.js');
    const skillQuery = jobName + ' ' + jobPrompt.slice(0, 200);
    const suppressedNamesRaw = (memoryStore as { getSkillsToSuppress?: (slug?: string) => string[] | Set<string> | undefined } | null | undefined)
      ?.getSkillsToSuppress?.(agentSlug);
    const suppressedNames = Array.isArray(suppressedNamesRaw)
      ? new Set(suppressedNamesRaw)
      : (suppressedNamesRaw ?? undefined);

    type PreparedSkill = {
      name: string; title: string; content: string;
      toolsUsed: string[]; attachments: string[]; skillDir: string;
      score?: number; source: 'pinned' | 'auto';
    };
    const prepared: PreparedSkill[] = [];
    const seen = new Set<string>();

    // 1. Load pinned skills first via exact slug lookup.
    if (pinnedSkills?.length) {
      for (const pinName of pinnedSkills) {
        if (seen.has(pinName)) continue;
        if (prepared.length >= MAX_INJECTED_SKILLS) break;
        const skill = loadSkillByName(pinName, agentSlug, { suppressedNames });
        if (!skill) {
          missing.push(pinName);
          logger.warn({ jobName, pin: pinName, agentSlug }, 'cron: pinned skill not found');
          continue;
        }
        prepared.push({ ...skill, source: 'pinned' });
        seen.add(pinName);
      }
    }

    // 2. Auto-match fills the remainder, deduped against pins.
    const remaining = MAX_INJECTED_SKILLS - prepared.length;
    if (remaining > 0) {
      const matched = searchSkills(skillQuery, remaining + (pinnedSkills?.length ?? 0), agentSlug, { suppressedNames });
      for (const m of matched) {
        if (prepared.length >= MAX_INJECTED_SKILLS) break;
        if (seen.has(m.name)) continue;
        prepared.push({ ...m, source: 'auto' });
        seen.add(m.name);
      }
    }

    if (prepared.length === 0) return { text: '', applied, missing };

    const skillLines = prepared.map(s => {
      recordSkillUse(s.name);
      (memoryStore as { logSkillUse?: (entry: Record<string, unknown>) => void } | null | undefined)?.logSkillUse?.({
        skillName: s.name,
        sessionKey: `cron:${agentSlug ?? 'clementine'}:${jobName}`,
        queryText: skillQuery,
        score: s.score ?? 0,
        agentSlug: agentSlug ?? null,
      });
      applied.push({ name: s.name, source: s.source, score: s.score });
      let block = `### ${s.title}${s.source === 'pinned' ? ' _(pinned)_' : ''}\n${s.content}`;
      if (s.toolsUsed.length > 0) block += `\n**Tools:** ${s.toolsUsed.join(', ')}`;
      if (s.attachments.length > 0) {
        const attDir = path.join(s.skillDir, s.name + '.files');
        for (const attName of s.attachments.slice(0, 3)) {
          const attPath = path.join(attDir, attName);
          if (fs.existsSync(attPath)) {
            try {
              const content = fs.readFileSync(attPath, 'utf-8').slice(0, 2000);
              block += `\n#### ${attName}\n\`\`\`\n${content}\n\`\`\``;
            } catch { /* skip */ }
          }
        }
      }
      return block;
    });
    const text = `## Learned Procedures (from past successful executions)\nFollow these proven approaches when applicable:\n\n${skillLines.join('\n\n')}\n\n`;
    return { text, applied, missing };
  } catch (err) {
    logger.debug({ err, jobName }, 'buildSkillContext failed (non-fatal)');
    return { text: '', applied, missing };
  }
}

/** Minimal interface for the post-task reflection + skill extraction
 *  hooks. Lets `runAgentCron` stay decoupled from the full
 *  PersonalAssistant import while still benefiting from the existing
 *  procedures. */
export interface CronPostTaskHooks {
  triggerCronReflection: (
    jobName: string,
    jobPrompt: string,
    deliverable: string,
    successCriteria?: string[],
  ) => Promise<void>;
  triggerSkillExtractionFromExecution: (
    source: 'unleashed' | 'cron' | 'chat',
    jobName: string,
    prompt: string,
    output: string,
    durationMs: number,
    agentSlug?: string,
  ) => Promise<void>;
  triggerMemoryExtractionPostExchange: (
    userMessage: string,
    assistantResponse: string,
    sessionKey?: string,
    profile?: AgentProfile,
  ) => Promise<void>;
}

export interface RunAgentCronOptions {
  /** Job name from CRON.md. Used for telemetry, progress lookup, skill match. */
  jobName: string;
  /** Job prompt body (the user-defined "do this" text). */
  jobPrompt: string;
  /** Cron tier. Drives effort + budget. */
  tier?: number;
  /** Optional max-turns cap (the SDK runs until done otherwise, bounded by maxBudget). */
  maxTurns?: number;
  /** Profile of the hired agent running this job (Sasha/Ross/Nora/etc). null = Clementine. */
  profile?: AgentProfile | null;
  /** Hired-agent registry — passed through to runAgent so subagent delegation works. */
  agentManager?: AgentManager | null;
  /** Memory store for cost logging + skill use tracking. */
  memoryStore?: MemoryStore | null;
  /** Per-job success criteria from CRON.md frontmatter. */
  successCriteria?: string[];
  /** Optional model override (rare — most jobs let the SDK default decide). */
  model?: string;
  /** Optional max-budget override. Default: tier-1 = $1, tier-2+ = $3. */
  maxBudgetUsd?: number;
  /** Optional working directory override (project-scoped jobs). */
  workDir?: string;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** Post-task hooks (reflection + skill extraction). Pass the
   *  PersonalAssistant — it implements both members. Optional so the
   *  helper still works in tests without the full assistant graph. */
  postTaskHooks?: CronPostTaskHooks | null;
  // ── Trick capabilities ────────────────────────────────────────────
  /** Pinned skill slugs from the trick definition. Loaded before the
   *  auto-match search; total skills injected is capped at
   *  `MAX_INJECTED_SKILLS`. */
  pinnedSkills?: string[];
  /** Per-trick tool whitelist. Intersected with `profile.team.allowedTools`
   *  when both are present. 'Agent' is always force-included. Undefined
   *  preserves today's behavior (falls back to profile or default). */
  allowedTools?: string[];
  /** Per-trick MCP server whitelist (server names from `discoverMcpServers`).
   *  Applied after `buildExtraMcpForRunAgent` runs, so the effective set
   *  is `profile ∩ trick`. */
  allowedMcpServers?: string[];
}

export interface RunAgentCronResult extends RunAgentResult {
  /** The final prompt that was sent to the agent (after context injection).
   *  Useful for cron diagnostics + debugging. */
  builtPrompt: string;
  /** Diagnostics: which Composio + external servers were live for this run. */
  composioConnected: string[];
  externalConnected: string[];
  /** Skills actually injected (pinned + auto). Surfaced on the run log so the
   *  dashboard can render a "ran with: …" line. */
  skillsApplied: Array<{ name: string; source: 'pinned' | 'auto'; score?: number }>;
  /** Pinned skills that didn't resolve (bad slug / suppressed). Empty array
   *  is fine; only populated when the trick had pins that failed to load. */
  skillsMissing: string[];
  /** Effective tool allowlist passed to runAgent (post-intersection). Undefined
   *  means the trick didn't override — runAgent fell through to profile/default. */
  allowedToolsApplied?: string[];
  /** MCP servers live for this run after profile + trick intersection. */
  mcpServersApplied: string[];
}

/** Plan output from `buildCronExecutionPlan` — everything the runner needs
 *  to dispatch, plus the broken-down context blocks so a preview UI can
 *  show "what came from where" without re-running the build. */
export interface CronExecutionPlan {
  builtPrompt: string;
  contextBlocks: {
    memoryContext: string;
    progressContext: string;
    goalContext: string;
    delegationContext: string;
    teamContext: string;
    criteriaContext: string;
    skillContext: string;
    jobPrompt: string;
    howToRespond: string;
  };
  skillsApplied: SkillContextResult['applied'];
  skillsMissing: string[];
  effectiveAllowedTools: string[] | undefined;
  mcpServerMap: Record<string, unknown>;
  mcpServersApplied: string[];
  composioConnected: string[];
  externalConnected: string[];
  tier: number;
  effort: 'low' | 'medium' | 'high';
  maxBudgetUsd: number | undefined;
  agentSlug: string | undefined;
  ownerName: string;
}

/**
 * Plan a cron run — assemble all context, resolve skills, intersect tool/MCP
 * allowlists — without dispatching to the agent. Used by `runAgentCron` for
 * the actual run, and by the dashboard's `GET /api/cron/:name/preview`
 * endpoint so users can see *exactly* what the trick will send to the agent
 * before the next fire.
 */
export async function buildCronExecutionPlan(opts: RunAgentCronOptions): Promise<CronExecutionPlan> {
  const tier = opts.tier ?? 1;
  const agentSlug = opts.profile?.slug;
  const ownerName = process.env.OWNER_NAME ?? 'the user';

  const memoryContext = buildAutonomousMemoryContext(opts.profile);
  const progressContext = buildProgressContext(opts.jobName);
  const goalContext = buildGoalContext(opts.jobName);
  const delegationContext = buildDelegationContext(agentSlug);
  const teamContext = buildTeamContext(agentSlug);
  const criteriaContext = buildCriteriaContext(opts.successCriteria);
  const skillResult = await buildSkillContext(
    opts.jobName, opts.jobPrompt, agentSlug, opts.pinnedSkills, opts.memoryStore,
  );
  const skillContext = skillResult.text;

  const howToRespond =
    `## How to respond\n` +
    `You're sending this directly to ${ownerName} as a DM. ` +
    `Write like you're texting a friend — casual, warm, concise. ` +
    `Use their name naturally. No headers, bullet lists, or formal structure unless the content genuinely needs it. ` +
    `Skip narrating your process ("I checked X, then Y..."). Just share the interesting stuff.\n\n` +
    `If there's genuinely nothing worth mentioning (no new data, no changes, no alerts), ` +
    `output ONLY: __NOTHING__\n` +
    `But lean toward sharing something — a one-liner is better than silence. ` +
    `"Quiet morning, inbox is clean" beats __NOTHING__ if you did check things.\n\n` +
    `After finishing your work, you MUST write a final text response with your findings — ` +
    `only that final message gets delivered.`;

  const builtPrompt =
    `[Scheduled task: ${opts.jobName}]\n\n` +
    memoryContext +
    progressContext +
    goalContext +
    skillContext +
    delegationContext +
    teamContext +
    criteriaContext +
    `${opts.jobPrompt}\n\n` +
    howToRespond;

  const mcp = await buildExtraMcpForRunAgent({
    scopeText: [
      opts.jobName,
      opts.jobPrompt,
      opts.profile?.description,
      opts.profile?.systemPromptBody,
    ].filter(Boolean).join('\n\n'),
    profile: opts.profile,
  });

  // Per-trick MCP allowlist: post-filter on the profile-narrowed map.
  // Effective set = profile ∩ trick.
  const mcpServerMap = applyMcpAllowlist(mcp.servers, opts.allowedMcpServers);
  const allowSet = opts.allowedMcpServers?.length ? new Set(opts.allowedMcpServers) : null;
  const composioConnected = allowSet ? mcp.composioConnected.filter(n => allowSet.has(n)) : mcp.composioConnected;
  const externalConnected = allowSet ? mcp.externalConnected.filter(n => allowSet.has(n)) : mcp.externalConnected;
  const mcpServersApplied = Object.keys(mcpServerMap);

  // Per-trick tool allowlist intersection.
  const effectiveAllowedTools = computeEffectiveAllowedTools(
    opts.allowedTools,
    opts.profile?.team?.allowedTools,
  );

  // Per-tier cap from config (BUDGET.cronT1 / BUDGET.cronT2). 0 = uncapped.
  const configuredCap = tier >= 2 ? BUDGET.cronT2 : BUDGET.cronT1;
  const maxBudget: number | undefined =
    opts.maxBudgetUsd ?? (configuredCap > 0 ? configuredCap : undefined);
  const effort: 'low' | 'medium' | 'high' = tier >= 2 ? 'high' : 'medium';

  return {
    builtPrompt,
    contextBlocks: {
      memoryContext, progressContext, goalContext, delegationContext,
      teamContext, criteriaContext, skillContext,
      jobPrompt: opts.jobPrompt, howToRespond,
    },
    skillsApplied: skillResult.applied,
    skillsMissing: skillResult.missing,
    effectiveAllowedTools,
    mcpServerMap,
    mcpServersApplied,
    composioConnected,
    externalConnected,
    tier,
    effort,
    maxBudgetUsd: maxBudget,
    agentSlug,
    ownerName,
  };
}

/**
 * Run a cron job via the canonical SDK runAgent path.
 *
 * Composes the same context blocks the legacy runCronJob injects
 * (progress, goals, delegation, team, criteria, skills, fanout
 * directive), wires Composio + external MCP via the dedup-aware
 * helper, then calls runAgent.
 *
 * The SDK handles the loop, compaction, subagent fanout, prompt
 * caching, retries — none of which we wrap manually anymore.
 */
export async function runAgentCron(opts: RunAgentCronOptions): Promise<RunAgentCronResult> {
  const plan = await buildCronExecutionPlan(opts);
  const {
    builtPrompt, agentSlug, effort, maxBudgetUsd: maxBudget,
    effectiveAllowedTools, mcpServerMap, composioConnected, externalConnected, mcpServersApplied,
  } = plan;

  logger.info({
    job: opts.jobName,
    tier: plan.tier,
    profile: agentSlug,
    composioConnected,
    externalConnected,
    promptChars: builtPrompt.length,
    pinnedSkills: opts.pinnedSkills?.length ?? 0,
    skillsApplied: plan.skillsApplied.length,
    skillsMissing: plan.skillsMissing.length,
    trickAllowedTools: effectiveAllowedTools?.length,
    trickAllowedMcp: opts.allowedMcpServers?.length,
  }, 'runAgentCron: dispatching to runAgent');

  const startedAt = Date.now();
  const result = await runAgent(builtPrompt, {
    sessionKey: `cron:${opts.jobName}`,
    source: 'cron',
    profile: opts.profile,
    agentManager: opts.agentManager,
    memoryStore: opts.memoryStore,
    model: opts.model,
    effort,
    ...(maxBudget !== undefined ? { maxBudgetUsd: maxBudget } : {}),
    maxTurns: opts.maxTurns,
    abortSignal: opts.abortSignal,
    ...(effectiveAllowedTools ? { allowedTools: effectiveAllowedTools } : {}),
    extraMcpServers: mcpServerMap as unknown as Parameters<typeof runAgent>[1]['extraMcpServers'],
  });

  // Mirror the run into transcripts so future chat recall can see it.
  // Legacy runCronJob did this with role='cron'; canonical needs the
  // same so memory queries (`what did Sasha do this morning?`) work.
  const deliverable = result.text ?? '';
  if (opts.memoryStore && deliverable.trim()) {
    try {
      opts.memoryStore.saveTurn(`cron:${opts.jobName}`, 'cron', deliverable, opts.model ?? '');
    } catch (err) {
      logger.debug({ err, job: opts.jobName }, 'runAgentCron: transcript mirror failed (non-fatal)');
    }
  }

  // ── Post-task hooks: reflection + skill extraction + memory ──────
  // All fire-and-forget — never block the cron deliverable on these.
  // Reflection grades the run, skill extraction banks repeatable
  // procedures, memory extraction distills facts the agent learned
  // (e.g. "Mark Finizio is now the buyer at FamilyCenter") into the
  // agent's MEMORY.md. The legacy runCronJob fired reflection +
  // skill but never memory extraction; that gap is closed now.
  if (opts.postTaskHooks && deliverable && deliverable.trim() !== '__NOTHING__') {
    const durationMs = Date.now() - startedAt;
    opts.postTaskHooks
      .triggerCronReflection(opts.jobName, opts.jobPrompt, deliverable, opts.successCriteria)
      .catch(err => logger.debug({ err, job: opts.jobName }, 'runAgentCron: reflection failed (non-fatal)'));
    opts.postTaskHooks
      .triggerSkillExtractionFromExecution('cron', opts.jobName, opts.jobPrompt, deliverable, durationMs, agentSlug)
      .catch(err => logger.debug({ err, job: opts.jobName }, 'runAgentCron: skill extraction failed (non-fatal)'));
    opts.postTaskHooks
      .triggerMemoryExtractionPostExchange(
        opts.jobPrompt,
        deliverable,
        `cron:${opts.jobName}`,
        opts.profile ?? undefined,
      )
      .catch(err => logger.debug({ err, job: opts.jobName }, 'runAgentCron: memory extraction failed (non-fatal)'));
  }

  return {
    ...result,
    builtPrompt,
    composioConnected,
    externalConnected,
    skillsApplied: plan.skillsApplied,
    skillsMissing: plan.skillsMissing,
    allowedToolsApplied: effectiveAllowedTools,
    mcpServersApplied,
  };
}
