/**
 * Clementine TypeScript — OAuth auth profile store.
 *
 * OAuth tokens (access + refresh + expiry) have different semantics from
 * API keys: they expire and need refresh. Keeping them in ~/.clementine/.env
 * alongside long-lived API keys mixes two lifecycles and makes token refresh
 * awkward. This store keeps them separate at ~/.clementine/auth-profiles/<provider>.json
 * with mode 0o600, so the OAuth flow code can atomically update tokens
 * without touching .env.
 *
 * Current scope: storage + basic read/write/refresh-check. Callers (outlook,
 * Google OAuth flows) can adopt this incrementally; existing env-based OAuth
 * keeps working until migrated.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.auth-profiles' });

const PROFILES_DIR = path.join(BASE_DIR, 'auth-profiles');

export interface AuthProfile {
  /** Provider slug (matches integrations-registry, e.g. "microsoft-365"). */
  provider: string;
  /** Short-lived access token. */
  accessToken: string;
  /** Long-lived refresh token, optional. */
  refreshToken?: string;
  /** Unix epoch ms — when accessToken expires. */
  expiresAt?: number;
  /** Identifier (email, user id) for the authenticated account. */
  accountId?: string;
  /** Comma-delimited scopes granted. */
  scopes?: string;
  /** When this profile was first written. */
  createdAt: string;
  /** When this profile was last refreshed. */
  updatedAt: string;
  /** Provider-specific extras. */
  extras?: Record<string, unknown>;
}

function ensureDir(): void {
  if (!existsSync(PROFILES_DIR)) {
    mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  }
}

function profilePath(provider: string): string {
  const safe = provider.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(PROFILES_DIR, `${safe}.json`);
}

/** Atomic write — write tmp then rename. Mode 0o600. */
export function save(profile: AuthProfile): void {
  ensureDir();
  const p = profilePath(profile.provider);
  const tmp = p + '.tmp';
  const content = JSON.stringify(profile, null, 2);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, p);
  logger.info({ provider: profile.provider, account: profile.accountId }, 'Auth profile saved');
}

export function load(provider: string): AuthProfile | null {
  const p = profilePath(provider);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as AuthProfile;
  } catch {
    return null;
  }
}

export function remove(provider: string): boolean {
  const p = profilePath(provider);
  if (!existsSync(p)) return false;
  try {
    // Overwrite with empty data before unlink so contents aren't trivially recoverable.
    writeFileSync(p, '');
    const { unlinkSync } = require('node:fs') as typeof import('node:fs');
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** List provider slugs with stored profiles. */
export function list(): string[] {
  ensureDir();
  try {
    return readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * True if accessToken is present and either has no expiry set or expires
 * more than `bufferMs` from now. Callers should call their refresh flow if
 * this returns false.
 */
export function isValid(profile: AuthProfile | null, bufferMs = 5 * 60 * 1000): boolean {
  if (!profile?.accessToken) return false;
  if (!profile.expiresAt) return true;
  return Date.now() + bufferMs < profile.expiresAt;
}

/** Get access token if valid, else null. Does not refresh — caller refreshes. */
export function getValidAccessToken(provider: string): string | null {
  const p = load(provider);
  return isValid(p) ? p!.accessToken : null;
}

/** Status summary for status reporting. */
export interface AuthProfileStatus {
  provider: string;
  accountId?: string;
  valid: boolean;
  expiresInMinutes: number | null;
}

export function statusAll(): AuthProfileStatus[] {
  const slugs = list();
  const now = Date.now();
  return slugs.map(slug => {
    const p = load(slug);
    const valid = isValid(p);
    const expiresInMinutes = p?.expiresAt ? Math.round((p.expiresAt - now) / 60000) : null;
    return {
      provider: slug,
      accountId: p?.accountId,
      valid,
      expiresInMinutes,
    };
  });
}
