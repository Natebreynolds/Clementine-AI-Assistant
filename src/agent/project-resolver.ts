/**
 * project-resolver — match natural-language project mentions to the
 * Clementine project registry, and discover filesystem candidates when
 * the registry has no match.
 *
 * Why this exists (1.18.187)
 * ──────────────────────────
 * Linked projects live in `~/.clementine/projects.json` (see
 * `assistant.ts:findProjectByName / getLinkedProjects`). Until now the
 * only way a chat turn could "enter" a project was via Discord's
 * `!project <name>` slash command — which most owners never used.
 *
 * Result: when an owner said "the coaches project, build me an HTML
 * report," Clementine had no anchor. She free-floated, overflowed
 * context, and (in the 2026-05-11 audit) hallucinated a deploy URL.
 *
 * This module gives the chat path two new capabilities:
 *  1. **Auto-resolve** a project from the user's message by fuzzy-
 *     matching against the registry. Fires every chat turn; if it
 *     matches, the session's project is set for this turn so cwd,
 *     additionalDirectories, and the turn-context block all anchor
 *     to the project root.
 *  2. **Discover** filesystem candidates when the message mentions a
 *     project name that ISN'T in the registry. Surfaces "I found
 *     /Users/.../Downloads/coaches/ — link it as a project?" so the
 *     owner can register a new project without leaving chat. The chat
 *     agent then calls `project_link` to add it.
 *
 * Pure functions where possible; filesystem discovery is the only
 * I/O. Safe to call from any layer that has a sessionKey.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectMeta } from './assistant.js';
import { getLinkedProjects } from './assistant.js';

// ── Configuration ────────────────────────────────────────────────────

/**
 * Minimum confidence (0..1) for auto-resolve to claim a match.
 * Below this the resolver returns null and the chat path falls back
 * to either filesystem discovery (Part G) or no-project mode.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Default filesystem search roots for project discovery. The user's
 * home directory plus the four most common project parking spots.
 * Skipped on each: known system folders, hidden dirs, irrelevant
 * macOS chrome.
 */
export const DEFAULT_DISCOVERY_ROOTS = [
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Projects'),
];

/** Skip these folder names when scanning for candidates. */
const DISCOVERY_IGNORE = new Set([
  'node_modules', '.git', '.DS_Store', 'Library', 'Applications',
  '.npm', '.cache', '.Trash', '.config', '.local', '.cargo',
  '.rustup', '.nvm', '.cursor', '.claude', '.clementine',
  'iCloud Drive', 'Pictures', 'Music', 'Movies', 'Public',
]);

// ── Public API: registry resolution ──────────────────────────────────

export interface ProjectMatch {
  project: ProjectMeta;
  /** 0..1 confidence score. Above DEFAULT_MIN_CONFIDENCE = strong match. */
  confidence: number;
  /** Which field of the project record matched. */
  matchedVia: 'name' | 'keyword' | 'path-basename' | 'description';
  /** The term in the user message that triggered the match (truncated). */
  matchedTerm: string;
}

/**
 * Resolve a project from a natural-language message by fuzzy-matching
 * against the registry. Returns the highest-confidence match above
 * the threshold, or null if no match qualifies.
 *
 * Matching strategy (ranked highest to lowest):
 *   1. Exact keyword (or keyword prefix) in message: 0.95
 *   2. Path basename whole-word in message: 0.90
 *   3. Quoted project name in message: 0.85
 *   4. Path basename substring (3+ chars) in message: 0.70
 *   5. Description significant word in message: 0.55
 *
 * The match must clear `minConfidence` to be returned. Defaults to
 * DEFAULT_MIN_CONFIDENCE = 0.6 so substring-only and description-only
 * matches don't fire (too noisy).
 */
