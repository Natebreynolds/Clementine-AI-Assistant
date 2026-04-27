/**
 * Background "is there a newer version on npm?" check.
 *
 * Polls the public npm registry once per `CACHE_TTL_MS` (default 24h) and
 * caches the result on disk so subsequent calls are instant. Surfaced in
 * `clementine status` and the dashboard header so the user discovers
 * updates without remembering to run `clementine update`.
 *
 * Pure read-only — never installs anything. Network failures are silent
 * (offline → no nudge, not an error).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const PACKAGE_NAME = 'clementine-agent';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface VersionCheckCache {
  /** ISO timestamp of the most recent successful check. */
  checkedAt: string;
  /** Latest version on npm at last check (semver string). */
  latestVersion: string;
  /** Version we observed locally at last check — used to detect "we just updated". */
  observedLocalVersion: string;
}

export interface VersionCheckResult {
  localVersion: string;
  latestVersion: string | null;
  /** True when latestVersion is strictly greater than localVersion. */
  updateAvailable: boolean;
  /** ISO of last successful registry check. null = never checked or fetch failed. */
  checkedAt: string | null;
  /** True when the cache was used (no network call this invocation). */
  fromCache: boolean;
}

function cachePath(baseDir: string): string {
  return path.join(baseDir, '.update-check.json');
}

function readCache(baseDir: string): VersionCheckCache | null {
  try {
    const p = cachePath(baseDir);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')) as VersionCheckCache;
  } catch {
    return null;
  }
}

function writeCache(baseDir: string, entry: VersionCheckCache): void {
  try {
    writeFileSync(cachePath(baseDir), JSON.stringify(entry, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal — cache is an optimization, not state.
  }
}

/**
 * Fetch the latest published version of the package from npm. Resolves null
 * on any network/parse error so callers can degrade silently.
 */
function fetchLatestFromNpm(timeoutMs = 5000): Promise<string | null> {
  return new Promise(resolve => {
    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { timeout: timeoutMs, headers: { Accept: 'application/json' } },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { version?: string };
            resolve(parsed.version ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Compare two semver strings lexicographically by parts. Returns positive
 * when `a` > `b`, negative when `a` < `b`, zero when equal. Tolerates
 * pre-release suffixes by ignoring them (we only care about released bumps).
 */
function compareSemver(a: string, b: string): number {
  if (a === b) return 0;
  const partsA = a.replace(/[-+].*$/, '').split('.').map(n => parseInt(n, 10) || 0);
  const partsB = b.replace(/[-+].*$/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const av = partsA[i] ?? 0;
    const bv = partsB[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Check whether a newer version is available. Uses the cache when fresh.
 * Pass `force = true` to bypass the cache (e.g. from a "check now" CLI flag).
 */
export async function checkForUpdate(
  baseDir: string,
  localVersion: string,
  opts: { force?: boolean } = {},
): Promise<VersionCheckResult> {
  const cache = readCache(baseDir);
  const now = Date.now();
  const cacheFresh = !!cache && (now - new Date(cache.checkedAt).getTime() < CACHE_TTL_MS);

  if (cache && cacheFresh && !opts.force) {
    return {
      localVersion,
      latestVersion: cache.latestVersion,
      updateAvailable: compareSemver(cache.latestVersion, localVersion) > 0,
      checkedAt: cache.checkedAt,
      fromCache: true,
    };
  }

  const latest = await fetchLatestFromNpm();
  if (!latest) {
    // Couldn't reach the registry — fall back to stale cache if we have one.
    if (cache) {
      return {
        localVersion,
        latestVersion: cache.latestVersion,
        updateAvailable: compareSemver(cache.latestVersion, localVersion) > 0,
        checkedAt: cache.checkedAt,
        fromCache: true,
      };
    }
    return { localVersion, latestVersion: null, updateAvailable: false, checkedAt: null, fromCache: false };
  }

  writeCache(baseDir, {
    checkedAt: new Date().toISOString(),
    latestVersion: latest,
    observedLocalVersion: localVersion,
  });

  return {
    localVersion,
    latestVersion: latest,
    updateAvailable: compareSemver(latest, localVersion) > 0,
    checkedAt: new Date().toISOString(),
    fromCache: false,
  };
}

/**
 * Synchronous read of the cached result — used in fast paths like
 * `clementine status` so we never block on a network call. Returns null
 * when there's no cache yet.
 */
export function readCachedUpdateCheck(baseDir: string, localVersion: string): VersionCheckResult | null {
  const cache = readCache(baseDir);
  if (!cache) return null;
  return {
    localVersion,
    latestVersion: cache.latestVersion,
    updateAvailable: compareSemver(cache.latestVersion, localVersion) > 0,
    checkedAt: cache.checkedAt,
    fromCache: true,
  };
}
