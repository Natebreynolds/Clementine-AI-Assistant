/**
 * Skill store — Phase A (read-only) of the Skills-First redesign.
 *
 * Discovers skill .md files from two locations and parses their
 * frontmatter into the Skill type. Phase A surfaces what's already on
 * disk; Phase B adds editing + testing; Phase C wires runtime invocation.
 *
 * Discovery order:
 *   1. ~/.clementine/vault/00-System/skills/<name>.md  (global)
 *   2. <work_dir>/.clementine/skills/<name>.md         (per-project)
 *
 * Per-project files win on name collision — they override global skills
 * for that project. The dashboard surfaces both pools and tags each
 * skill with its scope so the user can see which one will resolve.
 *
 * Schema detection: a file is `v1` when its frontmatter declares any of
 * inputs / tools.allow / tools.deny / dataSources / stateKeys / success.
 * Otherwise (only legacy fields like title / triggers / toolsUsed) it's
 * `legacy` and the dashboard shows a migration badge.
 *
 * Used-by join: Phase A reads the `skills:` array on CronJobDefinition
 * (the existing field) to populate Skill.usedByTriggers. Phase C will
 * extend this to read the new top-level `skill:` field on the trigger.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import type {
  Skill,
  SkillFrontmatter,
  SkillScope,
  SkillSchemaVersion,
  SkillToolPolicy,
  SkillSuccess,
  SkillLimits,
  SkillDataSource,
  SkillInputSchema,
  CronJobDefinition,
} from '../types.js';

/** Resolve the global skills directory from CLEMENTINE_HOME (or default). */
function globalSkillsDir(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
  return path.join(base, 'vault', '00-System', 'skills');
}

/** Resolve a per-project skills directory. Returns null if work_dir is
 *  empty or doesn't have a .clementine/skills/ child. */
function projectSkillsDir(workDir: string | undefined): string | null {
  if (!workDir) return null;
  const dir = path.join(workDir, '.clementine', 'skills');
  return existsSync(dir) ? dir : null;
}

/** Strip backup files (.bak), hidden files, and directories. */
function isSkillFile(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (!name.endsWith('.md')) return false;
  if (name.endsWith('.bak')) return false;
  if (name.endsWith('.bak.md')) return false;
  return true;
}

/** Skill name is the filename without extension. We don't trust the
 *  frontmatter's `name:` field as the canonical identifier because
 *  different files could collide on it; the filename is what the loader
 *  joins on. The frontmatter `name:` is preserved as a display alias. */
function nameFromFile(file: string): string {
  return path.basename(file, '.md');
}

/** Detect whether a frontmatter object uses the v1 schema or the
 *  pre-redesign legacy shape. Phase A renders this as a badge so users
 *  can see which skills need migration in Phase B. */
function detectSchemaVersion(fm: Record<string, unknown>): SkillSchemaVersion {
  const v1Markers = ['inputs', 'dataSources', 'stateKeys', 'success', 'limits'];
  if (v1Markers.some((k) => k in fm)) return 'v1';
  const tools = fm.tools as Record<string, unknown> | undefined;
  if (tools && (Array.isArray(tools.allow) || Array.isArray(tools.deny))) return 'v1';
  return 'legacy';
}

/** Coerce a parsed YAML object into the SkillFrontmatter shape. We
 *  accept both the v1 fields and the legacy fields side-by-side; the
 *  caller's schemaVersion check tells the dashboard which is which. */
