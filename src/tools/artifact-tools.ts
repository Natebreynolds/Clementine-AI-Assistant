/**
 * Clementine TypeScript — Artifact MCP tools.
 *
 * Artifact memory: persist large tool outputs (API responses, search
 * results, long file reads) so later turns can recall them without
 * re-executing the tool. Summary is what the agent sees when browsing;
 * the full content is fetched on demand via artifact_get.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ACTIVE_AGENT_SLUG, getStore, logger, textResult } from './shared.js';

const MAX_CONTENT_PREVIEW_CHARS = 4000;

export function registerArtifactTools(server: McpServer): void {
  server.tool(
    'artifact_store',
    'Persist a tool output (or any text blob) for later recall across turns. Use when a tool returns a large result you may need to reference again later — saves re-running the tool. Returns the artifact id.',
    {
      tool_name: z.string().describe('Name of the tool or source that produced this output (e.g. "web_search", "api.stripe.customers", "manual")'),
      summary: z.string().describe('1–3 sentence summary of what this artifact contains. Shown when browsing; should be specific enough to recognize later.'),
      content: z.string().describe('The raw content to store. Can be JSON, markdown, plain text — anything.'),
      tags: z.string().optional().describe('Comma-separated tags to aid recall (e.g. "stripe,customer,invoice").'),
      session_key: z.string().optional().describe('Current session key. Defaults to null (artifact visible across sessions).'),
    },
    async ({ tool_name, summary, content, tags, session_key }) => {
      try {
        const store = await getStore();
        const id = store.storeArtifact({
          toolName: tool_name,
          summary,
          content,
          tags: tags ?? '',
          sessionKey: session_key ?? null,
          agentSlug: ACTIVE_AGENT_SLUG,
        });
        logger.info({ artifactId: id, toolName: tool_name, bytes: content.length }, 'Artifact stored');
        return textResult(`Artifact stored: id=${id} (${content.length} bytes). Recall later with artifact_get(${id}) or search with artifact_recall.`);
      } catch (err) {
        return textResult(`Failed to store artifact: ${String(err)}`);
      }
    },
  );

  server.tool(
    'artifact_recall',
    'Search stored artifacts by keyword. Returns metadata (id, tool_name, summary, stored_at) — use artifact_get to fetch full content. Use this to answer questions like "what did that API return earlier?"',
    {
      query: z.string().optional().describe('Keyword query. Omit to list recent artifacts.'),
      limit: z.number().optional().default(10).describe('Max results (default 10).'),
      session_key: z.string().optional().describe('Filter by session key.'),
    },
    async ({ query, limit, session_key }) => {
      try {
        const store = await getStore();
        const rows = store.searchArtifacts({
          query,
          limit: limit ?? 10,
          sessionKey: session_key ?? null,
          agentSlug: ACTIVE_AGENT_SLUG,
        });
        if (rows.length === 0) {
          return textResult(query ? `No artifacts matching "${query}".` : 'No artifacts stored yet.');
        }
        const lines = rows.map((r) => {
          const tagBit = r.tags ? ` [${r.tags}]` : '';
          return `- **#${r.id}** ${r.toolName}${tagBit} (${r.storedAt}) — ${r.summary}`;
        });
        return textResult(`Found ${rows.length} artifact${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n\nFetch full content with artifact_get(id).`);
      } catch (err) {
        return textResult(`Failed to search artifacts: ${String(err)}`);
      }
    },
  );

  server.tool(
    'artifact_get',
    'Fetch the full content of a stored artifact by id. Use after artifact_recall to pull back the raw blob.',
    {
      id: z.number().describe('Artifact id (from artifact_recall or a prior artifact_store).'),
      max_chars: z.number().optional().describe('Truncate content at this many chars (helpful for very large artifacts).'),
    },
    async ({ id, max_chars }) => {
      try {
        const store = await getStore();
        const art = store.getArtifact(id);
        if (!art) return textResult(`Artifact #${id} not found.`);

        const limit = max_chars ?? MAX_CONTENT_PREVIEW_CHARS;
        const truncated = art.content.length > limit;
        const body = truncated ? art.content.slice(0, limit) + `\n\n…(truncated, ${art.content.length - limit} more chars — call artifact_get with max_chars=${art.content.length} for full content)` : art.content;

        const header = `# Artifact #${art.id}\n**Tool:** ${art.toolName} | **Stored:** ${art.storedAt} | **Accesses:** ${art.accessCount}\n**Summary:** ${art.summary}${art.tags ? `\n**Tags:** ${art.tags}` : ''}\n\n---\n\n`;
        return textResult(header + body);
      } catch (err) {
        return textResult(`Failed to fetch artifact: ${String(err)}`);
      }
    },
  );
}
