/**
 * Phase 13 — extractErrorInfo helper.
 *
 * Live FalkorDB integration is hard to test hermetically (needs a running
 * server), but the diagnosis helper is pure and worth locking down — it's
 * the difference between "FalkorDB connection lost ERR:" (the bug we
 * shipped) and "FalkorDB connection lost errCode=ECONNREFUSED errPath=
 * /tmp/x.sock" (actionable diagnosis).
 */

import { describe, expect, it } from 'vitest';
import { extractErrorInfo } from '../src/memory/graph-store.js';

describe('extractErrorInfo', () => {
  it('returns no-error-object marker for null/undefined', () => {
    expect(extractErrorInfo(null)).toEqual({ errKind: 'no-error-object' });
    expect(extractErrorInfo(undefined)).toEqual({ errKind: 'no-error-object' });
  });

  it('handles primitives', () => {
    const r = extractErrorInfo('something went wrong');
    expect(r.errKind).toBe('primitive');
    expect(r.err).toBe('something went wrong');
  });

  it('captures Error.message when present', () => {
    const err = new Error('boom');
    const r = extractErrorInfo(err);
    expect(r.errMessage).toBe('boom');
    expect(r.errName).toBe('Error');
  });

  it('captures Node socket-error fields (the case that motivated this helper)', () => {
    // Simulate a Node ECONNREFUSED — these are the fields the falkordb
    // client surfaces with empty .message that left us blind.
    const err: any = new Error('');
    err.code = 'ECONNREFUSED';
    err.errno = -61;
    err.syscall = 'connect';
    err.address = '/var/folders/abc/.graph.sock';
    const r = extractErrorInfo(err);
    expect(r.errCode).toBe('ECONNREFUSED');
    expect(r.errno).toBe(-61);
    expect(r.errSyscall).toBe('connect');
    expect(r.errAddress).toBe('/var/folders/abc/.graph.sock');
    // .message was empty so it shouldn't appear
    expect(r.errMessage).toBeUndefined();
  });

  it('falls back to constructor name + JSON when nothing meaningful surfaced', () => {
    class WeirdError {}
    const w = new WeirdError();
    const r = extractErrorInfo(w);
    expect(r.errKind).toBe('WeirdError');
  });

  it('truncates very long messages', () => {
    const err = new Error('x'.repeat(500));
    const r = extractErrorInfo(err);
    expect(typeof r.errMessage).toBe('string');
    expect((r.errMessage as string).length).toBeLessThanOrEqual(200);
  });

  it('captures EPIPE shape (the most likely cause of our 36 drops)', () => {
    const err: any = new Error('');
    err.code = 'EPIPE';
    err.errno = -32;
    err.syscall = 'write';
    const r = extractErrorInfo(err);
    expect(r.errCode).toBe('EPIPE');
    expect(r.errSyscall).toBe('write');
  });
});
