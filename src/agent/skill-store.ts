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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Anthropic skill slug regex. Exported (1.18.144) so other modules
 * (self-improve, migration tooling) don't drift their own copies.
 * Lowercase letters/digits/dashes, must start with [a-z0-9], ≤64 chars.
 */
export const ANTHROPIC_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_PATTERN = ANTHROPIC_SKILL_NAME_PATTERN;
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
  // Legacy Clementine concepts preserved through migration.
  if (Array.isArray(r.triggers)) out.triggers = r.triggers.map(String);
  if (typeof r.source === 'string') out.source = r.source;
  if (typeof r.useCount === 'number') out.useCount = r.useCount;
  if (typeof r.migratedFrom === 'string') out.migratedFrom = r.migratedFrom;
  if (typeof r.migratedAt === 'string') out.migratedAt = r.migratedAt;

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

// ── Legacy → folder-form migration ───────────────────────────────────
//
// Converts a flat-form legacy skill (`<name>.md` with title/triggers/
// toolsUsed/useCount frontmatter) into Anthropic-compatible folder form
// (`<name>/SKILL.md` with name+description top-level + clementine: namespace
// for the migration metadata).
//
// Preserves everything:
//   - title (legacy display name) → moves to top-level `title` (still readable)
//   - triggers (NLP phrases) → clementine.triggers (preserved for reference)
//   - toolsUsed → clementine.tools.allow (informational → enforced allowlist)
//   - useCount + lastUsed → clementine.useCount + clementine.lastUsed
//   - source → clementine.source
//   - body → unchanged, written to <folder>/SKILL.md
//
// The original `<name>.md` is renamed to `<name>.md.bak` (kept on disk for
// rollback). The bak is filtered out by isLoadableSkillFile so the dashboard
// won't show it twice.

import { renameSync } from 'node:fs';

export interface MigrationResult {
  ok: boolean;
  /** Path to the new SKILL.md created. Undefined when ok=false. */
  newSkillPath?: string;
  /** Path the original .md was moved to (.bak). Undefined when ok=false. */
  backupPath?: string;
  /** Set when ok=false — what went wrong. */
  error?: string;
  /** Set when the loader found nothing to migrate (already folder-form). */
  alreadyMigrated?: boolean;
}

/** Migrate one legacy flat skill to Anthropic-compatible folder form.
 *  Idempotent: a folder-form skill is reported as alreadyMigrated. */
