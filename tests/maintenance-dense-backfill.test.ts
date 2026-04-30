/**
 * Periodic-maintenance dense-embedding backfill — verifies the cycle
 * invokes store.backfillDenseEmbeddings with the configured batch size,
 * passes the call through cleanly, and tolerates backfill failures
 * (best-effort: TF-IDF fallback handles query time when dense isn't
 * yet warm).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPeriodicCycle } from '../src/memory/maintenance.js';

function makeStubStore(over: Partial<Record<string, unknown>> = {}) {
  return {
    decaySalience: () => undefined,
    pruneStaleData: () => undefined,
    buildEmbeddings: () => undefined,
    conn: null,
    backfillDenseEmbeddings: vi.fn(async () => ({ embedded: 100, skipped: 0, failed: 0, model: 'test-model' })),
    expireConsolidated: () => ({ softDeleted: 0, physicallyDeleted: 0 }),
    pruneOutcomes: () => 0,
    capExtractions: () => 0,
    setMaintenanceMeta: () => undefined,
    getMaintenanceMeta: () => null,
    lastActivityAt: () => Date.now(),
    vacuum: () => null,
    ...over,
  };
}

describe('runPeriodicCycle — dense embedding backfill', () => {
  beforeEach(() => {
    delete process.env.CLEMENTINE_DENSE_BATCH;
    // Re-import is needed if we ever change envs at runtime; currently the
    // batch constant is captured at module load. Tests below avoid relying
    // on overrides — they verify the call shape, not the constant.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes backfillDenseEmbeddings with a positive numeric limit', async () => {
    const store = makeStubStore();
    await runPeriodicCycle(store);
    expect(store.backfillDenseEmbeddings).toHaveBeenCalledTimes(1);
    const callArg = (store.backfillDenseEmbeddings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg).toMatchObject({ limit: expect.any(Number) });
    expect(callArg.limit).toBeGreaterThan(0);
  });

  it('skips backfill cleanly when the store has no dense API (older shape)', async () => {
    const store = makeStubStore({ backfillDenseEmbeddings: undefined });
    // Should not throw — the backfill is feature-detected.
    await expect(runPeriodicCycle(store)).resolves.toBeUndefined();
  });

  it('catches a backfill error without aborting the rest of the cycle', async () => {
    const downstreamCalled = vi.fn();
    const store = makeStubStore({
      backfillDenseEmbeddings: vi.fn(async () => { throw new Error('model load failed'); }),
      // Use runJanitor's expireConsolidated as a "did the cycle continue?" probe.
      expireConsolidated: () => { downstreamCalled(); return { softDeleted: 0, physicallyDeleted: 0 }; },
    });
    await expect(runPeriodicCycle(store)).resolves.toBeUndefined();
    expect(downstreamCalled).toHaveBeenCalled(); // janitor still ran
  });

  it('respects CLEMENTINE_DENSE_BATCH override at module load', async () => {
    // Constant is captured at import — so this test verifies the parsing
    // logic by re-importing fresh with the env set.
    process.env.CLEMENTINE_DENSE_BATCH = '5';
    vi.resetModules();
    const fresh = await import('../src/memory/maintenance.js?override-batch');
    const store = makeStubStore();
    await fresh.runPeriodicCycle(store);
    const call = (store.backfillDenseEmbeddings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.limit).toBe(5);
    delete process.env.CLEMENTINE_DENSE_BATCH;
  });
});
