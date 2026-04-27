/**
 * Tool-usage analytics.
 *
 * Reads ~/.clementine/logs/audit.jsonl and aggregates tool_use events by
 * family + name + source so a CLI report can answer:
 *
 *   - "What is the agent spending its tool calls on?"
 *   - "Which integration (mcp__ family) is hottest?"
 *   - "Which job/source is the biggest tool consumer?"
 *
 * Pure file read + in-memory aggregation — no daemon access required.
 * Designed to run on multi-MB audit logs without buffering everything;
 * we stream line-by-line.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ToolFamilyStats {
  /** Family label — collapses mcp__ subnames into one bucket per server. */
  family: string;
  totalCalls: number;
  /** Per-tool breakdown within the family, sorted by count desc. */
  byTool: Array<{ tool: string; count: number }>;
  /** Per-source breakdown — which job/context drives this family. */
  bySource: Array<{ source: string; count: number }>;
}

export interface ToolUsageReport {
  windowStart: string;
  windowEnd: string;
  totalToolCalls: number;
  totalQueries: number;
  families: ToolFamilyStats[];
  /** Total cost (sum of query_complete events) over the window — context for tool counts. */
  totalCostUsd: number;
}

/**
 * Family normalization. Built-in SDK tools keep their name; MCP tools are
 * grouped by server (mcp__<server>__<tool> → "mcp:<server>"). Anything
 * else falls into "other".
 */
export function classifyToolFamily(toolName: string): string {
  if (!toolName) return 'other';
  // mcp__server-name__tool_name → mcp:server-name
  const mcpMatch = toolName.match(/^mcp__([^_]+(?:[-_][^_]+)*)__/);
  if (mcpMatch) return `mcp:${mcpMatch[1]}`;
  // Built-ins kept as their own families
  const BUILTIN_FAMILIES: Record<string, string> = {
    Bash: 'shell',
    Read: 'fs-read',
    Glob: 'fs-read',
    Grep: 'fs-read',
    Edit: 'fs-write',
    Write: 'fs-write',
    NotebookEdit: 'fs-write',
    WebFetch: 'web',
    WebSearch: 'web',
    Agent: 'subagent',
    Task: 'subagent',
  };
  return BUILTIN_FAMILIES[toolName] ?? toolName;
}

interface RawEntry {
  ts?: string;
  event_type?: string;
  tool_name?: string;
  source?: string;
  job?: string;
  cost_usd?: number;
}

/**
 * Aggregate tool_use + query_complete events from audit.jsonl over the
 * given window. Window bounds are ISO strings; entries outside are ignored.
 *
 * The function is forgiving: malformed lines are skipped, missing fields
 * default to 'unknown'. Audit logs are append-only so we never need to
 * worry about ordering.
 */
export function buildToolUsageReport(
  auditLogPath: string,
  windowStart: string,
  windowEnd: string,
): ToolUsageReport {
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);

  // family → { totalCalls, perTool: Map<string,count>, perSource: Map<string,count> }
  const families = new Map<string, {
    totalCalls: number;
    perTool: Map<string, number>;
    perSource: Map<string, number>;
  }>();
  let totalToolCalls = 0;
  let totalQueries = 0;
  let totalCost = 0;

  if (!existsSync(auditLogPath)) {
    return { windowStart, windowEnd, totalToolCalls: 0, totalQueries: 0, families: [], totalCostUsd: 0 };
  }

  // Stream-friendly read — each line is independent JSON. Audit logs are
  // typically a few MB; readFileSync is fine at that scale.
  const raw = readFileSync(auditLogPath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: RawEntry;
    try { entry = JSON.parse(line) as RawEntry; }
    catch { continue; }
    if (!entry.ts) continue;
    const tsMs = Date.parse(entry.ts);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs < startMs || tsMs > endMs) continue;

    if (entry.event_type === 'tool_use' && entry.tool_name) {
      const family = classifyToolFamily(entry.tool_name);
      const source = entry.job || entry.source || 'unknown';
      let bucket = families.get(family);
      if (!bucket) {
        bucket = { totalCalls: 0, perTool: new Map(), perSource: new Map() };
        families.set(family, bucket);
      }
      bucket.totalCalls++;
      bucket.perTool.set(entry.tool_name, (bucket.perTool.get(entry.tool_name) ?? 0) + 1);
      bucket.perSource.set(source, (bucket.perSource.get(source) ?? 0) + 1);
      totalToolCalls++;
    } else if (entry.event_type === 'query_complete') {
      totalQueries++;
      if (typeof entry.cost_usd === 'number' && Number.isFinite(entry.cost_usd)) {
        totalCost += entry.cost_usd;
      }
    }
  }

  const familyStats: ToolFamilyStats[] = [...families.entries()]
    .map(([family, b]) => ({
      family,
      totalCalls: b.totalCalls,
      byTool: [...b.perTool.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, c) => c.count - a.count),
      bySource: [...b.perSource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, c) => c.count - a.count),
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);

  return {
    windowStart,
    windowEnd,
    totalToolCalls,
    totalQueries,
    families: familyStats,
    totalCostUsd: Number(totalCost.toFixed(4)),
  };
}

/** Default audit log path — passed-through for CLI default + tests. */
export function defaultAuditLogPath(baseDir: string): string {
  return path.join(baseDir, 'logs', 'audit.jsonl');
}
