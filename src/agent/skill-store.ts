/**
 * Skill store — Phase A / A.5 of the Skills-First redesign.
 *
 * Anthropic-compatible skill loader. Walks two skill directories and
 * accepts both layouts:
 *
 *   1. **Folder form** (Anthropic spec): <dir>/<skill-name>/SKILL.md
 *      A capital-S SKILL.md is the entry point. Sibling .md files and
 *      a scripts/ subdirectory are surfaced as bundled files.
 *
 *   2. **Flat form** (Clementine legacy): <dir>/<skill-name>.md
 *      A single .md file with frontmatter + body. Bundled files
 *      unsupported. Used by the 12 pre-redesign skill files we already
 *      have on disk.
 *
 * Discovery directories (per-project wins on name collision):
 *   - global:      $CLEMENTINE_HOME/vault/00-System/skills/
 *   - per-project: <work_dir>/.clementine/skills/
 *
 * Phase A is read-only. Phase B adds editing + a "Test this skill"
 * runner. Phase C wires runtime invocation. Phase E migrates legacy
 * crons → folder-form skills.
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
  SkillLayout,
  SkillBundledFile,
  SkillValidationWarning,
  SkillToolPolicy,
  SkillSuccess,
  SkillLimits,
  SkillDataSource,
  SkillInputSchema,
  ClementineSkillExtensions,
  CronJobDefinition,
} from '../types.js';

// ── Path resolution (lazy — reads CLEMENTINE_HOME on each call) ──────

function globalSkillsDir(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
  return path.join(base, 'vault', '00-System', 'skills');
}

function projectSkillsDir(workDir: string | undefined): string | null {
  if (!workDir) return null;
  const dir = path.join(workDir, '.clementine', 'skills');
  return existsSync(dir) ? dir : null;
}

// ── Anthropic spec validations ────────────────────────────────────────

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set(['anthropic', 'claude']);
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const BODY_LINE_LIMIT_WARN = 500;

/** Run Anthropic-spec validations on a parsed skill. Errors are spec
 *  violations (skill would be rejected by the Anthropic API); warnings
 *  are best-practice hints (still loadable). Findings render in the
 *  dashboard's detail pane. */
export function validateSkill(skill: Skill): SkillValidationWarning[] {
  const out: SkillValidationWarning[] = [];
  const fm = skill.frontmatter;

  // Name validation (Anthropic spec).
  if (!fm.name) {
    out.push({ severity: 'error', field: 'name', message: 'name is required' });
  } else {
    if (fm.name.length > NAME_MAX_LEN) {
      out.push({ severity: 'error', field: 'name', message: `name exceeds ${NAME_MAX_LEN} chars (got ${fm.name.length})` });
    }
    if (!NAME_PATTERN.test(fm.name)) {
      out.push({ severity: 'error', field: 'name', message: 'name must be lowercase letters, numbers, and hyphens only' });
    }
    const lower = fm.name.toLowerCase();
    if (RESERVED_NAMES.has(lower) || lower.includes('anthropic') || lower.includes('claude')) {
      // Anthropic forbids these words anywhere in the name.
      out.push({ severity: 'error', field: 'name', message: 'name cannot contain reserved words "anthropic" or "claude"' });
    }
  }

  // Description validation (Anthropic spec).
  if (!fm.description || !fm.description.trim()) {
    out.push({ severity: 'warning', field: 'description', message: 'description is required by Anthropic spec — add one so the skill can be discovered' });
  } else if (fm.description.length > DESCRIPTION_MAX_LEN) {
    out.push({ severity: 'error', field: 'description', message: `description exceeds ${DESCRIPTION_MAX_LEN} chars (got ${fm.description.length})` });
  } else if (/<\w+/i.test(fm.description)) {
    out.push({ severity: 'error', field: 'description', message: 'description cannot contain XML tags' });
  }

  // Body length (best-practice hint).
  const bodyLines = (skill.body.match(/\n/g)?.length ?? 0) + 1;
  if (bodyLines > BODY_LINE_LIMIT_WARN) {
    out.push({ severity: 'warning', field: 'body', message: `body is ${bodyLines} lines — Anthropic recommends under ${BODY_LINE_LIMIT_WARN}; split into bundled files (FORMS.md, reference.md, etc.)` });
  }

  // Layout hint: flat skills can't bundle scripts or sibling references.
  if (skill.layout === 'flat' && skill.schemaVersion !== 'legacy') {
    out.push({ severity: 'warning', field: 'layout', message: 'consider folder form (<skill-name>/SKILL.md) so you can bundle scripts and reference files later' });
  }

  return out;
}

