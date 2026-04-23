/**
 * Auto-synthesize a skill document for every tool discovered via MCP
 * schema fetching. Pure schema → markdown transform, no LLM call.
 *
 * User-authored skills under `skills/<name>.md` (top-level) always win
 * on retrieval over auto-generated skills under `skills/auto/<server>/<tool>.md`.
 * A user can shadow any auto-skill by dropping a hand-written file at
 * top level — same triggers, their version serves.
 *
 * Regeneration: each auto-skill's frontmatter includes a `schemaHash`
 * computed from the tool's inputSchema. On every boot we diff and only
 * rewrite skills whose hash changed. User edits to auto-skills aren't
 * preserved — they should shadow, not edit.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import matter from 'gray-matter';

import { VAULT_DIR } from '../config.js';
import { logger } from '../tools/shared.js';
import type { AllSchemas, ToolSchema } from './mcp-schemas.js';
import { loadToolInventory } from './mcp-bridge.js';

const SKILLS_ROOT = path.join(VAULT_DIR, '00-System', 'skills');
const AUTO_ROOT = path.join(SKILLS_ROOT, 'auto');

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  [k: string]: unknown;
}

function schemaHash(schema: unknown): string {
  return createHash('sha1').update(JSON.stringify(schema ?? {})).digest('hex').slice(0, 16);
}

/**
 * Split a snake_case/camelCase identifier into readable words.
 * `read_imessages` → "read imessages", `pageSize` → "page size"
 */
function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Derive trigger phrases a user might use to invoke this tool. Every trigger
 * must include the server name (or a server-specific noun derived from the
 * tool name) so generic verbs like "list", "check", "read" don't trip skills
 * across all connectors. The server name is the disambiguator.
 */
function deriveTriggers(server: string, tool: ToolSchema): string[] {
  // Normalize the server name for use in triggers. claude_ai_Google_Drive →
  // "google drive"; Bright_Data → "bright data"; imessage → "imessage".
  const rawServer = server.replace(/^claude_ai_/, '');
  const serverWords = humanize(rawServer);
  const toolWords = humanize(tool.name);

  // Alias shortening for common server names so user phrasings match.
  // "Google Drive" → also match "drive", "Microsoft 365" → also match "outlook", etc.
  const serverAliases = new Set<string>([serverWords]);
  const aliasMap: Record<string, string[]> = {
    'google drive': ['drive', 'gdrive', 'google drive'],
    'google calendar': ['calendar', 'gcal'],
    'gmail': ['gmail', 'email', 'mail'],
    'microsoft 365': ['outlook', 'microsoft', 'office'],
    'imessage': ['imessage', 'messages', 'texts', 'text messages', 'sms'],
    'figma': ['figma', 'design'],
    'hostinger-mcp': ['hostinger'],
    'bright data': ['brightdata'],
    'dataforseo': ['seo', 'serp'],
    'elevenlabs': ['voice', 'tts', 'text to speech'],
    'supabase': ['database', 'postgres'],
  };
  for (const alias of aliasMap[serverWords] ?? []) serverAliases.add(alias);

  const triggers = new Set<string>();
  // Every trigger is a phrase, not a single generic verb. The server name
  // (or an alias) is always present to scope the match to this connector.
  for (const alias of serverAliases) {
    triggers.add(`${toolWords} ${alias}`);
    triggers.add(`${alias} ${toolWords}`);
    // Natural phrasings a user would actually type
    triggers.add(`my ${alias}`);
    triggers.add(`check ${alias}`);
    // If the tool name starts with a verb (read/send/list/get/search/create/
    // update/delete/list), pair it with the alias for a clean trigger.
    const firstWord = toolWords.split(/\s+/)[0];
    if (['read', 'send', 'list', 'get', 'search', 'create', 'update', 'delete', 'find', 'show'].includes(firstWord)) {
      triggers.add(`${firstWord} ${alias}`);
      triggers.add(`${firstWord} my ${alias}`);
    }
  }
  // The server name alone is a useful single-word trigger (e.g. "imessage")
  // — specific enough to not overmatch generic tool-list queries.
  for (const alias of serverAliases) triggers.add(alias);

  return Array.from(triggers).filter(t => t.length > 0);
}

