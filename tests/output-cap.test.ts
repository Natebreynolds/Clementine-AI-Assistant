/**
 * Phase 11d — capOutput helper.
 *
 * Pure function tests for the shared output-truncation utility used by
 * memory_read, cron_progress_read, and (future) other large-output MCP tools.
 */

import { describe, expect, it } from 'vitest';
import { capOutput, DEFAULT_OUTPUT_MAX_CHARS } from '../src/tools/shared.js';

describe('capOutput', () => {
  it('passes through content under the limit unchanged', () => {
    const text = 'a'.repeat(100);
    expect(capOutput(text, 200)).toBe(text);
  });

  it('truncates content above the limit and adds a marker', () => {
    const text = 'a'.repeat(50_000);
    const out = capOutput(text, 30_000);
    expect(out.length).toBeLessThan(31_000);
    expect(out).toContain('truncated');
    expect(out).toContain('chars');
  });

  it('reports the dropped char count and KB in the marker', () => {
    const text = 'a'.repeat(50_000);
    const out = capOutput(text, 30_000);
    // 50_000 - (30_000 - 200) = 20_200 dropped (200 reserved for marker)
    expect(out).toMatch(/truncated 20[,.]?\d{0,3}\s*chars/);
    expect(out).toMatch(/\d+\.\d KB/);
  });

  it('exposes hintParam in the truncation marker when provided', () => {
    const text = 'a'.repeat(50_000);
    const out = capOutput(text, 30_000, { hintParam: 'max_chars' });
    expect(out).toContain('Pass `max_chars`');
  });

  it('keeps a tail when requested (head + … + tail)', () => {
    const text = 'A'.repeat(40_000) + '|END|';
    const out = capOutput(text, 30_000, { tail: 200 });
    expect(out.endsWith('|END|')).toBe(true);
    expect(out).toContain('truncated');
  });

  it('default cap matches DEFAULT_OUTPUT_MAX_CHARS', () => {
    const justOver = 'a'.repeat(DEFAULT_OUTPUT_MAX_CHARS + 1);
    const out = capOutput(justOver);
    expect(out.length).toBeLessThan(DEFAULT_OUTPUT_MAX_CHARS + 500);
    expect(out).toContain('truncated');
  });

  it('does not truncate when text length equals the limit', () => {
    const text = 'a'.repeat(1000);
    expect(capOutput(text, 1000)).toBe(text);
  });

  it('handles empty input', () => {
    expect(capOutput('', 100)).toBe('');
  });
});