export function migrateLegacySkill(name: string): MigrationResult {
  if (!name) return { ok: false, error: 'name required' };
  const dir = globalSkillsDir();
  const flat = path.join(dir, name + '.md');
  const folder = path.join(dir, name);

  // Already folder-form → no-op.
  if (existsSync(folder) && existsSync(path.join(folder, 'SKILL.md'))) {
    return { ok: true, alreadyMigrated: true, newSkillPath: path.join(folder, 'SKILL.md') };
  }
  // Source file must exist.
  if (!existsSync(flat)) return { ok: false, error: `legacy skill file not found: ${flat}` };
  // Folder must NOT exist (collides with the rename target).
  if (existsSync(folder)) return { ok: false, error: `target folder already exists: ${folder}` };

  // Read + parse the legacy file.
  let raw: string;
  try { raw = readFileSync(flat, 'utf-8'); }
  catch (err) { return { ok: false, error: 'failed to read source: ' + String(err) }; }

  let parsed: ReturnType<typeof matter>;
  try { parsed = matter(raw); }
  catch (err) { return { ok: false, error: 'failed to parse YAML in source: ' + String(err) }; }

  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content || '';

  // Build the new frontmatter:
  //   - name (always the filename)
  //   - description (preserved from legacy)
  //   - title (preserved as display alias)
  //   - clementine.* — bucket all the legacy-only fields here
  const newFm: Record<string, unknown> = {
    name,
  };
  if (typeof data.description === 'string' && data.description.trim()) newFm.description = data.description;
  if (typeof data.title === 'string' && data.title.trim() && data.title !== data.description) {
    newFm.title = data.title;
  }
  const clementine: Record<string, unknown> = {};
  if (Array.isArray(data.triggers) && data.triggers.length > 0) {
    clementine.triggers = data.triggers.map(String);
  }
  if (Array.isArray(data.toolsUsed) && data.toolsUsed.length > 0) {
    // Convert informational toolsUsed → enforced tools.allow. Authors can
    // tighten by editing in Phase B.
    clementine.tools = { allow: data.toolsUsed.map(String) };
  }
  if (typeof data.source === 'string' && data.source.trim()) clementine.source = data.source;
  if (typeof data.useCount === 'number') clementine.useCount = data.useCount;
  if (typeof data.lastUsed === 'string') clementine.lastUsed = data.lastUsed;
  if (typeof data.createdAt === 'string') clementine.createdAt = data.createdAt;
  if (typeof data.updatedAt === 'string') clementine.updatedAt = data.updatedAt;
  // Stamp the migration provenance so future tooling can see where this
  // came from.
  clementine.migratedFrom = path.basename(flat);
  clementine.migratedAt = new Date().toISOString();
  clementine.version = 1;

  if (Object.keys(clementine).length > 0) newFm.clementine = clementine;

  // Serialize: gray-matter handles YAML output. matter.stringify takes
  // (content, data) → returns the full file with frontmatter.
  const newContent = matter.stringify(body.startsWith('\n') ? body : '\n' + body, newFm);

  // Create the folder + write SKILL.md.
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), newContent);
  } catch (err) {
    return { ok: false, error: 'failed to write new SKILL.md: ' + String(err) };
  }

  // Move the original to .bak so the loader stops surfacing it. We use
  // <name>.md.bak which isLoadableSkillFile already filters out.
  const backupPath = flat + '.bak';
  try {
    renameSync(flat, backupPath);
  } catch (err) {
    // Roll back the folder we just created so we don't leave the user in
    // a half-migrated state with both shapes for the same name.
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      fs.unlinkSync(path.join(folder, 'SKILL.md'));
      fs.rmdirSync(folder);
    } catch { /* best-effort */ }
    return { ok: false, error: 'failed to rename original to .bak: ' + String(err) };
  }

  return {
    ok: true,
    newSkillPath: path.join(folder, 'SKILL.md'),
    backupPath,
  };
}

/** Migrate every legacy skill in the global pool. Returns per-skill
 *  results so the dashboard can render a summary banner. */
export function migrateAllLegacySkills(): { migrated: MigrationResult[]; skipped: MigrationResult[] } {
  // Walk the dir directly so we don't trigger a full parse + validation.
  const dir = globalSkillsDir();
  const migrated: MigrationResult[] = [];
  const skipped: MigrationResult[] = [];
  if (!existsSync(dir)) return { migrated, skipped };
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return { migrated, skipped }; }

  for (const entry of entries) {
    if (!isLoadableSkillFile(entry)) continue;
    const name = entry.replace(/\.md$/, '');
    // Quickly check it's actually legacy — avoid migrating an Anthropic-
    // form flat file that the user explicitly authored without a folder.
    const filePath = path.join(dir, entry);
    let isLegacy = false;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = matter(raw).data as Record<string, unknown>;
      isLegacy = ['title', 'triggers', 'toolsUsed', 'useCount', 'source'].some((k) => k in data);
    } catch { /* leave isLegacy=false */ }
    if (!isLegacy) {
      skipped.push({ ok: true, alreadyMigrated: true, newSkillPath: filePath });
      continue;
    }
    migrated.push(migrateLegacySkill(name));
  }
  return { migrated, skipped };
}