function renderArgsTable(schema: JsonSchema): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(props);
  if (entries.length === 0) return '_No arguments._';

  const rows = entries.map(([name, spec]) => {
    const type = spec.type ?? 'any';
    const req = required.has(name) ? '**required**' : 'optional';
    const enumHint = Array.isArray(spec.enum) && spec.enum.length > 0
      ? ` (one of: ${spec.enum.map(v => `\`${v}\``).join(', ')})`
      : '';
    const desc = (spec.description ?? '').replace(/\n/g, ' ').slice(0, 140);
    return `| \`${name}\` | \`${type}\` | ${req} | ${desc}${enumHint} |`;
  });
  return ['| Arg | Type | Required | Description |', '|-----|------|----------|-------------|', ...rows].join('\n');
}

function renderExample(schema: JsonSchema): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const example: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    if (!required.has(name) && Object.keys(example).length >= 2) continue;
    switch (spec.type) {
      case 'string':
        example[name] = Array.isArray(spec.enum) && spec.enum.length > 0 ? spec.enum[0] : `<${name}>`;
        break;
      case 'number':
      case 'integer':
        example[name] = 3;
        break;
      case 'boolean':
        example[name] = true;
        break;
      case 'array':
        example[name] = [];
        break;
      default:
        example[name] = null;
    }
  }
  return Object.keys(example).length > 0
    ? '```json\n' + JSON.stringify(example, null, 2) + '\n```'
    : '```json\n{}\n```';
}

function renderSkillBody(server: string, tool: ToolSchema): string {
  const fullName = `mcp__${server}__${tool.name}`;
  const schema = (tool.inputSchema as JsonSchema) ?? { type: 'object', properties: {} };
  return [
    `# ${humanize(server)} — ${humanize(tool.name)}`,
    '',
    tool.description || '_(no description provided by the server)_',
    '',
    '## Tool call',
    '',
    `\`${fullName}\``,
    '',
    '## Arguments',
    '',
    renderArgsTable(schema),
    '',
    '## Minimal example',
    '',
    renderExample(schema),
    '',
    '## Notes',
    '',
    '- The arg names above come directly from the MCP server\'s `tools/list` schema — use them exactly. If a call returns an error like "unknown field", the error text names the allowed args; correct the call and retry.',
    '- Per-call errors (invalid args, auth, rate limits) are not connector failures. Do not declare the connector "broken" or "unavailable" unless the MCP server itself is unreachable.',
    '',
    '---',
    '',
    `*Auto-generated from the MCP server\'s schema. To override, create \`skills/<your-slug>.md\` at the top level with your own triggers — user skills take precedence at retrieval time.*`,
  ].join('\n');
}

function writeAutoSkill(server: string, tool: ToolSchema): { wrote: boolean; unchanged: boolean } {
  const serverDir = path.join(AUTO_ROOT, sanitizePathSegment(server));
  if (!existsSync(serverDir)) mkdirSync(serverDir, { recursive: true });
  const filePath = path.join(serverDir, `${sanitizePathSegment(tool.name)}.md`);

  const hash = schemaHash(tool.inputSchema);
  const now = new Date().toISOString();
  const frontmatter = {
    title: `${humanize(server)} — ${humanize(tool.name)}`,
    description: tool.description || `Auto-generated skill for ${tool.name}`,
    triggers: deriveTriggers(server, tool),
    source: 'auto-mcp-schema',
    server,
    tool: `mcp__${server}__${tool.name}`,
    schemaHash: hash,
    generatedAt: now,
  };

  // Skip write if hash matches existing.
  if (existsSync(filePath)) {
    try {
      const existing = matter(readFileSync(filePath, 'utf-8'));
      if (existing.data.schemaHash === hash) {
        return { wrote: false, unchanged: true };
      }
    } catch { /* regen on parse error */ }
  }

  const content = matter.stringify('\n' + renderSkillBody(server, tool) + '\n', frontmatter);
  writeFileSync(filePath, content);
  return { wrote: true, unchanged: false };
}