export function resolveProjectFromMessage(
  message: string,
  opts: { minConfidence?: number; projects?: ProjectMeta[] } = {},
): ProjectMatch | null {
  const projects = opts.projects ?? getLinkedProjects();
  if (projects.length === 0 || !message || !message.trim()) return null;

  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const msgLower = message.toLowerCase();
  // Tokenize once for whole-word checks.
  const msgWords = new Set(
    msgLower.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean),
  );

  let best: ProjectMatch | null = null;
  for (const project of projects) {
    const basename = path.basename(project.path).toLowerCase();
    const keywords = (project.keywords ?? []).map((k) => k.toLowerCase());
    const description = (project.description ?? '').toLowerCase();

    // 1. Exact keyword (whole word, multi-word phrase, or quoted) — 0.95
    for (const kw of keywords) {
      if (!kw) continue;
      // Single-word keywords: whole-word match (matches "coaches" in
      // "the coaches project" but not "coaches" in "approaches").
      // Multi-word keywords (e.g., "seo audit"): word-boundary substring
      // match against the whole message (since they can't appear in
      // msgWords as a single token).
      const hasMultipleWords = /\s/.test(kw);
      const matchedWholeWord = !hasMultipleWords && msgWords.has(kw);
      const matchedPhrase = hasMultipleWords
        && new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i').test(msgLower);
      const matchedQuoted = msgLower.includes(`"${kw}"`);
      if (matchedWholeWord || matchedPhrase || matchedQuoted) {
        if (!best || best.confidence < 0.95) {
          best = { project, confidence: 0.95, matchedVia: 'keyword', matchedTerm: kw };
        }
      }
    }
    // 2. Path basename whole-word — 0.90
    if (msgWords.has(basename)) {
      if (!best || best.confidence < 0.90) {
        best = { project, confidence: 0.90, matchedVia: 'path-basename', matchedTerm: basename };
      }
    }
    // 3. Quoted project basename — 0.85
    if (msgLower.includes(`"${basename}"`)) {
      if (!best || best.confidence < 0.85) {
        best = { project, confidence: 0.85, matchedVia: 'path-basename', matchedTerm: basename };
      }
    }
    // 4. Substring (3+ chars) in basename — 0.70
    if (basename.length >= 3 && msgLower.includes(basename)) {
      // Already covered by whole-word above; this catches hyphenated
      // names like "track-coaches" referenced as "track-coaches".
      const score = 0.70;
      if (!best || best.confidence < score) {
        best = { project, confidence: score, matchedVia: 'path-basename', matchedTerm: basename };
      }
    }
    // 5. Description significant words — 0.55 (rarely wins)
    for (const word of description.split(/\s+/)) {
      if (word.length < 4) continue;
      if (msgWords.has(word)) {
        const score = 0.55;
        if (!best || best.confidence < score) {
          best = { project, confidence: score, matchedVia: 'description', matchedTerm: word };
        }
        break; // one description hit is enough
      }
    }
  }

  if (!best) return null;
  return best.confidence >= minConfidence ? best : null;
}

// ── Public API: filesystem discovery ─────────────────────────────────

export interface DiscoveryCandidate {
  path: string;
  basename: string;
  /** Levenshtein/contains score against the search term (0..1). */
  nameScore: number;
  /** Recency of last modification (0..1, 1 = today, 0 = >90 days old). */
  recencyScore: number;
  /** Content shape score (0..1) — does it look like a project? */
  contentScore: number;
  /** Composite (weighted sum, 0..1). */
  totalScore: number;
  /** Human-readable summary of what's inside. */
  contentSummary: string;
}

/**
 * Search the filesystem for folders that could plausibly be the
 * project the user is mentioning. Used when the registry has no match.
 *
 * 1.18.189 — search order:
 *   1. Spotlight (`mdfind`) on macOS — instant, system-indexed,
 *      finds folders ANYWHERE on disk by name. Critical when the
 *      project is at depth 2+ ("~/Documents/Work/team-coaches")
 *      or the owner only knows part of the name.
 *   2. Direct walk of DEFAULT_DISCOVERY_ROOTS (depth 1) — fallback
 *      for non-macOS and edge cases where Spotlight is disabled.
 *
 * Returns candidates sorted by composite score (best first). The
 * caller — typically the chat agent via the `project_discover` tool —
 * inspects the list and decides whether to ask the owner for
 * confirmation before calling `project_link`.
 *
 * Conservative by design: no candidate auto-links. The owner always
 * confirms.
 */
