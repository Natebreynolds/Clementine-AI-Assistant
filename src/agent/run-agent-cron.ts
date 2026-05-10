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
  // 1.18.148 — distinguish "no allowlist" (undefined → unrestricted) from
  // "explicitly empty allowlist" (`[]` → deny all). Before this, both
  // collapsed to `undefined` because of the `?.length` check, which meant
  // meta-jobs passing `allowedTools: []` actually got the FULL tool set
  // injected (and blew past the prompt limit when Composio toolkits piled
  // on tool schemas). The fix: an explicit `[]` returns `['Agent']` only
  // (just the SDK's required spawn-subagent tool).
  if (jobAllow === undefined) return undefined;
  if (jobAllow.length === 0) return ['Agent']; // explicitly empty → minimal
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
  // 1.18.148 — empty array means "deny all MCP servers", not "no
  // restriction". Before this, passing `[]` collapsed to `?.length === 0`
  // and returned the unfiltered server map — so meta-jobs (insight-check,
  // grade:*, route-classify, diagnose:*) got every Composio toolkit's
  // tool schemas wired into their prompt and blew past Claude's input
  // limit. 110+ "Prompt is too long" errors per 8 hours.
  if (jobAllowedMcpServers === undefined) return servers;
  if (jobAllowedMcpServers.length === 0) return {} as Record<string, T>;
  const allow = new Set(jobAllowedMcpServers);
  return Object.fromEntries(
    Object.entries(servers).filter(([name]) => allow.has(name)),
  ) as Record<string, T>;
}

/**
 * Widen the cron's tool allowlist with the union of pinned-skill
 * `clementine.tools.allow` declarations.
 *
 * **Why this exists:** Pinning a skill is a positive user signal — "I want
 * this skill, with the tools it declares it needs." Before 1.18.125 the
 * skill's `tools.allow` was rendered into the prompt as text only; the SDK
 * never saw it, so a skill pinned to a cron with a narrower allowlist would
 * silently fail with tool-not-found errors.
 *
 * **Semantics:**
 *   - Cron has no allowlist → return undefined (cron is unrestricted; pinned
 *     skill tools flow through the profile/default fallback in `runAgent`).
 *     We deliberately don't synthesize an allowlist out of just skill tools
 *     here, because that would NARROW an unrestricted cron to "only what the
 *     skills declared."
 *   - Cron has allowlist + skills declared tools → return the union (skills
 *     widen, never narrow, an existing constraint).
 *   - Cron has allowlist + no pinned-skill tools → return the cron's allowlist
 *     unchanged.
 */
export function widenAllowlistWithSkillTools(
  jobAllow: string[] | undefined,
  pinnedSkillTools: string[] | undefined,
): string[] | undefined {
  // 1.18.148 — preserve "explicitly empty" semantics. An empty array is a
  // contract: "I want no tools." Skill-pin widening doesn't apply when no
  // skills are pinned (which is the case for meta-jobs).
  if (jobAllow === undefined) return undefined;
  if (jobAllow.length === 0 && !pinnedSkillTools?.length) return [];
  if (!pinnedSkillTools?.length) return [...jobAllow];
  return [...new Set([...jobAllow, ...pinnedSkillTools])];
}

/** Match `mcp__SERVER__TOOL` references in skill body Markdown.
 *  Server names can contain single underscores (`Bright_Data`,
 *  `claude_ai_Microsoft_365`) but never `__` (double-underscore is the
 *  delimiter). The regex captures the server segment between the leading
 *  `mcp__` and the next `__`. Anchored on word boundaries so it doesn't
 *  catch substrings of longer identifiers. */
const MCP_TOOL_REF = /mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__/g;

/**
 * Extract every distinct `mcp__<server>__<tool>` server name referenced
 * inside the bodies of pinned skills. Empty array when no references found.
 */
