/**
 * Cron-clean migrator (1.18.119)
 *
 * Migrates legacy cron jobs to the cleaner Skills-First contract model
 * without changing what the job DOES. Pure function — takes a
 * CronJobDefinition + the available skills inventory, returns the
 * migrated job + a list of human-readable changes + an eligibility flag.
 *
 * What "legacy" means in user-collected data:
 *   - `predictable` is undefined or false → at fire-time the runner injects
 *     MEMORY.md, recent team activity, the delegation queue, and auto-
 *     matches MCP servers based on prompt text.
 *   - The prompt body opens with a "TOOL RESTRICTIONS — MANDATORY" preamble
 *     listing forbidden + allowed tools in prose. This is leftover from
 *     before the runtime allowedTools field existed.
 *   - No skill is pinned even though the runtime auto-matches one (or
 *     several) every fire. The match is not deterministic and the user
 *     can't see what's being chosen.
 *   - No description field — the card shows the first 200 chars of the
 *     prompt, which is often the tool-restriction boilerplate.
 *
 * What "clean" looks like:
 *   - `predictable: true` (contract mode — runs only with what's attached).
 *   - `description:` populated (auto-generated from the matching skill's
 *     description if there is one, else the first sentence of the
 *     non-restriction prompt body).
 *   - `skills: [<name>]` pinned when a clear match exists.
 *   - `allowed_tools: [...]` pulled out of the "ALLOWED tools (the COMPLETE
 *     list)" line of the legacy preamble.
 *   - `prompt:` reduced to either "Run the {skill name} skill." (when a
 *     skill is pinned) or just the cleaned procedural part (when no skill
 *     match — preamble stripped).
 *
 * Eligibility — a job is eligible when it has at least one of:
 *   - the legacy preamble in its prompt, OR
 *   - predictable: undefined/false AND a candidate skill match.
 * If neither, the migrator returns `eligible: false` and leaves the job
 * unchanged. This keeps "ones that don't need to be fixed" out of the
 * migration UI entirely.
 */

import type { CronJobDefinition, Skill } from '../types.js';

export interface CronMigrationResult {
  /** True when migration would change something. False = "skip this one". */
  eligible: boolean;
  /** The migrated job (or the input job, untouched, when ineligible). */
  migrated: CronJobDefinition;
  /** Human-readable bullets — what the migrator did. Empty when not eligible. */
  changes: string[];
  /** When a skill match was applied, the matched skill's name. Surfaces in
   *  the migration UI so the user can verify. */
  matchedSkill?: string;
  /** Brief explanation when eligible:false — drives the dashboard's "this
   *  task already looks clean — nothing to do" affordance. */
  notEligibleReason?: string;
}

// ── Preamble detection + parsing ──────────────────────────────────────

const PREAMBLE_RE = /^TOOL RESTRICTIONS\s*[—-]\s*MANDATORY[\s\S]*?(?:\n\n|\r\n\r\n)/i;

/**
 * When the prompt opens with the canonical "TOOL RESTRICTIONS — MANDATORY"
 * preamble, this returns:
 *   - allowedTools: the parsed list of allowed tools (from the "ALLOWED
 *     tools (the COMPLETE list):" line)
 *   - cleanedPrompt: the rest of the prompt with the preamble removed
 *     and trimmed.
 * When no preamble is found, returns null and the caller treats the prompt
 * as already-clean.
 */
export function stripToolRestrictionsPreamble(
  rawPrompt: string,
): { allowedTools: string[]; cleanedPrompt: string } | null {
  if (!rawPrompt) return null;
  const m = rawPrompt.match(PREAMBLE_RE);
  if (!m) return null;
  const preamble = m[0];
  const cleanedPrompt = rawPrompt.slice(preamble.length).trim();

  // Extract the "ALLOWED tools (the COMPLETE list): a, b, c." line.
  // Tolerant of variations: "ALLOWED — list:", "ALLOWED tools list:", etc.
  const allowedMatch = preamble.match(
    /ALLOWED[\s\S]*?(?:list|tools)\s*\)?\s*:\s*([^.\n]+)/i,
  );
  const allowedTools: string[] = [];
  if (allowedMatch && allowedMatch[1]) {
    const list = allowedMatch[1]
      .split(/[,;]/)
      .map((s) => s.trim().replace(/[.,;:]+$/, ''))
      .filter(Boolean)
      .filter((s) => /^[a-zA-Z][\w-]*$/.test(s) || /^mcp__[\w-]+/.test(s));
    allowedTools.push(...list);
  }

  return { allowedTools, cleanedPrompt };
}

// ── Skill matching ────────────────────────────────────────────────────