function coerceFrontmatter(raw: Record<string, unknown>, fileBasename: string): SkillFrontmatter {
  const fm: SkillFrontmatter = {
    // Identifier — ALWAYS the filename (without .md). The frontmatter's
    // `name:` field is intentionally ignored to avoid two skills colliding
    // on it. Users wanting a friendly display string can set `title:`
    // instead, which Phase B's editor surfaces as the heading.
    name: fileBasename,
  };
  if (typeof raw.description === 'string') fm.description = raw.description;
  // v1 inputs — JSON Schema map keyed by field name.
  if (raw.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs)) {
    fm.inputs = raw.inputs as Record<string, SkillInputSchema>;
  }
  // tools.allow / tools.deny
  if (raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)) {
    const t = raw.tools as Record<string, unknown>;
    const policy: SkillToolPolicy = {};
    if (Array.isArray(t.allow)) policy.allow = t.allow.map(String);
    if (Array.isArray(t.deny)) policy.deny = t.deny.map(String);
    if (policy.allow || policy.deny) fm.tools = policy;
  }
  if (Array.isArray(raw.dataSources)) {
    fm.dataSources = raw.dataSources
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      .map((d) => ({
        kind: String(d.kind || 'unknown'),
        purpose: String(d.purpose || ''),
      } as SkillDataSource));
  }
  if (Array.isArray(raw.stateKeys)) fm.stateKeys = raw.stateKeys.map(String);
  if (raw.success && typeof raw.success === 'object' && !Array.isArray(raw.success)) {
    const s = raw.success as Record<string, unknown>;
    const success: SkillSuccess = {};
    if (s.schema && typeof s.schema === 'object') success.schema = s.schema as SkillInputSchema;
    if (typeof s.criterion === 'string') success.criterion = s.criterion;
    if (success.schema || success.criterion) fm.success = success;
  }
  if (raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits)) {
    const l = raw.limits as Record<string, unknown>;
    const limits: SkillLimits = {};
    if (typeof l.maxTurns === 'number') limits.maxTurns = l.maxTurns;
    if (typeof l.maxBudgetUsd === 'number') limits.maxBudgetUsd = l.maxBudgetUsd;
    if (typeof l.timeoutSeconds === 'number') limits.timeoutSeconds = l.timeoutSeconds;
    if (Object.keys(limits).length > 0) fm.limits = limits;
  }
  if (typeof raw.version === 'number') fm.version = raw.version;
  if (typeof raw.createdAt === 'string') fm.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === 'string') fm.updatedAt = raw.updatedAt;
  if (typeof raw.lastUsed === 'string') fm.lastUsed = raw.lastUsed;
  if (typeof raw.lastTestPass === 'string') fm.lastTestPass = raw.lastTestPass;
  // Legacy fields (preserved as-is for the migration UI).
  if (typeof raw.title === 'string') fm.title = raw.title;
  if (Array.isArray(raw.triggers)) fm.triggers = raw.triggers.map(String);
  if (typeof raw.source === 'string') fm.source = raw.source;
  if (Array.isArray(raw.toolsUsed)) fm.toolsUsed = raw.toolsUsed.map(String);
  if (typeof raw.useCount === 'number') fm.useCount = raw.useCount;
  return fm;
}

interface ParseResult {
  skill: Skill;
  /** Set when the file existed but couldn't be parsed (bad YAML, etc.).
   *  We still surface the file with a fallback frontmatter so the user
   *  can see which one needs fixing. */
  parseError?: string;
}

/** Parse a single skill file. Returns a Skill record even when the
 *  frontmatter is malformed — the dashboard renders the parse error
 *  in-pane so the user can fix it without leaving the UI. */
export function parseSkillFile(filePath: string, scope: SkillScope): ParseResult {
  const basename = nameFromFile(filePath);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      skill: emptySkill(filePath, basename, scope),
      parseError: 'failed to read: ' + String(err),
    };
  }
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    return {
      skill: { ...emptySkill(filePath, basename, scope), body: raw },
      parseError: 'YAML parse error: ' + String(err),
    };
  }
  const data = parsed.data as Record<string, unknown>;
  const fm = coerceFrontmatter(data, basename);
  const schemaVersion = detectSchemaVersion(data);
  return {
    skill: {
      frontmatter: fm,
      body: parsed.content || '',
      filePath,
      scope,
      schemaVersion,
      usedByTriggers: [],
    },
  };
}