// ── Frontmatter parsing ───────────────────────────────────────────────

/** Detect which of the three schema variants this frontmatter is.
 *
 * - 'clementine'  if the `clementine:` namespace is present
 * - 'legacy'      if any of the pre-redesign top-level fields are present
 *                 (title / triggers / toolsUsed / useCount) AND no clementine
 * - 'anthropic'   otherwise (just name + description, the canonical case)
 */
function detectSchemaVersion(raw: Record<string, unknown>): SkillSchemaVersion {
  if (raw.clementine && typeof raw.clementine === 'object' && !Array.isArray(raw.clementine)) {
    return 'clementine';
  }
  const legacyMarkers = ['title', 'triggers', 'toolsUsed', 'useCount', 'source'];
  if (legacyMarkers.some((k) => k in raw)) return 'legacy';
  return 'anthropic';
}

function coerceClementineExtensions(raw: unknown): ClementineSkillExtensions | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: ClementineSkillExtensions = {};

  if (r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs)) {
    out.inputs = r.inputs as Record<string, SkillInputSchema>;
  }
  if (r.tools && typeof r.tools === 'object' && !Array.isArray(r.tools)) {
    const t = r.tools as Record<string, unknown>;
    const policy: SkillToolPolicy = {};
    if (Array.isArray(t.allow)) policy.allow = t.allow.map(String);
    if (Array.isArray(t.deny)) policy.deny = t.deny.map(String);
    if (policy.allow || policy.deny) out.tools = policy;
  }
  if (Array.isArray(r.dataSources)) {
    out.dataSources = r.dataSources
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d))
      .map((d) => ({ kind: String(d.kind || 'unknown'), purpose: String(d.purpose || '') } as SkillDataSource));
  }
  if (Array.isArray(r.stateKeys)) out.stateKeys = r.stateKeys.map(String);
  if (r.success && typeof r.success === 'object' && !Array.isArray(r.success)) {
    const s = r.success as Record<string, unknown>;
    const success: SkillSuccess = {};
    if (s.schema && typeof s.schema === 'object') success.schema = s.schema as SkillInputSchema;
    if (typeof s.criterion === 'string') success.criterion = s.criterion;
    if (success.schema || success.criterion) out.success = success;
  }
  if (r.limits && typeof r.limits === 'object' && !Array.isArray(r.limits)) {
    const l = r.limits as Record<string, unknown>;
    const limits: SkillLimits = {};
    if (typeof l.maxTurns === 'number') limits.maxTurns = l.maxTurns;
    if (typeof l.maxBudgetUsd === 'number') limits.maxBudgetUsd = l.maxBudgetUsd;
    if (typeof l.timeoutSeconds === 'number') limits.timeoutSeconds = l.timeoutSeconds;
    if (Object.keys(limits).length > 0) out.limits = limits;
  }
  if (typeof r.version === 'number') out.version = r.version;
  if (typeof r.createdAt === 'string') out.createdAt = r.createdAt;
  if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt;
  if (typeof r.lastUsed === 'string') out.lastUsed = r.lastUsed;
  if (typeof r.lastTestPass === 'string') out.lastTestPass = r.lastTestPass;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce raw YAML object → SkillFrontmatter. Filename always wins for
 *  identity (frontmatter `name:` is ignored to prevent two skills from
 *  colliding); we treat the YAML name as a display alias only. */
function coerceFrontmatter(raw: Record<string, unknown>, fileBasename: string): SkillFrontmatter {
  const fm: SkillFrontmatter = { name: fileBasename };
  if (typeof raw.description === 'string') fm.description = raw.description;
  const ext = coerceClementineExtensions(raw.clementine);
  if (ext) fm.clementine = ext;
  // Legacy top-level fields preserved for the migration UI.
  if (typeof raw.title === 'string') fm.title = raw.title;
  if (Array.isArray(raw.triggers)) fm.triggers = raw.triggers.map(String);
  if (typeof raw.source === 'string') fm.source = raw.source;
  if (Array.isArray(raw.toolsUsed)) fm.toolsUsed = raw.toolsUsed.map(String);
  if (typeof raw.useCount === 'number') fm.useCount = raw.useCount;
  return fm;
}

// ── File / folder helpers ─────────────────────────────────────────────

function isLoadableSkillFile(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (!name.endsWith('.md')) return false;
  if (name.endsWith('.bak')) return false;
  if (name.endsWith('.bak.md')) return false;
  return true;
}

