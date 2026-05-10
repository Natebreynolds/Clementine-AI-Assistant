import { describe, it, expect } from 'vitest';
import {
  normalizeErrorMessage,
  clusterBrokenJobs,
  formatClustersForHypothesizer,
  MIN_CLUSTER_SIZE,
} from '../src/gateway/failure-clustering.js';
import type { BrokenJob } from '../src/gateway/failure-monitor.js';

function fakeBrokenJob(name: string, errors: string[], errorCount48h = 5): BrokenJob {
  return {
    jobName: name,
    errorCount48h,
    totalRuns48h: errorCount48h + 1,
    lastErrorAt: new Date().toISOString(),
    lastErrors: errors,
    circuitBreakerEngagedAt: null,
    lastAdvisorOpinion: null,
  };
}

describe('normalizeErrorMessage', () => {
  it('collapses ISO timestamps', () => {
    const a = normalizeErrorMessage('Failed at 2026-05-10T14:23:00.000Z while processing');
    const b = normalizeErrorMessage('Failed at 2026-01-01T08:00:00Z while processing');
    expect(a).toBe(b);
    expect(a).toContain('<ts>');
  });

  it('collapses parenthesized numbers including "(N tokens)"', () => {
    const a = normalizeErrorMessage('Prompt is too long (12345 tokens)');
    const b = normalizeErrorMessage('Prompt is too long (98765 tokens)');
    expect(a).toBe(b);
    expect(a).toContain('(N tokens)');
  });

  it('collapses bare parenthesized numbers without a suffix', () => {
    const a = normalizeErrorMessage('Reached maximum number of turns (8)');
    const b = normalizeErrorMessage('Reached maximum number of turns (15)');
    expect(a).toBe(b);
    expect(a).toContain('(N)');
  });

  it('collapses UUIDs', () => {
    const a = normalizeErrorMessage('Session aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee timed out');
    const b = normalizeErrorMessage('Session 11111111-2222-3333-4444-555555555555 timed out');
    expect(a).toBe(b);
    expect(a).toContain('<uuid>');
  });

  it('collapses long hex tokens', () => {
    const a = normalizeErrorMessage('Failed: 0123456789abcdef0123456789');
    const b = normalizeErrorMessage('Failed: fedcba9876543210fedcba9876');
    expect(a).toBe(b);
    expect(a).toContain('<hex>');
  });

  it('collapses absolute paths to keep just the basename', () => {
    const a = normalizeErrorMessage('Cannot read /home/user/project/foo.json');
    const b = normalizeErrorMessage('Cannot read /var/lib/clementine/foo.json');
    expect(a).toBe(b);
    expect(a).toContain('foo.json');
  });

  it('lowercases + collapses whitespace', () => {
    expect(normalizeErrorMessage('Prompt   IS   too   LONG')).toBe('prompt is too long');
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(500);
    const out = normalizeErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('returns empty string on empty/null', () => {
    expect(normalizeErrorMessage('')).toBe('');
  });
});

describe('clusterBrokenJobs', () => {
  it('returns empty when no jobs are broken', () => {
    expect(clusterBrokenJobs([])).toEqual([]);
  });

  it(`requires ≥${MIN_CLUSTER_SIZE} distinct jobs to form a cluster`, () => {
    const jobs = [
      fakeBrokenJob('job-a', ['Prompt is too long (123 tokens)']),
      fakeBrokenJob('job-b', ['Prompt is too long (456 tokens)']),
      // only 2 jobs — below threshold
    ];
    expect(clusterBrokenJobs(jobs)).toEqual([]);
  });

  it('clusters 3+ jobs hitting the same normalized pattern', () => {
    const jobs = [
      fakeBrokenJob('insight-check', ['Prompt is too long (12345 tokens)']),
      fakeBrokenJob('outcome-grader', ['Prompt is too long (45678 tokens)']),
      fakeBrokenJob('route-classifier', ['Prompt is too long (99999 tokens)']),
    ];
    const clusters = clusterBrokenJobs(jobs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.jobs).toHaveLength(3);
    expect(clusters[0]!.pattern).toContain('prompt is too long');
    expect(clusters[0]!.pattern).toContain('(N tokens)');
  });

  it('does not double-count a job that has the same pattern twice in lastErrors', () => {
    const jobs = [
      fakeBrokenJob('a', ['Prompt is too long (1)', 'Prompt is too long (2)']),
      fakeBrokenJob('b', ['Prompt is too long (3)']),
      fakeBrokenJob('c', ['Prompt is too long (4)']),
    ];
    const clusters = clusterBrokenJobs(jobs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.jobs).toHaveLength(3);
  });

  it('a job with two distinct patterns counts toward both clusters', () => {
    const jobs = [
      fakeBrokenJob('multi', ['Prompt is too long (1)', 'Reached maximum number of turns (5)']),
      fakeBrokenJob('p1', ['Prompt is too long (2)']),
      fakeBrokenJob('p2', ['Prompt is too long (3)']),
      fakeBrokenJob('t1', ['Reached maximum number of turns (6)']),
      fakeBrokenJob('t2', ['Reached maximum number of turns (7)']),
    ];
    const clusters = clusterBrokenJobs(jobs);
    expect(clusters).toHaveLength(2);
    const names = clusters.map(c => c.jobs.map(j => j.jobName).sort());
    expect(names.flat()).toContain('multi'); // appears in both clusters
  });

  it('sorts clusters by job count desc, then total errors desc', () => {
    const jobs = [
      // smaller cluster (3 jobs, 9 errors)
      fakeBrokenJob('s1', ['Pattern X'], 3),
      fakeBrokenJob('s2', ['Pattern X'], 3),
      fakeBrokenJob('s3', ['Pattern X'], 3),
      // larger cluster (4 jobs, 4 errors)
      fakeBrokenJob('l1', ['Pattern Y'], 1),
      fakeBrokenJob('l2', ['Pattern Y'], 1),
      fakeBrokenJob('l3', ['Pattern Y'], 1),
      fakeBrokenJob('l4', ['Pattern Y'], 1),
    ];
    const clusters = clusterBrokenJobs(jobs);
    expect(clusters[0]!.jobs).toHaveLength(4); // larger one wins
    expect(clusters[1]!.jobs).toHaveLength(3);
  });

  it('picks the most-common raw form as the representative', () => {
    // "Prompt is too long (X tokens)" appears twice with the same raw shape
    // for "common", once with a different form. Both normalize to the same key.
    const jobs = [
      fakeBrokenJob('a', ['Prompt is too long (1 tokens)']),
      fakeBrokenJob('b', ['Prompt is too long (1 tokens)']),
      fakeBrokenJob('c', ['Prompt is too long (1 tokens)']),
      fakeBrokenJob('d', ['prompt-too-long: rare-variant']),
    ];
    const clusters = clusterBrokenJobs(jobs);
    // The variant tokens differ; the raw "Prompt is too long (1 tokens)"
    // wins as representative because it appeared 3 times.
    if (clusters.length > 0) {
      const rep = clusters[0]!.representative;
      expect(rep).toContain('Prompt is too long');
    }
  });

  it('aggregates totalErrors across all jobs in a cluster', () => {
    const jobs = [
      fakeBrokenJob('a', ['Pattern Z'], 4),
      fakeBrokenJob('b', ['Pattern Z'], 5),
      fakeBrokenJob('c', ['Pattern Z'], 6),
    ];
    const clusters = clusterBrokenJobs(jobs);
    expect(clusters[0]!.totalErrors).toBe(15);
  });
});

describe('formatClustersForHypothesizer', () => {
  it('returns empty string for empty clusters', () => {
    expect(formatClustersForHypothesizer([])).toBe('');
  });

  it('renders a header + bullet per cluster + closing nudge', () => {
    const clusters = clusterBrokenJobs([
      fakeBrokenJob('a', ['Prompt is too long (1)']),
      fakeBrokenJob('b', ['Prompt is too long (2)']),
      fakeBrokenJob('c', ['Prompt is too long (3)']),
    ]);
    const out = formatClustersForHypothesizer(clusters);
    expect(out).toContain('Cross-job failure clusters');
    expect(out).toContain('3 jobs');
    expect(out).toContain('a, b, c');
    expect(out).toContain('root-cause');
  });

  it('truncates the job list at 5 with a "+N more" suffix', () => {
    const jobs = Array.from({ length: 8 }, (_, i) => fakeBrokenJob('job-' + i, ['Same Pattern']));
    const clusters = clusterBrokenJobs(jobs);
    const out = formatClustersForHypothesizer(clusters);
    expect(out).toContain('+3 more');
  });

  it('caps representative at ~100 chars', () => {
    const longErr = 'Same prefix that should be visible: ' + 'x'.repeat(300);
    const jobs = [
      fakeBrokenJob('a', [longErr]),
      fakeBrokenJob('b', [longErr]),
      fakeBrokenJob('c', [longErr]),
    ];
    const clusters = clusterBrokenJobs(jobs);
    const out = formatClustersForHypothesizer(clusters);
    expect(out).toContain('…');
  });
});
