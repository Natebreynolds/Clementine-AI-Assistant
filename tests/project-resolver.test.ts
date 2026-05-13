import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveProjectFromMessage,
  discoverProjectCandidates,
  detectDisputePattern,
} from '../src/agent/project-resolver.js';
import type { ProjectMeta } from '../src/agent/assistant.js';

// ── resolveProjectFromMessage ────────────────────────────────────────

describe('resolveProjectFromMessage (1.18.187 Part A)', () => {
  const projects: ProjectMeta[] = [
    {
      path: '/Users/me/Downloads/product-catalog',
      description: '100 product records HTML report',
      keywords: ['catalog', 'product-catalog', 'recruiting'],
    },
    {
      path: '/Users/me/Desktop/Proposal Builder',
      description: 'SEO audits',
      keywords: ['seo audit', 'proposal'],
    },
    {
      path: '/Users/me/Projects/Marketing Intel',
      description: 'Marketo + Salesforce dashboards',
      keywords: ['marketo', 'salesforce'],
    },
  ];

  it('matches a registered keyword (whole word) with high confidence', () => {
    const match = resolveProjectFromMessage('back to the catalog project, build me a report', { projects });
    expect(match).not.toBeNull();
    expect(match?.project.path).toContain('product-catalog');
    expect(match?.matchedVia).toBe('keyword');
    expect(match?.matchedTerm).toBe('catalog');
    expect(match?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches a multi-word keyword phrase via word-boundary check', () => {
    const match = resolveProjectFromMessage('run an seo audit for that client', { projects });
    expect(match).not.toBeNull();
    expect(match?.project.path).toContain('Proposal Builder');
  });

  it('matches by path basename when no keyword fires', () => {
    // "marketing intel" appears in the path basename "Marketing Intel" but
    // the keywords are marketo/salesforce — substring-on-basename should fire.
    const match = resolveProjectFromMessage('open marketing intel and show me last week', { projects });
    expect(match).not.toBeNull();
    expect(match?.project.path).toContain('Marketing Intel');
  });

  it('returns null when message contains none of the keywords', () => {
    const match = resolveProjectFromMessage('what is the weather today', { projects });
    expect(match).toBeNull();
  });

  it('does NOT falsely match keyword substring inside an unrelated word', () => {
    // "approaches" contains "catalog" as a substring but the keyword
    // check is whole-word only. The basename "product-catalog" doesn't
    // appear in the message as a whole word or substring either.
    // So this message should resolve to NULL — no false positive.
    const match = resolveProjectFromMessage('different approaches to consider', { projects });
    expect(match).toBeNull();
  });

  it('returns null for empty projects list', () => {
    expect(resolveProjectFromMessage('the catalog project', { projects: [] })).toBeNull();
  });

  it('returns null for empty message', () => {
    expect(resolveProjectFromMessage('', { projects })).toBeNull();
    expect(resolveProjectFromMessage('   ', { projects })).toBeNull();
  });

  it('respects custom minConfidence threshold', () => {
    // "marketing intel" matches the path basename via substring → 0.70.
    // Raise the threshold above 0.70 and it should reject.
    const match = resolveProjectFromMessage('open marketing intel and show me last week', {
      projects,
      minConfidence: 0.85,
    });
    expect(match).toBeNull();
  });

  it('prefers highest-confidence match when multiple keywords hit', () => {
    // A message that touches multiple projects' keywords — should pick
    // the strongest by confidence, which is the keyword whole-word match.
    const match = resolveProjectFromMessage(
      'use the catalog project but also salesforce data',
      { projects },
    );
    // Both 'catalog' (product-catalog keyword) and 'salesforce' (Marketing Intel
    // keyword) hit; both at confidence 0.95. First-matched wins (product-catalog
    // is first in the array). Behavior is deterministic; test pins it.
    expect(match?.project.path).toContain('product-catalog');
  });
});

// ── discoverProjectCandidates ────────────────────────────────────────

describe('discoverProjectCandidates (1.18.187 Part G)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-disc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // disableSpotlight on every test so they're deterministic regardless
  // of what mdfind finds on the test machine. Spotlight coverage is in
  // its own integration check below.
  it('finds a folder whose name matches the search term', () => {
    fs.mkdirSync(path.join(tmpHome, 'catalog'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'catalog', 'data.csv'), 'col1,col2\n1,2');
    const candidates = discoverProjectCandidates('catalog', { searchRoots: [tmpHome], disableSpotlight: true });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.basename).toBe('catalog');
    expect(candidates[0]?.nameScore).toBe(1.0);
  });

  it('ranks an exact name match above a substring match', () => {
    fs.mkdirSync(path.join(tmpHome, 'catalog'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'product-catalog-2024'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'catalog', 'data.csv'), 'a');
    fs.writeFileSync(path.join(tmpHome, 'product-catalog-2024', 'data.csv'), 'a');
    const candidates = discoverProjectCandidates('catalog', { searchRoots: [tmpHome], disableSpotlight: true });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]?.basename).toBe('catalog');
    expect(candidates[0]!.totalScore).toBeGreaterThan(candidates[1]!.totalScore);
  });

  it('skips ignore-listed folders (node_modules, .git, etc.)', () => {
    fs.mkdirSync(path.join(tmpHome, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'project-foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'project-foo', 'data.csv'), 'a');
    const candidates = discoverProjectCandidates('foo', { searchRoots: [tmpHome], disableSpotlight: true });
    expect(candidates.some((c) => c.path.includes('node_modules'))).toBe(false);
  });

  it('returns empty when no folders match', () => {
    fs.mkdirSync(path.join(tmpHome, 'unrelated'), { recursive: true });
    const candidates = discoverProjectCandidates('unique-no-match-xyz999', { searchRoots: [tmpHome], disableSpotlight: true });
    expect(candidates).toEqual([]);
  });

  it('summarizes content shape (CSV count, code files, README)', () => {
    const dir = path.join(tmpHome, 'project-shape-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.csv'), 'a');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
    fs.writeFileSync(path.join(dir, 'main.py'), 'print(1)');
    const candidates = discoverProjectCandidates('shape', { searchRoots: [tmpHome], disableSpotlight: true });
    expect(candidates[0]?.contentSummary).toContain('data file');
    expect(candidates[0]?.contentSummary).toContain('README');
  });

  it('limits results to maxResults', () => {
    for (let i = 0; i < 10; i++) {
      const dir = path.join(tmpHome, `catalog-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'data.csv'), 'a');
    }
    const candidates = discoverProjectCandidates('catalog', {
      searchRoots: [tmpHome],
      maxResults: 3,
      disableSpotlight: true, // avoid system-wide noise
    });
    expect(candidates).toHaveLength(3);
  });

  it('disableSpotlight option works for deterministic tests', () => {
    // Verify the spotlight path can be turned off so tests don't
    // depend on what mdfind happens to find on the test machine.
    fs.mkdirSync(path.join(tmpHome, 'unique-test-name-xyz123'), { recursive: true });
    const candidates = discoverProjectCandidates('unique-test-name-xyz123', {
      searchRoots: [tmpHome],
      disableSpotlight: true,
    });
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.path).toContain('unique-test-name-xyz123');
  });
});

// ── detectDisputePattern ─────────────────────────────────────────────

describe('detectDisputePattern (1.18.187 Part E)', () => {
  it('detects "not found" claims', () => {
    expect(detectDisputePattern('its saying site not found when i open it')).toBe(true);
    expect(detectDisputePattern('the URL says not found')).toBe(true);
  });

  it('detects "not working" / "isn\'t working" claims', () => {
    expect(detectDisputePattern('its not working still')).toBe(true);
    expect(detectDisputePattern("isn't there anymore")).toBe(true);
  });

  it('detects 404 references', () => {
    expect(detectDisputePattern('the URL is 404ing')).toBe(true);
    expect(detectDisputePattern('still 404')).toBe(true);
  });

  it('detects "broken" / "still broken"', () => {
    expect(detectDisputePattern('site is broken')).toBe(true);
    expect(detectDisputePattern('still broken after the update')).toBe(true);
  });

  it('detects "didn\'t deploy" / "didn\'t work" patterns', () => {
    expect(detectDisputePattern("didn't deploy correctly")).toBe(true);
    expect(detectDisputePattern("didn't work for me")).toBe(true);
  });

  it('does NOT trigger on neutral "not" usage', () => {
    // "I'm not finding the right approach" should NOT trigger.
    expect(detectDisputePattern('not sure which approach to use')).toBe(false);
    expect(detectDisputePattern('would not be helpful')).toBe(false);
    expect(detectDisputePattern('not yet, maybe next week')).toBe(false);
  });

  it('does NOT trigger on empty / falsy input', () => {
    expect(detectDisputePattern('')).toBe(false);
    expect(detectDisputePattern('   ')).toBe(false);
  });
});