function classifyBundledFile(relPath: string): SkillBundledFile['kind'] {
  if (relPath.endsWith('.md')) return 'markdown';
  if (relPath.startsWith('scripts/')) return 'script';
  if (/\.(py|js|ts|sh|rb)$/.test(relPath)) return 'script';
  return 'other';
}

/** Walk a skill folder (recursively shallow — one level into scripts/)
 *  and return non-SKILL.md files as bundled artifacts. Skips hidden
 *  files, .bak duplicates, and the SKILL.md itself. */
function discoverBundledFiles(skillFolder: string): SkillBundledFile[] {
  const out: SkillBundledFile[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const abs = path.join(dir, entry);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      if (st.isDirectory()) {
        // Only descend one level — avoids surprise when a skill bundles
        // node_modules or similar. Convention: scripts/, reference/.
        if (relPrefix) continue;
        walk(abs, rel);
        continue;
      }
      if (!st.isFile()) continue;
      // Skip the entry-point file itself + .bak duplicates.
      if (rel === 'SKILL.md') continue;
      if (entry.endsWith('.bak') || entry.endsWith('.bak.md')) continue;
      out.push({
        relPath: rel,
        absPath: abs,
        kind: classifyBundledFile(rel),
        sizeBytes: st.size,
      });
    }
  };
  walk(skillFolder, '');
  // Sort deterministically: top-level files first, then scripts/, then
  // alphabetical within each group.
  out.sort((a, b) => {
    const aTop = !a.relPath.includes('/');
    const bTop = !b.relPath.includes('/');
    if (aTop !== bTop) return aTop ? -1 : 1;
    return a.relPath.localeCompare(b.relPath);
  });
  return out;
}

// ── Skill parsing ────────────────────────────────────────────────────

interface ParseResult {
  skill: Skill;
  /** Set when the file existed but couldn't be parsed (bad YAML, etc.).
   *  We still surface the skill with synthesized frontmatter so the
   *  dashboard can render the offending file with an error banner. */
  parseError?: string;
}

function emptySkill(filePath: string, basename: string, scope: SkillScope, layout: SkillLayout): Skill {
  return {
    frontmatter: { name: basename },
    body: '',
    filePath,
    scope,
    layout,
    schemaVersion: 'legacy',
    bundledFiles: [],
    usedByTriggers: [],
    validation: [],
  };
}

/** Parse a flat-form skill file (single .md). */
export function parseSkillFile(filePath: string, scope: SkillScope): ParseResult {
  const basename = path.basename(filePath, '.md');
  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); }
  catch (err) {
    return { skill: emptySkill(filePath, basename, scope, 'flat'), parseError: 'failed to read: ' + String(err) };
  }
  let parsed: ReturnType<typeof matter>;
  try { parsed = matter(raw); }
  catch (err) {
    const skill = { ...emptySkill(filePath, basename, scope, 'flat'), body: raw };
    return { skill, parseError: 'YAML parse error: ' + String(err) };
  }
  const data = parsed.data as Record<string, unknown>;
  const skill: Skill = {
    frontmatter: coerceFrontmatter(data, basename),
    body: parsed.content || '',
    filePath,
    scope,
    layout: 'flat',
    schemaVersion: detectSchemaVersion(data),
    bundledFiles: [],
    usedByTriggers: [],
    validation: [],
  };
  skill.validation = validateSkill(skill);
  return { skill };
}

/** Parse a folder-form skill (Anthropic spec: <name>/SKILL.md plus optional
 *  bundled files). The folder name is the canonical skill identifier. */
export function parseSkillFolder(folderPath: string, scope: SkillScope): ParseResult {
  const basename = path.basename(folderPath);
  const entryPoint = path.join(folderPath, 'SKILL.md');
  if (!existsSync(entryPoint)) {
    return {
      skill: emptySkill(entryPoint, basename, scope, 'folder'),
      parseError: 'no SKILL.md in folder',
    };
  }
  let raw: string;
  try { raw = readFileSync(entryPoint, 'utf-8'); }
  catch (err) {
    return { skill: emptySkill(entryPoint, basename, scope, 'folder'), parseError: 'failed to read SKILL.md: ' + String(err) };
  }
  let parsed: ReturnType<typeof matter>;
  try { parsed = matter(raw); }
  catch (err) {
    const skill = { ...emptySkill(entryPoint, basename, scope, 'folder'), body: raw };
    return { skill, parseError: 'YAML parse error in SKILL.md: ' + String(err) };
  }
  const data = parsed.data as Record<string, unknown>;
  const skill: Skill = {
    frontmatter: coerceFrontmatter(data, basename),
    body: parsed.content || '',
    filePath: entryPoint,
    scope,
    layout: 'folder',
    schemaVersion: detectSchemaVersion(data),
    bundledFiles: discoverBundledFiles(folderPath),
    usedByTriggers: [],
    validation: [],
  };
  skill.validation = validateSkill(skill);
  return { skill };
}

