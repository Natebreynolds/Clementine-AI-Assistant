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

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { VAULT_DIR, textResult, logger } from './shared.js';

// Anthropic spec — keep these in sync with skill-store.validateSkill.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const RESERVED_NAMES = new Set(['anthropic', 'claude']);

function globalSkillsDir(): string {
  return path.join(VAULT_DIR, '00-System', 'skills');
}

export function registerSkillTools(server: McpServer): void {
  // ── create_skill ────────────────────────────────────────────────────
  // Writes a folder-form skill to ~/.clementine/vault/00-System/skills/<name>/SKILL.md
  // with Anthropic-canonical frontmatter (name + description top-level)
  // and Clementine extensions (tools.allow, source: chat) under the
  // `clementine` namespace.
  server.tool(
    'create_skill',
    'Author a new reusable skill (a recipe Claude follows when invoked). Writes <name>/SKILL.md in the vault. Returns the skill name + path on success. Anthropic spec: name must match ^[a-z0-9][a-z0-9-]{0,63}$ and description ≤1024 chars.',
    {
      name: z.string()
        .describe('Skill slug — lowercase letters/digits/dashes, max 64 chars, must start with a letter or digit. Example: "morning-deal-review".'),
      title: z.string().optional()
        .describe('Optional friendlier display name. Example: "Morning Deal Review".'),
      description: z.string()
        .describe('One-paragraph summary of what this skill does and when Claude should run it. Used by the runtime auto-matcher AND surfaced as the cron task card preview when the skill is pinned. Max 1024 chars.'),
      body: z.string()
        .describe('The procedure body in Markdown. Use headers (# / ##), numbered lists, code fences. Max 500 lines is best practice. Example: "# Morning Deal Review\\n\\n1. Pull deals updated in the last 24h.\\n2. Surface high-value ones." '),
      tools: z.array(z.string()).optional()
        .describe('Optional allowlist of tool names this skill should restrict itself to (e.g. ["Read", "Bash", "memory_search"]). Stored under clementine.tools.allow. Empty/omitted means inherit the cron task or chat session defaults.'),
      triggers: z.array(z.string()).optional()
        .describe('Optional natural-language phrases that should auto-match this skill at runtime (e.g. ["morning deal review", "check deals today"]). Stored under clementine.triggers. Pinned skills don\'t need triggers — they fire by name.'),
    },
    async ({ name, title, description, body, tools, triggers }) => {
      // Validate per Anthropic spec
      if (!NAME_PATTERN.test(name)) {
        return textResult(`❌ Name "${name}" doesn't match the spec. Use lowercase letters, digits, and dashes only — must start with a letter or digit, max 64 chars.`);
      }
      if (name.length > NAME_MAX_LEN) {
        return textResult(`❌ Name is too long (${name.length} chars). Max is ${NAME_MAX_LEN}.`);
      }
      if (RESERVED_NAMES.has(name) || /\b(anthropic|claude)\b/i.test(name)) {
        return textResult(`❌ Name "${name}" uses a reserved word ("anthropic" or "claude"). Pick another.`);
      }
      if (!description || !description.trim()) {
        return textResult('❌ Description is required — Claude uses it to decide when to apply this skill.');
      }
      if (description.length > DESCRIPTION_MAX_LEN) {
        return textResult(`❌ Description is too long (${description.length} chars). Max is ${DESCRIPTION_MAX_LEN}.`);
      }
      if (!body || !body.trim()) {
        return textResult('❌ Procedure body is required — that\'s what Claude actually runs.');
      }

      const skillsDir = globalSkillsDir();
      const folderPath = path.join(skillsDir, name);
      const entryPath = path.join(folderPath, 'SKILL.md');
      if (existsSync(entryPath)) {
        return textResult(`❌ Skill "${name}" already exists at ${entryPath}. Use update_skill instead, or pick a different name.`);
      }

      try {
        mkdirSync(folderPath, { recursive: true });
        const now = new Date().toISOString();
        const fm: Record<string, unknown> = { name, description };
        if (title && title.trim()) fm.title = title.trim();
        const clementineExt: Record<string, unknown> = {
          source: 'chat',
          useCount: 0,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        if (Array.isArray(tools) && tools.length > 0) {
          clementineExt.tools = { allow: tools.map(String).map(s => s.trim()).filter(Boolean) };
        }
        if (Array.isArray(triggers) && triggers.length > 0) {
          clementineExt.triggers = triggers.map(String).map(s => s.trim()).filter(Boolean);
        }
        fm.clementine = clementineExt;
        const content = matter.stringify(body.endsWith('\n') ? body : body + '\n', fm);
        writeFileSync(entryPath, content);
        logger.info({ name, entryPath, source: 'chat' }, 'Skill created via chat');

        const toolsLine = (tools && tools.length > 0) ? `\nAllowed tools: ${tools.slice(0, 5).join(', ')}${tools.length > 5 ? `, +${tools.length - 5} more` : ''}` : '';
        const triggersLine = (triggers && triggers.length > 0) ? `\nTriggers: ${triggers.slice(0, 4).join(', ')}${triggers.length > 4 ? `, +${triggers.length - 4} more` : ''}` : '';
        return textResult(
          `✅ Created skill "${name}" at ${entryPath}\n` +
          `Description: ${description.slice(0, 200)}${description.length > 200 ? '…' : ''}` +
          toolsLine +
          triggersLine +
          `\n\nThe skill is ready to pin to any task — open the cron editor, go to Tools & MCP, click "+ Add skill" and select "${name}". Or invoke it directly in chat: "Run the ${title || name} skill."`,
        );
      } catch (err) {
        logger.error({ err, name }, 'create_skill failed');
        return textResult(`❌ Failed to write the skill: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── update_skill ────────────────────────────────────────────────────
  // Edits an existing skill. Preserves frontmatter the caller doesn't
  // touch (useCount, lastUsed, migration provenance, custom fields) so
  // chat edits don't reset the lifecycle metadata.
  server.tool(
    'update_skill',
    'Update an existing skill\'s description, body, tools, or triggers. Preserves lifecycle metadata (useCount, createdAt, etc.). Returns the updated path on success.',
    {
      name: z.string().describe('Slug of the skill to update (e.g. "morning-deal-review").'),
      description: z.string().optional().describe('New description (one paragraph, ≤1024 chars).'),
      body: z.string().optional().describe('New procedure body (Markdown). Replaces the existing body in full.'),
      tools: z.array(z.string()).optional().describe('New allowlist for clementine.tools.allow. Pass [] to clear.'),
      triggers: z.array(z.string()).optional().describe('New trigger phrase list for clementine.triggers. Pass [] to clear.'),
    },
    async ({ name, description, body, tools, triggers }) => {
      if (!NAME_PATTERN.test(name)) {
        return textResult(`❌ Name "${name}" is not a valid skill slug.`);
      }
      const skillsDir = globalSkillsDir();
      const folderEntry = path.join(skillsDir, name, 'SKILL.md');
      const flatEntry = path.join(skillsDir, name + '.md');
      const targetPath = existsSync(folderEntry) ? folderEntry : (existsSync(flatEntry) ? flatEntry : null);
      if (!targetPath) {
        return textResult(`❌ Skill "${name}" not found. Use create_skill if you want to author it from scratch.`);
      }

      try {
        const raw = readFileSync(targetPath, 'utf-8');
        const parsed = matter(raw);
        const fm: Record<string, unknown> = { ...parsed.data };
        fm.name = name;
        if (description !== undefined) {
          if (description.length > DESCRIPTION_MAX_LEN) {
            return textResult(`❌ Description is too long (${description.length} chars). Max is ${DESCRIPTION_MAX_LEN}.`);
          }
          fm.description = description;
        }
        const ext = (fm.clementine && typeof fm.clementine === 'object') ? fm.clementine as Record<string, unknown> : {};
        ext.updatedAt = new Date().toISOString();
        if (tools !== undefined) {
          if (tools.length > 0) ext.tools = { ...(ext.tools as object || {}), allow: tools };
          else if (ext.tools && typeof ext.tools === 'object') delete (ext.tools as Record<string, unknown>).allow;
        }
        if (triggers !== undefined) {
          if (triggers.length > 0) ext.triggers = triggers;
          else delete ext.triggers;
        }
        fm.clementine = ext;
        const newBody = body !== undefined ? (body.endsWith('\n') ? body : body + '\n') : parsed.content;
        const content = matter.stringify(newBody, fm);
        writeFileSync(targetPath, content);
        logger.info({ name, targetPath, source: 'chat' }, 'Skill updated via chat');

        const changed: string[] = [];
        if (description !== undefined) changed.push('description');
        if (body !== undefined) changed.push('body');
        if (tools !== undefined) changed.push('tools');
        if (triggers !== undefined) changed.push('triggers');
        return textResult(
          `✅ Updated skill "${name}" — changed: ${changed.join(', ') || '(no fields specified)'}.\n` +
          `Path: ${targetPath}`,
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
    'List every skill currently in the global vault. Returns name, title, description, schema version (anthropic / clementine / legacy), and layout (folder / flat). Useful when the user asks "what skills do you have?" or "show me my skills."',
    {},
    async () => {
      try {
        const skillsDir = globalSkillsDir();
        if (!existsSync(skillsDir)) return textResult('No skills directory yet. Use create_skill to author your first one.');
        const { readdirSync, statSync } = await import('node:fs');
        const items = readdirSync(skillsDir);
        const skills: Array<{ name: string; title: string; description: string; layout: string }> = [];
        for (const item of items) {
          if (item.startsWith('.')) continue;
          const full = path.join(skillsDir, item);
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) {
            const entry = path.join(full, 'SKILL.md');
            if (!existsSync(entry)) continue;
            try {
              const fm = matter(readFileSync(entry, 'utf-8')).data as Record<string, unknown>;
              skills.push({
                name: String(fm.name ?? item),
                title: String(fm.title ?? fm.name ?? item),
                description: String(fm.description ?? ''),
                layout: 'folder',
              });
            } catch { /* skip malformed */ }
          } else if (st.isFile() && item.endsWith('.md') && !item.endsWith('.bak.md')) {
            try {
              const fm = matter(readFileSync(full, 'utf-8')).data as Record<string, unknown>;
              skills.push({
                name: String(fm.name ?? item.replace(/\.md$/, '')),
                title: String(fm.title ?? fm.name ?? item),
                description: String(fm.description ?? ''),
                layout: 'flat',
              });
            } catch { /* skip malformed */ }
          }
        }
        if (skills.length === 0) return textResult('No skills found yet. Use create_skill to author your first one.');
        skills.sort((a, b) => a.name.localeCompare(b.name));
        const lines = skills.map(s => `• ${s.title} (\`${s.name}\`) — ${s.description.slice(0, 120)}${s.description.length > 120 ? '…' : ''}`);
        return textResult(`${skills.length} skill${skills.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`);
      } catch (err) {
        return textResult(`❌ Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