// ── writeSkill — single source of truth for creating skills ──────────
//
// 1.18.124 — Three skill-creation paths existed before this:
//   1. POST /api/skills (dashboard "+ New skill" modal)
//   2. create_skill MCP tool (chat — Discord / dashboard chat)
//   3. saveActiveSkill in skill-extractor.ts (auto-extraction from runs)
//
// All three wrote slightly different frontmatter shapes. The auto-
// extraction path was the worst — it wrote LEGACY flat-form (top-level
// triggers/source/useCount) which the Skills page renders with the
// "LEGACY" badge, even on fresh installs. Same input, three drifting
// outputs.
//
// This helper is the shared write path. Anthropic-canonical name +
// description top-level; everything Clementine-specific (source,
// useCount, lifecycle metadata, triggers, tools.allow) under the
// `clementine:` namespace. Folder form by default. Optional agentSlug
// scopes the write to <agentsDir>/<slug>/skills/<name>/SKILL.md.
//
// Returns the written entry path. Throws when the name is invalid or
// the file already exists (caller can fall back to update).

export interface WriteSkillInput {
  /** Slug (lowercase letters/digits/dashes, ≤64 chars, Anthropic regex). */
  name: string;
  /** Human-readable display name. Optional. */
  title?: string;
  /** One-paragraph "what does this do, when should Claude run it" — required by spec. */
  description: string;
  /** Procedure body (Markdown). Required. */
  body: string;
  /** Where the skill came from. Drives lifecycle metadata + dashboard badge. */
  source: 'manual' | 'chat' | 'auto' | 'imported';
  /** Optional tool allowlist — stored under clementine.tools.allow. */
  tools?: string[];
  /** Optional NLP trigger phrases for auto-match — stored under clementine.triggers. */
  triggers?: string[];
  /** Optional agent scope. When set, writes to <agentsDir>/<slug>/skills/
   *  instead of the global skills dir. Used by auto-extraction so each
   *  hired agent's skills stay isolated by default. */
  agentSlug?: string;
  /** When true, allow overwriting an existing skill (used by update flows). */
  overwrite?: boolean;
  /** Optional source-job tag (auto-extraction provenance). */
  sourceJob?: string;
}

export interface WriteSkillResult {
  /** Absolute path to the written SKILL.md. */
  filePath: string;
  /** Slug (matches input name). */
  name: string;
  /** Whether an existing skill was overwritten. */
  overwrote: boolean;
}

export function writeSkill(input: WriteSkillInput): WriteSkillResult {
  // Validate name per Anthropic spec — single guard for every caller.
  if (!input.name || !NAME_PATTERN.test(input.name)) {
    throw new Error('writeSkill: name must match ^[a-z0-9][a-z0-9-]{0,63}$');
  }
  if (input.name.length > NAME_MAX_LEN) {
    throw new Error(`writeSkill: name exceeds ${NAME_MAX_LEN} chars`);
  }
  if (RESERVED_NAMES.has(input.name) || /\b(anthropic|claude)\b/i.test(input.name)) {
    throw new Error(`writeSkill: name uses a reserved word`);
  }
  if (!input.description || !input.description.trim()) {
    throw new Error('writeSkill: description is required');
  }
  if (input.description.length > DESCRIPTION_MAX_LEN) {
    throw new Error(`writeSkill: description exceeds ${DESCRIPTION_MAX_LEN} chars`);
  }
  if (!input.body || !input.body.trim()) {
    throw new Error('writeSkill: body is required');
  }

  // Resolve target directory. Agent-scoped writes land under the agent's
  // skills folder so each hired agent's skill set is independent.
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
  const targetDir = input.agentSlug
    ? path.join(base, 'vault', '00-System', 'agents', input.agentSlug, 'skills')
    : globalSkillsDir();
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const folderPath = path.join(targetDir, input.name);
  const entryPath = path.join(folderPath, 'SKILL.md');
  const existed = existsSync(entryPath);
  if (existed && !input.overwrite) {
    throw new Error(`writeSkill: skill "${input.name}" already exists`);
  }

  mkdirSync(folderPath, { recursive: true });

  // Build the frontmatter. Anthropic-canonical fields (name, description)
  // top-level. Everything else under clementine:. The lifecycle metadata
  // (createdAt / updatedAt / version) keeps the Skills page detail pane
  // accurate without authors having to remember to set it by hand.
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    name: input.name,
    description: input.description.trim(),
  };
  if (input.title && input.title.trim()) fm.title = input.title.trim();

  const ext: Record<string, unknown> = {
    source: input.source,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  if (input.tools && input.tools.length > 0) {
    ext.tools = { allow: input.tools.map(String).map(s => s.trim()).filter(Boolean) };
  }
  if (input.triggers && input.triggers.length > 0) {
    ext.triggers = input.triggers.map(String).map(s => s.trim()).filter(Boolean);
  }
  if (input.sourceJob) ext.sourceJob = input.sourceJob;
  fm.clementine = ext;

  const content = matter.stringify(input.body.endsWith('\n') ? input.body : input.body + '\n', fm);
  writeFileSync(entryPath, content);

  return { filePath: entryPath, name: input.name, overwrote: existed };
}

