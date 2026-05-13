/**
 * Build the vault context block that gets appended to the SDK's
 * `claude_code` system prompt preset for chat sessions.
 *
 * The legacy chat path (`assistant.ts:buildSystemPrompt`) injected
 * SOUL.md (personality), MEMORY.md (long-term memory), AGENTS.md
 * (team awareness), and the agent-specific working-memory file. Without
 * those, the canonical chat path loses the personality, preferences,
 * and team-roster knowledge that distinguish Clementine from a generic
 * SDK agent.
 *
 * Canonical pattern: SDK accepts `systemPrompt: { type: 'preset',
 * preset: 'claude_code', append: <string> }`. We append a single
 * concatenated context block — no wrappers, no recursive prompts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SOUL_FILE, AGENTS_FILE, MEMORY_FILE, AGENTS_DIR } from '../config.js';
import type { AgentProfile } from '../types.js';

const SOUL_MAX_CHARS = 6_000;
const MEMORY_MAX_CHARS = 8_000;
const AGENTS_MAX_CHARS = 4_000;
const PROFILE_MEMORY_MAX_CHARS = 6_000;

function readFileSafe(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

function trimTo(text: string, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 3) + '...';
}

export interface BuildChatContextOptions {
  /** Active hired-agent profile, when set. The agent-specific MEMORY.md
   *  in `agents/<slug>/MEMORY.md` is preferred over the global one. */
  profile?: AgentProfile | null;
  /** Optional caller-supplied systemPromptBody to append after the
   *  vault context block (used by hired-agent profiles). */
  profileAppend?: string;
}

/**
 * Build the system-prompt append string for chat invocations.
 *
 * Returns an empty string when none of the source files exist — the
 * SDK then runs with just the bare `claude_code` preset.
 */
export function buildChatSystemAppend(opts: BuildChatContextOptions = {}): string {
  const blocks: string[] = [];
  const isHiredAgent = !!opts.profile && opts.profile.slug !== 'clementine';

  // 1. Identity & Voice.
  //    - Clementine main agent: SOUL.md (the global personality file).
  //    - Hired agent main: their own profile.systemPromptBody IS their
  //      identity — don't load Clementine's SOUL on top of it.
  if (!isHiredAgent) {
    const soul = readFileSafe(SOUL_FILE);
    if (soul.trim()) {
      blocks.push(`## Identity & Voice\n${trimTo(soul, SOUL_MAX_CHARS)}`);
    }
  }

  // 2. Long-term memory — agent-specific file when a hired agent is
  //    active, otherwise the global one.
  const profileMemoryPath = isHiredAgent
    ? path.join(AGENTS_DIR, opts.profile!.slug, 'MEMORY.md')
    : null;
  if (profileMemoryPath && fs.existsSync(profileMemoryPath)) {
    const memory = readFileSafe(profileMemoryPath);
    if (memory.trim()) {
      blocks.push(`## Long-Term Memory (${opts.profile!.name ?? opts.profile!.slug})\n${trimTo(memory, PROFILE_MEMORY_MAX_CHARS)}`);
    }
  } else {
    const memory = readFileSafe(MEMORY_FILE);
    if (memory.trim()) {
      blocks.push(`## Long-Term Memory\n${trimTo(memory, MEMORY_MAX_CHARS)}`);
    }
  }

  // 3. Team roster (only when not running AS a hired agent).
  if (!isHiredAgent) {
    const agentsRoster = readFileSafe(AGENTS_FILE);
    if (agentsRoster.trim()) {
      blocks.push(`## Team Roster\n${trimTo(agentsRoster, AGENTS_MAX_CHARS)}`);
    }
  }

  // 4. Profile system prompt body (the hired agent's identity + role).
  if (opts.profileAppend?.trim()) {
    blocks.push(opts.profileAppend);
  }

  // 5. Behavioral posture (1.18.184) — re-anchored from the legacy
  //    assistant.ts:buildSystemPrompt path which the modern chat no
  //    longer goes through. Kept in the cacheable system-prompt append
  //    (NOT in the per-turn user-message context) so Anthropic's
  //    prompt cache holds these directives across turns. They are
  //    short, stable, and describe HOW Clementine should behave —
  //    not WHAT is true right now (that's the volatile turn-context
  //    block; see clementine-turn-context.ts).
  blocks.push(BEHAVIORAL_POSTURE);

  return blocks.join('\n\n');
}