export function discoverProjectCandidates(
  searchTerm: string,
  opts: { searchRoots?: string[]; maxResults?: number; nowMs?: number; disableSpotlight?: boolean } = {},
): DiscoveryCandidate[] {
  const term = String(searchTerm ?? '').trim().toLowerCase();
  if (!term) return [];

  const roots = opts.searchRoots ?? DEFAULT_DISCOVERY_ROOTS;
  const maxResults = opts.maxResults ?? 5;
  const nowMs = opts.nowMs ?? Date.now();

  const candidates: DiscoveryCandidate[] = [];
  const seen = new Set<string>();

  const consider = (full: string): void => {
    if (seen.has(full)) return;
    seen.add(full);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { return; }
    if (!stat.isDirectory()) return;
    const basename = path.basename(full).toLowerCase();
    if (DISCOVERY_IGNORE.has(path.basename(full))) return;
    if (basename.startsWith('.')) return;
    // Skip anything under our own ignore roots even if Spotlight indexed them.
    if (/\/(node_modules|\.git|Library|\.cache|\.Trash)\//.test(full)) return;

    const nameScore = computeNameScore(basename, term);
    if (nameScore === 0) return;
    const recencyScore = computeRecencyScore(stat.mtimeMs, nowMs);
    const { score: contentScore, summary: contentSummary } = computeContentScore(full);
    const totalScore = 0.6 * nameScore + 0.25 * contentScore + 0.15 * recencyScore;
    candidates.push({
      path: full,
      basename: path.basename(full),
      nameScore,
      recencyScore,
      contentScore,
      totalScore,
      contentSummary,
    });
  };

  // ── 1. Spotlight (macOS) ─────────────────────────────────────────
  if (!opts.disableSpotlight && process.platform === 'darwin') {
    try {
      const spotlightHits = mdfindFolders(term);
      for (const full of spotlightHits) consider(full);
    } catch {
      // Spotlight unavailable / disabled — fall through to walk.
    }
  }

  // ── 2. Direct walk of standard roots (depth 1) ───────────────────
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (DISCOVERY_IGNORE.has(entry)) continue;
      consider(path.join(root, entry));
    }
  }

  candidates.sort((a, b) => b.totalScore - a.totalScore);
  return candidates.slice(0, maxResults);
}

/**
 * Run `mdfind` to find folders whose name matches the search term.
 * macOS only. Returns absolute paths. Limits result count + total
 * runtime so a vague query can't hang the agent.
 */
