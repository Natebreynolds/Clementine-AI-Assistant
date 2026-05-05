import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCronDiagnosticResponse,
  detectCronDiagnosticRequest,
} from '../src/gateway/cron-diagnostic-turn.js';

describe('cron diagnostic local turn', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'clementine-cron-diagnostic-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function writeRun(entry: Record<string, unknown>): void {
    const file = path.join(baseDir, 'cron', 'runs', 'customer-followup-review.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  }

  function writeUnleashedStatus(jobName: string, status: Record<string, unknown>): void {
    const file = path.join(baseDir, 'unleashed', jobName, 'status.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(status, null, 2));
  }

  function writeCronConfig(): void {
    const file = path.join(baseDir, 'vault', '00-System', 'CRON.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, [
      'jobs:',
      '  - name: customer-followup-review',
      '    schedule: 30 8 * * *',
      '    tier: 2',
      '    enabled: true',
      '    mode: unleashed',
      '    max_hours: 1',
      '    agentSlug: account-manager',
      '    work_dir: /tmp/customer-workspace',
      '    prompt: |',
      '      Long job prompt starts here.',
    ].join('\n'));
  }

  it('detects a spaced mention of a configured hyphenated job', () => {
    writeCronConfig();
    const request = detectCronDiagnosticRequest('Can we fix the customer follow up review job?', { baseDir });
    expect(request).toEqual({
      jobName: 'customer-followup-review',
      wantsFix: true,
    });
  });

  it('does not intercept non-diagnostic mentions of the job', () => {
    writeCronConfig();
    expect(detectCronDiagnosticRequest('customer follow up review went out yesterday', { baseDir })).toBeNull();
  });

  it('does not intercept unrelated hyphenated phrases without cron context', () => {
    expect(detectCronDiagnosticRequest('fix the sign-up modal')).toBeNull();
  });

  it('returns a bounded diagnostic without running the job', () => {
    writeCronConfig();
    writeRun({
      jobName: 'customer-followup-review',
      startedAt: '2026-05-01T15:30:00.000Z',
      finishedAt: '2026-05-01T15:39:00.000Z',
      status: 'ok',
      durationMs: 540_000,
      outputPreview: 'Processed 20 tasks.',
    });
    writeRun({
      jobName: 'customer-followup-review',
      startedAt: '2026-05-02T15:30:00.655Z',
      finishedAt: '2026-05-02T15:46:01.354Z',
      status: 'ok',
      durationMs: 960_699,
      terminalReason: 'rapid_refill_breaker',
      outputPreview: 'Autocompact is thrashing: the context refilled to the limit within 3 turns.',
    });

    const response = buildCronDiagnosticResponse(
      'Are you able to fix the customer follow up review?',
      { baseDir },
    );

    expect(response).toContain('I found customer-followup-review. I am not running the job.');
    expect(response).toContain('terminal rapid_refill_breaker');
    expect(response).toContain('not a downstream integration failure');
    expect(response).toContain('Current config: - name: customer-followup-review');
    expect(response).toContain('max_hours: 1');
    expect(response).toContain('config/prompt repair');
  });

  it('does not parse internal deep-mode result prompts as cron job names', () => {
    const response = buildCronDiagnosticResponse(
      '[DEEP_MODE_RESULT] The background task failed: Background work failed. Let the user know.',
      { baseDir },
    );

    expect(response).toBeNull();
    expect(detectCronDiagnosticRequest('[DEEP_MODE_RESULT] market-leader-followup failed', { baseDir })).toBeNull();
  });

  it('treats delivered abort notices as semantic failures even when wrapper status is ok', () => {
    writeCronConfig();
    writeRun({
      jobName: 'customer-followup-review',
      startedAt: '2026-05-04T23:00:00.478Z',
      finishedAt: '2026-05-04T23:00:19.929Z',
      status: 'ok',
      durationMs: 19451,
      outputPreview: 'Task "customer-followup-review" aborted after 3 consecutive phase errors.',
      terminalReason: 'completed',
    });
    writeUnleashedStatus('customer-followup-review', {
      jobName: 'customer-followup-review',
      status: 'error',
      phase: 3,
      updatedAt: '2026-05-04T23:00:19.928Z',
    });

    const response = buildCronDiagnosticResponse(
      'How do we fix customer-followup-review?',
      { baseDir },
    );

    expect(response).toContain('Unleashed status: error, phase 3');
    expect(response).toContain('Root cause from latest output');
    expect(response).toContain('underlying phase failure');
  });
});
