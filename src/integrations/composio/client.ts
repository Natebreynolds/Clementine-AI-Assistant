/**
 * Composio integration — client + connection management.
 *
 * Composio brokers OAuth and tool execution for 1000+ third-party services
 * (Gmail, Slack, Notion, Linear, GitHub, …). Users authenticate once via
 * Composio's hosted OAuth flow; Composio holds the tokens and refreshes them
 * automatically. Clementine never sees the credentials.
 *
 * This module owns everything except the per-toolkit MCP server construction
 * (see ./mcp-bridge.ts) and the dashboard endpoints (see cli/dashboard.ts).
 *
 * Disabled gracefully when COMPOSIO_API_KEY is not set — every public function
 * returns an empty result, never throws.
 */

import { Composio } from '@composio/core';
import { ClaudeAgentSDKProvider } from '@composio/claude-agent-sdk';
import pino from 'pino';
import { getEnv } from '../../config.js';

const logger = pino({ name: 'clementine.composio' });

// `process.env` is intentionally NOT populated from .env (config.ts keeps
// secrets out of the SDK subprocess). Reading process.env.COMPOSIO_API_KEY
// directly works during the dashboard's hot-reload (PUT handler mutates
// process.env), but is empty after a fresh daemon restart even if the key
// is in .env. Use this helper everywhere we read Composio env vars: it
// prefers process.env (hot-reload from dashboard) and falls back to the
// .env file via getEnv (survives restarts).
function readComposioEnv(key: string): string {
  return process.env[key] || getEnv(key, '');
}

export type ToolkitAuthMode = 'managed' | 'byo';

export interface CuratedToolkit {
  slug: string;
  displayName: string;
  /** "managed" = Composio hosts the OAuth app — click Connect, it works.
   *  "byo"     = User must register their own OAuth app on the toolkit's
   *              dev portal and add it as an Auth Config in Composio first. */
  authMode: ToolkitAuthMode;
}

// Curated set surfaced in the dashboard. Composio exposes 1000+ — rendering
// them all is noisy. Users can still connect anything by editing this list.
export const CURATED_TOOLKITS: CuratedToolkit[] = [
  { slug: 'gmail', displayName: 'Gmail', authMode: 'managed' },
  { slug: 'googlecalendar', displayName: 'Google Calendar', authMode: 'managed' },
  { slug: 'googledrive', displayName: 'Google Drive', authMode: 'managed' },
  { slug: 'googlesheets', displayName: 'Google Sheets', authMode: 'managed' },
  { slug: 'googledocs', displayName: 'Google Docs', authMode: 'managed' },
  { slug: 'slack', displayName: 'Slack', authMode: 'managed' },
  { slug: 'github', displayName: 'GitHub', authMode: 'managed' },
  { slug: 'linear', displayName: 'Linear', authMode: 'managed' },
  { slug: 'notion', displayName: 'Notion', authMode: 'managed' },
  { slug: 'hubspot', displayName: 'HubSpot', authMode: 'managed' },
  { slug: 'salesforce', displayName: 'Salesforce', authMode: 'managed' },
  { slug: 'discord', displayName: 'Discord', authMode: 'managed' },
  { slug: 'trello', displayName: 'Trello', authMode: 'managed' },
  { slug: 'asana', displayName: 'Asana', authMode: 'managed' },
  { slug: 'jira', displayName: 'Jira', authMode: 'managed' },
  { slug: 'airtable', displayName: 'Airtable', authMode: 'managed' },
  { slug: 'figma', displayName: 'Figma', authMode: 'managed' },
  { slug: 'dropbox', displayName: 'Dropbox', authMode: 'managed' },
  { slug: 'stripe', displayName: 'Stripe', authMode: 'managed' },
  { slug: 'supabase', displayName: 'Supabase', authMode: 'managed' },
  { slug: 'linkedin', displayName: 'LinkedIn', authMode: 'managed' },
  { slug: 'outlook', displayName: 'Outlook', authMode: 'managed' },
  { slug: 'onedrive', displayName: 'OneDrive', authMode: 'managed' },
  { slug: 'zoom', displayName: 'Zoom', authMode: 'managed' },
  { slug: 'twitter', displayName: 'Twitter / X', authMode: 'byo' },
];

