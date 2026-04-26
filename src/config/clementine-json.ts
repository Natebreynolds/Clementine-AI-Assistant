/**
 * Clementine JSON config loader.
 *
 * `~/.clementine/clementine.json` is the canonical user-editable config file.
 * Each field is optional — missing values fall through to .env, then to
 * compiled defaults. Precedence (highest first):
 *
 *   1. process.env (CI/runtime overrides)
 *   2. ~/.clementine/.env (existing user-edited config)
 *   3. ~/.clementine/clementine.json (this file)
 *   4. Compiled defaults
 *
 * The file is created on first run by the 0005 migration (kind: 'config').
 * Loader validates with zod and falls back gracefully on malformed input —
 * a corrupt file is logged and treated as empty.
 *
 * Cached by mtime so subsequent reads are O(1) absent file changes.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { z } from 'zod';

const logger = pino({ name: 'clementine.config-json' });

// ── Schema ───────────────────────────────────────────────────────────

export const clementineJsonSchema = z.object({
  schemaVersion: z.literal(1),
  ownerName: z.string().optional(),
  assistantName: z.string().optional(),
  timezone: z.string().optional(),
  models: z.object({
    default: z.string().optional(),
    haiku: z.string().optional(),
    sonnet: z.string().optional(),
    opus: z.string().optional(),
  }).optional(),
  budgets: z.object({
    heartbeat: z.number().nonnegative().optional(),
    cronT1: z.number().nonnegative().optional(),
    cronT2: z.number().nonnegative().optional(),
    chat: z.number().nonnegative().optional(),
  }).optional(),
  heartbeat: z.object({
    intervalMinutes: z.number().int().positive().optional(),
    activeStart: z.number().int().min(0).max(23).optional(),
    activeEnd: z.number().int().min(0).max(23).optional(),
  }).optional(),
  unleashed: z.object({
    phaseTurns: z.number().int().positive().optional(),
    defaultMaxHours: z.number().positive().optional(),
    maxPhases: z.number().int().positive().optional(),
  }).optional(),
});

export type ClementineJson = z.infer<typeof clementineJsonSchema>;

// ── Loader with mtime cache ──────────────────────────────────────────

interface CacheEntry {
  mtime: number;
  data: ClementineJson;
}

const cache = new Map<string, CacheEntry>();

export function clementineJsonPath(baseDir: string): string {
  return path.join(baseDir, 'clementine.json');
}

/**
 * Load and validate clementine.json. Returns an empty object if the file
 * is missing, unreadable, or fails validation. Cached by mtime.
 */
export function loadClementineJson(baseDir: string): ClementineJson {
  const filePath = clementineJsonPath(baseDir);
  if (!existsSync(filePath)) return { schemaVersion: 1 };

  let mtime: number;
  try {
    mtime = statSync(filePath).mtimeMs;
  } catch {
    return { schemaVersion: 1 };
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.data;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse clementine.json — using empty config');
    return { schemaVersion: 1 };
  }

  const parsed = clementineJsonSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { filePath, errors: parsed.error.issues.slice(0, 3) },
      'clementine.json failed validation — using empty config',
    );
    return { schemaVersion: 1 };
  }

  cache.set(filePath, { mtime, data: parsed.data });
  return parsed.data;
}

/** Test-only: clear the loader cache. */
export function _resetClementineJsonCache(): void {
  cache.clear();
}
