import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enforceToolPermissions,
  setHeartbeatMode,
  setApprovalCallback,
  setInteractionSource,
  resetBrowserHarnessApproval,
  isBrowserHarnessApproved,
} from '../src/agent/hooks.js';

const T3 = 'mcp__browser-harness__browser_click_xy';
const T2 = 'mcp__browser-harness__browser_navigate';
const T1 = 'mcp__browser-harness__browser_screenshot';

describe('browser-harness Tier 3 enforcement (Phase 2)', () => {
  beforeEach(() => {
    setHeartbeatMode(false);
    setInteractionSource('owner-dm');
    setApprovalCallback(null);
    resetBrowserHarnessApproval();
  });
  afterEach(() => {
    setHeartbeatMode(false);
    setInteractionSource('owner-dm');
    setApprovalCallback(null);
    resetBrowserHarnessApproval();
  });
  it('blocks T3 click during heartbeat', async () => {
    setHeartbeatMode(true);
    const r = await enforceToolPermissions(T3, { x: 100, y: 200 });
    expect(r.behavior).toBe('deny');
    expect(r.message).toMatch(/autonomous|blocked/i);
  });
  it('blocks T3 click when source is autonomous', async () => {
    setInteractionSource('autonomous');
    const r = await enforceToolPermissions(T3, { x: 100, y: 200 });
    expect(r.behavior).toBe('deny');
  });
  it('denies T3 when no approval callback set', async () => {
    setInteractionSource('owner-dm');
    setApprovalCallback(null);
    const r = await enforceToolPermissions(T3, { x: 100, y: 200 });
    expect(r.behavior).toBe('deny');
  });
  it('asks approvalCallback once and caches approval', async () => {
    setInteractionSource('owner-dm');
    const cb = vi.fn().mockResolvedValue(true);
    setApprovalCallback(cb);
    const r1 = await enforceToolPermissions(T3, { x: 100, y: 200 });
    expect(r1.behavior).toBe('allow');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(isBrowserHarnessApproved()).toBe(true);
    const r2 = await enforceToolPermissions(T3, { x: 50, y: 50 });
    expect(r2.behavior).toBe('allow');
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('rejection is not cached, asks again on next call', async () => {
    setInteractionSource('owner-dm');
    let response = false;
    const cb = vi.fn().mockImplementation(async () => response);
    setApprovalCallback(cb);
    const r1 = await enforceToolPermissions(T3, { x: 1, y: 1 });
    expect(r1.behavior).toBe('deny');
    expect(isBrowserHarnessApproved()).toBe(false);
    response = true;
    const r2 = await enforceToolPermissions(T3, { x: 1, y: 1 });
    expect(r2.behavior).toBe('allow');
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it('resetBrowserHarnessApproval forces a new prompt', async () => {
    setInteractionSource('owner-dm');
    const cb = vi.fn().mockResolvedValue(true);
    setApprovalCallback(cb);
    await enforceToolPermissions(T3, { x: 1, y: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
    resetBrowserHarnessApproval();
    expect(isBrowserHarnessApproved()).toBe(false);
    await enforceToolPermissions(T3, { x: 1, y: 1 });
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it('T2 navigate does not require approval', async () => {
    setInteractionSource('owner-dm');
    const cb = vi.fn().mockResolvedValue(true);
    setApprovalCallback(cb);
    const r = await enforceToolPermissions(T2, { url: 'https://example.com' });
    expect(r.behavior).toBe('allow');
    expect(cb).not.toHaveBeenCalled();
  });
  it('T1 screenshot does not require approval', async () => {
    setInteractionSource('owner-dm');
    const cb = vi.fn().mockResolvedValue(true);
    setApprovalCallback(cb);
    const r = await enforceToolPermissions(T1, {});
    expect(r.behavior).toBe('allow');
    expect(cb).not.toHaveBeenCalled();
  });
  it('blocks all 5 T3 tool names autonomously', async () => {
    setHeartbeatMode(true);
    const tools = [
      'mcp__browser-harness__browser_click_xy',
      'mcp__browser-harness__browser_type_text',
      'mcp__browser-harness__browser_press_key',
      'mcp__browser-harness__browser_scroll',
      'mcp__browser-harness__browser_run_python',
    ];
    for (const t of tools) {
      const r = await enforceToolPermissions(t, {});
      expect(r.behavior, t).toBe('deny');
    }
  });
});