const DISPLAY_NAME_BY_SLUG = new Map(CURATED_TOOLKITS.map(t => [t.slug, t.displayName]));

let singleton: Composio<ClaudeAgentSDKProvider> | null = null;

export function getComposio(): Composio<ClaudeAgentSDKProvider> | null {
  if (singleton) return singleton;
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!apiKey) return null;
  singleton = new Composio<ClaudeAgentSDKProvider>({
    apiKey,
    provider: new ClaudeAgentSDKProvider(),
  });
  return singleton;
}

export function isComposioEnabled(): boolean {
  return Boolean(readComposioEnv('COMPOSIO_API_KEY'));
}

/**
 * Discard the cached client + identity cache so the next call to getComposio()
 * picks up a freshly-set COMPOSIO_API_KEY without a daemon restart. Called by
 * the dashboard PUT /api/settings/COMPOSIO_API_KEY handler.
 */
export function resetComposioClient(): void {
  singleton = null;
  identityCache.clear();
  toolkitMetaCache = null;
  detectedPreferredUserId = null;
}

// Public: same logic as the internal detector, exposed for the MCP bridge so
// agent sessions land on the right user_id.
export async function getPreferredUserId(): Promise<string> {
  const composio = getComposio();
  if (!composio) return clementineUserId();
  return detectPreferredUserId(composio);
}

// Default user_id for *new* connections. We list connections without filtering
// so existing accounts (set up in Composio's web UI under the platform default
// "default" user_id, or any other label) still surface — but new authorize()
// calls have to pass *some* user_id, and we want it to match whatever the
// user already has if possible. detectPreferredUserId() picks the user_id
// with the most existing connections, falling back to this constant.
// Empty string matches Composio's web-UI default user_id (verified by
// probing — connections created via dashboard.composio.dev land under '').
// Using the same value here keeps Clementine-authorized connections in the
// same bucket as anything the user already has from the web UI.
const DEFAULT_NEW_CONNECTION_USER_ID = '';

export function clementineUserId(): string {
  return readComposioEnv('COMPOSIO_USER_ID') || DEFAULT_NEW_CONNECTION_USER_ID;
}

// Cached after first detection — avoids extra API calls per authorize.
let detectedPreferredUserId: string | null = null;

async function detectPreferredUserId(
  composio: NonNullable<ReturnType<typeof getComposio>>,
): Promise<string> {
  const explicit = readComposioEnv('COMPOSIO_USER_ID');
  if (explicit) return explicit;
  if (detectedPreferredUserId !== null) return detectedPreferredUserId;

  // The list response doesn't expose userId on records (verified empirically),
  // so we can't read it from the data. Instead, probe each candidate user_id
  // with a filtered list and pick whichever returns connections. This matches
  // however the connections were originally created — including empty string,
  // which is what Composio's web UI uses by default for new accounts.
  const candidates = ['', 'default', 'user', 'me'];
  let totalUnscoped = 0;
  try {
    const all = await composio.connectedAccounts.list({ limit: 1 });
    totalUnscoped = all.items.length;
  } catch { /* non-fatal */ }

  if (totalUnscoped > 0) {
    for (const uid of candidates) {
      try {
        const resp = await composio.connectedAccounts.list({ userIds: [uid], limit: 1 });
        if (resp.items.length > 0) {
          logger.info({ userId: uid }, 'Detected Composio user_id via probe');
          detectedPreferredUserId = uid;
          return uid;
        }
      } catch { /* try next */ }
    }
  }

  // No connections yet, or none of the common user_ids match. Fall back to
  // empty string, which is what Composio's web UI uses by default — keeps
  // future Clementine-authorized connections in the same bucket as anything
  // the user creates in Composio's dashboard.
  detectedPreferredUserId = DEFAULT_NEW_CONNECTION_USER_ID;
  return DEFAULT_NEW_CONNECTION_USER_ID;
}

export function displayNameFor(slug: string): string {
  return DISPLAY_NAME_BY_SLUG.get(slug) ?? humanize(slug);
}

