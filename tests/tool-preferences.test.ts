import { describe, expect, it } from 'vitest';
import {
  buildComposioStatusBlock,
  buildPromptInstruction,
  computeAvailability,
} from '../src/integrations/tool-preferences.js';

describe('buildComposioStatusBlock', () => {
  it('returns empty string when no toolkits are connected', () => {
    expect(buildComposioStatusBlock([])).toBe('');
  });

  it('emits a status block with a single toolkit', () => {
    const out = buildComposioStatusBlock(['outlook']);
    expect(out).toContain('## Composio Integration');
    expect(out).toContain('Connected toolkits: outlook');
    expect(out).toContain('mcp__outlook__*');
    expect(out).toContain('NOT claude.ai integrations');
  });

  it('lists multiple toolkits sorted alphabetically', () => {
    const out = buildComposioStatusBlock(['outlook', 'googledrive', 'googledocs']);
    expect(out).toContain('Connected toolkits: googledocs, googledrive, outlook');
  });

  it('does not mutate the input array', () => {
    const input = ['outlook', 'googledrive', 'googledocs'];
    const snapshot = [...input];
    buildComposioStatusBlock(input);
    expect(input).toEqual(snapshot);
  });

  it('uses the first sorted slug in the example tool name', () => {
    const out = buildComposioStatusBlock(['outlook', 'googledocs']);
    expect(out).toContain('`mcp__googledocs__*`');
  });
});

describe('buildPromptInstruction (regression)', () => {
  it('still emits nothing when there are no conflicts', () => {
    const availability = computeAvailability(
      new Set(['outlook']),       // composio only
      new Set(),                  // no claude.ai
      {},
    );
    expect(buildPromptInstruction(availability, {})).toBe('');
  });

  it('emits a conflict line when both sources are connected', () => {
    const availability = computeAvailability(
      new Set(['outlook']),
      new Set(['Microsoft_365']),
      {},
    );
    const out = buildPromptInstruction(availability, {});
    expect(out).toContain('## Tool Source Preferences');
    expect(out).toContain('mcp__outlook__*');
    expect(out).toContain('mcp__claude_ai_Microsoft_365__*');
  });
});
