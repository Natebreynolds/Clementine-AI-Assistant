import { describe, expect, it } from 'vitest';
import { detectComplexTaskForBackground } from '../src/agent/complex-task-detector.js';

describe('complex task background detector', () => {
  it('offers background mode for multi-system batch work', () => {
    const rec = detectComplexTaskForBackground(
      'Review all of my Asana tasks, compile the updates into Google Sheets, check Salesforce and four websites, then update Asana and report back.',
    );

    expect(rec).toBeTruthy();
    expect(rec?.queueImmediately).toBe(false);
    expect(rec?.suggestedMaxMinutes).toBeGreaterThanOrEqual(60);
    expect(rec?.reasons.join(' ')).toMatch(/named systems|batch/);
  });

  it('queues immediately only when the user explicitly asks for background work', () => {
    const rec = detectComplexTaskForBackground(
      'Run this in the background: research every stale Salesforce contact, enrich with DataForSEO, draft prospecting emails, and report back.',
    );

    expect(rec).toBeTruthy();
    expect(rec?.queueImmediately).toBe(true);
  });

  it('does not intercept skill authoring requests', () => {
    const rec = detectComplexTaskForBackground(
      'Create a skill that reviews Salesforce contacts and drafts emails.',
    );

    expect(rec).toBeNull();
  });

  it('does not offer background mode for simple chat', () => {
    expect(detectComplexTaskForBackground('What time is it?')).toBeNull();
    expect(detectComplexTaskForBackground('Summarize this short note.')).toBeNull();
  });
});
