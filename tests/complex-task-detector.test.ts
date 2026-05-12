import { describe, expect, it } from 'vitest';
import { detectComplexTaskForBackground } from '../src/agent/complex-task-detector.js';

describe('complex task background detector', () => {
  it('returns null for multi-system batch work without explicit background intent', () => {
    // Chat now handles this directly with auto-compaction + planner/researcher
    // subagent delegation. Only an explicit "in the background / overnight"
    // phrasing should auto-queue.
    const rec = detectComplexTaskForBackground(
      'Review all of my Asana tasks, compile the updates into Google Sheets, check Salesforce and four websites, then update Asana and report back.',
    );

    expect(rec).toBeNull();
  });

  it('queues immediately when the user explicitly asks for background work', () => {
    const rec = detectComplexTaskForBackground(
      'Run this in the background: research every stale Salesforce contact, enrich with DataForSEO, draft prospecting emails, and report back.',
    );

    expect(rec).toBeTruthy();
    expect(rec?.queueImmediately).toBe(true);
    expect(rec?.reasons.join(' ')).toMatch(/explicit background/);
  });

  it('queues immediately on "overnight" phrasing', () => {
    const rec = detectComplexTaskForBackground(
      'Go research these 30 firms overnight and put the findings in a sheet.',
    );

    expect(rec).toBeTruthy();
    expect(rec?.queueImmediately).toBe(true);
    expect(rec?.suggestedMaxMinutes).toBeGreaterThanOrEqual(30);
  });

  it('queues immediately on "keep working / don\'t stop" phrasing', () => {
    const rec = detectComplexTaskForBackground(
      'Keep working on the audit, don\'t stop until every page is reviewed.',
    );

    expect(rec).toBeTruthy();
    expect(rec?.queueImmediately).toBe(true);
  });

  it('returns null for project build and deployment requests without explicit background intent', () => {
    // The "host on Netlify" canonical test case: chat should just do it.
    const rec = detectComplexTaskForBackground(
      'Please recreate the dashboard as part of the coaches project and then host it on Netlify.',
    );

    expect(rec).toBeNull();
  });

  it('does not intercept skill authoring requests even with background phrasing', () => {
    const rec = detectComplexTaskForBackground(
      'Create a skill in the background that reviews Salesforce contacts and drafts emails.',
    );

    expect(rec).toBeNull();
  });

  it('returns null for simple chat', () => {
    expect(detectComplexTaskForBackground('What time is it?')).toBeNull();
    expect(detectComplexTaskForBackground('Summarize this short note.')).toBeNull();
  });
});
