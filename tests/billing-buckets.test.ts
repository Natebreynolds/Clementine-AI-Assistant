import { describe, it, expect } from 'vitest';
import {
  classifyBillingBucket,
  isExtraUsage,
  BUCKET_DISPLAY_ORDER,
} from '../src/lib/billing-buckets.js';

describe('classifyBillingBucket', () => {
  it('classifies plain Sonnet model IDs as in-plan 200K', () => {
    const b = classifyBillingBucket('claude-sonnet-4-6');
    expect(b.id).toBe('sonnet');
    expect(b.context).toBe('200k');
    expect(b.meteredOnMax).toBe('plan');
    expect(isExtraUsage(b)).toBe(false);
  });

  it('classifies Sonnet [1m] as Extra Usage on Max', () => {
    // The headline finding from the 2026-05-11 audit: Max covers Opus
    // long-context but NOT Sonnet 1M. Sonnet [1m] always routes to the
    // Extra Usage billing path.
    const b = classifyBillingBucket('claude-sonnet-4-6[1m]');
    expect(b.id).toBe('sonnet-1m');
    expect(b.context).toBe('1m');
    expect(b.meteredOnMax).toBe('extra');
    expect(isExtraUsage(b)).toBe(true);
    expect(b.label).toContain('Extra Usage');
  });

  it('classifies plain Opus as in-plan 200K', () => {
    const b = classifyBillingBucket('claude-opus-4-7');
    expect(b.id).toBe('opus');
    expect(b.context).toBe('200k');
    expect(b.meteredOnMax).toBe('plan');
  });

  it('classifies Opus [1m] as in-plan (Max covers Opus long-context)', () => {
    // The whole point of preferring Opus [1m] over Sonnet [1m] when 1M
    // is actually needed: Opus 1M is covered by Max, Sonnet 1M is not.
    const b = classifyBillingBucket('claude-opus-4-7[1m]');
    expect(b.id).toBe('opus-1m');
    expect(b.context).toBe('1m');
    expect(b.meteredOnMax).toBe('plan');
    expect(isExtraUsage(b)).toBe(false);
  });

  it('classifies Haiku model IDs (no 1M variant exists)', () => {
    const b = classifyBillingBucket('claude-haiku-4-5-20251001');
    expect(b.id).toBe('haiku');
    expect(b.context).toBe('200k');
    expect(b.meteredOnMax).toBe('plan');
  });

  it('accepts SDK tier aliases (sonnet, opus, haiku)', () => {
    expect(classifyBillingBucket('sonnet').id).toBe('sonnet');
    expect(classifyBillingBucket('opus').id).toBe('opus');
    expect(classifyBillingBucket('haiku').id).toBe('haiku');
  });

  it('is case-insensitive for [1m] suffix', () => {
    expect(classifyBillingBucket('claude-sonnet-4-6[1M]').id).toBe('sonnet-1m');
    expect(classifyBillingBucket('claude-sonnet-4-6[1m]').id).toBe('sonnet-1m');
  });

  it('falls back to "other" for empty / unknown strings', () => {
    expect(classifyBillingBucket('').id).toBe('other');
    expect(classifyBillingBucket(undefined).id).toBe('other');
    expect(classifyBillingBucket(null).id).toBe('other');
    expect(classifyBillingBucket('gpt-4').id).toBe('other');
  });

  it('preserves the raw label for unknown models so the dashboard shows what was passed', () => {
    const b = classifyBillingBucket('weird-model-name');
    expect(b.id).toBe('other');
    expect(b.label).toBe('weird-model-name');
  });

  it('puts Extra Usage last in BUCKET_DISPLAY_ORDER so it visually anchors callouts', () => {
    const extra = BUCKET_DISPLAY_ORDER.indexOf('sonnet-1m');
    const lastPlan = Math.max(
      BUCKET_DISPLAY_ORDER.indexOf('opus-1m'),
      BUCKET_DISPLAY_ORDER.indexOf('opus'),
      BUCKET_DISPLAY_ORDER.indexOf('haiku'),
      BUCKET_DISPLAY_ORDER.indexOf('sonnet'),
    );
    expect(extra).toBeGreaterThan(lastPlan);
  });
});