function emptySkill(filePath: string, basename: string, scope: SkillScope): Skill {
  return {
    frontmatter: { name: basename },
    body: '',
    filePath,
    scope,
    schemaVersion: 'legacy',
    usedByTriggers: [],
  };
}

/** List skills in a directory, returning Skill records (not just paths)
 *  so callers can immediately render them. Tolerates missing dirs and
 *  unreadable files — best-effort. */
function listSkillsInDir(dir: string, scope: SkillScope): Skill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    if (!isSkillFile(entry)) continue;
    const fullPath = path.join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    out.push(parseSkillFile(fullPath, scope).skill);
  }
  return out;
}

export interface ListSkillsOptions {
  /** Optional per-project work_dir to also scan. Per-project skills
   *  override global skills with the same filename. */
  projectWorkDir?: string;
  /** Optional cron jobs list — when provided, the loader populates the
   *  usedByTriggers field on each skill via the existing skills[] array
   *  on CronJobDefinition (Phase A's join). */
  jobs?: CronJobDefinition[];
}

/** Top-level discovery API. Returns the merged list of skills across
 *  global + per-project pools, with per-project taking precedence on
 *  name collision. usedByTriggers is populated when jobs are passed in. */
export function listSkills(opts: ListSkillsOptions = {}): Skill[] {
  const globalSkills = listSkillsInDir(globalSkillsDir(), 'global');
  const projectSkills = opts.projectWorkDir
    ? (() => {
        const pdir = projectSkillsDir(opts.projectWorkDir);
        return pdir ? listSkillsInDir(pdir, 'project') : [];
      })()
    : [];

  // Build a map keyed by basename so per-project entries override global.
  const merged = new Map<string, Skill>();
  for (const s of globalSkills) merged.set(s.frontmatter.name, s);
  for (const s of projectSkills) merged.set(s.frontmatter.name, s);

  // Used-by join from cron jobs' skills[] array. Same skill referenced by
  // multiple jobs accumulates them in order.
  if (opts.jobs && opts.jobs.length > 0) {
    for (const job of opts.jobs) {
      if (!Array.isArray(job.skills)) continue;
      for (const skillName of job.skills) {
        const s = merged.get(skillName);
        if (s) s.usedByTriggers.push(job.name);
      }
    }
  }

  // Sorted alphabetically — predictable rendering, no need for the
  // dashboard to re-sort. Per-project always sorts at the same key as
  // the global version it replaced.
  return [...merged.values()].sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
}

/** Get a single skill by name, with the same global/project precedence
 *  as listSkills. Returns null if neither pool has the skill. */
export function getSkill(name: string, opts: ListSkillsOptions = {}): Skill | null {
  // Per-project first (precedence).
  if (opts.projectWorkDir) {
    const pdir = projectSkillsDir(opts.projectWorkDir);
    if (pdir) {
      const candidate = path.join(pdir, name + '.md');
      if (existsSync(candidate)) {
        const result = parseSkillFile(candidate, 'project');
        if (opts.jobs) result.skill.usedByTriggers = jobsUsing(name, opts.jobs);
        return result.skill;
      }
    }
  }
  // Global fallback.
  const candidate = path.join(globalSkillsDir(), name + '.md');
  if (existsSync(candidate)) {
    const result = parseSkillFile(candidate, 'global');
    if (opts.jobs) result.skill.usedByTriggers = jobsUsing(name, opts.jobs);
    return result.skill;
  }
  return null;
}

/** Internal helper for the used-by join. */
function jobsUsing(skillName: string, jobs: CronJobDefinition[]): string[] {
  const out: string[] = [];
  for (const job of jobs) {
    if (Array.isArray(job.skills) && job.skills.includes(skillName)) out.push(job.name);
  }
  return out;
}

/** Test-only: where the loader looked. Useful in unit tests + the
 *  dashboard's diagnostics surface. */
export function _skillDirsForDiagnostics(workDir?: string): { global: string; project: string | null } {
  return {
    global: globalSkillsDir(),
    project: projectSkillsDir(workDir) ?? null,
  };
}
