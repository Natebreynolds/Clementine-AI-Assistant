/**
 * Clementine TypeScript — Procedural Memory (Skill Extraction + Retrieval).
 *
 * Extracts reusable skill documents from successful multi-step executions
 * (unleashed jobs, cron runs, complex chat interactions) and stores them
 * as markdown files in vault/00-System/skills/ (global) or
 * vault/00-System/agents/{slug}/skills/ (agent-scoped).
 *
 * New skills land in a pending queue first. The owner approves or rejects
 * them via chat or dashboard before they become active.
 *
 * Skills are automatically indexed by the memory store FTS5 and retrieved
 * during context search to avoid re-deriving procedures from scratch.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';

import { VAULT_DIR, AGENTS_DIR, PENDING_SKILLS_DIR } from '../config.js';
import type { SkillDocument } from '../types.js';
import type { PersonalAssistant } from './assistant.js';
import { embed as embedText, cosineSimilarity, isReady as embeddingsReady } from '../memory/embeddings.js';

const logger = pino({ name: 'clementine.skills' });

const GLOBAL_SKILLS_DIR = path.join(VAULT_DIR, '00-System', 'skills');

function agentSkillsDir(agentSlug: string): string {
  return path.join(AGENTS_DIR, agentSlug, 'skills');
}

function ensureDirs(): void {
  for (const dir of [GLOBAL_SKILLS_DIR, PENDING_SKILLS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ── Skill Extraction ────────────────────────────────────────────────

/**
 * Extract a reusable skill from a successful execution.
 * New skills go to the pending queue — owner must approve before they activate.
 * Merges into existing approved skills directly (no re-approval needed).
 */
export async function extractSkill(
  assistant: PersonalAssistant,
  context: {
    source: SkillDocument['source'];
    sourceJob?: string;
    agentSlug?: string;
    prompt: string;           // The original task/prompt
    output: string;           // The successful output
    toolsUsed: string[];      // Tools that were called
    durationMs: number;
  },
): Promise<SkillDocument | null> {
  try {
    const extractionPrompt =
      `You are a skill extraction agent. Analyze this successful task execution and distill it into a reusable procedure.\n\n` +
      `## Original Task\n${context.prompt.slice(0, 2000)}\n\n` +
      `## Successful Output\n${context.output.slice(0, 3000)}\n\n` +
      `## Tools Used\n${context.toolsUsed.join(', ') || '(none)'}\n\n` +
      `## Instructions\n` +
      `Extract a reusable skill document. The skill should be general enough to apply to similar future tasks, ` +
      `but specific enough to be actionable.\n\n` +
      `Output ONLY a JSON object (no markdown, no explanation):\n` +
      `{\n` +
      `  "title": "Short descriptive title",\n` +
      `  "description": "1-2 sentence description of what this skill does",\n` +
      `  "triggers": ["keyword1", "keyword2", "phrase that should activate this"],\n` +
      `  "steps": "Step-by-step markdown procedure with numbered steps",\n` +
      `  "toolsUsed": ["tool1", "tool2"]\n` +
      `}\n\n` +
      `If this task is too trivial or one-off to be worth saving as a skill, output: { "skip": true }`;

    const result = await assistant.runPlanStep('skill-extract', extractionPrompt, {
      tier: 1,
      maxTurns: 1,
      disableTools: true,
    });

    // Parse JSON response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.skip) {
      logger.debug({ source: context.source, sourceJob: context.sourceJob }, 'Skill extraction skipped — too trivial');
      return null;
    }

    const name = slugify(parsed.title);
    const now = new Date().toISOString();

    const skill: SkillDocument = {
      name,
      title: parsed.title,
      description: parsed.description,
      triggers: parsed.triggers ?? [],
      source: context.source,
      sourceJob: context.sourceJob,
      agentSlug: context.agentSlug,
      steps: parsed.steps,
      toolsUsed: parsed.toolsUsed ?? context.toolsUsed,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Check for duplicate/similar skills in active dirs (and pending) before saving
    const existing = findSimilarActiveSkill(skill.triggers, context.agentSlug);
    if (existing) {
      logger.info({ name: existing.name, newTitle: skill.title }, 'Similar skill exists — merging');
      return mergeSkill(assistant, existing, skill);
    }

    // Check pending for duplicates too — don't queue it twice
    const existingPending = findSimilarPendingSkill(skill.triggers);
    if (existingPending) {
      logger.info({ name: existingPending.name, newTitle: skill.title }, 'Similar pending skill exists — skipping');
      return null;
    }

    // Save to pending queue — owner approves before it goes live
    savePendingSkill(skill);

    // Notify owner via callback if wired
    const cb = (assistant as any).onSkillProposed as ((skill: SkillDocument) => void) | null | undefined;
    if (cb) {
      try { cb(skill); } catch { /* non-fatal */ }
    }

    return skill;
  } catch (err) {
    logger.error({ err, source: context.source }, 'Skill extraction failed');
    return null;
  }
}

