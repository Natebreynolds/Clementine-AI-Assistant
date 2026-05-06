/**
 * Wave-scheduling primitives extracted from the deleted PlanOrchestrator.
 *
 * The `workflow-runner` (saved Clementine workflows) still needs them to
 * topologically schedule steps with dependencies and run waves with a
 * concurrency cap. Pure utilities — no LLM calls.
 */

import type { PlanStep } from '../types.js';

/**
 * Compute execution waves from a dependency graph via topological sort.
 * Steps with empty dependsOn = wave 0. Steps whose deps are all in wave N
 * = wave N+1.
 */
export function computeWaves(steps: PlanStep[]): PlanStep[][] {
  const stepMap = new Map(steps.map(s => [s.id, s]));
  const waveOf = new Map<string, number>();
  const visiting = new Set<string>();

  function getWave(id: string): number {
    if (waveOf.has(id)) return waveOf.get(id)!;
    if (visiting.has(id)) throw new Error(`Circular dependency detected involving step ${id}`);
    visiting.add(id);

    const step = stepMap.get(id);
    if (!step || step.dependsOn.length === 0) {
      visiting.delete(id);
      waveOf.set(id, 0);
      return 0;
    }

    let maxDepWave = 0;
    for (const depId of step.dependsOn) {
      if (!stepMap.has(depId)) continue;
      maxDepWave = Math.max(maxDepWave, getWave(depId) + 1);
    }
    visiting.delete(id);
    waveOf.set(id, maxDepWave);
    return maxDepWave;
  }

  for (const step of steps) {
    getWave(step.id);
  }

  const maxWave = Math.max(0, ...waveOf.values());
  const waves: PlanStep[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const step of steps) {
    waves[waveOf.get(step.id) ?? 0].push(step);
  }
  return waves.filter(w => w.length > 0);
}

/**
 * Run promises with a concurrency limit. Settled-style — each entry is
 * `{status, value}` or `{status, reason}` so the caller can decide how
 * to react to partial failure.
 */
export async function settledWithLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason: unknown) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
