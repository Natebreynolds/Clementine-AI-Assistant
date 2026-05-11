import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExecutionToolPolicy,
  listClementineMcpToolNames,
} from '../src/agent/execution-policy.js';

describe('buildExecutionToolPolicy', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('uses explicit empty allowedTools as deny-all', () => {
    const policy = buildExecutionToolPolicy({
      requestedTools: [],
      defaultBuiltins: ['Read', 'Bash'],
      mcpServerNames: ['clementine-tools', 'github'],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.permissionMode).toBe('dontAsk');
    expect(policy.builtinTools).toEqual([]);
    expect(policy.allowedTools).toEqual([]);
    expect(policy.clementineToolAllowlist).toBe('');
  });

  it('defaults to core built-ins plus mounted MCP wildcards', () => {
    const policy = buildExecutionToolPolicy({
      defaultBuiltins: ['Read', 'Bash', 'mcp__not-a-builtin__noop'],
      mcpServerNames: ['clementine-tools', 'github'],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.builtinTools).toEqual(['Bash', 'Read']);
    expect(policy.allowedTools).toContain('Read');
    expect(policy.allowedTools).toContain('Bash');
    expect(policy.allowedTools).toContain('mcp__clementine-tools__*');
    expect(policy.allowedTools).toContain('mcp__github__*');
    expect(policy.clementineToolAllowlist).toBe('*');
  });

  it('maps bare Clementine MCP tool names into SDK MCP names', () => {
    expect([...listClementineMcpToolNames()]).toContain('memory_read');

    const policy = buildExecutionToolPolicy({
      requestedTools: ['Read', 'memory_read', 'mcp__github__search'],
      defaultBuiltins: ['Read', 'Bash'],
      mcpServerNames: ['clementine-tools', 'github'],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.builtinTools).toEqual(['Read']);
    expect(policy.allowedTools).toContain('Read');
    expect(policy.allowedTools).toContain('mcp__clementine-tools__memory_read');
    expect(policy.allowedTools).toContain('mcp__github__search');
    expect(policy.clementineToolAllowlist).toBe('memory_read');
  });

  it('keeps legacy memory-write profiles compatible with brain ingestion tools', () => {
    const policy = buildExecutionToolPolicy({
      requestedTools: ['Read', 'memory_write'],
      defaultBuiltins: [],
      mcpServerNames: ['clementine-tools'],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.builtinTools).toEqual(['Read']);
    expect(policy.allowedTools).toContain('mcp__clementine-tools__memory_write');
    expect(policy.allowedTools).toContain('mcp__clementine-tools__brain_save');
    expect(policy.allowedTools).toContain('mcp__clementine-tools__brain_ingest_folder');
    expect(policy.clementineToolAllowlist.split(',')).toEqual([
      'brain_ingest_folder',
      'brain_save',
      'memory_write',
    ]);
  });

  it('scopes Clementine MCP to wildcard when explicitly requested', () => {
    const policy = buildExecutionToolPolicy({
      requestedTools: ['mcp__clementine-tools__*'],
      defaultBuiltins: [],
      mcpServerNames: ['clementine-tools'],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.allowedTools).toEqual(['mcp__clementine-tools__*']);
    expect(policy.clementineToolAllowlist).toBe('*');
  });

  it('maps local CLI names to scoped Bash approvals without broad shell approval', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'clementine-policy-'));
    const cliPath = path.join(binDir, 'demo-cli');
    writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', 'utf-8');
    chmodSync(cliPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    try {
      const policy = buildExecutionToolPolicy({
        requestedTools: ['Bash', 'demo-cli'],
        defaultBuiltins: [],
        mcpServerNames: [],
        clementineServerName: 'clementine-tools',
      });

      expect(policy.builtinTools).toEqual(['Bash']);
      expect(policy.allowedTools).toContain('Bash(demo-cli:*)');
      expect(policy.allowedTools).not.toContain('Bash');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('keeps explicit scoped Bash approvals from widening to all Bash', () => {
    const policy = buildExecutionToolPolicy({
      requestedTools: ['Bash', 'Bash(git:*)'],
      defaultBuiltins: [],
      mcpServerNames: [],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.builtinTools).toEqual(['Bash']);
    expect(policy.allowedTools).toEqual(['Bash(git:*)']);
  });

  it('preserves unknown tool names for SDK/plugin forward compatibility', () => {
    const policy = buildExecutionToolPolicy({
      requestedTools: ['futureTool'],
      defaultBuiltins: [],
      mcpServerNames: [],
      clementineServerName: 'clementine-tools',
    });

    expect(policy.builtinTools).toEqual([]);
    expect(policy.allowedTools).toEqual(['futureTool']);
  });

  it('only sets the dangerous bypass flag for explicit bypass mode', () => {
    const policy = buildExecutionToolPolicy({
      requestedTools: ['Read'],
      defaultBuiltins: [],
      mcpServerNames: [],
      clementineServerName: 'clementine-tools',
      permissionMode: 'bypassPermissions',
    });

    expect(policy.permissionMode).toBe('bypassPermissions');
    expect(policy.allowDangerouslySkipPermissions).toBe(true);
  });
});