/** Safe path segment — strip anything that isn't alphanum/dash/dot/underscore. */
function sanitizePathSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/**
 * Given the fetched schemas, write one auto-skill per tool. Idempotent —
 * only writes when the schema hash changes or the file is missing.
 * Prunes stale auto-skills for tools the server no longer declares.
 */
export function synthesizeSkillsFromSchemas(schemas: AllSchemas): {
  written: number;
  unchanged: number;
  pruned: number;
  toolCount: number;
} {
  let written = 0;
  let unchanged = 0;
  let pruned = 0;
  let toolCount = 0;

  if (!existsSync(AUTO_ROOT)) mkdirSync(AUTO_ROOT, { recursive: true });

  // Current tools we expect to exist on disk
  const expected = new Set<string>();

  // Phase 1: full-schema skills from stdio probes.
  for (const [server, s] of Object.entries(schemas.servers)) {
    if (!s.tools || s.tools.length === 0) continue;
    for (const tool of s.tools) {
      toolCount++;
      const res = writeAutoSkill(server, tool);
      if (res.wrote) written++;
      if (res.unchanged) unchanged++;
      expected.add(`${sanitizePathSegment(server)}/${sanitizePathSegment(tool.name)}.md`);
    }
  }

  // Phase 2: minimal skills for remote connectors (claude_ai_*, etc.) whose
  // schemas we couldn't fetch directly — we only have the tool name from
  // the SDK inventory. The skill has no args table, but triggers still
  // derive from tool name + server alias so retrieval works. Users can
  // override with a hand-written skill at skills/<name>.md.
  try {
    const inv = loadToolInventory();
    if (inv?.tools) {
      const knownServers = new Set(Object.keys(schemas.servers));
      for (const fullName of inv.tools) {
        const m = fullName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
        if (!m) continue;
        const [, server, toolName] = m;
        // Skip if the stdio probe already wrote a full-schema skill.
        if (knownServers.has(server)) continue;
        // Skip Clementine's own server + plugin tools (both documented elsewhere).
        if (server === 'clementine-tools' || server.startsWith('plugin_')) continue;
        const tool: ToolSchema = {
          name: toolName,
          description: '',
          inputSchema: { type: 'object', properties: {} },
        };
        const res = writeAutoSkill(server, tool);
        if (res.wrote) written++;
        if (res.unchanged) unchanged++;
        toolCount++;
        expected.add(`${sanitizePathSegment(server)}/${sanitizePathSegment(toolName)}.md`);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Minimal-skill pass (remote connectors) failed — non-fatal');
  }

  // Phase 3: single prune pass. Walk skills/auto/ and remove any .md whose
  // path isn't in `expected`. We never touch anything outside skills/auto/,
  // so user-authored top-level skills are preserved.
  try {
    if (existsSync(AUTO_ROOT)) {
      for (const serverDir of readdirSync(AUTO_ROOT, { withFileTypes: true })) {
        if (!serverDir.isDirectory()) continue;
        const dir = path.join(AUTO_ROOT, serverDir.name);
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.md')) continue;
          const rel = `${serverDir.name}/${file}`;
          if (!expected.has(rel)) {
            try { rmSync(path.join(dir, file)); pruned++; } catch { /* ignore */ }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Auto-skill prune pass failed (non-fatal)');
  }

  logger.info({ written, unchanged, pruned, toolCount }, 'Auto-skills synthesized from MCP schemas');
  return { written, unchanged, pruned, toolCount };
}
