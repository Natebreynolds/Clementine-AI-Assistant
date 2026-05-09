/**
 * Schedule registry — 1.18.129.
 *
 * The Anthropic-pure architectural shift: skills stay vanilla SKILL.md
 * folders, scheduling lives in a separate tiny registry. Today's "fat
 * cron" model in CRON.md duplicated ~70% of the skill schema (prompt,
 * tools, MCP allowlists, work_dir, success criteria); this registry
 * replaces all that with a thin {skillName → schedule} map.
 *
 * Storage: a single JSON file at `~/.clementine/schedules.json` with
 * the shape:
 *
 *   {
 *     "morning-briefing": {
 *       "schedule": "0 7 * * 1-5",
 *       "enabled": true,
 *       "agentSlug": null,
 *       "addedAt": "2026-05-08T...",
 *       "lastModifiedAt": "2026-05-08T..."
 *     }
 *   }
 *
 * The cron scheduler reads this alongside CRON.md and emits one
 * CronJobDefinition per scheduled skill. The runtime path is unchanged
 * — the skill body becomes the prompt via the existing buildSkillContext
 * pipeline, no special case.
 *
 * Coexists with CRON.md indefinitely. Both formats run today; new work
 * goes through this registry. Phase 3 ships the migrator that converts
 * legacy crons to scheduled skills.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolve lazily on each call so test environments (which override
// CLEMENTINE_HOME inside beforeEach) see the fresh value rather than the
// value snapshot at module-load time. Mirrors skill-suppressions.ts.
function baseDir(): string {
  return process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
}
function schedulesPath(): string {
  return path.join(baseDir(), 'schedules.json');
}

export interface ScheduleEntry {
  /** Skill slug — must match a skill in the catalog. The runtime auto-pins
   *  this skill, so its body becomes the prompt at fire-time. */
  skillName: string;
  /** Cron expression. Empty / falsy = no auto-fire (still appears on
   *  Tasks page so the user can edit it). */
  schedule: string;
  /** When false the scheduler skips it. Lets users pause without losing
   *  the schedule definition. */
  enabled: boolean;
  /** When set, the skill runs as the named hired agent (Sasha, Ross,
   *  Nora, etc.). null/undefined = Clementine. Per-agent skills load
   *  from `agents/<slug>/skills/` first; the runtime resolves precedence. */
  agentSlug?: string | null;
  /** ISO timestamp of when the schedule was first created. */
  addedAt?: string;
  /** ISO timestamp of the last edit. */
  lastModifiedAt?: string;
}

/** On-disk shape — keyed by skill name for O(1) lookup + simple merge. */
export type ScheduleFile = Record<string, Omit<ScheduleEntry, 'skillName'>>;

function readFile(): ScheduleFile {
  const filePath = schedulesPath();
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ScheduleFile = {};
    for (const [name, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      // Tolerate partially-populated entries (a hand-edited file might
      // have only `schedule` set). Default everything else.
      out[name] = {
        schedule: typeof e.schedule === 'string' ? e.schedule : '',
        enabled: e.enabled !== false, // default true
        agentSlug: typeof e.agentSlug === 'string' ? e.agentSlug : null,
        addedAt: typeof e.addedAt === 'string' ? e.addedAt : undefined,
        lastModifiedAt: typeof e.lastModifiedAt === 'string' ? e.lastModifiedAt : undefined,
      };
    }
    return out;
  } catch {
    // Malformed JSON — never throw out of the registry. Worst case the
    // user re-creates entries via the UI; their CRON.md jobs keep firing.
    return {};
  }
}

function writeFile(data: ScheduleFile): void {
  const dir = baseDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Sorted keys → deterministic on disk → friendly to git users who
  // version-control their ~/.clementine/.
  const sorted: ScheduleFile = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  writeFileSync(schedulesPath(), JSON.stringify(sorted, null, 2));
}

/**
 * Read every schedule entry as a flat array. Each entry includes its
 * skill name so callers don't have to reconstruct it.
 */
export function listSchedules(): ScheduleEntry[] {
  const file = readFile();
  return Object.entries(file).map(([skillName, entry]) => ({ skillName, ...entry }));
}

/** Read one entry by skill name. Returns null when not scheduled. */
export function getSchedule(skillName: string): ScheduleEntry | null {
  const file = readFile();
  const entry = file[skillName];
  if (!entry) return null;
  return { skillName, ...entry };
}

export interface SetScheduleInput {
  schedule: string;
  enabled?: boolean;
  agentSlug?: string | null;
}

/**
 * Upsert a schedule for a skill. New entries get `addedAt`; existing
 * entries get `lastModifiedAt` updated. Returns the resulting entry so
 * the dashboard can re-render without a re-fetch.
 */
export function setSchedule(skillName: string, input: SetScheduleInput): ScheduleEntry {
  if (!skillName || typeof skillName !== 'string') {
    throw new Error('setSchedule: skillName required');
  }
  const file = readFile();
  const existing = file[skillName];
  const now = new Date().toISOString();
  const entry: Omit<ScheduleEntry, 'skillName'> = {
    schedule: input.schedule ?? '',
    enabled: input.enabled !== false,
    agentSlug: input.agentSlug ?? null,
    addedAt: existing?.addedAt ?? now,
    lastModifiedAt: now,
  };
  file[skillName] = entry;
  writeFile(file);
  return { skillName, ...entry };
}

/** Drop the entry for a skill. No-op when nothing is scheduled. */
export function removeSchedule(skillName: string): void {
  const file = readFile();
  if (!(skillName in file)) return;
  delete file[skillName];
  writeFile(file);
}

/** Toggle the enabled flag. Skill stays in the registry; just won't
 *  fire while disabled. Caller-side convenience to avoid re-passing
 *  schedule + agentSlug just to flip the boolean. */
export function enableSchedule(skillName: string, enabled: boolean): ScheduleEntry | null {
  const file = readFile();
  const entry = file[skillName];
  if (!entry) return null;
  entry.enabled = enabled;
  entry.lastModifiedAt = new Date().toISOString();
  file[skillName] = entry;
  writeFile(file);
  return { skillName, ...entry };
}
