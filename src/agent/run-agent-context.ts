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

  // 1. Soul (personality + voice)
  const soul = readFileSafe(SOUL_FILE);
  if (soul.trim()) {
    blocks.push(`## Identity & Voice\n${trimTo(soul, SOUL_MAX_CHARS)}`);
  }

  // 2. Long-term memory — agent-specific file overrides the global one.
  const profileMemoryPath = opts.profile?.slug
    ? path.join(AGENTS_DIR, opts.profile.slug, 'MEMORY.md')
    : null;
  let memory = '';
  if (profileMemoryPath && fs.existsSync(profileMemoryPath)) {
    memory = readFileSafe(profileMemoryPath);
    if (memory.trim()) {
      blocks.push(`## Long-Term Memory (${opts.profile?.name ?? opts.profile?.slug})\n${trimTo(memory, PROFILE_MEMORY_MAX_CHARS)}`);
    }
  } else {
    memory = readFileSafe(MEMORY_FILE);
    if (memory.trim()) {
      blocks.push(`## Long-Term Memory\n${trimTo(memory, MEMORY_MAX_CHARS)}`);
    }
  }

  // 3. Team roster (only when not running AS a hired agent — Sasha
  //    doesn't need to be told who Sasha is).
  if (!opts.profile) {
    const agentsRoster = readFileSafe(AGENTS_FILE);
    if (agentsRoster.trim()) {
      blocks.push(`## Team Roster\n${trimTo(agentsRoster, AGENTS_MAX_CHARS)}`);
    }
  }

  // 4. Profile system prompt body (e.g. Sasha's role description).
  if (opts.profileAppend?.trim()) {
    blocks.push(opts.profileAppend);
  }

  return blocks.join('\n\n');
}