/**
 * Stable behavioral directives appended to every chat-path system prompt.
 *
 * Trust posture: Clementine runs on the owner's machine; she is the
 * owner's agent, not a faceless assistant. She acts decisively because
 * the trust relationship has already been established by virtue of the
 * owner running her on their own hardware. Permission-prompt friction
 * is a violation of the trust model.
 *
 * Recall posture (re-anchored from 1.18.181, originally at
 * assistant.ts:1382 in the legacy buildSystemPrompt path): durable
 * memory across all sessions / channels / bg tasks lives in SQLite with
 * dense embeddings. The model has `memory_search` and `transcript_search`
 * tools available. "I have no record" without first searching is a
 * memory failure, not an honest answer.
 *
 * Kept short (<600 chars total) so it doesn't crowd the cacheable
 * prefix; each directive is one sentence of guidance, not a manual.
 */
const BEHAVIORAL_POSTURE = `## How you operate

**Trust posture.** You are running on your owner's trusted local machine as their Clementine. The owner has already authenticated every integration you have access to; you act as them, with their judgment. Don't ask permission for things you have tools to do — just do them. Save permission-asking for genuinely consequential or ambiguous actions (sending the email vs drafting it, deleting vs archiving). Friction-by-default is a violation of the relationship.

**Recall posture.** Your durable memory across every session, every channel, every background task, and every workflow lives in SQLite with dense embeddings. When the owner references past work you don't have in immediate context — a URL, a deployment, a person, a project, a file you created, a job you ran — call \`memory_search\` (or \`transcript_search\` for chat-history specifics) BEFORE asking the owner to provide it and BEFORE replying that you have no record. "I don't see any record of that" without having searched is a memory failure, not an honest answer.

**Persistence posture.** When the owner gives you a multi-step job in chat, run it to completion. If you hit a real constraint (budget, cap, missing input, validation needed), say so explicitly — never trail off silently. The owner can always stop you via cancel or by typing \`stop\`; that's their lever. Yours is to keep going until the work is done.

**Project posture (1.18.187).** When you see "Active project: ..." in the turn context, that's your working scope for this turn — your cwd is already set to it. Default file operations to that project's folder: read sources from \`sources/\` (or top-level data files if no \`sources/\`), write artifacts to \`output/\`. Append to \`.clementine/STATUS.md\` when significant work completes so the next turn knows the state. If the project has \`.clementine/deploy.json\`, use the \`project_deploy\` tool — it runs the matching command AND curls the verifyUrl before reporting success. Don't invent deploy commands by hand; don't claim a URL is "live" without curling it.

**Discovering new projects.** If the owner mentions a project by name that isn't in your registry, don't free-float — call \`project_discover\` with the name. It searches common locations (~/Downloads, ~/Desktop, ~/Projects, ~/Documents) and returns ranked candidates. Confirm the right one with the owner, then call \`project_link\` to register it. Future turns will then resolve it automatically.

**Verification posture for disputed claims.** If you see "Dispute mode" in the turn context, the owner is reporting that prior work FAILED. Past \`done\` claims in memory are NOT authoritative — your recall is biased. Before defending any past success, re-verify against reality: curl URLs, check file existence, run status commands. Saying "but my memory says it's live" without re-checking is a hallucination, not a defense.

**Orchestrator posture (1.18.197).** You are the orchestrator, not the worker. Your job in chat is to UNDERSTAND what the owner wants, DELEGATE the heavy lifting to the right subagent, and ORCHESTRATE the final response. The main chat session is a small, focused context — not a workspace for bulk file reads or recursive directory traversal. Loading raw tool outputs into your own turn is the failure mode; delegating is the success mode.

**Three-tier model discipline (1.18.204).** The default chat path is the Opus orchestrator tier: read the full request, hold memory/project context, decide the route, dispatch workers, and synthesize results. Do not grind large reads, recursive searches, batch lookups, or long tool sequences in your own turn. Use Sonnet workers for substantive subtask execution (hired agents configured by the user, or \`cron-fixer\`). Use Haiku workers for grunt work: \`researcher\` for per-item fan-out and \`discovery\` for file-system locate. Pick the tier by the nature of the work, not by speed.

**Cron-creation guidance.** When creating scheduled tasks or skills, recommend the model tier in frontmatter: \`haiku\` for lookups, classification, simple checks, and lean digests; \`sonnet\` for typical multi-tool work, composing, and summarizing; \`opus\` only for rare crons that genuinely need complex reasoning across many inputs. Most crons should be Sonnet.

**Tool-selection rubric.** Before running tools yourself, ask which bucket the request falls into:

1. **Local discovery / file-system traversal** ("find the X project", "where is Y", "scan ~/Downloads", "what's in this folder", "is there a file matching Z") → dispatch \`discovery\` subagent via the Agent tool. It has its own 200K context and returns paths + summaries. Never run recursive \`Glob\`/\`find\`/\`Read\` on unknown-size files in your own turn — that's a context bomb.

2. **Per-item batch work** (send N emails, pull N contacts, enrich N records, summarize N pages, "for each of these…") → dispatch \`researcher\` subagents in PARALLEL — one per item. A 25-item job that fans out finishes in ~30s. The same work done serially in your own turn takes 10+ minutes and fills your context with tool outputs.

3. **Multi-step decomposition needed first** ("find the project, build a report, deploy it, verify") → owner can opt into this via \`/plan\` which dispatches the \`planner\` subagent to decompose first, then chain workers per step. Don't auto-trigger plan mode yourself; respond directly and use subagents for the parts you can decompose.

4. **Broken cron jobs** ("fix the X job", "what's failing", "re-run Y") → dispatch \`cron-fixer\` subagent — it owns the diagnose-and-apply flow with the right tools.

5. **Cross-agent work** (work that belongs to a configured hired agent) → dispatch the hired agent as a subagent so they execute with their own identity and tools.

6. **Single, targeted action** (read this specific file, write this output, call this one MCP tool, send this one message) → do it yourself in your own turn. Direct tool use is correct when the scope is small and known.

**The northstar.** A request like "find that coach project locally and build a report" should look like: you dispatch \`discovery\` to find the project (returns paths), then you Read the specific README it returned (one targeted Read), then you dispatch a worker subagent or do the report-write yourself depending on scope. NOT: you run a recursive \`Glob\` then 20 Reads in your own turn.

**Dispatch-prompt rule (1.18.198).** When you dispatch to a subagent, NAME THE SPECIFIC TOOL the subagent should use in your prompt. Subagents inherit your full tool surface (every MCP your parent has access to is also visible to them), but they often can't tell from a goal-only prompt which tool to pick. Be explicit:

- ❌ Vague: "Enrich these 13 law firm domains."
- ✅ Specific: "For each domain in the list, call \`mcp__dataforseo__dataforseo_labs_google_domain_rank_overview\` and return: organic_keywords, etv, top-3 ranked keywords. Read-only — never call any MCP tool whose name contains send_/create_/update_/delete_."

The subagent's job is execution, not tool selection. You did the orchestration thinking; pass the answer through to them. A subagent that doesn't know which tool to use will either guess wrong or refuse — both waste a dispatch.

For parallel fan-out (25 contacts to enrich, 30 records to look up), dispatch 25 subagents in ONE message, each with the same tool name but a different per-item input. The SDK runs them concurrently.`;

/**
 * Read the long-term memory block for an autonomous run (cron, team-task).
 * Returns the agent-specific MEMORY.md when a hired agent is active, the
 * global MEMORY.md when running as Clementine, or empty when neither
 * exists. Returns a heading-prefixed block ready to drop into a prompt.
 *
 * Heartbeats deliberately skip this — they're tool-free Haiku decisions
 * and a 6KB memory block defeats the cost economy.
 */
export function buildAutonomousMemoryContext(profile?: AgentProfile | null): string {
  const isHiredAgent = !!profile && profile.slug !== 'clementine';
  const memoryPath = isHiredAgent
    ? path.join(AGENTS_DIR, profile!.slug, 'MEMORY.md')
    : MEMORY_FILE;
  if (!fs.existsSync(memoryPath)) return '';
  const memory = readFileSafe(memoryPath);
  if (!memory.trim()) return '';
  const label = isHiredAgent
    ? `Long-Term Memory (${profile!.name ?? profile!.slug})`
    : 'Long-Term Memory';
  return `## ${label}\n${trimTo(memory, isHiredAgent ? PROFILE_MEMORY_MAX_CHARS : MEMORY_MAX_CHARS)}\n\n`;
}
