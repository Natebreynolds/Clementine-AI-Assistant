/**
 * chat-skill-resolver — match a chat message against the skill catalog,
 * extract the MCP servers / toolkits the matched skills imply, and
 * produce a system-prompt block listing them as "Relevant Skills."
 *
 * Why this exists (1.18.170)
 * ──────────────────────────
 * Before this module, the modern chat path (`router.ts → runAgent`) did
 * three things in order:
 *   1. Build extra MCP servers from `routeToolSurface(userText)` — a
 *      regex-bundle matcher over 19 fixed bundles in `tool-router.ts`.
 *   2. Build vault context (SOUL.md / MEMORY.md / AGENTS.md).
 *   3. Call runAgent with the assembled pieces.
 *
 * Step 1 has a fundamental gap: anything outside the 19 hardcoded
 * bundles (Salesforce, HubSpot, Asana, ClickUp, Airtable, an installed
 * CLI like `sf`) silently fails to route. The model gets no Salesforce
 * tools loaded even when the user just connected the Salesforce MCP.
 *
 * Clementine already auto-generates one skill per MCP tool whenever a
 * server's schema is fetched (`auto-skills.ts` → `~/.clementine/vault/
 * 00-System/skills/auto/<server>/<tool>.md`). Those auto-skills include
 * server-aware triggers ("salesforce", "my salesforce", "query records
 * salesforce", …) and a `mcp__<server>__<tool>` reference in their body.
 *
 * The legacy chat path (`assistant.ts:1487-1538`) already searched the
 * skill catalog and injected a "## Relevant Skill" block — but that
 * code lives in the deprecated PersonalAssistant.query() path. The
 * modern runAgent path skipped it entirely.
 *
 * This module ports + extends the legacy behavior:
 *   • Top-3 match aggregation (not just top-1) — handles category queries
 *     like "salesforce" where many tool-specific auto-skills match
 *     similarly. The parent sees all 3 bodies and picks the right tool.
 *   • Extracts `mcp__<server>__<tool>` references from every matched
 *     skill's body. Used to widen `buildExtraMcpForRunAgent` so the
 *     right Composio toolkits / claude.ai integrations load even though
 *     "Salesforce" isn't in the regex-bundle list.
 *   • Extracts `clementine.tools.allow` from user-authored skills (the
 *     auto-skills don't set this field but human-authored ones often do).
 *   • Auto-skills get a small penalty in `searchSkills` already (-0.5)
 *     so user-authored skills outrank them at parity — preserved here.
 *
 * Not a sandbox: we never *restrict* tools based on matched skills (the
 * SDK still receives the parent's full allowedTools). We only widen the
 * MCP server selection. Hard tool-scope enforcement happens via the
 * `runSkill` primitive (`run-skill.ts:300`), not chat.
 *
 * Failure mode: this module never throws. A match search that errors
 * (corrupt skill file, missing dir, etc.) returns empty results and the
 * caller proceeds with `routeToolSurface` alone — i.e. today's behavior.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import pino from 'pino';

import { searchSkills, type SkillMatch } from './skill-extractor.js';
import type { AgentProfile } from '../types.js';
import type { MemoryStore } from '../memory/store.js';

const logger = pino({ name: 'clementine.chat-skill-resolver' });

// ── Tunables ──────────────────────────────────────────────────────────

/** Default minimum score to consider a skill match real. Mirrors the
 *  legacy `assistant.ts:1492` threshold. Skill auto-match is heuristic;
 *  this filter keeps weak matches from injecting unrelated tooling. */
const DEFAULT_MIN_SCORE = 4;

/** Default top-K matches to aggregate. Single-tool requests usually
 *  return one strong match; category requests ("salesforce") return
 *  several similarly-scored auto-skills. Top-3 covers both. Raising
 *  this bloats the system prompt without much routing benefit. */
const DEFAULT_TOP_K = 3;

/** Cap per-skill body excerpt in the injected prompt. The full body is
 *  often a multi-KB args table for an MCP tool — fine if the user
 *  needs to look at it, wasteful for routing context. Mirrors
 *  `assistant.ts:1501` which sliced at 800 chars. */
const PER_SKILL_BODY_CHARS = 1000;

/** Same MCP_TOOL_REF pattern used in `run-skill.ts:153` / `tool-router.ts:172`.
 *  Matches `mcp__<server>__<tool>` references inside skill body text. */
const MCP_TOOL_REF = /mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__[A-Za-z0-9_-]+/g;

// ── Types ─────────────────────────────────────────────────────────────

