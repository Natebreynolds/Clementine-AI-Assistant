/**
 * 1.18.185 — pin the cron field parsing for `model`, `always_deliver`
 * (and its camelCase alias `alwaysDeliver` for backward compat), and
 * `lean`. These are the three fields that 1.18.185 wired into the
 * dashboard write path; before that they only worked if you hand-
 * edited CRON.md.
 *
 * We test by mocking the config CRON_FILE to a tmp path so we can
 * control the YAML content and assert what comes out of parseCronJobs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;
let tmpCronFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clem-cron-test-'));
  tmpCronFile = path.join(tmpDir, 'CRON.md');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function parseWith(content: string) {
  writeFileSync(tmpCronFile, content);
  vi.doMock('../src/config.js', async () => {
    const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
    return { ...actual, CRON_FILE: tmpCronFile };
  });
  const { parseCronJobs } = await import('../src/gateway/cron-scheduler.js');
  return parseCronJobs();
}

// 1.18.192 — bump describe-level timeout: parseCronJobs imports
// cron-scheduler.js whose transitive imports (gateway/router → assistant)
// take >5s the first time the suite warms them up. The test logic itself
// is sub-second; just need to absorb the cold-import cost.
describe('CRON.md field parsing (1.18.185)', { timeout: 30000 }, () => {
  it('parses per-job model override', async () => {
    const jobs = await parseWith(`---
jobs:
  - name: with-model
    schedule: "0 9 * * *"
    prompt: "do thing"
    model: "claude-opus-4-7[1m]"
---

# CRON
`);
    const job = jobs.find((j) => j.name === 'with-model');
    expect(job).toBeDefined();
    expect(job?.model).toBe('claude-opus-4-7[1m]');
  });

  it('parses always_deliver (canonical snake_case)', async () => {
    const jobs = await parseWith(`---
jobs:
  - name: retry-empty
    schedule: "*/30 * * * *"
    prompt: "poll"
    always_deliver: true
---

# CRON
`);
    const job = jobs.find((j) => j.name === 'retry-empty');
    expect(job?.alwaysDeliver).toBe(true);
  });

  it('parses alwaysDeliver (defensive camelCase) — accepts both casings', async () => {
    // 1.18.185 — the original dashboard POST/PUT wrote camelCase but
    // the parser only read snake_case. Now both work; canonical write
    // is snake_case but defensive parsing handles either form.
    const jobs = await parseWith(`---
jobs:
  - name: retry-empty
    schedule: "*/30 * * * *"
    prompt: "poll"
    alwaysDeliver: true
---

# CRON
`);
    const job = jobs.find((j) => j.name === 'retry-empty');
    expect(job?.alwaysDeliver).toBe(true);
  });

  it('parses lean mode flag', async () => {
    const jobs = await parseWith(`---
jobs:
  - name: meta-job
    schedule: "0 * * * *"
    prompt: "tiny prompt"
    lean: true
---

# CRON
`);
    const job = jobs.find((j) => j.name === 'meta-job');
    expect(job?.lean).toBe(true);
  });

  it('omits all three fields when unset (no false positives)', async () => {
    const jobs = await parseWith(`---
jobs:
  - name: plain
    schedule: "0 9 * * *"
    prompt: "default"
---

# CRON
`);
    const job = jobs.find((j) => j.name === 'plain');
    expect(job?.model).toBeUndefined();
    expect(job?.alwaysDeliver).toBeUndefined();
    expect(job?.lean).toBeUndefined();
  });

  it('all three fields can coexist on one job', async () => {
    const jobs = await parseWith(`---
jobs:
  - name: full-loaded
    schedule: "0 9 * * *"
    prompt: "the works"
    model: "claude-opus-4-7[1m]"
    always_deliver: true
    lean: true
---

# CRON
`);
    const job = jobs.find((j) => j.name === 'full-loaded');
    expect(job?.model).toBe('claude-opus-4-7[1m]');
    expect(job?.alwaysDeliver).toBe(true);
    expect(job?.lean).toBe(true);
  });
});
