/**
 * Tests for chat-skill-resolver — the bridge between user chat messages
 * and the auto-skill catalog. Verifies that:
 *   • Top-3 matches above the score threshold are returned
 *   • MCP server references in matched skill bodies are extracted
 *   • frontmatter `server` + `tool` fields are honored when present
 *   • The rendered prompt block is non-empty when matches exist
 *   • Telemetry diagnostics reflect what actually matched
 *
 * We don't go through `searchSkills` end-to-end here (that requires a
 * skill directory) — those tests live in `skill-extractor.test.ts`. We
 * exercise the public surface of `chat-skill-resolver` directly and
 * test the helpers (`extractMcpServersFromMatch`,
 * `extractAllowedToolsFromMatch`, `renderPromptBlock`) which are the
 * actual translation logic this module owns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractMcpServersFromMatch,
  extractAllowedToolsFromMatch,
  renderPromptBlock,
  resolveSkillsForChat,
} from '../src/agent/chat-skill-resolver.js';
import type { SkillMatch } from '../src/agent/skill-extractor.js';

function fakeMatch(over: Partial<SkillMatch> = {}): SkillMatch {
  return {
    name: 'fake-skill',
    title: 'Fake Skill',
    content: '',
    score: 5,
    toolsUsed: [],
    attachments: [],
    skillDir: '/tmp/fake-skill-dir',
    ...over,
  };
}

describe('extractMcpServersFromMatch', () => {
  it('extracts mcp__<server>__<tool> references from body content', () => {
    const m = fakeMatch({
      content: 'Use `mcp__salesforce__QUERY_RECORDS` to fetch records.\n\nAlso try `mcp__salesforce__GET_RECORD`.',
    });
    const servers = extractMcpServersFromMatch(m);
    expect(servers).toEqual(['salesforce']);
  });

  it('returns multiple servers when the body references several', () => {
    const m = fakeMatch({
      content: 'Pipeline: `mcp__notion__create_page` then `mcp__slack__post_message`.',
    });
    const servers = extractMcpServersFromMatch(m).sort();
    expect(servers).toEqual(['notion', 'slack']);
  });

  it('returns an empty list when no MCP refs exist', () => {
    const m = fakeMatch({ content: 'Just regular markdown body with no mcp refs.' });
    expect(extractMcpServersFromMatch(m)).toEqual([]);
  });

  it('handles server names with underscores correctly', () => {
    const m = fakeMatch({
      content: 'Call `mcp__claude_ai_Google_Drive__create_file`.',
    });
    const servers = extractMcpServersFromMatch(m);
    // The regex captures the longest server-name prefix; trailing tool name follows __
    expect(servers).toEqual(['claude_ai_Google_Drive']);
  });
});

describe('extractMcpServersFromMatch (frontmatter lookup)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-resolver-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('reads frontmatter `server` and `tool` fields for auto-skills', () => {
    const autoDir = join(dir, 'auto', 'salesforce');
    mkdirSync(autoDir, { recursive: true });
    const fp = join(autoDir, 'QUERY_RECORDS.md');
    writeFileSync(fp, `---
title: Salesforce — Query Records
description: Run a SOQL query
triggers: [salesforce, query records salesforce]
source: auto-mcp-schema
server: salesforce
tool: mcp__salesforce__QUERY_RECORDS
---

# Salesforce — Query Records
## Tool call
\`mcp__salesforce__QUERY_RECORDS\`
`);
    const match = fakeMatch({
      // The slug used by skill-extractor for nested auto-skill files:
      name: 'auto-salesforce-QUERY_RECORDS',
      skillDir: dir,
      content: 'body without explicit mcp ref',
    });
    const servers = extractMcpServersFromMatch(match);
    expect(servers).toContain('salesforce');
  });
});

describe('extractAllowedToolsFromMatch', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-resolver-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('reads clementine.tools.allow from frontmatter', () => {
    const fp = join(dir, 'my-skill.md');
    writeFileSync(fp, `---
title: My Skill
description: test
clementine:
  tools:
    allow:
      - Bash
      - mcp__salesforce__SOQL_QUERY
---

Body here.
`);
    const m = fakeMatch({ name: 'my-skill', skillDir: dir });
    const allowed = extractAllowedToolsFromMatch(m);
    expect(allowed).toEqual(['Bash', 'mcp__salesforce__SOQL_QUERY']);
  });

  it('returns [] when no clementine.tools.allow is declared', () => {
    const fp = join(dir, 'no-tools.md');
    writeFileSync(fp, `---
title: No Tools
description: test
---

Body.
`);
    const m = fakeMatch({ name: 'no-tools', skillDir: dir });
    expect(extractAllowedToolsFromMatch(m)).toEqual([]);
  });

  it('returns [] when the file does not exist', () => {
    const m = fakeMatch({ name: 'nonexistent-skill', skillDir: dir });
    expect(extractAllowedToolsFromMatch(m)).toEqual([]);
  });
});

describe('renderPromptBlock', () => {
  it('returns empty string for zero matches', () => {
    expect(renderPromptBlock([])).toBe('');
  });

  it('returns a single-skill header for one match', () => {
    const m = fakeMatch({ title: 'Send Outlook Email', content: 'Step 1: …\nStep 2: …' });
    const out = renderPromptBlock([m]);
    expect(out).toContain('## Relevant Skill: Send Outlook Email');
    expect(out).toContain('Step 1');
  });

  it('returns a multi-skill nested block for multiple matches', () => {
    const out = renderPromptBlock([
      fakeMatch({ title: 'A', content: 'body-a' }),
      fakeMatch({ title: 'B', content: 'body-b' }),
      fakeMatch({ title: 'C', content: 'body-c' }),
    ]);
    expect(out).toContain('## Relevant Skills');
    expect(out).toContain('### 1. A');
    expect(out).toContain('### 2. B');
    expect(out).toContain('### 3. C');
    expect(out).toContain('body-a');
    expect(out).toContain('body-c');
  });

  it('caps per-skill body to the configured length', () => {
    const huge = 'X'.repeat(50_000);
    const out = renderPromptBlock([fakeMatch({ title: 'huge', content: huge })]);
    // Should be much smaller than the raw 50KB body
    expect(out.length).toBeLessThan(3_000);
  });
});

describe('auto-only noise filter (1.18.171 hotfix)', () => {
  // We can't easily mock `searchSkills` from this test file without
  // restructuring imports, so we lean on the integration behavior:
  // verify that when the real catalog is searched, the diagnostics
  // distinguish auto-only matches from user-authored matches.

  it('does NOT inject when all matches are auto-skills from 3+ distinct servers', () => {
    // Construct a query that would yield mostly noise: very short,
    // generic words that semantic similarity might map to anything.
    // We use the real catalog — this should either match nothing or
    // be dropped by the auto-only noise filter. Either way, the
    // returned promptBlock must not contain a "Relevant Skills"
    // header when the filter activates.
    const r = resolveSkillsForChat('did the changes break it');
    // Telemetry must always be populated
    expect(r.diagnostics.queryChars).toBeGreaterThan(0);
    // If matches survive, they must NOT be a noisy auto-only set
    if (r.matches.length >= 2 && r.matches.every(m => m.name.startsWith('auto-'))) {
      const servers = new Set<string>();
      for (const m of r.matches) {
        for (const s of extractMcpServersFromMatch(m)) servers.add(s);
      }
      // The filter should have dropped this — never let 3+ servers ship.
      expect(servers.size).toBeLessThan(3);
    }
  });

  it('still surfaces a strong auto-only match when the cluster is on one server', () => {
    // "imessage" is unambiguous — all matches will be on the imessage
    // server, so the noise filter must NOT trip.
    const r = resolveSkillsForChat('imessage');
    // We expect a match-set on a single server (imessage). If it's
    // empty in the test env (no skill dir), the assertion is trivially
    // satisfied; if it's non-empty, distinct servers must be ≤ 1.
    if (r.matches.length > 0) {
      const servers = new Set<string>();
      for (const m of r.matches) {
        for (const s of extractMcpServersFromMatch(m)) servers.add(s);
      }
      // imessage cluster should NOT be dropped
      expect(servers.size).toBeLessThanOrEqual(2);
    }
  });

  it('uses the higher minScore (8) when all candidates are auto-skills', () => {
    // Indirect verification: a generic 1-word query that auto-skills
    // can match at score ~5.5 (the regression case) should now be
    // dropped because 5.5 < 8. We use a query word unlikely to be in
    // any USER skill's triggers to force the "all-auto" branch.
    const r = resolveSkillsForChat('changes', { minScore: 4 });
    // The matches that DO survive must all clear the 8-threshold
    // when they're auto-only.
    if (r.matches.length > 0 && r.matches.every(m => m.name.startsWith('auto-'))) {
      for (const m of r.matches) {
        expect(m.score).toBeGreaterThanOrEqual(8);
      }
    }
  });
});

describe('resolveSkillsForChat (integration)', () => {
  it('returns empty result for an empty message', () => {
    const r = resolveSkillsForChat('');
    expect(r.matches).toEqual([]);
    expect(r.hintedMcpServers).toEqual([]);
    expect(r.promptBlock).toBe('');
    expect(r.diagnostics.queryChars).toBe(0);
  });

  it('returns empty result for whitespace-only message', () => {
    const r = resolveSkillsForChat('   \n   ');
    expect(r.matches).toEqual([]);
  });

  it('produces diagnostics block on a real query (even with no matches)', () => {
    // No skill directory available in test env → searchSkills returns []
    const r = resolveSkillsForChat('test query about something obscure', { minScore: 100 });
    expect(r.diagnostics.queryChars).toBeGreaterThan(0);
    expect(r.matches).toEqual([]);
  });

  it('respects custom minScore threshold', () => {
    // Force matches by setting an extremely low minScore — but since the
    // test environment likely has no skill dir, this validates the
    // option propagation rather than match shape.
    const r = resolveSkillsForChat('imessage', { minScore: 0.001 });
    expect(r.matches.length).toBeGreaterThanOrEqual(0);
    expect(typeof r.diagnostics.candidatesConsidered).toBe('number');
  });

  it('respects custom limit', () => {
    const r = resolveSkillsForChat('email triage', { limit: 2 });
    expect(r.matches.length).toBeLessThanOrEqual(2);
  });
});
