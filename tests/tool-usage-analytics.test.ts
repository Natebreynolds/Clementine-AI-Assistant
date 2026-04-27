/**
 * Phase 11 — tool-usage analytics aggregator.
 *
 * Pure JSONL parsing + grouping; tests use fixture audit logs.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildToolUsageReport,
  classifyToolFamily,
  defaultAuditLogPath,
} from '../src/analytics/tool-usage.js';

describe('classifyToolFamily', () => {
  it('groups MCP tools by server name', () => {
    expect(classifyToolFamily('mcp__dataforseo__google_keyword_overview')).toBe('mcp:dataforseo');
    expect(classifyToolFamily('mcp__clementine-tools__memory_search')).toBe('mcp:clementine-tools');
  });

  it('maps built-in tools to family labels', () => {
    expect(classifyToolFamily('Bash')).toBe('shell');
    expect(classifyToolFamily('Read')).toBe('fs-read');
    expect(classifyToolFamily('Write')).toBe('fs-write');
    expect(classifyToolFamily('WebFetch')).toBe('web');
    expect(classifyToolFamily('Agent')).toBe('subagent');
  });

  it('passes through unknown tool names as their own family', () => {
    expect(classifyToolFamily('SomeCustomTool')).toBe('SomeCustomTool');
  });

  it('handles empty / undefined gracefully', () => {
    expect(classifyToolFamily('')).toBe('other');
  });
});

describe('buildToolUsageReport', () => {
  let dir: string;
  let auditPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clem-tool-usage-'));
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    auditPath = defaultAuditLogPath(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLog(entries: object[]): void {
    writeFileSync(auditPath, entries.map(e => JSON.stringify(e)).join('\n'));
  }

  it('returns empty report when audit log is missing', () => {
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.totalToolCalls).toBe(0);
    expect(r.families).toEqual([]);
  });

  it('counts tool_use events and groups by family', () => {
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'Bash', source: 'cron', job: 'job-a' },
      { ts: '2026-04-26T10:01:00Z', event_type: 'tool_use', tool_name: 'Bash', source: 'cron', job: 'job-a' },
      { ts: '2026-04-26T10:02:00Z', event_type: 'tool_use', tool_name: 'Read', source: 'cron', job: 'job-b' },
      { ts: '2026-04-26T10:03:00Z', event_type: 'tool_use', tool_name: 'mcp__dataforseo__keyword_overview', source: 'cron', job: 'job-a' },
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.totalToolCalls).toBe(4);
    const families = Object.fromEntries(r.families.map(f => [f.family, f.totalCalls]));
    expect(families).toEqual({ shell: 2, 'fs-read': 1, 'mcp:dataforseo': 1 });
  });

  it('respects the time window', () => {
    writeLog([
      { ts: '2026-04-25T00:00:00Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-28T00:00:00Z', event_type: 'tool_use', tool_name: 'Bash' },
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.totalToolCalls).toBe(1);
  });

  it('aggregates per-tool and per-source within a family', () => {
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'mcp__dataforseo__keyword_overview', job: 'market-leader' },
      { ts: '2026-04-26T10:01:00Z', event_type: 'tool_use', tool_name: 'mcp__dataforseo__keyword_overview', job: 'market-leader' },
      { ts: '2026-04-26T10:02:00Z', event_type: 'tool_use', tool_name: 'mcp__dataforseo__competitors', job: 'audit' },
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    const dataforseo = r.families.find(f => f.family === 'mcp:dataforseo');
    expect(dataforseo).toBeDefined();
    expect(dataforseo!.byTool[0]!.tool).toBe('mcp__dataforseo__keyword_overview');
    expect(dataforseo!.byTool[0]!.count).toBe(2);
    expect(dataforseo!.bySource[0]!.source).toBe('market-leader');
  });

  it('sums query_complete cost over the window', () => {
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'query_complete', cost_usd: 0.42, num_turns: 1 },
      { ts: '2026-04-26T11:00:00Z', event_type: 'query_complete', cost_usd: 1.18, num_turns: 5 },
      { ts: '2026-04-25T00:00:00Z', event_type: 'query_complete', cost_usd: 99 }, // out of window
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.totalQueries).toBe(2);
    expect(r.totalCostUsd).toBeCloseTo(1.6, 4);
  });

  it('skips malformed lines without throwing', () => {
    writeFileSync(auditPath, [
      '{ malformed',
      JSON.stringify({ ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'Bash' }),
      '',
      'not json at all',
    ].join('\n'));
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.totalToolCalls).toBe(1);
  });

  it('ranks families by attributed cost first, then call count', () => {
    // Family A (shell): 1 call in a $1 query → $1 attributed
    // Family B (fs-read): 4 calls in a $0.40 query → $0.10 each, $0.40 total
    // shell wins on cost despite fewer calls.
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-26T10:00:30Z', event_type: 'query_complete', cost_usd: 1.00 },
      { ts: '2026-04-26T10:01:00Z', event_type: 'tool_use', tool_name: 'Read' },
      { ts: '2026-04-26T10:01:01Z', event_type: 'tool_use', tool_name: 'Read' },
      { ts: '2026-04-26T10:01:02Z', event_type: 'tool_use', tool_name: 'Read' },
      { ts: '2026-04-26T10:01:03Z', event_type: 'tool_use', tool_name: 'Read' },
      { ts: '2026-04-26T10:01:30Z', event_type: 'query_complete', cost_usd: 0.40 },
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.families[0]!.family).toBe('shell');
    expect(r.families[0]!.estimatedCostUsd).toBeCloseTo(1.0, 2);
    expect(r.families[1]!.family).toBe('fs-read');
    expect(r.families[1]!.estimatedCostUsd).toBeCloseTo(0.40, 2);
  });

  it('attributes query cost evenly across tool calls in its window', () => {
    // 3 Bash calls then a $0.30 query → $0.10 each
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-26T10:00:01Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-26T10:00:02Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-26T10:00:30Z', event_type: 'query_complete', cost_usd: 0.30 },
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    const shell = r.families.find(f => f.family === 'shell')!;
    expect(shell.estimatedCostUsd).toBeCloseTo(0.30, 4);
    expect(r.attributedCostUsd).toBeCloseTo(0.30, 4);
  });

  it('tool calls without a closing query_complete contribute zero cost', () => {
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'tool_use', tool_name: 'Bash' },
      { ts: '2026-04-26T10:00:01Z', event_type: 'tool_use', tool_name: 'Bash' },
      // No query_complete in window — the query's cost lives in a later window.
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.attributedCostUsd).toBe(0);
    expect(r.families[0]!.estimatedCostUsd).toBe(0);
    expect(r.families[0]!.totalCalls).toBe(2); // calls still counted
  });

  it('query_complete with no preceding tool_use contributes to totalCost but not attributedCost', () => {
    writeLog([
      { ts: '2026-04-26T10:00:00Z', event_type: 'query_complete', cost_usd: 0.50 },
    ]);
    const r = buildToolUsageReport(auditPath, '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z');
    expect(r.totalCostUsd).toBeCloseTo(0.50, 4);
    expect(r.attributedCostUsd).toBe(0);
  });
});
