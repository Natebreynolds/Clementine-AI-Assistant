import { describe, expect, it } from 'vitest';
import { formatToolsetChoices, getToolsetPreset, normalizeToolsetName, toolsetAllowsLocalWrites } from '../src/agent/toolsets.js';

describe('toolsets', () => {
  it('normalizes operator-friendly aliases', () => {
    expect(normalizeToolsetName('diagnostics')).toBe('diagnostic');
    expect(normalizeToolsetName('comms')).toBe('communications');
    expect(normalizeToolsetName('operator')).toBe('full');
    expect(normalizeToolsetName('nope')).toBeNull();
  });

  it('describes presets and local write policy', () => {
    expect(getToolsetPreset('memory').directive).toContain('transcript_search');
    expect(formatToolsetChoices()).toContain('diagnostic');
    expect(toolsetAllowsLocalWrites('safe')).toBe(false);
    expect(toolsetAllowsLocalWrites('full')).toBe(true);
  });
});