/**
 * Returns a skill from the catalog that matches this job by either:
 *   1. Exact name match (job "morning-briefing" → skill "morning-briefing")
 *   2. Job name appears in skill triggers (job "audit-inbox-check" →
 *      skill "checking-audit-inbox" with trigger "audit inbox check")
 *   3. Job-name keyword overlap with skill description (looser, last resort).
 *
 * Returns null when no clear match exists. The migrator then leaves the
 * skill pin off and just strips the preamble — still an improvement.
 */
export function findMatchingSkill(
  job: CronJobDefinition,
  skills: Skill[],
): Skill | null {
  const jobName = job.name.toLowerCase();
  const jobNameWords = new Set(jobName.split(/[-_]/).filter((w) => w.length > 2));

  // 1. Exact name match
  for (const s of skills) {
    if (s.frontmatter.name.toLowerCase() === jobName) return s;
  }

  // 2. Trigger phrase contains the job-name word set
  for (const s of skills) {
    const triggers = s.frontmatter.clementine?.triggers ?? [];
    for (const trigger of triggers) {
      const triggerWords = String(trigger).toLowerCase().split(/\s+/);
      const triggerWordSet = new Set(triggerWords);
      // Match if all job-name words appear in trigger words (in any order)
      let allMatch = true;
      for (const w of jobNameWords) {
        if (!triggerWordSet.has(w)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch && jobNameWords.size > 0) return s;
    }
  }

  // 3. Job-name word overlap with skill name (substring fallback —
  //    catches "audit-inbox-check" → "checking-audit-inbox" via shared
  //    "audit" + "inbox" word tokens).
  for (const s of skills) {
    const skillNameWords = new Set(
      s.frontmatter.name.toLowerCase().split(/[-_]/).filter((w) => w.length > 2),
    );
    let overlap = 0;
    for (const w of jobNameWords) if (skillNameWords.has(w)) overlap++;
    // Need ≥2 overlapping content words for a confident match (avoids
    // matching every "build-*" job to a single "build" skill).
    if (overlap >= 2) return s;
  }

  return null;
}

// ── Description generation ────────────────────────────────────────────

/**
 * Picks a 1-paragraph description for the migrated job.
 * Priority:
 *   1. The matched skill's description (best — it's already curated).
 *   2. First sentence of the cleaned prompt body, ≤240 chars.
 *   3. Empty string when prompt is empty or unintelligible — the caller
 *      then leaves the description field unset.
 */
export function generateDescription(
  cleanedPrompt: string,
  matchedSkill: Skill | null,
): string {
  if (matchedSkill?.frontmatter.description) {
    return matchedSkill.frontmatter.description.trim().slice(0, 500);
  }
  if (!cleanedPrompt) return '';
  // First sentence — match up to ., !, ?, or first newline-newline.
  // Falls back to first 200 chars when the body is one giant paragraph.
  const sentenceMatch = cleanedPrompt.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const candidate = (sentenceMatch ? sentenceMatch[0] : cleanedPrompt.slice(0, 200))
    .trim()
    .replace(/\s+/g, ' ');
  return candidate.slice(0, 240);
}

// ── The migration itself ──────────────────────────────────────────────

/**
 * Apply the clean-format migration to one cron job. Pure function —
 * does NOT touch disk. Returns the new definition + the list of changes.
 *
 * Idempotent: passing an already-clean job back through returns
 * `eligible: false` with `notEligibleReason`. Safe to call on every
 * job in a vault and filter by eligibility.
 *
 * The caller (an HTTP endpoint or CLI) is responsible for:
 *   - serializing the result back to YAML
 *   - writing the .bak file
 *   - replacing the job in CRON.md
 *   - returning the diff to the dashboard
 */
export function migrateCronJob(
  job: CronJobDefinition,
  skills: Skill[],
): CronMigrationResult {
  const changes: string[] = [];

  // 1. Detect the legacy preamble.
  const stripped = stripToolRestrictionsPreamble(job.prompt);
  const hasPreamble = stripped !== null;

  // 2. Find a matching skill (or null).
  const matchedSkill = findMatchingSkill(job, skills);

  // 3. Eligibility — anything that looks legacy is eligible.
  const isLegacyPredictable = job.predictable !== true;
  const hasNoDescription = !job.description || !job.description.trim();
  const hasNoSkillsButCouldPinOne = (!job.skills || job.skills.length === 0) && matchedSkill !== null;

  if (!hasPreamble && !isLegacyPredictable && !hasNoDescription && !hasNoSkillsButCouldPinOne) {
    return {
      eligible: false,
      migrated: job,
      changes: [],
      matchedSkill: matchedSkill?.frontmatter.name,
      notEligibleReason: 'Already clean — has predictable=true, a description, no legacy preamble, and either pinned skills or no skill match.',
    };
  }

  // 4. Build the migrated definition. Start from a shallow copy so we
  //    don't mutate the input.
  const migrated: CronJobDefinition = { ...job };

  // 4a. Set predictable: true (the headline contract-mode flip).
  if (isLegacyPredictable) {
    migrated.predictable = true;
    changes.push('Enabled Strict mode (no auto-injected memory or team comms at fire-time).');
  }

  // 4b. Strip the preamble + populate allowed_tools.
  let cleanedPrompt = job.prompt;
  if (hasPreamble && stripped) {
    cleanedPrompt = stripped.cleanedPrompt;
    changes.push('Stripped TOOL RESTRICTIONS preamble from the prompt.');
    if (stripped.allowedTools.length > 0) {
      // Merge with any existing allowedTools so we don't lose tool-level
      // narrowing the user already had.
      const existing = new Set(job.allowedTools ?? []);
      for (const t of stripped.allowedTools) existing.add(t);
      migrated.allowedTools = [...existing];
      changes.push(
        `Moved ${stripped.allowedTools.length} tool name${stripped.allowedTools.length === 1 ? '' : 's'} into the allowed_tools field (${stripped.allowedTools.slice(0, 3).join(', ')}${stripped.allowedTools.length > 3 ? `, +${stripped.allowedTools.length - 3} more` : ''}).`,
      );
    }
  }

  // 4c. Pin the matched skill + replace the prompt with a thin invocation.
  if (matchedSkill && (!job.skills || job.skills.length === 0)) {
    const pinned = [matchedSkill.frontmatter.name];
    migrated.skills = pinned;
    changes.push(`Pinned matching skill: \`${matchedSkill.frontmatter.name}\` (was being auto-matched at fire-time).`);
    // Reduce the prompt to a thin reference. The skill body carries the
    // procedure; the cron prompt just needs to invoke it. Keep ANY
    // post-preamble text the user added that wasn't already in the skill —
    // when in doubt, prefer "Run the X skill." for a true clean migration.
    const remainsBeyondSkill = (cleanedPrompt || '').trim();
    const nameLabel = matchedSkill.frontmatter.title || matchedSkill.frontmatter.name;
    migrated.prompt = `Run the ${nameLabel} skill.`;
    if (remainsBeyondSkill && remainsBeyondSkill.length > 50) {
      // The user had additional instructions after the preamble that aren't
      // in the skill body. Append them so we don't lose intent. Length cap
      // ensures we don't accidentally re-add the boilerplate we just stripped.
      migrated.prompt += `\n\n${remainsBeyondSkill.slice(0, 1000)}`;
      changes.push('Preserved additional prompt instructions after the skill invocation.');
    }
  } else if (hasPreamble) {
    // No skill match but we did strip the preamble — just save the
    // cleaned prompt. Still an improvement: the card preview will now
    // show actual instructions, not boilerplate.
    migrated.prompt = cleanedPrompt.trim();
  }

  // 4d. Generate description if missing.
  if (!job.description || !job.description.trim()) {
    const desc = generateDescription(
      stripped?.cleanedPrompt || job.prompt,
      matchedSkill,
    );
    if (desc) {
      migrated.description = desc;
      changes.push(`Added description: "${desc.slice(0, 80)}${desc.length > 80 ? '…' : ''}".`);
    }
  }

  return {
    eligible: changes.length > 0,
    migrated,
    changes,
    matchedSkill: matchedSkill?.frontmatter.name,
    notEligibleReason: changes.length === 0
      ? 'No legacy markers detected — task already follows the clean format.'
      : undefined,
  };
}

/**
 * Run migrateCronJob across an entire CRON.md inventory. Returns:
 *   - eligible: jobs that would be migrated, with their migration result
 *   - skipped: jobs that look already-clean (eligibility=false)
 *
 * Used by the bulk-migrate UI to preview the full impact before the user
 * commits to changes.
 */
export function migrateAllEligibleJobs(
  jobs: CronJobDefinition[],
  skills: Skill[],
): {
  eligible: Array<{ job: CronJobDefinition; result: CronMigrationResult }>;
  skipped: Array<{ job: CronJobDefinition; reason: string }>;
} {
  const eligible: Array<{ job: CronJobDefinition; result: CronMigrationResult }> = [];
  const skipped: Array<{ job: CronJobDefinition; reason: string }> = [];
  for (const job of jobs) {
    const result = migrateCronJob(job, skills);
    if (result.eligible) {
      eligible.push({ job, result });
    } else {
      skipped.push({ job, reason: result.notEligibleReason || 'Already clean.' });
    }
  }
  return { eligible, skipped };
}