// ── Legacy backup janitor (1.18.125) ─────────────────────────────────
//
// Pre-1.18.124, `saveActiveSkill` wrote a per-overwrite `.md.bak` next to
// every skill it updated. The new `writeSkill` path doesn't create these,
// but the old ones rot in the vault forever unless something sweeps them.
// `cleanupLegacySkillBackups` finds `.md.bak` files older than the cutoff
// and removes them. Runs from the periodic memory-maintenance cycle so
// users don't need to know it exists.
//
// Conservative: 30-day age floor + only the slug-named `.md.bak` pattern.
// Anything mtime-recent stays put in case a user is mid-rollback.

const LEGACY_BAK_AGE_DAYS = 30;
const LEGACY_BAK_AGE_MS = LEGACY_BAK_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface SkillBackupSweepResult {
  /** Files removed this pass. Absolute paths. */
  removed: string[];
  /** Files inspected (matched the pattern). Useful for "nothing to do" telemetry. */
  inspected: number;
  /** Files that matched the pattern but were younger than the cutoff (kept). */
  keptFresh: number;
}

/**
 * Sweep `.md.bak` skill backups older than `LEGACY_BAK_AGE_DAYS` from the
 * global skills directory and from every per-agent skills directory under
 * `00-System/agents/<slug>/skills/`. Best-effort: per-file errors are
 * swallowed so a permission glitch on one file doesn't stop the sweep.
 *
 * Idempotent — safe to call repeatedly. Returns counts for logging.
 */
export function cleanupLegacySkillBackups(): SkillBackupSweepResult {
  const result: SkillBackupSweepResult = { removed: [], inspected: 0, keptFresh: 0 };
  const cutoff = Date.now() - LEGACY_BAK_AGE_MS;

  const sweepRoots: string[] = [globalSkillsDir()];

  // Per-agent skill dirs — discover via the agents/ folder.
  try {
    const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
    const agentsDir = path.join(base, 'vault', '00-System', 'agents');
    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir)) {
        if (entry.startsWith('.')) continue;
        const agentSkillsDir = path.join(agentsDir, entry, 'skills');
        if (existsSync(agentSkillsDir)) sweepRoots.push(agentSkillsDir);
      }
    }
  } catch { /* non-fatal — global sweep still runs */ }

  for (const root of sweepRoots) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      // Match exactly the legacy pattern. Don't touch anything else — we
      // never want to nuke `templates/old-draft.md.bak` inside a folder skill,
      // for instance. The legacy writer only ever produced flat
      // `<slug>.md.bak` siblings, so that's all we sweep.
      if (!entry.endsWith('.md.bak')) continue;
      const full = path.join(root, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      result.inspected++;
      if (st.mtimeMs > cutoff) { result.keptFresh++; continue; }
      try {
        unlinkSync(full);
        result.removed.push(full);
      } catch { /* skip — permission or race; next sweep retries */ }
    }
  }

  return result;
}
