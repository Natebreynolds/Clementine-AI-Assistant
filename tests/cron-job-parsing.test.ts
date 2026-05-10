/**
 * Cron job parser — trick-capability fields.
 *
 * Verifies that the new trick-capability fields (`skills`, `allowed_tools`,
 * `allowed_mcp_servers`, `tags`, `category`) round-trip from CRON.md
 * frontmatter into `CronJobDefinition`, and that legacy entries without
 * those fields parse identically to before.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The cron-scheduler import chain transitively loads `src/security/integrity.ts`,
// which reads `CRON_FILE` synchronously at module load. That happens before any
// `const` in this file's body has been initialized (ESM TDZ), so the mock getter
// has to read from a globalThis property that we can set before importing.
const ROOT_DIR = mkdtempSync(path.join(tmpdir(), 'clem-cron-parse-root-'));
(globalThis as any).__CLEM_TEST_CRON_FILE = path.join(ROOT_DIR, 'CRON.md');
(globalThis as any).__CLEM_TEST_AGENTS_DIR = path.join(ROOT_DIR, 'agents');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    get CRON_FILE() { return (globalThis as any).__CLEM_TEST_CRON_FILE as string; },
    get AGENTS_DIR() { return (globalThis as any).__CLEM_TEST_AGENTS_DIR as string; },
  };
});

const { parseCronJobs, parseAgentCronJobs } = await import('../src/gateway/cron-scheduler.js');

let TMP_DIR = '';
const TMP_CRON = (): string => path.join(TMP_DIR, 'CRON.md');
const TMP_AGENTS = (): string => path.join(TMP_DIR, 'agents');

function writeCron(yaml: string): void {
  writeFileSync(TMP_CRON(), `---\n${yaml}\n---\n`);
}

function writeAgentCron(slug: string, yaml: string): void {
  const dir = path.join(TMP_AGENTS(), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CRON.md'), `---\n${yaml}\n---\n`);
}

let PREV_CLEMENTINE_HOME: string | undefined;

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'clem-cron-parse-'));
  (globalThis as any).__CLEM_TEST_CRON_FILE = TMP_CRON();
  (globalThis as any).__CLEM_TEST_AGENTS_DIR = TMP_AGENTS();
  // 1.18.154 — also redirect CLEMENTINE_HOME so the schedule registry
  // (~/.clementine/schedules.json, resolved lazily inside schedule-registry.ts)
  // points at the temp dir. Without this, parseCronJobs leaks live registry
  // entries into test output. (Latent isolation gap; surfaced when a real
  // schedule was added on the dev box on 2026-05-10.)
  PREV_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = TMP_DIR;
});
afterEach(() => {
  if (TMP_DIR && existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  if (PREV_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_CLEMENTINE_HOME;
});

beforeAll(() => { /* no-op */ });
afterAll(() => {
  if (existsSync(ROOT_DIR)) rmSync(ROOT_DIR, { recursive: true, force: true });
});

