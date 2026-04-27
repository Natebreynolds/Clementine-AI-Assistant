import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAll,
  extractServerName,
  getTrippedServers,
  isServerTripped,
  recordToolOutcome,
  resetServer,
} from '../src/agent/mcp-circuit-breaker.js';

describe('mcp circuit breaker — server name extraction', () => {
  it('extracts the server name from various MCP tool name shapes', () => {
    expect(extractServerName('mcp__clementine-tools__memory_search')).toBe('clementine-tools');
    expect(extractServerName('mcp__ElevenLabs__text_to_speech')).toBe('ElevenLabs');
    // Server names with underscores in them — the LAST __ is the boundary.
    expect(extractServerName('mcp__claude_ai_Gmail__authenticate')).toBe('claude_ai_Gmail');
    expect(extractServerName('mcp__plugin_proposal-builder_brightdata__discover')).toBe('plugin_proposal-builder_brightdata');
  });

  it('returns null for non-MCP tool names', () => {
    expect(extractServerName('Bash')).toBeNull();
    expect(extractServerName('Read')).toBeNull();
    expect(extractServerName('Edit')).toBeNull();
    expect(extractServerName('Agent')).toBeNull();
  });

  it('returns null when there is no tool segment after the server', () => {
    expect(extractServerName('mcp__server')).toBeNull();
    expect(extractServerName('mcp__')).toBeNull();
  });
});

describe('mcp circuit breaker — trip behavior', () => {
  beforeEach(() => {
    _resetAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetAll();
  });

  it('does not trip on argument errors (those are agent fault, not connector)', () => {
    const tool = 'mcp__ElevenLabs__text_to_speech';
    for (let i = 0; i < 10; i++) {
      recordToolOutcome(tool, 'arg_error');
    }
    expect(isServerTripped('ElevenLabs')).toBe(false);
  });

  it('trips after 5 connector failures within the window', () => {
    const tool = 'mcp__ElevenLabs__text_to_speech';
    for (let i = 0; i < 4; i++) {
      recordToolOutcome(tool, 'other_error');
    }
    expect(isServerTripped('ElevenLabs')).toBe(false);
    recordToolOutcome(tool, 'other_error');
    expect(isServerTripped('ElevenLabs')).toBe(true);
  });

  it('does not trip when failures are spread outside the 5-minute window', () => {
    const tool = 'mcp__claude_ai_Gmail__authenticate';
    for (let i = 0; i < 5; i++) {
      recordToolOutcome(tool, 'auth_error');
      vi.advanceTimersByTime(2 * 60 * 1000); // 2 minutes between failures
    }
    // Only the most recent ~3 are within a 5-minute window
    expect(isServerTripped('claude_ai_Gmail')).toBe(false);
  });

  it('auto-resets after the cooldown expires', () => {
    const tool = 'mcp__plugin_x_y__do_thing';
    for (let i = 0; i < 5; i++) recordToolOutcome(tool, 'other_error');
    expect(isServerTripped('plugin_x_y')).toBe(true);

    // Just before cooldown — still tripped
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(isServerTripped('plugin_x_y')).toBe(true);

    // After cooldown — auto-clears
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(isServerTripped('plugin_x_y')).toBe(false);
  });

  it('clears the failure window on success when not tripped', () => {
    const tool = 'mcp__ElevenLabs__text_to_speech';
    for (let i = 0; i < 4; i++) recordToolOutcome(tool, 'other_error');
    expect(isServerTripped('ElevenLabs')).toBe(false);

    // Success clears accumulated failures.
    recordToolOutcome(tool, 'success');
    // Now we need a full 5 fresh failures to trip.
    for (let i = 0; i < 4; i++) recordToolOutcome(tool, 'other_error');
    expect(isServerTripped('ElevenLabs')).toBe(false);
    recordToolOutcome(tool, 'other_error');
    expect(isServerTripped('ElevenLabs')).toBe(true);
  });

  it('manual reset closes an open breaker', () => {
    const tool = 'mcp__ElevenLabs__text_to_speech';
    for (let i = 0; i < 5; i++) recordToolOutcome(tool, 'other_error');
    expect(isServerTripped('ElevenLabs')).toBe(true);
    expect(resetServer('ElevenLabs')).toBe(true);
    expect(isServerTripped('ElevenLabs')).toBe(false);
    // Returns false when server was not tripped
    expect(resetServer('ElevenLabs')).toBe(false);
  });

  it('getTrippedServers returns each currently-open breaker with cooldown remaining', () => {
    const a = 'mcp__a__t';
    const b = 'mcp__b__t';
    for (let i = 0; i < 5; i++) recordToolOutcome(a, 'auth_error');
    for (let i = 0; i < 5; i++) recordToolOutcome(b, 'other_error');
    const tripped = getTrippedServers();
    expect(tripped.map(t => t.server).sort()).toEqual(['a', 'b']);
    expect(tripped.every(t => t.cooldownRemainingMs > 0)).toBe(true);
  });

  it('non-MCP tool outcomes are no-ops', () => {
    recordToolOutcome('Bash', 'other_error');
    recordToolOutcome('Read', 'other_error');
    expect(getTrippedServers()).toEqual([]);
  });
});