function humanize(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// ── Connected toolkits ─────────────────────────────────────────────────

export interface ConnectedToolkit {
  slug: string;
  connectionId: string;
  status: string;
  alias?: string;
  accountLabel?: string;
  accountEmail?: string;
  accountName?: string;
  accountAvatarUrl?: string;
  createdAt?: string;
}

interface AccountIdentity {
  email?: string;
  name?: string;
  avatarUrl?: string;
  label?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1]!;
    const padded = payload + '==='.slice((payload.length + 3) % 4);
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// Composio's connected-account state is shaped per toolkit. Pull whatever
// human identity we can find — OAuth id_tokens (Google et al.) carry
// email/name/picture; other toolkits stash shop, subdomain, account_id.
function extractAccountIdentity(state: unknown, data: unknown): AccountIdentity {
  const s = (state && typeof state === 'object' ? state as Record<string, unknown> : {}) ?? {};
  const d = (data && typeof data === 'object' ? data as Record<string, unknown> : {}) ?? {};
  const out: AccountIdentity = {};

  const idToken = str(s.id_token) ?? str(d.id_token);
  if (idToken) {
    const payload = decodeJwtPayload(idToken);
    if (payload) {
      out.email = str(payload.email);
      out.name = str(payload.name) ?? str(payload.given_name);
      out.avatarUrl = str(payload.picture);
    }
  }

  for (const src of [d, s]) {
    const profile =
      (src.user_info && typeof src.user_info === 'object' ? src.user_info as Record<string, unknown> : null) ??
      (src.profile && typeof src.profile === 'object' ? src.profile as Record<string, unknown> : null);
    if (profile) {
      out.email = out.email ?? str(profile.email);
      out.name = out.name ?? str(profile.name) ?? str(profile.display_name);
      out.avatarUrl = out.avatarUrl ?? str(profile.picture) ?? str(profile.avatar_url);
    }
    out.email = out.email ?? str(src.email);
    out.name = out.name ?? str(src.name) ?? str(src.display_name);
    out.avatarUrl = out.avatarUrl ?? str(src.avatar_url) ?? str(src.picture);
  }

  const fallback =
    str(s.shop) ??
    str(s.subdomain) ??
    str(s.domain) ??
    str(s.account_id) ??
    str(s.site_name) ??
    str(d.shop) ??
    str(d.subdomain);

  out.label = out.email ?? out.name ?? fallback;
  return out;
}

// Per-toolkit "whoami" tool to enrich identity when state didn't carry an
// id_token. Composio redacts access_tokens, so calling the toolkit's own
// profile endpoint through composio.tools.execute is the only path.
interface WhoAmITool {
  tool: string;
  arguments: Record<string, unknown>;
  parse: (data: Record<string, unknown>) => Partial<AccountIdentity>;
}

function genericProfileParse(d: Record<string, unknown>): Partial<AccountIdentity> {
  const first = (...candidates: unknown[]): string | undefined => {
    for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
    return undefined;
  };
  const nested = (key: string): Record<string, unknown> =>
    (d[key] && typeof d[key] === 'object' ? d[key] as Record<string, unknown> : {});
  const viewer = nested('viewer');
  const user = nested('user');
  const team = nested('team');
  const profile = nested('profile');
  const email = first(d.email, user.email, viewer.email, profile.email);
  const name = first(d.name, d.login, d.display_name, user.name, viewer.name, profile.name, team.name);
  const avatar = first(d.avatar_url, d.avatarUrl, d.picture, user.avatar_url, viewer.avatarUrl, profile.image);
  return { email, name, avatarUrl: avatar, label: email ?? name };
}

const WHOAMI_BY_TOOLKIT: Record<string, WhoAmITool> = {
  gmail: {
    tool: 'GMAIL_GET_PROFILE',
    arguments: { user_id: 'me' },
    parse: d => {
      const email = typeof d.emailAddress === 'string' ? d.emailAddress : undefined;
      return { email, label: email };
    },
  },
  github: { tool: 'GITHUB_GET_THE_AUTHENTICATED_USER', arguments: {}, parse: genericProfileParse },
  linear: { tool: 'LINEAR_GET_CURRENT_USER', arguments: {}, parse: genericProfileParse },
  notion: { tool: 'NOTION_GET_ABOUT_ME', arguments: {}, parse: genericProfileParse },
  slack: { tool: 'SLACK_FETCH_TEAM_INFO', arguments: {}, parse: genericProfileParse },
  hubspot: { tool: 'HUBSPOT_GET_ACCOUNT_INFO', arguments: {}, parse: genericProfileParse },
  stripe: { tool: 'STRIPE_GET_ACCOUNT', arguments: {}, parse: genericProfileParse },
};

const identityCache = new Map<string, { at: number; identity: AccountIdentity }>();
const IDENTITY_TTL_MS = 15 * 60 * 1000;

async function fetchToolkitIdentity(
  composio: NonNullable<ReturnType<typeof getComposio>>,
  slug: string,
  connectedAccountId?: string,
): Promise<AccountIdentity> {
  const spec = WHOAMI_BY_TOOLKIT[slug];
  if (!spec) return {};
  try {
    const result = await composio.tools.execute(spec.tool, {
      userId: clementineUserId(),
      // Without this, Composio picks the user's *default* connection for the
      // toolkit, so multiple Gmail accounts end up labeled with the same email.
      ...(connectedAccountId ? { connectedAccountId } : {}),
      arguments: spec.arguments,
      // Composio requires either a pinned toolkit version or this flag.
      // Skipping pin so a toolkit bump doesn't break identity silently —
      // misses fall through to fallback chain below.
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful || !result.data) return {};
    return spec.parse(result.data as Record<string, unknown>);
  } catch (err) {
    logger.warn({ err, slug }, 'whoami fetch failed');
    return {};
  }
}

async function getIdentityFor(
  composio: NonNullable<ReturnType<typeof getComposio>>,
  id: string,
  slug: string,
  seed: AccountIdentity,
): Promise<AccountIdentity> {
  if (seed.label) return seed;
  const cached = identityCache.get(id);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.identity;
  let identity: AccountIdentity = {};
  try {
    const full = await composio.connectedAccounts.get(id);
    identity = extractAccountIdentity(
      (full as { state?: unknown }).state,
      (full as { data?: unknown }).data,
    );
  } catch (err) {
    logger.warn({ err, id }, 'failed to fetch full connection for identity');
  }
  if (!identity.label) {
    const whoami = await fetchToolkitIdentity(composio, slug, id);
    if (whoami.label) identity = { ...identity, ...whoami };
  }
  identityCache.set(id, { at: Date.now(), identity });
  return identity;
}

export async function listConnectedToolkits(): Promise<ConnectedToolkit[]> {
  const composio = getComposio();
  if (!composio) return [];
  try {
    // No userIds filter: a Composio API key is account-scoped, and a personal
    // agent should see every connection on the account regardless of which
    // user_id label it was created under. This is the fix for "I connected X
    // in Composio but it doesn't show up in Clementine."
    const resp = await composio.connectedAccounts.list({ limit: 100 });
    const enriched = await Promise.all(
      resp.items.map(async it => {
        const seed = extractAccountIdentity(
          (it as { state?: unknown }).state,
          (it as { data?: unknown }).data,
        );
        const identity = it.status === 'ACTIVE'
          ? await getIdentityFor(composio, it.id, it.toolkit.slug, seed)
          : seed;
        return {
          slug: it.toolkit.slug,
          connectionId: it.id,
          status: it.status,
          alias: it.alias ?? undefined,
          accountLabel: identity.label,
          accountEmail: identity.email,
          accountName: identity.name,
          accountAvatarUrl: identity.avatarUrl,
          createdAt: it.createdAt,
        };
      }),
    );
    return enriched;
  } catch (err) {
    logger.error({ err }, 'listConnectedToolkits failed');
    return [];
  }
}

// ── Toolkit catalog metadata (cached) ─────────────────────────────────

export interface ToolkitMeta {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  toolsCount?: number;
}

let toolkitMetaCache: Promise<Map<string, ToolkitMeta>> | null = null;

async function fetchAllToolkitMeta(): Promise<Map<string, ToolkitMeta>> {
  const composio = getComposio();
  if (!composio) return new Map();
  const out = new Map<string, ToolkitMeta>();
  try {
    const resp = await composio.toolkits.get({ limit: 500 });
    const items = Array.isArray(resp) ? resp : ((resp as { items?: unknown[] }).items ?? []);
    for (const it of items as Array<{ slug: string; name: string; meta?: { logo?: string; description?: string; toolsCount?: number } }>) {
      out.set(it.slug, {
        slug: it.slug,
        name: it.name,
        logo: it.meta?.logo,
        description: it.meta?.description,
        toolsCount: it.meta?.toolsCount,
      });
    }
    // Backfill curated toolkits the list endpoint omitted (e.g. MCP-only ones).
    await Promise.all(
      CURATED_TOOLKITS.filter(t => !out.has(t.slug)).map(async t => {
        try {
          const full = (await composio.toolkits.get(t.slug)) as { slug: string; name: string; meta?: { logo?: string; description?: string; toolsCount?: number } };
          out.set(full.slug, {
            slug: full.slug,
            name: full.name,
            logo: full.meta?.logo,
            description: full.meta?.description,
            toolsCount: full.meta?.toolsCount,
          });
        } catch (err) {
          logger.debug({ err, slug: t.slug }, 'meta backfill failed');
        }
      }),
    );
  } catch (err) {
    logger.error({ err }, 'fetchAllToolkitMeta failed');
  }
  return out;
}

export async function listToolkitMeta(): Promise<Map<string, ToolkitMeta>> {
  if (!toolkitMetaCache) {
    toolkitMetaCache = fetchAllToolkitMeta().catch(err => {
      logger.error({ err }, 'listToolkitMeta failed');
      toolkitMetaCache = null;
      return new Map<string, ToolkitMeta>();
    });
  }
  return toolkitMetaCache;
}

export async function listToolkitSlugsWithAuthConfig(): Promise<Set<string>> {
  const composio = getComposio();
  if (!composio) return new Set();
  try {
    const resp = await composio.authConfigs.list({ limit: 200 });
    return new Set(resp.items.map(it => it.toolkit.slug));
  } catch (err) {
    logger.error({ err }, 'listToolkitSlugsWithAuthConfig failed');
    return new Set();
  }
}

// ── Authorize / disconnect ─────────────────────────────────────────────

export class ComposioNeedsAuthConfigError extends Error {
  constructor(public readonly slug: string, public readonly underlying: string) {
    super(
      `Toolkit "${slug}" needs an auth config — Composio doesn't host a managed OAuth app for it. ` +
      `Add it via the Composio Dashboard: Toolkits → search ${slug} → Add to project → paste your OAuth credentials. ` +
      `https://platform.composio.dev/auth-configs`,
    );
    this.name = 'ComposioNeedsAuthConfigError';
  }
}

export async function authorizeToolkit(
  slug: string,
  // Reserved for future per-call overrides (callbackUrl / alias). Currently
  // unused because composio.toolkits.authorize doesn't surface those options
  // — alias is set later via patch, callback uses Composio's hosted page.
  _opts?: { callbackUrl?: string; alias?: string },
): Promise<{ redirectUrl: string | null; connectionId: string }> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY not set');

  // Use the SDK's blessed one-liner — handles auth config discovery
  // (reuses existing managed config if present) AND new-config creation
  // automatically. Source: README + composio-B75SFMkx.d.cts. Replaces our
  // older two-step `authConfigs.list/create + connectedAccounts.initiate`
  // flow which tripped 401s on plans that don't allow programmatic
  // authConfigs.create even when a managed app exists.
  const userId = await detectPreferredUserId(composio);
  try {
    const conn = await composio.toolkits.authorize(userId, slug);
    logger.info({ slug, userId, connectionId: conn.id }, 'Composio authorize OK');
    return { redirectUrl: conn.redirectUrl ?? null, connectionId: conn.id };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    logger.error({ err, slug, userId, status, step: 'toolkits.authorize' }, 'Composio authorize failed');
    // Translate the documented "no managed auth available" error codes into
    // the friendly BYO-setup banner the dashboard already renders.
    if (status === 400 || status === 401 || status === 403) {
      throw new ComposioNeedsAuthConfigError(slug, String(err));
    }
    throw err;
  }
}

export async function disconnectToolkit(connectionId: string): Promise<void> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY not set');
  await composio.connectedAccounts.delete(connectionId);
  identityCache.delete(connectionId);
}

export async function renameConnection(connectionId: string, alias: string): Promise<void> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY not set');
  // The Composio high-level wrapper only exposes status updates; alias
  // rename lives on the raw client's PATCH endpoint, which is marked
  // protected. Bridge through `as any` — this is a small, well-scoped escape
  // hatch and the alternative (bypassing the wrapper entirely) loses retry
  // and auth handling.
  await (composio as any).client.connectedAccounts.patch(connectionId, { alias });
}
