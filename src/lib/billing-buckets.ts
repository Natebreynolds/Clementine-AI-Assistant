/**
 * Anthropic billing-bucket classifier.
 *
 * Maps a Claude model string (full ID or SDK tier alias) to the metering
 * bucket Anthropic bills against. The headline distinction on Max /
 * Team / Enterprise plans is in-plan (covered by the subscription's
 * usage allowance) vs. Extra Usage (billed separately, surprises the
 * meter watcher).
 *
 * **Why this matters (2026-05-11)**: Sonnet `[1m]` is on the Extra Usage
 * path even with Max. Max covers Opus long-context but not Sonnet 1M.
 * Without per-bucket aggregation, the dashboard cost number conflates
 * "covered by my plan" with "billed separately" and the user has no way
 * to spot Extra Usage exposure until the invoice arrives. See
 * memory/feedback_sonnet_1m_extra_usage.md.
 *
 * Pure function, no I/O. Safe to call from any layer.
 */

export type BillingBucketId =
  | 'sonnet'      // Sonnet 200K (standard meter)
  | 'sonnet-1m'   // Sonnet 1M — Extra Usage on Max
  | 'opus'        // Opus 200K (Max-covered)
  | 'opus-1m'     // Opus 1M (Max-covered long-context)
  | 'haiku'       // Haiku (Max-covered, cheap)
  | 'other';      // Unrecognized / non-Claude

export type BillingBucketMetering =
  /** Counts against the Max/Team/Enterprise plan's usage allowance. */
  | 'plan'
  /** Billed separately as Extra Usage even when the user has Max. */
  | 'extra';

export interface BillingBucket {
  /** Stable bucket id, suitable for grouping/keys. */
  id: BillingBucketId;
  /** Human-readable label for UI ("Sonnet 200K", "Sonnet 1M — Extra Usage"). */
  label: string;
  /** Model family irrespective of context window. */
  family: 'sonnet' | 'opus' | 'haiku' | 'other';
  /** Context window class. */
  context: '200k' | '1m';
  /** How Anthropic bills this on a Max plan. */
  meteredOnMax: BillingBucketMetering;
}

/**
 * Classify a model string into its billing bucket.
 *
 * Accepts:
 *  - Full model IDs: `claude-sonnet-4-6`, `claude-sonnet-4-6[1m]`,
 *    `claude-opus-4-7[1m]`, `claude-haiku-4-5-20251001`, etc.
 *  - SDK tier aliases: `sonnet`, `opus`, `haiku` (no `[1m]` form for
 *    tier aliases — they always resolve to standard context).
 *  - Empty / unknown / non-Claude strings → `'other'` bucket.
 */
export function classifyBillingBucket(model: string | undefined | null): BillingBucket {
  const m = String(model ?? '').toLowerCase().trim();
  if (!m) return OTHER;

  const is1m = /\[1m\]/i.test(m);

  // Tier aliases — no context-window suffix possible.
  if (m === 'sonnet') return SONNET_200K;
  if (m === 'opus') return OPUS_200K;
  if (m === 'haiku') return HAIKU;

  // Full model IDs. Order matters — check opus before sonnet because
  // "opusplan" contains "opus" but not "sonnet"; reverse would still be
  // safe today, but explicit ordering is more robust to future names.
  if (m.includes('opus')) return is1m ? OPUS_1M : OPUS_200K;
  if (m.includes('sonnet')) return is1m ? SONNET_1M : SONNET_200K;
  if (m.includes('haiku')) return HAIKU; // 1M not supported on Haiku

  return { ...OTHER, label: model || 'Unknown' };
}

/** Stable singletons so equality checks and bucket-key lookups are cheap. */
const SONNET_200K: BillingBucket = {
  id: 'sonnet',
  label: 'Sonnet (200K)',
  family: 'sonnet',
  context: '200k',
  meteredOnMax: 'plan',
};
const SONNET_1M: BillingBucket = {
  id: 'sonnet-1m',
  label: 'Sonnet (1M) — Extra Usage',
  family: 'sonnet',
  context: '1m',
  meteredOnMax: 'extra',
};
const OPUS_200K: BillingBucket = {
  id: 'opus',
  label: 'Opus (200K)',
  family: 'opus',
  context: '200k',
  meteredOnMax: 'plan',
};
const OPUS_1M: BillingBucket = {
  id: 'opus-1m',
  label: 'Opus (1M)',
  family: 'opus',
  context: '1m',
  meteredOnMax: 'plan',
};
const HAIKU: BillingBucket = {
  id: 'haiku',
  label: 'Haiku',
  family: 'haiku',
  context: '200k',
  meteredOnMax: 'plan',
};
const OTHER: BillingBucket = {
  id: 'other',
  label: 'Unknown',
  family: 'other',
  context: '200k',
  meteredOnMax: 'plan',
};

/** Canonical render order for the dashboard panel. */
export const BUCKET_DISPLAY_ORDER: readonly BillingBucketId[] = [
  'sonnet',
  'haiku',
  'opus',
  'opus-1m',
  'sonnet-1m', // Extra Usage stays last so it visually anchors the callout
  'other',
];

/** Convenience: is this bucket on the Extra Usage path for Max plans? */
export function isExtraUsage(bucket: BillingBucket): boolean {
  return bucket.meteredOnMax === 'extra';
}