export interface ResolveSkillsOptions {
  /** Active hired-agent profile, when set. Used for agent-scoped skill
   *  priority (matches the legacy boost). */
  profile?: AgentProfile | null;
  /** Optional memory store — used to read the user's suppression list
   *  ("never auto-match this skill again"). */
  memoryStore?: MemoryStore | null;
  /** Override the top-K aggregation cap. Defaults to 3. */
  limit?: number;
  /** Override the minimum match score. Defaults to 4. */
  minScore?: number;
}

export interface ResolvedSkillContext {
  /** Match records from searchSkills, filtered to those above minScore
   *  and capped at `limit`. Length 0 means no skill matched — the
   *  caller should fall back to today's behavior (regex bundles only). */
  matches: SkillMatch[];
  /** MCP server slugs referenced by any matched skill's body. Caller
   *  unions this with `route.externalMcpServers` and `route.composioToolkits`. */
  hintedMcpServers: string[];
  /** Tools declared under `clementine.tools.allow` on matched skills.
   *  Caller can use these to widen the SDK's `allowedTools` if the
   *  matched skill expects access beyond the chat default. */
  hintedTools: string[];
  /** Pre-rendered "## Relevant Skills" markdown block, ready to append
   *  to the system prompt. Empty when `matches.length === 0`. */
  promptBlock: string;
  /** Diagnostics for log/telemetry. */
  diagnostics: {
    queryChars: number;
    candidatesConsidered: number;
    matchesAboveThreshold: number;
    topScore: number;
    mcpRefsExtracted: number;
  };
}

// ── Skill discovery support ──────────────────────────────────────────

/**
 * Find a matched skill's frontmatter on disk. `SkillMatch` carries
 * `name` + `skillDir` but not the full frontmatter — and we need
 * `clementine.tools.allow` + the explicit `tool:` field from auto-skills.
 *
 * Walks `<skillDir>` looking for any file whose basename or folder
 * matches `name`. Returns null on any failure; the caller already has
 * the matched body content from searchSkills and that's enough for
 * MCP-ref extraction. The frontmatter read here is opportunistic.
 */
function readMatchFrontmatter(match: SkillMatch): Record<string, unknown> | null {
  // The match's `skillDir` is the SEARCH root. Auto-skills live nested
  // under `<skillDir>/auto/<server>/<tool>.md`; user skills can be flat
  // (`<skillDir>/<slug>.md`) or folder-form (`<skillDir>/<slug>/SKILL.md`).
  const slug = match.name;
  const candidates = [
    join(match.skillDir, `${slug}.md`),
    join(match.skillDir, slug, 'SKILL.md'),
  ];
  // For auto-skill slugs like `auto-dataforseo-…`, also try the nested
  // path that the slug encodes. This is a best-effort lookup; on miss
  // we just skip frontmatter and use the body alone.
  if (slug.startsWith('auto-')) {
    const parts = slug.slice(5).split('-');
    if (parts.length >= 2) {
      const server = parts[0];
      const rest = parts.slice(1).join('-');
      candidates.push(join(match.skillDir, 'auto', server, `${rest}.md`));
    }
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf-8');
      const parsed = matter(raw);
      return parsed.data as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Extract the `mcp__<server>__<tool>` server-name component from a
 *  match's body content + frontmatter. Returns the set of server slugs. */
function extractMcpServersFromMatch(match: SkillMatch): string[] {
  const servers = new Set<string>();

  // From body text — works for auto-skills (which list the tool name
  // in their "## Tool call" section) and user skills that paste tool
  // refs into their instructions.
  MCP_TOOL_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MCP_TOOL_REF.exec(match.content)) !== null) {
    servers.add(m[1]);
  }

  // From frontmatter — auto-skills have `tool: mcp__<server>__<name>` AND
  // `server: <name>` set explicitly. Either is authoritative.
  const fm = readMatchFrontmatter(match);
  if (fm) {
    if (typeof fm.server === 'string' && fm.server.trim()) {
      servers.add(fm.server.trim());
    }
    if (typeof fm.tool === 'string') {
      const mm = MCP_TOOL_REF.exec(fm.tool);
      if (mm) servers.add(mm[1]);
      MCP_TOOL_REF.lastIndex = 0;
    }
  }

  return [...servers];
}

/** Extract `clementine.tools.allow` from a match's frontmatter.
 *  Returns the list of declared tool names (or [] if none). */