// ── Discovery (top-level API) ────────────────────────────────────────

function listSkillsInDir(dir: string, scope: SkillScope): Skill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return []; }
  const out: Skill[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = path.join(dir, entry);
    let st;
    try { st = statSync(fullPath); } catch { continue; }

    if (st.isDirectory()) {
      // Folder-form skill. Must contain SKILL.md (case-sensitive,
      // Anthropic spec). Skip folders that don't (e.g. accidental
      // dirs like 'auto/' that exist in current vault).
      if (!existsSync(path.join(fullPath, 'SKILL.md'))) continue;
      out.push(parseSkillFolder(fullPath, scope).skill);
      continue;
    }
    if (st.isFile() && isLoadableSkillFile(entry)) {
      out.push(parseSkillFile(fullPath, scope).skill);
    }
  }
  return out;
}

export interface ListSkillsOptions {
  /** Optional per-project work_dir to scan. Per-project skills shadow
   *  global ones with the same identifier. */
  projectWorkDir?: string;
  /** Optional cron jobs for the usedByTriggers join (via skills[]). */
  jobs?: CronJobDefinition[];
}

/** Top-level discovery API. Merges global + per-project pools, with
 *  per-project taking precedence. Populates usedByTriggers when jobs
 *  are passed. Returned list is sorted alphabetically by name. */
export function listSkills(opts: ListSkillsOptions = {}): Skill[] {
  const globalSkills = listSkillsInDir(globalSkillsDir(), 'global');
  const projectSkills = opts.projectWorkDir
    ? (() => {
        const pdir = projectSkillsDir(opts.projectWorkDir);
        return pdir ? listSkillsInDir(pdir, 'project') : [];
      })()
    : [];

  const merged = new Map<string, Skill>();
  for (const s of globalSkills) merged.set(s.frontmatter.name, s);
  for (const s of projectSkills) merged.set(s.frontmatter.name, s);

  if (opts.jobs && opts.jobs.length > 0) {
    for (const job of opts.jobs) {
      if (!Array.isArray(job.skills)) continue;
      for (const skillName of job.skills) {
        const s = merged.get(skillName);
        if (s) s.usedByTriggers.push(job.name);
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
}

/** Get one skill by name, applying per-project precedence. Returns
 *  null when neither pool has the skill. */
export function getSkill(name: string, opts: ListSkillsOptions = {}): Skill | null {
  // Per-project first (precedence), then global.
  const tryDir = (dir: string, scope: SkillScope): Skill | null => {
    const folder = path.join(dir, name);
    if (existsSync(folder) && existsSync(path.join(folder, 'SKILL.md'))) {
      return parseSkillFolder(folder, scope).skill;
    }
    const flat = path.join(dir, name + '.md');
    if (existsSync(flat)) {
      return parseSkillFile(flat, scope).skill;
    }
    return null;
  };

  let skill: Skill | null = null;
  if (opts.projectWorkDir) {
    const pdir = projectSkillsDir(opts.projectWorkDir);
    if (pdir) skill = tryDir(pdir, 'project');
  }
  if (!skill) skill = tryDir(globalSkillsDir(), 'global');
  if (skill && opts.jobs) {
    for (const j of opts.jobs) {
      if (Array.isArray(j.skills) && j.skills.includes(name)) skill.usedByTriggers.push(j.name);
    }
  }
  return skill;
}

/** Read one bundled file's contents — used by Phase B's preview pane.
 *  Defends against directory traversal: rejects paths that escape the
 *  skill folder. */
export function readBundledFile(skill: Skill, relPath: string): string | null {
  if (skill.layout !== 'folder') return null;
  const skillFolder = path.dirname(skill.filePath);
  const absPath = path.resolve(skillFolder, relPath);
  if (!absPath.startsWith(skillFolder + path.sep) && absPath !== skillFolder) return null;
  if (!existsSync(absPath)) return null;
  try { return readFileSync(absPath, 'utf-8'); }
  catch { return null; }
}

/** Diagnostics for the dashboard — expose where the loader looked. */
export function _skillDirsForDiagnostics(workDir?: string): { global: string; project: string | null } {
  return { global: globalSkillsDir(), project: projectSkillsDir(workDir) ?? null };
}