// ── Skill Storage ───────────────────────────────────────────────────

/** Save a skill to the pending queue (JSON, awaiting approval). */
function savePendingSkill(skill: SkillDocument): void {
  ensureDirs();
  const filePath = path.join(PENDING_SKILLS_DIR, `${skill.name}.json`);
  writeFileSync(filePath, JSON.stringify(skill, null, 2));
  logger.info({ name: skill.name, source: skill.source }, 'Skill queued for approval');
}

/** Save an approved skill as a formatted markdown file. Agent-scoped if agentSlug set. */
function saveActiveSkill(skill: SkillDocument): void {
  ensureDirs();

  const targetDir = skill.agentSlug ? agentSkillsDir(skill.agentSlug) : GLOBAL_SKILLS_DIR;
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  // gray-matter's YAML dumper throws on undefined values — omit them
  const frontmatter: Record<string, unknown> = {
    title: skill.title,
    description: skill.description,
    triggers: skill.triggers,
    source: skill.source,
    toolsUsed: skill.toolsUsed,
    useCount: skill.useCount,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
  if (skill.sourceJob) frontmatter.sourceJob = skill.sourceJob;
  if (skill.agentSlug) frontmatter.agentSlug = skill.agentSlug;
  if (skill.lastUsed) frontmatter.lastUsed = skill.lastUsed;

  const content = matter.stringify(`\n# ${skill.title}\n\n${skill.description}\n\n## Procedure\n\n${skill.steps}\n`, frontmatter);
  const filePath = path.join(targetDir, `${skill.name}.md`);

  // Backup existing before overwrite
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, filePath.replace(/\.md$/, '.md.bak')); } catch { /* best-effort */ }
  }
  writeFileSync(filePath, content);

  logger.info({ name: skill.name, source: skill.source, agentSlug: skill.agentSlug ?? 'global' }, 'Skill saved');
}

// ── Pending Skill Management ────────────────────────────────────────

