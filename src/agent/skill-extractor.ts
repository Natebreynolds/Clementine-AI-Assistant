/**
 * Clementine TypeScript — Procedural Memory (Skill Extraction + Retrieval).
 *
 * Extracts reusable skill documents from successful multi-step executions
 * (unleashed jobs, cron runs, complex chat interactions) and stores them
 * as markdown files in vault/00-System/skills/.
 *
 * Skills are automatically indexed by the memory store FTS5 and retrieved
 * during context search to avoid re-deriving procedures from scratch.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';

import { VAULT_DIR } from '../config.js';
import type { SkillDocument } from '../types.js';
import type { PersonalAssistant } from './assistant.js';

const logger = pino({ name: 'clementine.skills' });

const SKILLS_DIR = path.join(VAULT_DIR, '00-System', 'skills');

function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
}

// ── Skill Extraction ────────────────────────────────────────────────

/**
 * Extract a reusable skill from a successful execution.
 * Runs a lightweight LLM call to distill the procedure.
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

    // Check for duplicate/similar skills before saving
    const existing = findSimilarSkill(skill.triggers);
    if (existing) {
      logger.info({ name: existing.name, newTitle: skill.title }, 'Similar skill exists — merging');
      return mergeSkill(assistant, existing, skill);
    }

    saveSkill(skill);
    return skill;
  } catch (err) {
    logger.error({ err, source: context.source }, 'Skill extraction failed');
    return null;
  }
}

// ── Skill Storage ───────────────────────────────────────────────────

/** Save a skill document to the vault as a markdown file. */
function saveSkill(skill: SkillDocument): void {
  ensureSkillsDir();

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
  const filePath = path.join(SKILLS_DIR, `${skill.name}.md`);
  writeFileSync(filePath, content);

  logger.info({ name: skill.name, source: skill.source }, 'Skill saved');
}

/** Find a skill with overlapping triggers. */
function findSimilarSkill(triggers: string[]): SkillDocument | null {
  if (!existsSync(SKILLS_DIR)) return null;

  const triggerSet = new Set(triggers.map(t => t.toLowerCase()));
  const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = readFileSync(path.join(SKILLS_DIR, file), 'utf-8');
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
  return null;
}

/** Merge a new skill into an existing one by refining the procedure. */
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

    saveSkill(merged);
    logger.info({ name: merged.name }, 'Skill merged and updated');
    return merged;
  } catch (err) {
    logger.error({ err }, 'Skill merge failed');
    return null;
  }
}

// ── Skill Retrieval ─────────────────────────────────────────────────

/** Search skills by query text and return matching skill content for injection. Agent-scoped skills get a priority boost. */
export function searchSkills(query: string, limit = 3, agentSlug?: string): Array<{ name: string; title: string; content: string; score: number }> {
  const dirs: Array<{ dir: string; boost: number }> = [];
  // Agent-scoped skills get priority (boost=2)
  if (agentSlug) {
    const agentDir = path.join(VAULT_DIR, '00-System', 'agents', agentSlug, 'skills');
    if (existsSync(agentDir)) dirs.push({ dir: agentDir, boost: 2 });
  }
  // Global skills (no boost)
  if (existsSync(SKILLS_DIR)) dirs.push({ dir: SKILLS_DIR, boost: 0 });

  if (dirs.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results: Array<{ name: string; title: string; content: string; score: number }> = [];
  const seen = new Set<string>();

  for (const { dir, boost } of dirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const name = file.replace('.md', '');
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const raw = readFileSync(path.join(dir, file), 'utf-8');
        const parsed = matter(raw);
        const triggers: string[] = parsed.data.triggers ?? [];
        const title: string = parsed.data.title ?? '';
        const description: string = parsed.data.description ?? '';

        // Score: trigger matches (high weight) + title/description word overlap + agent boost
        let score = 0;
        const triggerLower = triggers.map(t => t.toLowerCase());
        for (const word of queryWords) {
          for (const trigger of triggerLower) {
            if (trigger.includes(word) || word.includes(trigger)) score += 3;
          }
          if (title.toLowerCase().includes(word)) score += 2;
          if (description.toLowerCase().includes(word)) score += 1;
        }

        if (score > 0) {
          results.push({
            name,
            title,
            content: parsed.content.slice(0, 1500),
            score: score + boost,
          });
        }
      } catch { /* skip */ }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Record that a skill was used (bump use count). */
export function recordSkillUse(skillName: string): void {
  try {
    const filePath = path.join(SKILLS_DIR, `${skillName}.md`);
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    parsed.data.useCount = (parsed.data.useCount ?? 0) + 1;
    parsed.data.lastUsed = new Date().toISOString();
    writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
  } catch { /* non-fatal */ }
}

/** List all skills (for dashboard/status). */
export function listSkills(): Array<{ name: string; title: string; source: string; useCount: number; updatedAt: string }> {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      try {
        const parsed = matter(readFileSync(path.join(SKILLS_DIR, f), 'utf-8'));
        return {
          name: f.replace('.md', ''),
          title: parsed.data.title ?? f,
          source: parsed.data.source ?? 'unknown',
          useCount: parsed.data.useCount ?? 0,
          updatedAt: parsed.data.updatedAt ?? '',
        };
      } catch { return null; }
    })
    .filter(Boolean) as any[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