export function extractMcpServersFromSkillBodies(bodies: string[]): string[] {
  const found = new Set<string>();
  for (const body of bodies) {
    if (!body) continue;
    for (const m of body.matchAll(MCP_TOOL_REF)) found.add(m[1]);
  }
  return [...found];
}

/**
 * Widen the cron's MCP-server allowlist with servers referenced inside
 * pinned-skill bodies (e.g., a skill that calls `mcp__gmail__send_message`
 * implicitly needs the `gmail` server connected).
 *
 * Same semantics as `widenAllowlistWithSkillTools`: only widens an existing
 * allowlist; doesn't synthesize one when the cron is unrestricted.
 */
export function widenMcpAllowlistWithSkillRefs(
  jobMcpAllow: string[] | undefined,
  skillReferencedServers: string[],
): string[] | undefined {
  // 1.18.148 — preserve "explicitly empty" semantics. See note on
  // applyMcpAllowlist + widenAllowlistWithSkillTools above.
  if (jobMcpAllow === undefined) return undefined;
  if (jobMcpAllow.length === 0 && !skillReferencedServers.length) return [];
  if (!skillReferencedServers.length) return [...jobMcpAllow];
  return [...new Set([...jobMcpAllow, ...skillReferencedServers])];
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
  /** Union of every `clementine.tools.allow` entry from pinned skills. Used by
   *  `buildCronExecutionPlan` to widen the cron's tool allowlist so a pinned
   *  skill's declared tools survive into the SDK call. Empty array when no
   *  pinned skill declared a `tools.allow` list. Auto-matched skills do NOT
   *  contribute — only explicit pins widen scope. */
  pinnedToolsRequested: string[];
  /** Bodies of pinned skills only — used for `mcp__server__tool` reference
   *  extraction so a skill's MCP usage propagates to `allowedMcpServers`.
   *  Auto-matched skills excluded for the same reason as above. */
  pinnedBodies: string[];
}

/**
 * Build the matched-skills block (procedures learned from prior successful runs).
 * Pinned skills load first via exact-slug lookup; remaining slots fill from
 * the keyword/semantic auto-match. Total cap = `MAX_INJECTED_SKILLS`. Pins
 * that don't resolve are surfaced via `missing[]` (warned, never fatal) so
 * the dashboard can flag broken references.
 *
 * When `opts.skipAutoMatch` is true (predictable mode), only pinned skills
 * load — the runtime keyword/semantic match is skipped entirely. The trick
 * runs with ONLY the skills the user explicitly attached.
 *
 * Exported only for testability — the production caller is `runAgentCron`.
 */