/** Move a pending skill to the active skills directory. */
export function approvePendingSkill(name: string): { ok: boolean; message: string } {
  ensureDirs();
  const pendingFile = path.join(PENDING_SKILLS_DIR, `${name}.json`);
  if (!existsSync(pendingFile)) {
    return { ok: false, message: `Pending skill not found: ${name}` };
  }

  try {
    const skill: SkillDocument = JSON.parse(readFileSync(pendingFile, 'utf-8'));
    skill.updatedAt = new Date().toISOString();
    saveActiveSkill(skill);
    unlinkSync(pendingFile);
    logger.info({ name }, 'Pending skill approved and activated');
    return { ok: true, message: `Skill **${skill.title}** is now active${skill.agentSlug ? ` for ${skill.agentSlug}` : ' (global)'}.` };
  } catch (err) {
    logger.error({ err, name }, 'Failed to approve pending skill');
    return { ok: false, message: `Failed to approve skill: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Delete a pending skill (reject it). */
export function rejectPendingSkill(name: string): { ok: boolean; message: string } {
  const pendingFile = path.join(PENDING_SKILLS_DIR, `${name}.json`);
  if (!existsSync(pendingFile)) {
    return { ok: false, message: `Pending skill not found: ${name}` };
  }
  try {
    unlinkSync(pendingFile);
    logger.info({ name }, 'Pending skill rejected');
    return { ok: true, message: `Skill **${name}** rejected and removed.` };
  } catch (err) {
    return { ok: false, message: `Failed to reject skill: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** List all skills waiting for approval. */
export function listPendingSkills(): Array<{ name: string; title: string; description: string; source: string; agentSlug?: string; createdAt: string }> {
  if (!existsSync(PENDING_SKILLS_DIR)) return [];
  return readdirSync(PENDING_SKILLS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const skill: SkillDocument = JSON.parse(readFileSync(path.join(PENDING_SKILLS_DIR, f), 'utf-8'));
        return {
          name: skill.name,
          title: skill.title,
          description: skill.description,
          source: skill.source,
          agentSlug: skill.agentSlug,
          createdAt: skill.createdAt,
        };
      } catch { return null; }
    })
    .filter(Boolean) as any[];
}

// ── Similarity Detection ────────────────────────────────────────────

/** Find an active skill (global or agent-scoped) with overlapping triggers. */
function findSimilarActiveSkill(triggers: string[], agentSlug?: string): SkillDocument | null {
  const dirs: string[] = [];
  if (agentSlug) {
    const ad = agentSkillsDir(agentSlug);
    if (existsSync(ad)) dirs.push(ad);
  }
  if (existsSync(GLOBAL_SKILLS_DIR)) dirs.push(GLOBAL_SKILLS_DIR);

  return findSimilarInDirs(triggers, dirs, false);
}

/** Find a pending skill with overlapping triggers (to avoid duplicates in queue). */
function findSimilarPendingSkill(triggers: string[]): SkillDocument | null {
  if (!existsSync(PENDING_SKILLS_DIR)) return null;
  const triggerSet = new Set(triggers.map(t => t.toLowerCase()));
  for (const f of readdirSync(PENDING_SKILLS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const skill: SkillDocument = JSON.parse(readFileSync(path.join(PENDING_SKILLS_DIR, f), 'utf-8'));
      const overlap = skill.triggers.filter(t => triggerSet.has(t.toLowerCase()));
      if (overlap.length >= 2) return skill;
    } catch { /* skip */ }
  }
  return null;
}

/** Shared similarity logic across markdown skill dirs. */
function findSimilarInDirs(triggers: string[], dirs: string[], _isPending: boolean): SkillDocument | null {
  const triggerSet = new Set(triggers.map(t => t.toLowerCase()));

  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(path.join(dir, file), 'utf-8');
        const parsed = matter(content);
        const existingTriggers: string[] = parsed.data.triggers ?? [];
        const overlap = existingTriggers.filter(t => triggerSet.has(t.toLowerCase()));
        if (overlap.length >= 2) {
          return {
            name: file.replace('.md', ''),
            title: parsed.data.title ?? file,
            description: parsed.data.description ?? '',
            triggers: existingTriggers,
            source: parsed.data.source ?? 'manual',
            sourceJob: parsed.data.sourceJob,
            agentSlug: parsed.data.agentSlug,
            steps: parsed.content,
            toolsUsed: parsed.data.toolsUsed ?? [],
            useCount: parsed.data.useCount ?? 0,
            lastUsed: parsed.data.lastUsed,
            createdAt: parsed.data.createdAt ?? new Date().toISOString(),
            updatedAt: parsed.data.updatedAt ?? new Date().toISOString(),
          };
        }
      } catch { /* skip malformed */ }
    }
  }
  return null;
}

