/**
 * Bulk-fix the ACL on existing clementine-agent keychain entries.
 *
 * Why this exists: keychain entries created before commit 88cfd99 used
 * `add-generic-password -T ''` which means NO apps are pre-approved to
 * read. Every Clementine read triggered a per-app dialog that often
 * didn't appear (hidden behind windows, dismissed silently, queued).
 *
 * The new keychain.set uses `-T /usr/bin/security` so future entries
 * don't have this problem. For existing entries this module runs
 *
 *   security set-generic-password-partition-list \
 *     -s clementine-agent -a <account> -S apple-tool:,apple:
 *
 * which adds Apple-signed tools (including /usr/bin/security itself)
 * to the partition allowlist. Result: future reads via security
 * succeed silently, no per-app dialog.
 *
 * The user is prompted for their LOGIN keychain password once per call
 * (the macOS system prompt — the one that DOES reliably appear). After
 * approving, all entries become readable without further prompts.
 */

import { execSync, spawnSync } from 'node:child_process';

/**
 * Both keychain service names the codebase has used over time:
 * - "clementine-agent" — used by src/secrets/keychain.ts (env_set / migrate-to-keychain)
 * - "clementine"       — getSecret's default fallback when no explicit service
 *                        passed (src/config.ts: ASSISTANT_NAME.toLowerCase()).
 *                        Holds older per-agent and handoff entries.
 */
const SERVICES = ['clementine-agent', 'clementine'] as const;
type Service = typeof SERVICES[number];

/**
 * Under the legacy "clementine" service, some non-Clementine apps
 * coincidentally store entries (e.g., macOS "Local Crypto Key Data"
 * with a UUID prefix). We refuse to touch those — only entries that
 * match our naming conventions get the ACL update.
 */
function isClementineAccount(service: Service, account: string): boolean {
  if (service === 'clementine-agent') return true; // we own this whole service
  // For the legacy "clementine" service, conservatively only touch entries
  // that look like things we set: per-agent secrets (AGENT_*),
  // handoff-decryption-key-*, oauth-tokens, env-var names (UPPER_SNAKE),
  // anything starting with "clementine-".
  if (account.startsWith('AGENT_')) return true;
  if (account.startsWith('handoff-')) return true;
  if (account === 'oauth-tokens') return true;
  if (account.startsWith('clementine-')) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(account)) return true;
  return false;
}

export interface KeychainEntry {
  service: Service;
  account: string;
  /** True when isClementineAccount returned true; only these get fixed. */
  isClementine: boolean;
}

export interface AclFixResult {
  service: Service;
  account: string;
  status: 'fixed' | 'failed' | 'skipped-foreign';
  error?: string;
}

/**
 * Enumerate every keychain entry under any service in SERVICES. Uses the
 * dump-keychain grep approach since `security` doesn't expose a clean
 * list-by-service. Read-only, no prompts.
 *
 * For the legacy "clementine" service we set `isClementine: false` on any
 * entry that doesn't match our naming patterns — those get reported but
 * never touched (could be other apps that coincidentally chose that name).
 */
export function listClementineKeychainEntries(): KeychainEntry[] {
  let raw: string;
  try {
    raw = execSync('/usr/bin/security dump-keychain 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  // dump-keychain emits one record per item. Within a record, fields appear
  // in arbitrary order — `acct` often comes BEFORE `svce`. So we can't track
  // "last-seen svce" line-by-line; we have to split into per-record blocks
  // and extract both fields from each block.
  //
  // Each record starts with `keychain: "/path/to/keychain"` followed by the
  // `version`, `class`, `attributes:` lines and the field blobs. The next
  // record begins at the next `^keychain: ` line.
  const entries: KeychainEntry[] = [];
  const seen = new Set<string>();
  // Split by record boundary. Use a positive lookahead so the delimiter stays
  // at the start of each chunk.
  const blocks = raw.split(/\n(?=keychain: ")/);
  for (const block of blocks) {
    const svceMatch = block.match(/"svce"<blob>="([^"]+)"/);
    const acctMatch = block.match(/"acct"<blob>="([^"]+)"/);
    if (!svceMatch || !acctMatch) continue;
    const svc = svceMatch[1]!;
    const account = acctMatch[1]!;
    if (!(SERVICES as readonly string[]).includes(svc)) continue;
    const service = svc as Service;
    const dedupeKey = `${service}\x00${account}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entries.push({
      service,
      account,
      isClementine: isClementineAccount(service, account),
    });
  }
  // Stable sort: service first, then account
  entries.sort((a, b) =>
    a.service === b.service ? a.account.localeCompare(b.account) : a.service.localeCompare(b.service),
  );
  return entries;
}

/**
 * Add `apple-tool:,apple:` to the partition list of a given account.
 *
 * `security set-generic-password-partition-list` prompts on the controlling
 * terminal — `password to unlock default:` — for the user's login keychain
 * password. We must inherit stdio so the child can read from the parent's
 * TTY; piped stdio causes security to consume an empty line and fail with
 * "exit code null" / "wrong password."
 *
 * That means this function only works when called from an interactive shell.
 * Callers in non-TTY contexts should fall back to instructing the user to
 * run `clementine config keychain-fix-acl` from their own terminal.
 */
/**
 * Discover which keychain a (service, account) pair lives in. Returns the
 * path or null if find-generic-password can't locate it (in which case we
 * skip — the entry isn't reachable via standard search anyway).
 */
function locateKeychain(service: Service, account: string): string | null {
  const probe = spawnSync('/usr/bin/security', [
    'find-generic-password',
    '-s', service,
    '-a', account,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
    encoding: 'utf-8',
  });
  if (probe.status !== 0) return null;
  // First line is `keychain: "/path/to/keychain"` — extract.
  const first = (probe.stdout || '').split('\n')[0] ?? '';
  const m = first.match(/^keychain:\s+"([^"]+)"/);
  return m ? m[1]! : null;
}

export function fixAcl(service: Service, account: string): AclFixResult {
  const keychainPath = locateKeychain(service, account);
  if (!keychainPath) {
    return {
      service,
      account,
      status: 'failed',
      error: 'item not findable via standard search (may be in iCloud or a non-default keychain) — leaving alone',
    };
  }
  // Pass the keychain path as the trailing positional arg so partition-list
  // doesn't search the wrong store.
  const args = [
    'set-generic-password-partition-list',
    '-s', service,
    '-a', account,
    '-S', 'apple-tool:,apple:',
    keychainPath,
  ];
  const result = spawnSync('/usr/bin/security', args, {
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.status === 0) {
    return { service, account, status: 'fixed' };
  }
  return {
    service,
    account,
    status: 'failed',
    error: result.error?.message ?? `exit code ${result.status}`,
  };
}

/**
 * Plan + apply: enumerate entries, fix each Clementine-shaped one in turn.
 * Foreign entries (other apps under the legacy "clementine" service) get
 * reported with status='skipped-foreign' and never touched.
 */
export function fixAllClementineEntries(): AclFixResult[] {
  const entries = listClementineKeychainEntries();
  const results: AclFixResult[] = [];
  for (const entry of entries) {
    if (!entry.isClementine) {
      results.push({ service: entry.service, account: entry.account, status: 'skipped-foreign' });
      continue;
    }
    results.push(fixAcl(entry.service, entry.account));
  }
  return results;
}