export async function buildSkillContext(
  jobName: string,
  jobPrompt: string,
  agentSlug: string | undefined,
  pinnedSkills: string[] | undefined,
  memoryStore?: MemoryStore | null,
  opts?: { skipAutoMatch?: boolean; projectWorkDir?: string },
): Promise<SkillContextResult> {
  const applied: SkillContextResult['applied'] = [];
  const missing: string[] = [];
  const pinnedToolsRequested: string[] = [];
  const pinnedBodies: string[] = [];
  try {
    const { searchSkills, recordSkillUse, loadSkillByName } = await import('./skill-extractor.js');
    const skillQuery = jobName + ' ' + jobPrompt.slice(0, 200);
    const suppressedNamesRaw = (memoryStore as { getSkillsToSuppress?: (slug?: string) => string[] | Set<string> | undefined } | null | undefined)
      ?.getSkillsToSuppress?.(agentSlug);
    const autoSuppressed = Array.isArray(suppressedNamesRaw)
      ? new Set(suppressedNamesRaw)
      : (suppressedNamesRaw ?? undefined);
    // 1.18.127 — merge automatic feedback-driven suppressions (from the
    // memory store) with manual user toggles (from skill-suppressions.json).
    // Both sets pass through to loadSkillByName + searchSkills under the
    // same `suppressedNames` parameter — the runtime doesn't care which
    // source flagged a skill.
    let suppressedNames: Set<string> | undefined = autoSuppressed;
    try {
      const { getManualSuppressions } = await import('./skill-suppressions.js');
      const manual = getManualSuppressions(agentSlug);
      if (manual.size > 0) {
        suppressedNames = new Set([...(autoSuppressed ?? []), ...manual]);
      }
    } catch (err) {
      logger.debug({ err }, 'manual suppression read failed (non-fatal)');
    }

    type PreparedSkill = {
      name: string; title: string; content: string;
      toolsUsed: string[]; attachments: string[]; skillDir: string;
      score?: number; source: 'pinned' | 'auto';
    };
    const prepared: PreparedSkill[] = [];
    const seen = new Set<string>();

    // 1. Load pinned skills first via exact slug lookup. When the cron has
    //    a workDir set, we ALSO check for a project-scoped skill at
    //    <workDir>/.clementine/skills/<name>/SKILL.md before falling back
    //    to the global lookup. This closes the SDK-alignment gap from the
    //    1.18.121 audit (project skills were silently unreachable from the
    //    cron runtime even though skill-store.getSkill supported them).
    if (pinnedSkills?.length) {
      const projectGetSkill = opts?.projectWorkDir
        ? (await import('./skill-store.js')).getSkill
        : null;
      for (const pinName of pinnedSkills) {
        if (seen.has(pinName)) continue;
        if (prepared.length >= MAX_INJECTED_SKILLS) break;
        // Project-scoped first when a workDir is in scope. The skill-store
        // shape differs from the runtime's SkillMatch — adapt it here so
        // the rest of the pipeline doesn't care which loader returned it.
        let skill: { name: string; title: string; content: string; toolsUsed: string[]; attachments: string[]; skillDir: string } | null = null;
        if (projectGetSkill && opts?.projectWorkDir) {
          const ps = projectGetSkill(pinName, { projectWorkDir: opts.projectWorkDir });
          if (ps && ps.scope === 'project') {
            const ext = (ps.frontmatter.clementine ?? {}) as Record<string, unknown>;
            const tools = ((ext.tools as { allow?: unknown })?.allow as unknown[] | undefined) ?? [];
            skill = {
              name: ps.frontmatter.name,
              title: String((ps.frontmatter as { title?: unknown }).title ?? ps.frontmatter.name),
              content: ps.body,
              toolsUsed: Array.isArray(tools) ? tools.map(String) : [],
              attachments: [],
              skillDir: path.dirname(path.dirname(ps.filePath)),
            };
          }
        }
        if (!skill) skill = loadSkillByName(pinName, agentSlug, { suppressedNames });
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
    //    In predictable (contract) mode we skip this entirely — only
    //    pinned skills load, the runtime keyword/semantic search is off.
    const remaining = MAX_INJECTED_SKILLS - prepared.length;
    if (remaining > 0 && !opts?.skipAutoMatch) {
      const matched = searchSkills(skillQuery, remaining + (pinnedSkills?.length ?? 0), agentSlug, { suppressedNames });
      for (const m of matched) {
        if (prepared.length >= MAX_INJECTED_SKILLS) break;
        if (seen.has(m.name)) continue;
        prepared.push({ ...m, source: 'auto' });
        seen.add(m.name);
      }
    }

    // 1.18.125 — collect pinned-skill tool declarations + bodies so the
    // cron planner can widen `allowedTools` / `allowedMcpServers` with what
    // the pinned skills explicitly need. Pins (not auto-matches) widen scope
    // because pinning is the user's explicit signal of intent.
    const pinnedSeen = new Set<string>();
    for (const s of prepared) {
      if (s.source !== 'pinned') continue;
      if (pinnedSeen.has(s.name)) continue;
      pinnedSeen.add(s.name);
      for (const t of s.toolsUsed) pinnedToolsRequested.push(t);
      pinnedBodies.push(s.content);
    }

    if (prepared.length === 0) return { text: '', applied, missing, pinnedToolsRequested: [], pinnedBodies: [] };

    // Folder-form bundled-file budget. Anthropic skill spec says the body
    // should be ≤500 lines; bundled files (templates/, reference docs)
    // load on top. We cap aggregate inlined bundle bytes so a skill with a
    // huge templates/ tree doesn't blow the context window — anything over
    // the cap is left on disk and the LLM can Read it via the cron's cwd.
    const BUNDLE_FILE_CAP = 5;
    const BUNDLE_BYTES_CAP = 12000;

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

      // Folder-form skills (post-migration default): inline sibling .md
      // files (templates/intro.md, reference.md, etc.) so the cron prompt
      // actually sees them. SKILL.md itself is the body above. scripts/
      // and other non-.md assets stay on disk — the cron's cwd has Bash
      // access to them via the runtime working directory.
      const folderPath = path.join(s.skillDir, s.name);
      const skillEntry = path.join(folderPath, 'SKILL.md');
      if (fs.existsSync(skillEntry)) {
        let bytesUsed = 0;
        let filesUsed = 0;
        const collectMd = (subDir: string, label: string): void => {
          if (filesUsed >= BUNDLE_FILE_CAP || bytesUsed >= BUNDLE_BYTES_CAP) return;
          let entries: string[];
          try { entries = fs.readdirSync(subDir).sort(); } catch { return; }
          for (const entry of entries) {
            if (filesUsed >= BUNDLE_FILE_CAP || bytesUsed >= BUNDLE_BYTES_CAP) break;
            if (entry === 'SKILL.md') continue;
            if (!entry.endsWith('.md')) continue;
            const full = path.join(subDir, entry);
            try {
              const content = fs.readFileSync(full, 'utf-8');
              const remaining = BUNDLE_BYTES_CAP - bytesUsed;
              const slice = content.slice(0, remaining);
              const labeled = label ? `${label}/${entry}` : entry;
              block += `\n\n#### ${labeled}\n${slice}`;
              bytesUsed += slice.length;
              filesUsed++;
            } catch { /* skip unreadable */ }
          }
        };
        // Top-level bundled .md files (reference.md, etc.)
        collectMd(folderPath, '');
        // Common sub-dirs: templates/, references/. One level deep only —
        // we don't recurse to keep the budget predictable.
        for (const sub of ['templates', 'references']) {
          if (filesUsed >= BUNDLE_FILE_CAP || bytesUsed >= BUNDLE_BYTES_CAP) break;
          const subPath = path.join(folderPath, sub);
          if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
            collectMd(subPath, sub);
          }
        }
      } else if (s.attachments.length > 0) {
        // Legacy flat form: attachments live under <skill>.files/ alongside
        // the skill .md. Kept for backward compat with un-migrated skills.
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
    return { text, applied, missing, pinnedToolsRequested: [...new Set(pinnedToolsRequested)], pinnedBodies };
  } catch (err) {
    logger.debug({ err, jobName }, 'buildSkillContext failed (non-fatal)');
    return { text: '', applied, missing, pinnedToolsRequested: [], pinnedBodies: [] };
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
  /** Predictable mode — when true, the runner skips the auto-injected
   *  context blocks (MEMORY.md, team comms, delegation queue) and the
   *  auto-matched skill search. The trick runs with ONLY what was
   *  explicitly attached: prompt, criteria, pinned skills, linked goals,
   *  prior progress. The fix for fire-time memory drift. Undefined =
   *  legacy behavior (inject everything). */
  predictable?: boolean;
  /** Lean mode — strictest possible context envelope, used by meta-jobs
   *  (insight-check, outcome-grader, route-classifier, failure-diagnostics,
   *  __heartbeat__) that ALSO have to stay under Haiku's prompt cap.
   *  Implies predictable + drops progress/goal/criteria/skill-context blocks
   *  + prunes MCP catalog to just the explicit allowed servers (no Composio
   *  auto-discovery, no claude.ai connector inventory). When unset, behaves
   *  like predictable. The 1.18.148 fix patched outcome-grader / route-
   *  classifier / failure-diagnostics directly; this 1.18.154 flag covers
   *  insight-check (which still failed 65/70 because predictable alone
   *  wasn't strict enough) and is the canonical hook for any future
   *  meta-job that needs a tiny prompt. */
  lean?: boolean;
  /** Extra read+execute scope for the agent's Read/Bash/Glob tools. Maps
   *  directly to the CronJobDefinition.addDirs YAML field. Combined with
   *  every pinned-skill folder so `Bash python3 scripts/render.py` works
   *  from inside a skill bundle without the cwd being set there. */
  addDirs?: string[];
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
  /** Whether the trick is in predictable (contract) mode — true means
   *  MEMORY.md / team / delegation / auto-skills were intentionally
   *  skipped. Used by the Preview verdict line. */
  predictable: boolean;
  /** Merged list of extra directories the SDK should expose to the agent's
   *  Read/Bash/Glob tools. Combines `opts.addDirs` with every pinned-skill
   *  folder so a skill's `scripts/render.py` is reachable without the cwd
   *  being set inside the skill folder. Deduped + filtered to existing
   *  paths. Empty when the trick has no addDirs and no folder-form pins. */
  additionalDirectories: string[];
  /** Diagnostics: which scopes a pinned skill widened on this run. Empty
   *  arrays when no widening happened. Surfaced in the Preview UI so users
   *  see "this skill brought in `Bash` and `gmail` MCP" without reading
   *  source. */
  widenedFromSkills: {
    /** Tool names a pinned skill's `clementine.tools.allow` added on top of
     *  the cron's own allowlist. Empty when nothing was widened. */
    tools: string[];
    /** MCP server names a pinned skill's body referenced (`mcp__server__tool`)
     *  that the cron's `allowedMcpServers` didn't already include. */
    mcpServers: string[];
  };
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

  // ── Predictable (contract) mode ────────────────────────────────────
  // When `predictable: true`, the trick runs with ONLY what was explicitly
  // attached — prompt, criteria, pinned skills, linked goals, prior progress.
  // We skip MEMORY.md, team comms, delegation queue, and the runtime skill
  // auto-match. This is the fix for the email-cadence failure mode where the
  // agent agreed to a plan in chat then re-derived from drifted memory at
  // fire time. Legacy tricks (predictable === undefined) preserve existing
  // behavior so we don't surprise anyone.
  const predictable = opts.predictable === true;
  // 1.18.154 — lean mode goes one tier stricter for meta-jobs (insight-check,
  // outcome-grader, route-classifier, failure-diagnostics, __heartbeat__).
  // Drops progress / goal / criteria / skill-context blocks too, leaving
  // the agent with [jobName] + [jobPrompt] + [howToRespond] only. Implies
  // predictable. Anything that ALSO needs a tiny MCP catalog uses the
  // pruning logic below.
  //
  // Auto-apply for known meta-jobs even if the CRON.md/registry entry
  // doesn't carry `lean: true` — these names are hard-coded singletons in
  // heartbeat-scheduler.ts and we know they need the strict envelope. Lets
  // existing user installs benefit from the fix without requiring them to
  // hand-edit CRON.md.
  const KNOWN_META_JOBS = new Set([
    'insight-check', 'outcome-grader', 'route-classifier',
    'failure-diagnostics', '__heartbeat__',
  ]);
  const lean = opts.lean === true || KNOWN_META_JOBS.has(opts.jobName);

  const memoryContext = predictable || lean ? '' : buildAutonomousMemoryContext(opts.profile);
  const progressContext = lean ? '' : buildProgressContext(opts.jobName);     // opt-in via cron_progress writes
  const goalContext = lean ? '' : buildGoalContext(opts.jobName);             // explicit links; not auto-inferred
  const delegationContext = predictable || lean ? '' : buildDelegationContext(agentSlug);
  const teamContext = predictable || lean ? '' : buildTeamContext(agentSlug);
  const criteriaContext = lean ? '' : buildCriteriaContext(opts.successCriteria);
  const skillResult = lean
    ? { text: '', applied: [], missing: [], pinnedBodies: [] as string[], pinnedToolsRequested: [] as string[] }
    : await buildSkillContext(
        opts.jobName, opts.jobPrompt, agentSlug, opts.pinnedSkills, opts.memoryStore,
        { skipAutoMatch: predictable, projectWorkDir: opts.workDir },
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

  // 1.18.154 — lean mode skips Composio + claude.ai MCP discovery entirely.
  // Meta-jobs (insight-check etc.) only need the always-on Clementine MCP
  // server (which is added in run-agent.ts and has cron_list, discord_*,
  // etc.). Loading 200+ extra MCP tool schemas just to call cron_list is
  // what was tipping the prompt over Haiku's cap. If a lean job DOES need
  // extras, declare them explicitly via `allowedMcpServers` and the helper
  // narrows discovery to those names.
  const mcp = lean && (!opts.allowedMcpServers || opts.allowedMcpServers.length === 0)
    ? { servers: {} as Record<string, unknown>, composioConnected: [] as string[], externalConnected: [] as string[] }
    : await buildExtraMcpForRunAgent({
        scopeText: [
          opts.jobName,
          opts.jobPrompt,
          opts.profile?.description,
          opts.profile?.systemPromptBody,
        ].filter(Boolean).join('\n\n'),
        profile: opts.profile,
      });

  // 1.18.125 — pinned-skill scope widening (SDK alignment).
  // A pinned skill that declares `clementine.tools.allow` or references
  // `mcp__server__tool` in its body needs those tools/servers to actually
  // be live for the SDK call — not just rendered into the prompt as text.
  // We widen (never narrow) the cron's allowlists with what the pinned
  // skills declared. Auto-matched skills don't widen scope (only explicit
  // pins do — the user's positive signal).
  const skillReferencedMcpServers = extractMcpServersFromSkillBodies(skillResult.pinnedBodies);
  const widenedJobAllowedTools = widenAllowlistWithSkillTools(
    opts.allowedTools,
    skillResult.pinnedToolsRequested,
  );
  const widenedJobMcpAllowlist = widenMcpAllowlistWithSkillRefs(
    opts.allowedMcpServers,
    skillReferencedMcpServers,
  );

  // Per-trick MCP allowlist: post-filter on the profile-narrowed map.
  // Effective set = profile ∩ trick (widened).
  // 1.18.148 — empty array means "deny all" not "no restriction" (was a
  // silent prompt-bloat bug — see applyMcpAllowlist note above).
  const mcpServerMap = applyMcpAllowlist(mcp.servers, widenedJobMcpAllowlist);
  const allowSet = widenedJobMcpAllowlist === undefined ? null : new Set(widenedJobMcpAllowlist);
  const composioConnected = allowSet ? mcp.composioConnected.filter(n => allowSet.has(n)) : mcp.composioConnected;
  const externalConnected = allowSet ? mcp.externalConnected.filter(n => allowSet.has(n)) : mcp.externalConnected;
  const mcpServersApplied = Object.keys(mcpServerMap);

  // Per-trick tool allowlist intersection (widened by pinned-skill needs).
  const effectiveAllowedTools = computeEffectiveAllowedTools(
    widenedJobAllowedTools,
    opts.profile?.team?.allowedTools,
  );

  // Per-tier cap from config (BUDGET.cronT1 / BUDGET.cronT2). 0 = uncapped.
  const configuredCap = tier >= 2 ? BUDGET.cronT2 : BUDGET.cronT1;
  const maxBudget: number | undefined =
    opts.maxBudgetUsd ?? (configuredCap > 0 ? configuredCap : undefined);
  const effort: 'low' | 'medium' | 'high' = tier >= 2 ? 'high' : 'medium';

  // 1.18.121 — assemble additionalDirectories. Combines:
  //   1. opts.addDirs (from CronJobDefinition.addDirs YAML field)
  //   2. Every pinned-skill folder so the skill's scripts/ + reference docs
  //      are reachable via Read/Bash without the cwd being set inside the
  //      skill folder.
  // Deduped via Set; filtered to paths that actually exist on disk so we
  // don't trigger SDK errors on stale references.
  const dirSet = new Set<string>();
  for (const d of opts.addDirs ?? []) {
    if (d && typeof d === 'string') dirSet.add(d);
  }
  for (const applied of skillResult.applied) {
    // skillResult.applied lacks the on-disk path; pull it from the prepared
    // skill list (which we have in scope as a closure via the skillContext
    // builder). Cheaper to reconstruct: every pinned-form skill lives at
    // `<skillsRoot>/<name>/SKILL.md` and we want to expose `<skillsRoot>/<name>/`.
    // Walk both global + agent-scoped roots; first hit wins.
    const candidates = [
      path.join(VAULT_DIR, '00-System', 'skills', applied.name),
    ];
    if (agentSlug) {
      candidates.unshift(path.join(VAULT_DIR, '00-System', 'agents', agentSlug, 'skills', applied.name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'SKILL.md'))) { dirSet.add(candidate); break; }
    }
  }
  // Final filter: only emit dirs that exist (the SDK errors on missing).
  const additionalDirectories = [...dirSet].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });

  // Diagnostics: what did the pinned skills add on top of what the cron
  // already declared? Renders in the Preview UI as "Skill widened scope: …"
  const baseToolSet = new Set(opts.allowedTools ?? []);
  const widenedToolsFromSkills = skillResult.pinnedToolsRequested.filter(t => !baseToolSet.has(t));
  const baseMcpSet = new Set(opts.allowedMcpServers ?? []);
  const widenedMcpFromSkills = skillReferencedMcpServers.filter(s => !baseMcpSet.has(s));

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
    predictable,
    additionalDirectories,
    widenedFromSkills: {
      // Only surface widening when the cron actually had a base allowlist —
      // otherwise the cron is unrestricted and "widening" isn't a meaningful
      // concept (the skills' tools were already implicitly allowed).
      tools: opts.allowedTools?.length ? widenedToolsFromSkills : [],
      mcpServers: opts.allowedMcpServers?.length ? widenedMcpFromSkills : [],
    },
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
    additionalDirectories,
  } = plan;

  // 1.18.154 — surface lean + promptChars for meta-job diagnostics. The
  // self-improve / insight-check failure mode is "small prompt, fat context"
  // which only shows in promptChars; plain log level was previously info but
  // anything > 50KB is on the cusp of Haiku's cap and worth a warn.
  const promptBytes = Buffer.byteLength(builtPrompt, 'utf8');
  const promptOversized = promptBytes > 50_000;
  logger[promptOversized ? 'warn' : 'info']({
    job: opts.jobName,
    tier: plan.tier,
    profile: agentSlug,
    lean: opts.lean === true || ['insight-check', 'outcome-grader', 'route-classifier', 'failure-diagnostics', '__heartbeat__'].includes(opts.jobName),
    composioConnected,
    externalConnected,
    promptChars: builtPrompt.length,
    promptBytes,
    pinnedSkills: opts.pinnedSkills?.length ?? 0,
    skillsApplied: plan.skillsApplied.length,
    skillsMissing: plan.skillsMissing.length,
    trickAllowedTools: effectiveAllowedTools?.length,
    trickAllowedMcp: opts.allowedMcpServers?.length,
    widenedFromSkills: plan.widenedFromSkills,
    ...(promptOversized ? { warning: 'prompt > 50KB; risk of "Prompt is too long" failure' } : {}),
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
    // 1.18.121 — pipe the merged addDirs+pinned-skill folders to the SDK
    // so a skill's bundled scripts/templates are reachable via Bash/Read
    // without making the cwd the skill folder.
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
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
