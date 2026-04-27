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
  /** Estimated cost attributed to this family (USD). Heuristic — see attributeCostsToToolUses. */
  estimatedCostUsd: number;
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
  /** Sum of cost attributed to tool calls (≤ totalCostUsd). The gap is the cost of
   *  query_completes whose tool calls fell outside the window or weren't logged. */
  attributedCostUsd: number;
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
  agent_slug?: string;
  cost_usd?: number;
}

/**
 * Time-proximity cost attribution. Audit events don't carry an explicit
 * query_id linking tool_use to query_complete, so we group by a sliding
 * window: tool_use events that occur AFTER the previous query_complete
 * (or the window start) and AT-OR-BEFORE the next query_complete are
 * attributed to that query. The query's cost is then divided evenly
 * across the tool calls in its window.
 *
 * Caveats:
 * - Concurrent queries (e.g. cron + chat in the same window) will mix.
 *   Best-effort heuristic, not exact accounting.
 * - Tool calls without a closing query_complete in the window get
 *   attributed nothing — captured in the gap between totalCostUsd
 *   and attributedCostUsd in the report.
 * - The even-distribution assumption ignores per-call cost variance
 *   (a single Bash that consumed 50k tokens vs a Read that consumed
 *   200). For our purposes (aggregate "where is my budget going?")
 *   this is good enough — actionable to within ~15% per family.
 */
function attributeCostsToToolUses(
  events: Array<{ ts: number; isQueryComplete: boolean; cost_usd?: number; toolEntryIndex?: number }>,
): Map<number, number> {
  const perToolCost = new Map<number, number>();
  let pendingToolIndices: number[] = [];
  for (const e of events) {
    if (!e.isQueryComplete) {
      if (e.toolEntryIndex !== undefined) pendingToolIndices.push(e.toolEntryIndex);
      continue;
    }
    // Query closed — distribute cost.
    if (pendingToolIndices.length > 0 && typeof e.cost_usd === 'number' && Number.isFinite(e.cost_usd)) {
      const perCall = e.cost_usd / pendingToolIndices.length;
      for (const idx of pendingToolIndices) {
        perToolCost.set(idx, (perToolCost.get(idx) ?? 0) + perCall);
      }
    }
    pendingToolIndices = [];
  }
  return perToolCost;
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

  // family → { totalCalls, totalCost, perTool, perSource }
  const families = new Map<string, {
    totalCalls: number;
    totalCost: number;
    perTool: Map<string, number>;
    perSource: Map<string, number>;
  }>();
  let totalToolCalls = 0;
  let totalQueries = 0;
  let totalCost = 0;

  if (!existsSync(auditLogPath)) {
    return {
      windowStart, windowEnd, totalToolCalls: 0, totalQueries: 0,
      families: [], totalCostUsd: 0, attributedCostUsd: 0,
    };
  }

  const raw = readFileSync(auditLogPath, 'utf-8');

  // First pass: collect tool_use entries (with their family + source) AND
  // query_complete events as a chronological sequence used for attribution.
  // Audit log is append-ordered, so iteration order = ts order.
  interface ToolEntry { family: string; source: string; toolName: string }
  const toolEntries: ToolEntry[] = [];
  const sequence: Array<{ ts: number; isQueryComplete: boolean; cost_usd?: number; toolEntryIndex?: number }> = [];

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
      toolEntries.push({ family, source, toolName: entry.tool_name });
      sequence.push({ ts: tsMs, isQueryComplete: false, toolEntryIndex: toolEntries.length - 1 });
      totalToolCalls++;
    } else if (entry.event_type === 'query_complete') {
      totalQueries++;
      const cost = typeof entry.cost_usd === 'number' && Number.isFinite(entry.cost_usd) ? entry.cost_usd : 0;
      totalCost += cost;
      sequence.push({ ts: tsMs, isQueryComplete: true, cost_usd: cost });
    }
  }

  // Second pass: attribute each query's cost across its preceding tool_use events.
  const perToolCost = attributeCostsToToolUses(sequence);
  let attributedCost = 0;

  // Third pass: bucket toolEntries into family stats, summing attributed cost.
  for (let i = 0; i < toolEntries.length; i++) {
    const t = toolEntries[i]!;
    const cost = perToolCost.get(i) ?? 0;
    attributedCost += cost;
    let bucket = families.get(t.family);
    if (!bucket) {
      bucket = { totalCalls: 0, totalCost: 0, perTool: new Map(), perSource: new Map() };
      families.set(t.family, bucket);
    }
    bucket.totalCalls++;
    bucket.totalCost += cost;
    bucket.perTool.set(t.toolName, (bucket.perTool.get(t.toolName) ?? 0) + 1);
    bucket.perSource.set(t.source, (bucket.perSource.get(t.source) ?? 0) + 1);
  }

  const familyStats: ToolFamilyStats[] = [...families.entries()]
    .map(([family, b]) => ({
      family,
      totalCalls: b.totalCalls,
      estimatedCostUsd: Number(b.totalCost.toFixed(4)),
      byTool: [...b.perTool.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, c) => c.count - a.count),
      bySource: [...b.perSource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, c) => c.count - a.count),
    }))
    // Sort by cost first (the actionable signal); fall back to call count.
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalCalls - a.totalCalls);

  return {
    windowStart,
    windowEnd,
    totalToolCalls,
    totalQueries,
    families: familyStats,
    totalCostUsd: Number(totalCost.toFixed(4)),
    attributedCostUsd: Number(attributedCost.toFixed(4)),
  };
}

/** Default audit log path — passed-through for CLI default + tests. */
export function defaultAuditLogPath(baseDir: string): string {
  return path.join(baseDir, 'logs', 'audit.jsonl');
}