describe('parseCronJobs — trick capability fields', () => {
  it('parses a fully-loaded trick with all five capability fields (snake_case)', () => {
    writeCron(
      `jobs:\n` +
      `  - name: morning-research\n` +
      `    schedule: "0 7 * * *"\n` +
      `    prompt: do the research\n` +
      `    enabled: true\n` +
      `    skills: [research-protocol, summarize-news]\n` +
      `    allowed_tools: [Read, Write, WebFetch]\n` +
      `    allowed_mcp_servers: [firecrawl, claude_ai_Gmail]\n` +
      `    tags: [morning, research]\n` +
      `    category: research\n`,
    );
    const jobs = parseCronJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'morning-research',
      skills: ['research-protocol', 'summarize-news'],
      allowedTools: ['Read', 'Write', 'WebFetch'],
      allowedMcpServers: ['firecrawl', 'claude_ai_Gmail'],
      tags: ['morning', 'research'],
      category: 'research',
    });
  });

  it('accepts camelCase aliases for allowed_tools / allowed_mcp_servers', () => {
    writeCron(
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    allowedTools: [Read]\n` +
      `    allowedMcpServers: [slack]\n`,
    );
    const [job] = parseCronJobs();
    expect(job.allowedTools).toEqual(['Read']);
    expect(job.allowedMcpServers).toEqual(['slack']);
  });

  it('normalizes arrays — trims, dedupes, drops empty/non-string entries', () => {
    writeCron(
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    skills: ["  trim-me  ", "trim-me", "", "keep"]\n` +
      `    tags: ["a", "a", "b"]\n`,
    );
    const [job] = parseCronJobs();
    expect(job.skills).toEqual(['trim-me', 'keep']);
    expect(job.tags).toEqual(['a', 'b']);
  });

  it('returns undefined for malformed array fields (preserves "absent ⇒ inherit" semantics)', () => {
    writeCron(
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    skills: not-an-array\n` +
      `    allowed_tools: 42\n` +
      `    tags: null\n`,
    );
    const [job] = parseCronJobs();
    expect(job.skills).toBeUndefined();
    expect(job.allowedTools).toBeUndefined();
    expect(job.tags).toBeUndefined();
  });

  it('returns undefined for empty arrays so YAML "tags: []" doesn\'t pin the inherit semantic to []', () => {
    writeCron(
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    skills: []\n    tags: []\n`,
    );
    const [job] = parseCronJobs();
    expect(job.skills).toBeUndefined();
    expect(job.tags).toBeUndefined();
  });

  it('truncates over-long category to 64 chars and trims whitespace', () => {
    const long = 'a'.repeat(200);
    writeCron(
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    category: "  ${long}  "\n`,
    );
    const [job] = parseCronJobs();
    expect(job.category).toBe('a'.repeat(64));
  });

  it('drops non-string category gracefully', () => {
    writeCron(
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    category: 42\n`,
    );
    const [job] = parseCronJobs();
    expect(job.category).toBeUndefined();
  });

  it('backward compat — a legacy entry with no capability fields parses identically to before', () => {
    writeCron(
      `jobs:\n` +
      `  - name: legacy\n    schedule: "0 8 * * *"\n    prompt: just do it\n` +
      `    enabled: false\n    tier: 2\n`,
    );
    const [job] = parseCronJobs();
    expect(job).toMatchObject({
      name: 'legacy',
      schedule: '0 8 * * *',
      prompt: 'just do it',
      enabled: false,
      tier: 2,
    });
    expect(job.skills).toBeUndefined();
    expect(job.allowedTools).toBeUndefined();
    expect(job.allowedMcpServers).toBeUndefined();
    expect(job.tags).toBeUndefined();
    expect(job.category).toBeUndefined();
  });
});

describe('parseAgentCronJobs — symmetric trick capability handling', () => {
  it('parses capability fields on agent-scoped jobs and prefixes name with slug', () => {
    writeAgentCron('ross-the-sdr',
      `jobs:\n` +
      `  - name: prospect-research\n    schedule: "0 9 * * *"\n    prompt: research\n` +
      `    skills: [linkedin-recon]\n` +
      `    allowed_tools: [WebFetch, Read]\n` +
      `    allowed_mcp_servers: [salesforce]\n` +
      `    tags: [outreach]\n    category: prospecting\n`,
    );
    const jobs = parseAgentCronJobs(TMP_AGENTS());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'ross-the-sdr:prospect-research',
      agentSlug: 'ross-the-sdr',
      skills: ['linkedin-recon'],
      allowedTools: ['WebFetch', 'Read'],
      allowedMcpServers: ['salesforce'],
      tags: ['outreach'],
      category: 'prospecting',
    });
  });

  it('honors camelCase aliases on agent-scoped jobs (parser symmetry with global)', () => {
    writeAgentCron('agent-x',
      `jobs:\n` +
      `  - name: t\n    schedule: "* * * * *"\n    prompt: p\n` +
      `    allowedTools: [Bash]\n    allowedMcpServers: [linear]\n`,
    );
    const [job] = parseAgentCronJobs(TMP_AGENTS());
    expect(job.allowedTools).toEqual(['Bash']);
    expect(job.allowedMcpServers).toEqual(['linear']);
  });

  it('legacy agent jobs without capability fields keep all new fields undefined', () => {
    writeAgentCron('legacy-agent',
      `jobs:\n` +
      `  - name: hello\n    schedule: "0 8 * * *"\n    prompt: hi\n`,
    );
    const [job] = parseAgentCronJobs(TMP_AGENTS());
    expect(job.name).toBe('legacy-agent:hello');
    expect(job.skills).toBeUndefined();
    expect(job.allowedTools).toBeUndefined();
    expect(job.allowedMcpServers).toBeUndefined();
    expect(job.tags).toBeUndefined();
    expect(job.category).toBeUndefined();
  });
});
