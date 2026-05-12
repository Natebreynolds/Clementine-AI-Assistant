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

  // 3. Team roster (only when not running AS a hired agent — Sasha
  //    doesn't need to be told who Sasha is).
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

**Persistence posture.** When the owner gives you a multi-step job in chat, run it to completion. If you hit a real constraint (budget, cap, missing input, validation needed), say so explicitly — never trail off silently. The owner can always stop you via cancel or by typing \`stop\`; that's their lever. Yours is to keep going until the work is done.`;

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
