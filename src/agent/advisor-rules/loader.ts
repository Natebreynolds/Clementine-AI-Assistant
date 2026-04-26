/**
 * Advisor Rule Engine — loader.
 *
 * Reads YAML rule files from:
 *   1. PKG_DIR/dist/agent/advisor-rules/builtin/*.yaml — engine builtins (npm package)
 *   2. ~/.clementine/advisor-rules/builtin/*.yaml      — synced copy (rewritten on update)
 *   3. ~/.clementine/advisor-rules/user/*.yaml         — user/LLM-authored, never overwritten
 *
 * User rules with the same `id` as a builtin replace the builtin.
 * Lower `priority` runs first.
 *
 * fs.watch on the user dir triggers hot reload (debounced, atomic swap).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, watch as fsWatch, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import yaml from 'js-yaml';
import { z } from 'zod';

import { BASE_DIR, PKG_DIR } from '../../config.js';
import type { AdvisorRule } from './types.js';

const logger = pino({ name: 'clementine.advisor-rules' });

// ── Paths ────────────────────────────────────────────────────────────

/**
 * Engine builtins shipped in the npm package. Prefer dist/ (post-build); fall
 * back to src/ for tsx-driven dev runs and unit tests.
 */
function resolvePkgBuiltinDir(): string {
  const distPath = path.join(PKG_DIR, 'dist', 'agent', 'advisor-rules', 'builtin');
  if (existsSync(distPath)) return distPath;
  return path.join(PKG_DIR, 'src', 'agent', 'advisor-rules', 'builtin');
}

export interface LoaderOptions {
  baseDir?: string;
  pkgBuiltinDir?: string;
}

function userBuiltinDir(baseDir: string): string {
  return path.join(baseDir, 'advisor-rules', 'builtin');
}
function userRulesDir(baseDir: string): string {
  return path.join(baseDir, 'advisor-rules', 'user');
}

// ── Validation schema ───────────────────────────────────────────────

const appliesToSchema = z.object({
  agentSlug: z.string().nullable().optional(),
  jobName: z.string().nullable().optional(),
  jobMode: z.enum(['standard', 'unleashed']).nullable().optional(),
  tier: z.array(z.number().int().positive()).optional(),
}).optional();

const whenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recentTerminalReason'), reason: z.string(), window: z.number().int().positive(), atLeast: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('recentErrorCount'), window: z.number().int().positive(), atLeast: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('recentTimeoutHits'), window: z.number().int().positive(), atLeast: z.number().int().nonnegative(), thresholdRatio: z.number().positive().optional() }),
  z.object({ kind: z.literal('avgReflectionQualityBelow'), window: z.number().int().positive(), threshold: z.number(), minSamples: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('lowQualityReflectionCount'), window: z.number().int().positive(), maxQuality: z.number(), atLeast: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('consecutiveErrorsAtLeast'), count: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('lastRunOlderThanMs'), ms: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('lastRunWithinMs'), ms: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('noRecentRuns') }),
  z.object({ kind: z.literal('modelContains'), substring: z.string() }),
  z.object({ kind: z.literal('effectiveModelContains'), substring: z.string() }),
  z.object({ kind: z.literal('recentSuccessCountAtLeast'), window: z.number().int().positive(), atLeast: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('adviceFieldSet'), field: z.string() }),
  z.object({ kind: z.literal('interventionStatBelow'), stat: z.enum(['modelUpgradeSuccessRate', 'turnAdjustSuccessRate', 'enrichmentSuccessRate']), threshold: z.number(), minSamples: z.number().int().nonnegative().optional() }),
]);

const thenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bumpMaxTurns'), multiplier: z.number().positive().optional(), baseDefault: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('bumpTimeoutMs'), multiplier: z.number().positive().optional(), baseMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('setModel'), model: z.string() }),
  z.object({ kind: z.literal('appendPromptEnrichment'), text: z.string() }),
  z.object({ kind: z.literal('invokePromptEvolver') }),
  z.object({ kind: z.literal('skipWithReason'), reason: z.string(), reasonTemplate: z.string().optional() }),
  z.object({ kind: z.literal('escalateWithReason'), reason: z.string(), reasonTemplate: z.string().optional() }),
  z.object({ kind: z.literal('clearAdviceField'), field: z.enum(['adjustedMaxTurns', 'adjustedModel', 'adjustedTimeoutMs', 'promptEnrichment']) }),
]);

const ruleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  description: z.string(),
  priority: z.number().int().nonnegative(),
  appliesTo: appliesToSchema,
  skipIf: z.array(whenSchema).optional(),
  when: z.array(whenSchema),
  then: z.array(thenSchema),
  stopOnFire: z.boolean().optional(),
  log: z.object({ reason: z.string().optional() }).optional(),
});

// ── Loader ──────────────────────────────────────────────────────────

let cachedRules: AdvisorRule[] = [];
let watcherInstalled = false;
let watchDebounce: NodeJS.Timeout | null = null;

function readYamlFile(filePath: string): unknown | null {
  try {
    return yaml.load(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse advisor rule YAML');
    return null;
  }
}

function readRulesFromDir(dir: string): AdvisorRule[] {
  if (!existsSync(dir)) return [];
  const out: AdvisorRule[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const filePath = path.join(dir, entry);
    const raw = readYamlFile(filePath);
    if (!raw) continue;
    const parsed = ruleSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { filePath, errors: parsed.error.issues.slice(0, 3) },
        'Invalid advisor rule schema — skipping',
      );
      continue;
    }
    out.push({ ...(parsed.data as AdvisorRule), _sourcePath: filePath });
  }
  return out;
}

/** Copy package builtins to the user-visible directory (overwrites). */
function syncBuiltinsToUserSpace(pkgBuiltinDir: string, dstDir: string): void {
  if (!existsSync(pkgBuiltinDir)) {
    logger.debug({ pkgBuiltinDir }, 'No package builtins directory — skipping sync');
    return;
  }
  if (!existsSync(dstDir)) {
    mkdirSync(dstDir, { recursive: true });
  }
  for (const entry of readdirSync(pkgBuiltinDir)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const src = path.join(pkgBuiltinDir, entry);
    const dst = path.join(dstDir, entry);
    try {
      writeFileSync(dst, readFileSync(src));
    } catch (err) {
      logger.warn({ err, entry }, 'Failed to sync builtin rule to user-space');
    }
  }
}

function mergeAndSort(builtins: AdvisorRule[], user: AdvisorRule[]): AdvisorRule[] {
  const byId = new Map<string, AdvisorRule>();
  for (const r of builtins) byId.set(r.id, r);
  for (const r of user) byId.set(r.id, r); // user overrides builtin
  return Array.from(byId.values()).sort((a, b) => a.priority - b.priority);
}

/**
 * Load (or reload) all advisor rules. Idempotent — call from boot, hot-reload, and tests.
 */
export function loadAdvisorRules(opts?: LoaderOptions): AdvisorRule[] {
  const baseDir = opts?.baseDir ?? BASE_DIR;
  const pkgBuiltinDir = opts?.pkgBuiltinDir ?? resolvePkgBuiltinDir();
  syncBuiltinsToUserSpace(pkgBuiltinDir, userBuiltinDir(baseDir));
  const builtins = readRulesFromDir(pkgBuiltinDir);
  const userDir = userRulesDir(baseDir);
  const user = existsSync(userDir) ? readRulesFromDir(userDir) : [];
  cachedRules = mergeAndSort(builtins, user);
  logger.info(
    { builtinCount: builtins.length, userCount: user.length, total: cachedRules.length },
    'Advisor rules loaded',
  );
  return cachedRules;
}

/** Read the most recently loaded rule set (no I/O). */
export function getLoadedRules(): AdvisorRule[] {
  return cachedRules;
}

/** Install fs.watch on the user rules dir. Safe to call multiple times. */
export function watchUserRulesDir(opts?: LoaderOptions): void {
  if (watcherInstalled) return;
  const baseDir = opts?.baseDir ?? BASE_DIR;
  const userDir = userRulesDir(baseDir);
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
  try {
    fsWatch(userDir, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        try {
          loadAdvisorRules(opts);
        } catch (err) {
          logger.warn({ err }, 'Hot reload failed — keeping previous rule set');
        }
      }, 250);
    });
    watcherInstalled = true;
    logger.debug({ dir: userDir }, 'Watching user rules dir for hot reload');
  } catch (err) {
    logger.warn({ err }, 'Failed to install rule watcher — hot reload disabled');
  }
}

/** Test-only: clear cached state. */
export function _resetLoaderState(): void {
  cachedRules = [];
  watcherInstalled = false;
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
}
