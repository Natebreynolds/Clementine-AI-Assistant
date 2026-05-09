/**
 * Manual skill suppression list — 1.18.127.
 *
 * Complements the automatic feedback-driven suppression in
 * `MemoryStore.getSkillsToSuppress` (which suppresses skills that
 * accumulate ≥3 negative ratings with >50% negative rate in the last 60
 * days). This file owns the *manual* list — what the user explicitly
 * toggles in the dashboard ("don't ever auto-match this skill again").
 *
 * Storage: a single JSON file at `~/.clementine/skill-suppressions.json`
 * with the shape:
 *
 *   {
 *     "global": ["my-buggy-skill", "stale-procedure"],
 *     "ross-the-sdr": ["sasha-only-skill"]
 *   }
 *
 * Merged with the auto-suppression set inside `buildSkillContext` so
 * the runtime sees one combined Set<string>. No schema migration; missing
 * file = empty list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolve lazily on each call so test environments (which override
// CLEMENTINE_HOME inside beforeEach) see the fresh value rather than
// the value snapshot at module-load time.
function baseDir(): string {
  return process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
}
function suppressionsPath(): string {
  return path.join(baseDir(), 'skill-suppressions.json');
}

export interface SuppressionFile {
  /** Global suppressions apply to every agent (Clementine + every hired agent). */
  global: string[];
  /** Per-agent suppressions apply only when the named agent is running. */
  [agentSlug: string]: string[];
}

function readFile(): SuppressionFile {
  const filePath = suppressionsPath();
  if (!existsSync(filePath)) return { global: [] };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { global: [] };
    const out: SuppressionFile = { global: Array.isArray(raw.global) ? raw.global.map(String) : [] };
    for (const key of Object.keys(raw)) {
      if (key === 'global') continue;
      if (Array.isArray(raw[key])) out[key] = (raw[key] as unknown[]).map(String);
    }
    return out;
  } catch {
    return { global: [] };
  }
}

function writeFile(data: SuppressionFile): void {
  const dir = baseDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(suppressionsPath(), JSON.stringify(data, null, 2));
}

/**
 * Read the merged set of manually suppressed skill names for a given
 * agent context. Includes the global list always; adds the agent-specific
 * list when `agentSlug` is provided.
 */
export function getManualSuppressions(agentSlug?: string | null): Set<string> {
  const data = readFile();
  const merged = new Set<string>(data.global ?? []);
  if (agentSlug && Array.isArray(data[agentSlug])) {
    for (const name of data[agentSlug]) merged.add(name);
  }
  return merged;
}

/** List the full suppression file as the dashboard sees it. */
export function listAllSuppressions(): SuppressionFile {
  return readFile();
}

/**
 * Toggle a skill's suppression state for a given scope. Returns the
 * resulting per-scope list so the UI can re-render without a refetch.
 *
 * - `scope === 'global'` writes to `data.global`
 * - any other scope value treats it as an agent slug
 */
export function setSuppression(
  skillName: string,
  scope: string,
  suppressed: boolean,
): { scope: string; list: string[] } {
  const data = readFile();
  const key = scope === 'global' ? 'global' : scope;
  const list = new Set(Array.isArray(data[key]) ? data[key] : []);
  if (suppressed) list.add(skillName);
  else list.delete(skillName);
  data[key] = [...list].sort();
  writeFile(data);
  return { scope: key, list: data[key] };
}