function mdfindFolders(term: string): string[] {
  // kMDItemDisplayName — folder name as Finder shows it
  // kMDItemContentTypeTree includes "public.folder" — restricts to folders
  // The query: name contains term (case-insensitive) AND is a folder.
  // Escape double quotes in the term defensively.
  const safe = term.replace(/["\\]/g, '');
  if (!safe) return [];
  const query = `kMDItemDisplayName == "*${safe}*"cd && kMDItemContentTypeTree == "public.folder"`;
  try {
    const out = execSync(`mdfind '${query}' 2>/dev/null | head -40`, {
      timeout: 4_000,
      maxBuffer: 256 * 1024,
      encoding: 'utf-8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Scoring helpers ──────────────────────────────────────────────────

function computeNameScore(basename: string, term: string): number {
  // Exact match: 1.0
  if (basename === term) return 1.0;
  // Whole-word substring (term appears with word boundaries inside basename):
  const wbRegex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
  if (wbRegex.test(basename)) return 0.85;
  // Substring: 0.6
  if (basename.includes(term) || term.includes(basename)) return 0.6;
  // Partial token overlap (hyphenated names like "track-coaches" vs "coaches")
  const basenameTokens = new Set(basename.split(/[-_\s]+/).filter(Boolean));
  const termTokens = term.split(/[-_\s]+/).filter(Boolean);
  const matchingTokens = termTokens.filter((t) => basenameTokens.has(t));
  if (matchingTokens.length > 0) {
    return 0.4 * (matchingTokens.length / termTokens.length);
  }
  return 0;
}

function computeRecencyScore(mtimeMs: number, nowMs: number): number {
  const ageDays = (nowMs - mtimeMs) / (24 * 60 * 60 * 1000);
  if (ageDays < 1) return 1.0;
  if (ageDays < 7) return 0.8;
  if (ageDays < 30) return 0.5;
  if (ageDays < 90) return 0.25;
  return 0.05;
}

interface ContentScoreResult {
  score: number;
  summary: string;
}

function computeContentScore(dir: string): ContentScoreResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { score: 0, summary: 'unreadable' };
  }

  // Cheap heuristics: presence of data files, README, code, project markers.
  const csvCount = entries.filter((e) => /\.(csv|tsv|json|yaml|yml)$/i.test(e.name)).length;
  const codeCount = entries.filter((e) => /\.(js|ts|py|rb|go|rs|md|html|css)$/i.test(e.name)).length;
  const dataCount = entries.filter((e) => /\.(xlsx|xls|pdf|txt|docx)$/i.test(e.name)).length;
  const hasReadme = entries.some((e) => /^readme(\.md|\.txt)?$/i.test(e.name));
  const hasProjectMarker = entries.some((e) =>
    /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|\.clementine|\.git)$/i.test(e.name),
  );
  const totalFiles = entries.filter((e) => e.isFile()).length;
  const subDirs = entries.filter((e) => e.isDirectory() && !DISCOVERY_IGNORE.has(e.name)).length;

  // Score: presence of recognizable content shape.
  let score = 0;
  if (csvCount > 0) score += 0.4;
  if (codeCount > 0) score += 0.3;
  if (dataCount > 0) score += 0.2;
  if (hasReadme) score += 0.2;
  if (hasProjectMarker) score += 0.3;
  if (totalFiles + subDirs === 0) score -= 0.5; // empty folder
  score = Math.max(0, Math.min(1, score));

  // Human-readable summary.
  const parts: string[] = [];
  if (csvCount > 0) parts.push(`${csvCount} data file${csvCount === 1 ? '' : 's'}`);
  if (codeCount > 0) parts.push(`${codeCount} code/doc file${codeCount === 1 ? '' : 's'}`);
  if (hasProjectMarker) parts.push('project marker');
  if (hasReadme) parts.push('README');
  if (subDirs > 0) parts.push(`${subDirs} subfolder${subDirs === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push(totalFiles === 0 ? 'empty' : `${totalFiles} files`);

  return { score, summary: parts.join(', ') };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Dispute detection ───────────────────────────────────────────────

/**
 * Heuristic: does the user message indicate they're disputing prior
 * work? Used by the turn-context builder (Part E) to gate out
 * past-success memory recall when the owner is reporting a failure.
 *
 * The regex requires the dispute words to co-occur with action verbs
 * or state references — "I'm not finding the right approach" doesn't
 * trigger; "site not found", "didn't deploy", "still broken" do.
 */
export function detectDisputePattern(message: string): boolean {
  if (!message) return false;
  const m = String(message).toLowerCase();
  // Pattern: a dispute marker near an action/state word.
  // Conservative: requires explicit failure markers.
  const patterns = [
    /\bnot\s+(found|working|live|there|deployed?|loaded|uploaded?)\b/,
    /\bisn['']?t\s+(there|working|live|loading|deployed?|loaded)\b/,
    /\bdoesn['']?t\s+(work|deploy|load|run|exist)\b/,
    /\bdidn['']?t\s+(work|deploy|run|happen|load|upload)\b/,
    /\bstill\s+(not|failing|broken|down|404)\b/,
    /\b404\b|404[a-z]/i,
    /\bbroken\b/,
    /\bsays?\s+(site\s+not\s+found|not\s+found)\b/,
  ];
  return patterns.some((rx) => rx.test(m));
}
