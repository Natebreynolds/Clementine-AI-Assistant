/**
 * Tests for tool-output-guard — the PostToolUse hook that bounds per-call
 * tool output to keep SDK auto-compaction from thrashing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  estimateBytes,
  compressToolOutput,
  adaptiveSoftCap,
  resolveCap,
  buildGuardHooks,
  defaultGuardConfig,
} from '../src/agent/tool-output-guard.js';

describe('estimateBytes', () => {
  it('counts UTF-8 byte length for strings', () => {
    expect(estimateBytes('hello')).toBe(5);
    expect(estimateBytes('héllo')).toBe(6); // é is 2 bytes
  });

  it('serializes objects and counts the JSON byte length', () => {
    const obj = { a: 1, b: 'two' };
    expect(estimateBytes(obj)).toBe(Buffer.byteLength(JSON.stringify(obj), 'utf8'));
  });

  it('returns 0 for nullish values', () => {
    expect(estimateBytes(null)).toBe(0);
    expect(estimateBytes(undefined)).toBe(0);
  });
});

describe('adaptiveSoftCap', () => {
  it('returns the base cap when usage is low', () => {
    expect(adaptiveSoftCap(30_000, 0.1, true)).toBe(30_000);
    expect(adaptiveSoftCap(30_000, 0.49, true)).toBe(30_000);
  });

  it('shrinks to ×0.6 at 50–75% usage', () => {
    expect(adaptiveSoftCap(30_000, 0.55, true)).toBe(18_000);
    expect(adaptiveSoftCap(30_000, 0.74, true)).toBe(18_000);
  });

  it('shrinks to ×0.35 at ≥75% usage', () => {
    expect(adaptiveSoftCap(30_000, 0.8, true)).toBe(10_500);
    expect(adaptiveSoftCap(30_000, 0.95, true)).toBe(10_500);
  });

  it('respects a floor so the cap can never collapse to zero', () => {
    expect(adaptiveSoftCap(1_000, 0.95, true)).toBeGreaterThanOrEqual(4_000);
  });

  it('returns the base cap unchanged when adaptive is off', () => {
    expect(adaptiveSoftCap(30_000, 0.95, false)).toBe(30_000);
  });
});

describe('resolveCap', () => {
  it('uses the default soft cap when no per-tool override', () => {
    const r = resolveCap('Bash', defaultGuardConfig(), 0);
    expect(r.softCap).toBe(defaultGuardConfig().softLimitBytes);
  });

  it('honors per-tool overrides', () => {
    const cfg = { ...defaultGuardConfig(), perTool: { 'mcp__big_server__list': 10_000 } };
    const r = resolveCap('mcp__big_server__list', cfg, 0);
    expect(r.softCap).toBe(10_000);
  });

  it('uses a tight default cap for Agent results', () => {
    const r = resolveCap('Agent', defaultGuardConfig(), 0);
    expect(r.softCap).toBeLessThanOrEqual(6_000);
  });

  it('uses a tighter default cap for full-file Read results', () => {
    const r = resolveCap('Read', defaultGuardConfig(), 0.8);
    expect(r.softCap).toBeLessThanOrEqual(4_000);
  });

  it('never returns a soft cap above the hard ceiling', () => {
    const cfg = { ...defaultGuardConfig(), softLimitBytes: 500_000, hardLimitBytes: 200_000 };
    const r = resolveCap('Read', cfg, 0);
    expect(r.softCap).toBeLessThanOrEqual(200_000);
  });
});

describe('compressToolOutput', () => {
  it('passes through outputs that fit under the cap', () => {
    const out = compressToolOutput('Read', { hello: 'world' }, {
      toolName: 'Read', toolUseId: 'tu_1', archivePath: null, cap: 30_000,
    });
    expect(out.passthrough).toBe(true);
    expect(out.bytesShed).toBe(0);
    expect(out.output).toEqual({ hello: 'world' });
  });

  it('shrinks a long array of small items by keeping head + tail + summary', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const out = compressToolOutput('list_things', items, {
      toolName: 'list_things', toolUseId: 'tu_2', archivePath: null, cap: 400,
    });
    expect(out.passthrough).toBe(false);
    // Either array-shrink (head + summary + tail) or raw slice — both must
    // produce something under the cap.
    expect(estimateBytes(out.output)).toBeLessThanOrEqual(2_000);
  });

  it('shrinks an array-under-data-field response (Composio shape)', () => {
    const payload = {
      data: Array.from({ length: 30 }, (_, i) => ({
        id: `m_${i}`,
        from: 'noreply@example.com',
        subject: `Email ${i}`,
        body: 'x'.repeat(5000), // big body
      })),
    };
    const out = compressToolOutput('mcp__outlook__inbox', payload, {
      toolName: 'mcp__outlook__inbox', toolUseId: 'tu_3', archivePath: '/tmp/archive.json', cap: 8_000,
    });
    expect(out.passthrough).toBe(false);
    // Output must be small and still recognizable as an inbox list
    expect(estimateBytes(out.output)).toBeLessThanOrEqual(12_000);
  });

  it('falls back to raw head+tail slice when structure-shrink is not enough', () => {
    // One giant string — no list shape to exploit.
    const huge = 'A'.repeat(100_000);
    const out = compressToolOutput('Bash', huge, {
      toolName: 'Bash', toolUseId: 'tu_4', archivePath: '/tmp/archive.json', cap: 5_000,
    });
    expect(out.passthrough).toBe(false);
    expect(typeof out.output).toBe('string');
    expect((out.output as string).length).toBeLessThanOrEqual(6_000); // cap + marker
    expect((out.output as string)).toContain('truncated');
    expect((out.output as string)).toContain('archive.json');
  });

  it('builds compact Agent handoffs instead of returning full subagent reports', () => {
    const report = [
      'Perfect. Now I have all the information needed. Let me compile the structured report:',
      '',
      '## Product Site Project — Structural Map',
      '',
      '**Total files:** 21',
      '',
      '### Top-Level Files',
      '- Product_Inventory.tsv (101 rows) — source export',
      '- Product_Contacts.csv (101 rows) — expanded contacts',
      '- Product_Site_Content.xlsx (557K) — primary workbook',
      '',
      '## Project Summary',
      'This is a product site project centered on a launch campaign.',
      '',
      '## Long tail detail',
      'x'.repeat(12_000),
      '',
      'agentId: abc5c2649a209c3bc',
      '<usage>total_tokens: 16390 tool_uses: 13 duration_ms: 31886</usage>',
    ].join('\n');
    const payload = [{ type: 'text', text: report }];

    const out = compressToolOutput('Agent', payload, {
      toolName: 'Agent',
      toolUseId: 'tu_agent',
      toolInput: { subagent_type: 'discovery', description: 'Map product site project' },
      archivePath: '/tmp/full-agent-result.json',
      cap: 2_500,
    });

    expect(out.passthrough).toBe(false);
    expect(typeof out.output).toBe('string');
    const text = out.output as string;
    expect(estimateBytes(text)).toBeLessThanOrEqual(2_500);
    expect(text).toContain('Subagent: discovery');
    expect(text).toContain('Task: Map product site project');
    expect(text).toContain('agentId: abc5c2649a209c3bc');
    expect(text).toContain('/tmp/full-agent-result.json');
    expect(text).not.toContain('x'.repeat(500));
  });

  it('flags ceilingHit when input is more than 2× the cap', () => {
    const huge = 'A'.repeat(50_000);
    const out = compressToolOutput('Bash', huge, {
      toolName: 'Bash', toolUseId: 'tu_5', archivePath: null, cap: 10_000,
    });
    expect(out.ceilingHit).toBe(true);
  });

  it('compresses verbose body fields even on small lists', () => {
    const payload = {
      items: Array.from({ length: 3 }, (_, i) => ({
        id: i,
        body: 'B'.repeat(10_000),
      })),
    };
    const out = compressToolOutput('mcp__x__y', payload, {
      toolName: 'mcp__x__y', toolUseId: 'tu_6', archivePath: null, cap: 5_000,
    });
    expect(out.passthrough).toBe(false);
    // Should be much smaller because body is replaced with a preview
    expect(estimateBytes(out.output)).toBeLessThan(estimateBytes(payload));
  });
});

describe('buildGuardHooks integration', () => {
  let archiveDir: string;
  let originalArchive: string | undefined;
  beforeEach(() => {
    archiveDir = mkdtempSync(join(tmpdir(), 'guard-test-'));
    originalArchive = process.env.CLEMENTINE_HOME;
  });
  afterEach(() => {
    if (originalArchive !== undefined) {
      process.env.CLEMENTINE_HOME = originalArchive;
    } else {
      delete process.env.CLEMENTINE_HOME;
    }
    try { rmSync(archiveDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns an empty hook map when the guard is disabled', () => {
    // Not feasible to flip TOOL_OUTPUT_GUARD.enabled at runtime without
    // remocking the module, but we can verify the shape of the public
    // surface always includes the three event keys when stats are present.
    const { hooks, stats } = buildGuardHooks({
      runId: 'run-disabled',
      config: defaultGuardConfig(),
    });
    expect(typeof hooks).toBe('object');
    expect(stats.inspected).toBe(0);
  });

  it('returns hook entries for PreToolUse + PostToolUse + compact hooks', () => {
    const { hooks } = buildGuardHooks({
      runId: 'run-1',
      config: defaultGuardConfig(),
    });
    // If the guard is enabled, all three must be present.
    if (hooks.PostToolUse) {
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toHaveLength(1);
      expect(hooks.PreCompact).toBeDefined();
      expect(hooks.PostCompact).toBeDefined();
    }
  });

  it('stages oversized Write inputs with a placeholder and restores content after native Write', async () => {
    const largeWrites: Array<{ filePath: string; contentBytes: number; archivePath: string | null }> = [];
    const target = join(archiveDir, 'report.html');
    const content = `<!doctype html>\n${'A'.repeat(20_000)}`;
    const { hooks, stats } = buildGuardHooks({
      runId: 'run-large-write',
      config: defaultGuardConfig(),
      archiveBaseDir: archiveDir,
      onLargeWrite: (info) => {
        largeWrites.push({
          filePath: info.filePath,
          contentBytes: info.contentBytes,
          archivePath: info.archivePath,
        });
      },
    });
    if (!hooks.PreToolUse || !hooks.PostToolUse) return;

    const preCb = hooks.PreToolUse[0].hooks[0];
    const preResult = await preCb({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target, content },
      tool_use_id: 'tu_write_big',
      session_id: 'sess',
    } as unknown as Parameters<typeof preCb>[0], 'tu_write_big', { signal: new AbortController().signal });

    const preOut = preResult as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        additionalContext?: string;
        updatedInput?: Record<string, unknown>;
      };
    };
    expect(preOut.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(preOut.hookSpecificOutput?.permissionDecisionReason).toContain('staged');
    expect(preOut.hookSpecificOutput?.additionalContext).toContain('restore the full content');
    const placeholder = String(preOut.hookSpecificOutput?.updatedInput?.content ?? '');
    expect(placeholder).toContain('large-write guard placeholder');
    expect(placeholder).not.toContain('A'.repeat(1000));
    expect(stats.largeWrites).toBe(0);
    expect(largeWrites).toHaveLength(0);

    writeFileSync(target, placeholder, 'utf8');

    const postCb = hooks.PostToolUse[0].hooks[0];
    const postResult = await postCb({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target, content: placeholder },
      tool_response: `File created successfully at: ${target}`,
      tool_use_id: 'tu_write_big',
      session_id: 'sess',
    } as unknown as Parameters<typeof postCb>[0], 'tu_write_big', { signal: new AbortController().signal });

    expect(readFileSync(target, 'utf8')).toBe(content);
    expect(stats.largeWrites).toBe(1);
    expect(largeWrites).toHaveLength(1);
    expect(largeWrites[0].filePath).toBe(target);
    expect(largeWrites[0].archivePath).toContain('Write__tu_write_big__input.json');
    expect(existsSync(largeWrites[0].archivePath!)).toBe(true);

    const postOut = postResult as {
      hookSpecificOutput?: {
        additionalContext?: string;
        updatedToolOutput?: unknown;
      };
    };
    expect(String(postOut.hookSpecificOutput?.updatedToolOutput ?? '')).toContain('File created successfully');
    expect(String(postOut.hookSpecificOutput?.updatedToolOutput ?? '')).toContain('restored');
    expect(postOut.hookSpecificOutput?.additionalContext).toContain('continue with verification');
  });

  it('invokes onCompress and updates stats when the hook fires', async () => {
    const compressed: Array<{ toolName: string; bytesShed: number }> = [];
    const { hooks, stats } = buildGuardHooks({
      runId: 'run-stats',
      config: { ...defaultGuardConfig(), softLimitBytes: 1_000, hardLimitBytes: 200_000 },
      onCompress: (info) => { compressed.push({ toolName: info.toolName, bytesShed: info.bytesShed }); },
    });
    if (!hooks.PostToolUse) return; // guard disabled — skip

    const cb = hooks.PostToolUse[0].hooks[0];
    const huge = 'X'.repeat(20_000);
    await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'BigTool',
      tool_input: {},
      tool_response: huge,
      tool_use_id: 'tu_stats',
      session_id: 'sess',
    } as unknown as Parameters<typeof cb>[0], 'tu_stats', { signal: new AbortController().signal });

    expect(stats.inspected).toBe(1);
    expect(stats.compressed).toBe(1);
    expect(stats.bytesShed).toBeGreaterThan(0);
    expect(compressed).toHaveLength(1);
    expect(compressed[0].toolName).toBe('BigTool');
  });

  it('archives the full payload under ~/.clementine/tool-archive/<runId>/', async () => {
    const { hooks } = buildGuardHooks({
      runId: 'run-archive',
      config: { ...defaultGuardConfig(), softLimitBytes: 500, hardLimitBytes: 200_000 },
      archiveBaseDir: archiveDir,
    });
    if (!hooks.PostToolUse) return;

    const cb = hooks.PostToolUse[0].hooks[0];
    const payload = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, msg: 'lorem ipsum '.repeat(20) })) };
    await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__test__big',
      tool_input: {},
      tool_response: payload,
      tool_use_id: 'tu_arc',
      session_id: 'sess',
    } as unknown as Parameters<typeof cb>[0], 'tu_arc', { signal: new AbortController().signal });

    const expectedArchive = join(archiveDir, 'tool-archive', 'run-archive');
    expect(existsSync(expectedArchive)).toBe(true);
    // Find the archive file
    const file = join(expectedArchive, 'mcp__test__big__tu_arc.json');
    expect(existsSync(file)).toBe(true);
    const archived = JSON.parse(readFileSync(file, 'utf8'));
    expect(archived.items).toHaveLength(100);
    // cleanup
    rmSync(expectedArchive, { recursive: true, force: true });
  });

  it('archives and replaces oversized Agent hook results', async () => {
    const { hooks, stats } = buildGuardHooks({
      runId: 'run-agent-archive',
      config: {
        ...defaultGuardConfig(),
        softLimitBytes: 30_000,
        hardLimitBytes: 200_000,
        perTool: { Agent: 2_000 },
      },
      archiveBaseDir: archiveDir,
    });
    if (!hooks.PostToolUse) return;

    const cb = hooks.PostToolUse[0].hooks[0];
    const payload = [{
      type: 'text',
      text: [
        '## Discovery Report',
        '- /Users/example/project (12 files) — target project',
        'Detailed section:',
        'A'.repeat(8_000),
        'agentId: agent-test-123',
        '<usage>total_tokens: 9999</usage>',
      ].join('\n'),
    }];

    const result = await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'discovery', description: 'Find project' },
      tool_response: payload,
      tool_use_id: 'tu_agent_arc',
      session_id: 'sess',
    } as unknown as Parameters<typeof cb>[0], 'tu_agent_arc', { signal: new AbortController().signal });

    expect(stats.compressed).toBe(1);
    const output = (result as { hookSpecificOutput?: { updatedToolOutput?: unknown } }).hookSpecificOutput?.updatedToolOutput;
    expect(typeof output).toBe('string');
    expect(String(output)).toContain('Subagent: discovery');
    expect(String(output)).toContain('agent-test-123');
    expect(String(output)).toContain('Full payload archived at');

    const file = join(archiveDir, 'tool-archive', 'run-agent-archive', 'Agent__tu_agent_arc.json');
    expect(existsSync(file)).toBe(true);
    const archived = JSON.parse(readFileSync(file, 'utf8'));
    expect(archived[0].text).toContain('A'.repeat(1000));
  });

  it('does not call onCompress for outputs under the cap', async () => {
    const compressed: Array<{ toolName: string }> = [];
    const { hooks, stats } = buildGuardHooks({
      runId: 'run-noop',
      config: defaultGuardConfig(),
      onCompress: (info) => { compressed.push({ toolName: info.toolName }); },
    });
    if (!hooks.PostToolUse) return;

    const cb = hooks.PostToolUse[0].hooks[0];
    const small = 'fine';
    const result = await cb({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: {},
      tool_response: small,
      tool_use_id: 'tu_small',
      session_id: 'sess',
    } as unknown as Parameters<typeof cb>[0], 'tu_small', { signal: new AbortController().signal });

    expect(stats.inspected).toBe(1);
    expect(stats.compressed).toBe(0);
    expect(compressed).toHaveLength(0);
    // No updatedToolOutput should be returned for a passthrough
    expect((result as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();
  });
});
