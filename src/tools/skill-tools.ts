/**
 * Skill MCP tools (1.18.120)
 *
 * Lets the agent (and therefore the user, via chat in Discord / dashboard /
 * Slack / Telegram) author and update skills in natural language.
 *
 * Why this matters:
 *   - Before this, creating a skill required either editing files by hand
 *     or clicking through the dashboard's "+ New skill" modal.
 *   - With these tools registered, a Discord message like "Hey Clem,
 *     create a skill called morning-deal-review that checks the deal
 *     pipeline at 8am every weekday" can produce a real `<name>/SKILL.md`
 *     folder on disk, ready to pin to a cron.
 *
 * The tools are intentionally thin wrappers around the existing skill-store
 * write path. The Anthropic-spec validation (name regex, ≤1024-char
 * description, body presence) is enforced by both the dashboard endpoint
 * and these tools, so you can't smuggle a bad skill through the chat path.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillDataSource, SkillInputSchema, SkillLimits, SkillSuccess } from '../types.js';

import { ACTIVE_AGENT_SLUG, textResult, logger } from './shared.js';

// 1.18.124 — name regex is the only validator skill-tools still uses
// directly (for update_skill's pre-flight slug check). All other
// validations + the file write live in skill-store.writeSkill.
// 1.18.144 — pulled the regex from skill-store's exported canonical
// constant so all skill-name validation now traces to one source.
import { ANTHROPIC_SKILL_NAME_PATTERN } from '../agent/skill-store.js';
const NAME_PATTERN = ANTHROPIC_SKILL_NAME_PATTERN;

const SOURCE_VALUES = new Set(['manual', 'chat', 'auto', 'imported']);

function resolveAgentSlug(agentSlug?: string | null): string | undefined {
  if (agentSlug === null) return undefined;
  const raw = typeof agentSlug === 'string' && agentSlug.trim() ? agentSlug.trim() : ACTIVE_AGENT_SLUG;
  return raw || undefined;
}

function preservedSource(value: unknown): 'manual' | 'chat' | 'auto' | 'imported' {
  return typeof value === 'string' && SOURCE_VALUES.has(value)
    ? value as 'manual' | 'chat' | 'auto' | 'imported'
    : 'chat';
}

function normalizeDataSources(dataSources: unknown): SkillDataSource[] | undefined {
  if (!Array.isArray(dataSources)) return undefined;
  const normalized = dataSources
    .map((d): SkillDataSource | null => {
      if (typeof d === 'string') {
        const trimmed = d.trim();
        return trimmed ? { kind: 'source', purpose: trimmed } : null;
      }
      if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
      const r = d as Record<string, unknown>;
      const kind = String(r.kind || 'source').trim() || 'source';
      const purpose = String(r.purpose || r.name || '').trim();
      return purpose ? { kind, purpose } : null;
    })
    .filter((d): d is SkillDataSource => !!d);
  return normalized.length > 0 ? normalized : [];
}

function normalizeSuccess(successCriteria: unknown): SkillSuccess | undefined {
  if (typeof successCriteria !== 'string') return undefined;
  const criterion = successCriteria.trim();
  return criterion ? { criterion } : {};
}

function normalizeInputs(inputs: unknown): Record<string, SkillInputSchema> | undefined {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return undefined;
  return inputs as Record<string, SkillInputSchema>;
}

function normalizeLimits(limits: unknown): SkillLimits | undefined {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return undefined;
  const r = limits as Record<string, unknown>;
  const out: SkillLimits = {};
  if (typeof r.maxTurns === 'number') out.maxTurns = r.maxTurns;
  if (typeof r.maxBudgetUsd === 'number') out.maxBudgetUsd = r.maxBudgetUsd;
  if (typeof r.timeoutSeconds === 'number') out.timeoutSeconds = r.timeoutSeconds;
  return Object.keys(out).length > 0 ? out : {};
}

export function registerSkillTools(server: McpServer): void {
  // ── create_skill ────────────────────────────────────────────────────
  // Writes a folder-form skill to ~/.clementine/vault/00-System/skills/<name>/SKILL.md
  // with Anthropic-canonical frontmatter (name + description top-level)
  // and Clementine extensions (tools.allow, source: chat) under the
  // `clementine` namespace.
  server.tool(
    'create_skill',
    'Create a reusable folder-form skill at <name>/SKILL.md. Use only when the user asks to save/teach/reuse/schedule a procedure.',
    {
      name: z.string()
        .describe('Skill slug: lowercase letters, digits, hyphens; max 64 chars.'),
      title: z.string().optional()
        .describe('Optional display name.'),
      description: z.string()
        .describe('What the skill does and when to use it. Max 1024 chars.'),
      body: z.string()
        .describe('Markdown procedure. Keep concise; link/bundle long references.'),
      tools: z.array(z.string()).optional()
        .describe('Exact tool allowlist, e.g. Bash or mcp__server__tool.'),
      triggers: z.array(z.string()).optional()
        .describe('Optional phrases that should match this skill.'),
      inputs: z.record(z.string(), z.any()).optional()
        .describe('Optional input schema for {{var}} placeholders.'),
      dataSources: z.array(z.union([
        z.string(),
        z.object({ kind: z.string().optional(), purpose: z.string() }),
      ])).optional()
        .describe('Optional source dependencies.'),
      successCriteria: z.string().optional()
        .describe('Optional completion criterion.'),
      limits: z.object({
        maxTurns: z.number().optional(),
        maxBudgetUsd: z.number().optional(),
        timeoutSeconds: z.number().optional(),
      }).optional()
        .describe('Optional runtime limits.'),
      agentSlug: z.string().nullable().optional()
        .describe('Optional agent owner; null means global.'),
    },
    async ({ name, title, description, body, tools, triggers, inputs, dataSources, successCriteria, limits, agentSlug }) => {
      // 1.18.124 — delegate to the shared writeSkill helper. Validation
      // (name regex, length caps, reserved words, already-exists) is
      // now centralized; the same checks run for the dashboard endpoint
      // and the auto-extraction path.
      try {
        const { writeSkill } = await import('../agent/skill-store.js');
        const scopedAgent = resolveAgentSlug(agentSlug);
        const result = writeSkill({
          name,
          title,
          description,
          body,
          tools,
          triggers,
          inputs: normalizeInputs(inputs),
          dataSources: normalizeDataSources(dataSources),
          success: normalizeSuccess(successCriteria),
          limits: normalizeLimits(limits),
          source: 'chat',
          ...(scopedAgent ? { agentSlug: scopedAgent } : {}),
        });
        logger.info({ name: result.name, entryPath: result.filePath, source: 'chat', agentSlug: scopedAgent ?? null }, 'Skill created via chat');
        const toolsLine = (tools && tools.length > 0) ? `\nAllowed tools: ${tools.slice(0, 5).join(', ')}${tools.length > 5 ? `, +${tools.length - 5} more` : ''}` : '';
        const triggersLine = (triggers && triggers.length > 0) ? `\nTriggers: ${triggers.slice(0, 4).join(', ')}${triggers.length > 4 ? `, +${triggers.length - 4} more` : ''}` : '';
        const scopeLine = scopedAgent ? `\nScope: agent ${scopedAgent}` : '\nScope: global';
        return textResult(
          `✅ Created skill "${result.name}" at ${result.filePath}\n` +
          `Description: ${description.slice(0, 200)}${description.length > 200 ? '…' : ''}` +
          toolsLine +
          triggersLine +
          scopeLine +
          `\n\nThe skill is ready to schedule or run manually — open Skills/Schedules in the dashboard and select "${result.name}", or invoke it directly in chat: "Run the ${title || result.name} skill."`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already exists')) {
          return textResult(`❌ Skill "${name}" already exists. Use update_skill instead, or pick a different name.`);
        }
        logger.error({ err, name }, 'create_skill failed');
        return textResult(`❌ ${msg}`);
      }
    },
  );

  // ── update_skill ────────────────────────────────────────────────────
  // Edits an existing skill. Preserves frontmatter the caller doesn't
  // touch (useCount, lastUsed, migration provenance, custom fields) so
  // chat edits don't reset the lifecycle metadata.
  server.tool(
    'update_skill',
    'Update an existing skill while preserving lifecycle metadata.',
    {
      name: z.string().describe('Skill slug.'),
      description: z.string().optional().describe('New description; max 1024 chars.'),
      body: z.string().optional().describe('New Markdown procedure.'),
      tools: z.array(z.string()).optional().describe('New exact tool allowlist; [] clears.'),
      triggers: z.array(z.string()).optional().describe('New trigger phrases; [] clears.'),
      inputs: z.record(z.string(), z.any()).optional().describe('New input schema; {} clears.'),
      dataSources: z.array(z.union([
        z.string(),
        z.object({ kind: z.string().optional(), purpose: z.string() }),
      ])).optional().describe('New data sources; [] clears.'),
      successCriteria: z.string().optional().describe('New success criterion; empty clears.'),
      limits: z.object({
        maxTurns: z.number().optional(),
        maxBudgetUsd: z.number().optional(),
        timeoutSeconds: z.number().optional(),
      }).optional().describe('New runtime limits; {} clears.'),
      agentSlug: z.string().nullable().optional().describe('Optional agent scope; null means global.'),
    },
    async ({ name, description, body, tools, triggers, inputs, dataSources, successCriteria, limits, agentSlug }) => {
      if (!NAME_PATTERN.test(name)) {
        return textResult(`❌ Name "${name}" is not a valid skill slug.`);
      }

      try {
        const scopedAgent = resolveAgentSlug(agentSlug);
        const { getSkill, writeSkill } = await import('../agent/skill-store.js');
        const skill = getSkill(name, { agentSlug: scopedAgent });
        if (!skill) {
          return textResult(`❌ Skill "${name}" not found${scopedAgent ? ` for ${scopedAgent} or global scope` : ''}. Use create_skill if you want to author it from scratch.`);
        }
        const ext = skill.frontmatter.clementine;
        const targetAgentSlug = skill.scope === 'agent' ? scopedAgent : undefined;
        const result = writeSkill({
          name,
          title: skill.frontmatter.title,
          description: description ?? skill.frontmatter.description ?? `Reusable skill "${name}". Use when this procedure is relevant.`,
          body: body ?? skill.body,
          tools,
          triggers,
          inputs: inputs !== undefined ? normalizeInputs(inputs) ?? {} : undefined,
          dataSources: dataSources !== undefined ? normalizeDataSources(dataSources) ?? [] : undefined,
          success: successCriteria !== undefined ? normalizeSuccess(successCriteria) ?? {} : undefined,
          limits: limits !== undefined ? normalizeLimits(limits) ?? {} : undefined,
          source: preservedSource(ext?.source),
          ...(targetAgentSlug ? { agentSlug: targetAgentSlug } : {}),
          overwrite: true,
        });
        logger.info({ name, targetPath: result.filePath, source: 'chat', agentSlug: targetAgentSlug ?? null }, 'Skill updated via chat');

        const changed: string[] = [];
        if (description !== undefined) changed.push('description');
        if (body !== undefined) changed.push('body');
        if (tools !== undefined) changed.push('tools');
        if (triggers !== undefined) changed.push('triggers');
        if (inputs !== undefined) changed.push('inputs');
        if (dataSources !== undefined) changed.push('dataSources');
        if (successCriteria !== undefined) changed.push('success');
        if (limits !== undefined) changed.push('limits');
        return textResult(
          `✅ Updated skill "${name}" — changed: ${changed.join(', ') || '(no fields specified)'}.\n` +
          `Path: ${result.filePath}`,
        );
      } catch (err) {
        logger.error({ err, name }, 'update_skill failed');
        return textResult(`❌ Failed to update the skill: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── list_skills ─────────────────────────────────────────────────────
  // Read-only — lets the agent answer "what skills do I have?" in chat
  // without needing to fall back to file-system tools.
  server.tool(
    'list_skills',
    'List skills visible to this chat context.',
    {
      agentSlug: z.string().nullable().optional().describe('Optional agent scope. Defaults to the active hired agent when present.'),
    },
    async ({ agentSlug }) => {
      try {
        const { listSkills } = await import('../agent/skill-store.js');
        const scopedAgent = resolveAgentSlug(agentSlug);
        const skills = listSkills({ agentSlug: scopedAgent });
        if (skills.length === 0) return textResult('No skills found yet. Use create_skill to author your first one.');
        const lines = skills.map(s => {
          const fm = s.frontmatter;
          const title = fm.title || fm.name;
          const desc = fm.description || '';
          const scope = s.scope === 'agent' && scopedAgent ? `agent:${scopedAgent}` : s.scope;
          return `• ${title} (\`${fm.name}\`) [${scope}/${s.layout}/${s.schemaVersion}] — ${desc.slice(0, 120)}${desc.length > 120 ? '…' : ''}`;
        });
        return textResult(`${skills.length} skill${skills.length === 1 ? '' : 's'}${scopedAgent ? ` visible to ${scopedAgent}` : ''}:\n\n${lines.join('\n')}`);
      } catch (err) {
        return textResult(`❌ Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── run_skill (1.18.162) ────────────────────────────────────────────
  // Invoke a skill as a hard-allowlisted sub-call. Mustache substitutes
  // `{{var}}` placeholders in the skill body from `inputs`, runs through
  // the SDK with ONLY the skill's clementine.tools.allow + a baseline
  // (Agent/Read/Glob/Grep) + auto-extracted mcp__*__* refs from the body,
  // and validates against clementine.success.schema if declared.
  //
  // Use this when a chat or another skill needs to *execute* a procedure
  // (not just reference it). Pinned-skills-as-context (the existing 1.18.121
  // widening path) is for the cron prompt; this is for callable execution.
  server.tool(
    'run_skill',
    'Execute a named skill with its declared tool allowlist and optional inputs.',
    {
      name: z.string().regex(NAME_PATTERN).describe('Existing skill slug.'),
      inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe('Values for {{var}} placeholders.'),
      context: z.string().optional()
        .describe('Optional caller context.'),
      agentSlug: z.string().nullable().optional()
        .describe('Optional agent scope; null means global.'),
    },
    async ({ name, inputs, context, agentSlug }: { name: string; inputs?: Record<string, string | number | boolean>; context?: string; agentSlug?: string | null }) => {
      try {
        // Lazy import — runSkill pulls in run-agent + the SDK; only load on
        // demand so `list_skills` etc stay fast and the MCP server boots
        // without warming the whole agent path.
        const { runSkill } = await import('../agent/run-skill.js');
        const result = await runSkill(name, { inputs, context, source: 'mcp:run_skill', agentSlug: resolveAgentSlug(agentSlug) });

        if (!result.ok) {
          return textResult(`❌ run_skill(${name}) failed: ${result.error ?? 'unknown error'}`);
        }

        const validationLine = result.validation
          ? `\n\n**Schema:** ${result.validation.tried ? (result.validation.pass ? '✅ pass' : `❌ fail — ${result.validation.errors.slice(0, 2).join('; ')}`) : '(skipped — no JSON in output)'}`
          : '';
        const meta = `\n\n_${result.turns ?? 0} turns · $${(result.cost ?? 0).toFixed(4)} · ${result.effectiveTools?.length ?? 0} tools allowed_${validationLine}`;
        return textResult(`${result.output}${meta}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, skill: name }, 'run_skill failed');
        return textResult(`❌ run_skill(${name}) failed: ${msg}`);
      }
    },
  );
}