function extractAllowedToolsFromMatch(match: SkillMatch): string[] {
  const fm = readMatchFrontmatter(match);
  if (!fm) return [];
  const clementine = (fm as { clementine?: { tools?: { allow?: unknown } } }).clementine;
  const allow = clementine?.tools?.allow;
  if (!Array.isArray(allow)) return [];
  return allow.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

// ── Prompt rendering ──────────────────────────────────────────────────

/**
 * Render the system-prompt block injected for the matched skills.
 * Single-match keeps the legacy `## Relevant Skill: <title>` shape;
 * multi-match nests them under `## Relevant Skills` with per-skill
 * subheadings. Tools-required warnings (legacy `assistant.ts:1504-1513`)
 * are NOT included here — they belong to the run-time tool policy
 * check, not the prompt context.
 */
function renderPromptBlock(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  if (matches.length === 1) {
    const s = matches[0];
    return `## Relevant Skill: ${s.title}\n\n${s.content.slice(0, PER_SKILL_BODY_CHARS)}`;
  }
  const parts: string[] = ['## Relevant Skills', ''];
  parts.push(`Top ${matches.length} skill matches for this request, ordered by relevance. ` +
    `Use these as a guide for which tools to call. If multiple skills suggest the same MCP server, ` +
    `prefer the highest-scored one's procedure.\n`);
  for (let i = 0; i < matches.length; i++) {
    const s = matches[i];
    parts.push(`### ${i + 1}. ${s.title}`, '');
    parts.push(s.content.slice(0, PER_SKILL_BODY_CHARS));
    parts.push('');
  }
  return parts.join('\n');
}

// ── Public entry point ────────────────────────────────────────────────

/**
 * Match a user message against the skill catalog and return the routing
 * hints + prompt block the chat path should layer on top of the static
 * `routeToolSurface` decision.
 *
 * Never throws — telemetry / matching errors degrade gracefully to
 * empty hints, and the caller proceeds with today's behavior.
 */
export function resolveSkillsForChat(
  userMessage: string,
  opts: ResolveSkillsOptions = {},
): ResolvedSkillContext {
  const queryChars = userMessage.length;
  const empty: ResolvedSkillContext = {
    matches: [],
    hintedMcpServers: [],
    hintedTools: [],
    promptBlock: '',
    diagnostics: {
      queryChars,
      candidatesConsidered: 0,
      matchesAboveThreshold: 0,
      topScore: 0,
      mcpRefsExtracted: 0,
    },
  };

  if (!userMessage || !userMessage.trim()) return empty;

  const limit = Math.max(1, opts.limit ?? DEFAULT_TOP_K);
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const suppressedNames = opts.memoryStore?.getSkillsToSuppress?.(opts.profile?.slug);

  let candidates: SkillMatch[] = [];
  try {
    candidates = searchSkills(
      userMessage,
      // Ask for a bit more than `limit` so we can filter by minScore and
      // still hit the cap when the distribution has a tail of weak hits.
      Math.max(limit + 2, 5),
      opts.profile?.slug,
      { ...(suppressedNames ? { suppressedNames } : {}) },
    );
  } catch (err) {
    logger.debug({ err }, 'chat-skill-resolver: searchSkills failed (non-fatal)');
    return empty;
  }

  const matches = candidates
    .filter((m) => m.score >= minScore)
    .slice(0, limit);

  if (matches.length === 0) {
    return {
      ...empty,
      diagnostics: {
        queryChars,
        candidatesConsidered: candidates.length,
        matchesAboveThreshold: 0,
        topScore: candidates[0]?.score ?? 0,
        mcpRefsExtracted: 0,
      },
    };
  }

  const mcpServerSet = new Set<string>();
  const toolSet = new Set<string>();
  for (const m of matches) {
    for (const s of extractMcpServersFromMatch(m)) mcpServerSet.add(s);
    for (const t of extractAllowedToolsFromMatch(m)) toolSet.add(t);
  }

  const result: ResolvedSkillContext = {
    matches,
    hintedMcpServers: [...mcpServerSet],
    hintedTools: [...toolSet],
    promptBlock: renderPromptBlock(matches),
    diagnostics: {
      queryChars,
      candidatesConsidered: candidates.length,
      matchesAboveThreshold: matches.length,
      topScore: matches[0].score,
      mcpRefsExtracted: mcpServerSet.size,
    },
  };

  logger.info({
    matches: matches.map(m => ({ name: m.name, score: Number(m.score.toFixed(2)) })),
    hintedMcpServers: result.hintedMcpServers,
    hintedToolCount: result.hintedTools.length,
    queryChars,
  }, 'chat-skill-resolver: skills matched');

  return result;
}

// Re-export the helpers so tests can target them directly.
export { extractMcpServersFromMatch, extractAllowedToolsFromMatch, renderPromptBlock };

// Silence lint for the dirname import — kept for future use when the
// matcher needs the parent folder of a matched skill (e.g. to surface
// bundled attachments in the prompt). Removing the import would be a
// pre-emptive cleanup but the file is already tagged for follow-up work.
void dirname;