/** Merge a new skill into an existing approved one by refining the procedure. */
async function mergeSkill(
  assistant: PersonalAssistant,
  existing: SkillDocument,
  incoming: SkillDocument,
): Promise<SkillDocument | null> {
  try {
    const mergePrompt =
      `You have an existing skill and a new execution of a similar task. Merge them into a single improved skill.\n\n` +
      `## Existing Skill: ${existing.title}\n${existing.steps}\n\n` +
      `## New Execution\nTitle: ${incoming.title}\n${incoming.steps}\n\n` +
      `Produce an improved procedure that incorporates lessons from both. ` +
      `Keep what works, add new steps or improvements from the new execution, ` +
      `remove anything that was shown to be unnecessary.\n\n` +
      `Output ONLY a JSON object:\n` +
      `{ "steps": "improved markdown procedure", "triggers": ["merged trigger list"] }`;

    const result = await assistant.runPlanStep('skill-merge', mergePrompt, {
      tier: 1,
      maxTurns: 1,
      disableTools: true,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Merge triggers (union)
    const allTriggers = [...new Set([...existing.triggers, ...incoming.triggers, ...(parsed.triggers ?? [])])];

    const merged: SkillDocument = {
      ...existing,
      steps: parsed.steps ?? existing.steps,
      triggers: allTriggers,
      toolsUsed: [...new Set([...existing.toolsUsed, ...incoming.toolsUsed])],
      useCount: existing.useCount,
      updatedAt: new Date().toISOString(),
    };

    // Merges go directly to active (existing skill was already approved)
    saveActiveSkill(merged);
    logger.info({ name: merged.name }, 'Skill merged and updated');
    return merged;
  } catch (err) {
    logger.error({ err }, 'Skill merge failed');
    return null;
  }
}

// ── Skill Retrieval ─────────────────────────────────────────────────

/** Search skills by query text and return matching skill content for injection. Agent-scoped skills get a priority boost. */
export interface SkillMatch {
  name: string;
  title: string;
  content: string;
  score: number;
  toolsUsed: string[];
  attachments: string[];
  skillDir: string;
}

/**
 * Cache of skill embeddings so we don't re-embed every skill's frontmatter
 * on every query. Keyed by the absolute path of the skill file; invalidated
 * implicitly (the cache stays in memory for the daemon's lifetime — skill
 * edits require a restart, same as the rest of the skill pipeline).
 */
const skillEmbeddingCache = new Map<string, Float32Array>();

function getSkillEmbedding(filePath: string, triggers: string[], title: string, description: string): Float32Array | null {
  const cached = skillEmbeddingCache.get(filePath);
  if (cached) return cached;
  const corpus = [title, description, triggers.join(' ')].filter(Boolean).join(' ');
  if (!corpus) return null;
  const vec = embedText(corpus);
  if (vec) skillEmbeddingCache.set(filePath, vec);
  return vec;
}

export function searchSkills(
  query: string,
  limit = 3,
  agentSlug?: string,
  opts?: { suppressedNames?: Set<string> },
): SkillMatch[] {
  const dirs: Array<{ dir: string; boost: number }> = [];
  // Agent-scoped skills get priority (boost=2)
  if (agentSlug) {
    const agentDir = agentSkillsDir(agentSlug);
    if (existsSync(agentDir)) dirs.push({ dir: agentDir, boost: 2 });
  }
  // Global skills (no boost)
  if (existsSync(GLOBAL_SKILLS_DIR)) dirs.push({ dir: GLOBAL_SKILLS_DIR, boost: 0 });

  if (dirs.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results: SkillMatch[] = [];
  const seen = new Set<string>();
  const suppressed = opts?.suppressedNames;

  // Semantic matching is optional — only engages if the vault has built an
  // embedding vocabulary (MemoryStore.buildEmbeddings). Falls back to pure
  // keyword scoring for fresh installs.
  const useSemantic = embeddingsReady();
  const queryVec = useSemantic ? embedText(query) : null;

  for (const { dir, boost } of dirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const name = file.replace('.md', '');
      if (seen.has(name)) continue;
      seen.add(name);
      // Feedback-gated: skip skills that have been repeatedly associated with
      // negative user feedback (see store.getSkillsToSuppress).
      if (suppressed?.has(name)) continue;
      const filePath = path.join(dir, file);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = matter(raw);
        const triggers: string[] = parsed.data.triggers ?? [];
        const title: string = parsed.data.title ?? '';
        const description: string = parsed.data.description ?? '';

        // Score: trigger matches (high weight) + title/description word overlap + agent boost
        // Filter non-string triggers defensively — YAML quirks like leading "##"
        // parse as null and would crash toLowerCase(), causing the entire skill
        // to be silently dropped by the outer catch. Skip them instead.
        let score = 0;
        const triggerLower = triggers
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
          .map(t => t.toLowerCase());
        for (const word of queryWords) {
          for (const trigger of triggerLower) {
            if (trigger.includes(word) || word.includes(trigger)) score += 3;
          }
          if (title.toLowerCase().includes(word)) score += 2;
          if (description.toLowerCase().includes(word)) score += 1;
        }

        // Semantic bonus: add cosine similarity × 4 so a strong semantic
        // match (cos ~ 0.7+) contributes like a single keyword hit, and
        // very close matches (cos ~ 0.9+) surface as a solid lead even
        // when the user's phrasing doesn't share vocabulary with the
        // skill's triggers. Keyword hits still dominate when present.
        let semanticScore = 0;
        if (queryVec) {
          const skillVec = getSkillEmbedding(filePath, triggerLower, title, description);
          if (skillVec) {
            const cos = cosineSimilarity(queryVec, skillVec);
            if (cos > 0.3) semanticScore = cos * 4;
          }
        }

        const totalScore = score + semanticScore;
        if (totalScore > 0) {
          results.push({
            name,
            title,
            content: parsed.content.slice(0, 1500),
            score: totalScore + boost,
            toolsUsed: parsed.data.toolsUsed ?? [],
            attachments: parsed.data.attachments ?? [],
            skillDir: dir,
          });
        }
      } catch { /* skip */ }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Record that a skill was used (bump use count). */
export function recordSkillUse(skillName: string, agentSlug?: string): void {
  try {
    // Check agent dir first, then global
    const dirs = agentSlug ? [agentSkillsDir(agentSlug), GLOBAL_SKILLS_DIR] : [GLOBAL_SKILLS_DIR];
    for (const dir of dirs) {
      const filePath = path.join(dir, `${skillName}.md`);
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = matter(raw);
      parsed.data.useCount = (parsed.data.useCount ?? 0) + 1;
      parsed.data.lastUsed = new Date().toISOString();
      writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
      return;
    }
  } catch { /* non-fatal */ }
}

/** List all active skills (global + all agent-scoped). */
export function listSkills(agentSlug?: string): Array<{ name: string; title: string; source: string; useCount: number; updatedAt: string; agentSlug?: string }> {
  const results: ReturnType<typeof listSkills> = [];

  const dirs: Array<{ dir: string; slug?: string }> = [];
  if (agentSlug) {
    dirs.push({ dir: agentSkillsDir(agentSlug), slug: agentSlug });
  } else {
    dirs.push({ dir: GLOBAL_SKILLS_DIR });
  }

  for (const { dir, slug } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      try {
        const parsed = matter(readFileSync(path.join(dir, f), 'utf-8'));
        results.push({
          name: f.replace('.md', ''),
          title: parsed.data.title ?? f,
          source: parsed.data.source ?? 'unknown',
          useCount: parsed.data.useCount ?? 0,
          updatedAt: parsed.data.updatedAt ?? '',
          agentSlug: slug,
        });
      } catch { /* skip */ }
    }
  }

  return results;
}

// ── Stale skill archival ────────────────────────────────────────────

/**
 * Move skills that were never used (useCount=0, no usage telemetry rows) and
 * are older than `olderThanDays` to the `.archive/` subdirectory inside their
 * skill dir. Returns the list of archived skill names.
 *
 * `retrievalCount(name)` is consulted so that even skills whose frontmatter
 * useCount wasn't bumped (the FS write is best-effort) still get preserved
 * when the SQLite telemetry shows retrievals.
 */
export function archiveStaleSkills(
  olderThanDays = 90,
  retrievalCount?: (skillName: string) => number,
): string[] {
  ensureDirs();
  const archived: string[] = [];
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const dirs: string[] = [];
  if (existsSync(GLOBAL_SKILLS_DIR)) dirs.push(GLOBAL_SKILLS_DIR);
  if (existsSync(AGENTS_DIR)) {
    for (const entry of readdirSync(AGENTS_DIR)) {
      const candidate = path.join(AGENTS_DIR, entry, 'skills');
      if (existsSync(candidate)) dirs.push(candidate);
    }
  }

  for (const dir of dirs) {
    const archiveDir = path.join(dir, '.archive');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(dir, file);
      try {
        const parsed = matter(readFileSync(filePath, 'utf-8'));
        const name = file.replace(/\.md$/, '');
        const useCount = Number(parsed.data.useCount ?? 0);
        const createdAt = parsed.data.createdAt ? Date.parse(parsed.data.createdAt) : NaN;
        if (!Number.isFinite(createdAt) || createdAt > cutoffMs) continue;
        if (useCount > 0) continue;
        if (retrievalCount && retrievalCount(name) > 0) continue;

        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, file);
        copyFileSync(filePath, archivePath);
        unlinkSync(filePath);
        // Also move the backup if it exists
        const bakPath = filePath.replace(/\.md$/, '.md.bak');
        if (existsSync(bakPath)) {
          try { copyFileSync(bakPath, archivePath.replace(/\.md$/, '.md.bak')); unlinkSync(bakPath); }
          catch { /* best-effort */ }
        }
        archived.push(name);
        logger.info({ name, dir }, 'Archived stale skill (unused for ' + olderThanDays + '+ days)');
      } catch { /* skip malformed */ }
    }
  }

  return archived;
}

// ── Helpers ─────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
