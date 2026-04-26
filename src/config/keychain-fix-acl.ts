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

const SERVICE = 'clementine-agent';

export interface KeychainEntry {
  account: string;
}

export interface AclFixResult {
  account: string;
  status: 'fixed' | 'failed';
  error?: string;
}

/**
 * Enumerate every clementine-agent keychain entry. Uses the dump-keychain
 * grep approach since `security` doesn't expose a clean list-by-service.
 * Read-only, no prompts.
 */
export function listClementineKeychainEntries(): KeychainEntry[] {
  try {
    const out = execSync('/usr/bin/security dump-keychain 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const accounts = new Set<string>();
    // Lines look like:  "acct"<blob>="clementine-agent-DISCORD_TOKEN"
    const re = /"acct"<blob>="(clementine-agent-[^"]+)"/g;
    for (const m of out.matchAll(re)) {
      accounts.add(m[1]!);
    }
    return Array.from(accounts).sort().map(account => ({ account }));
  } catch {
    return [];
  }
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
export function fixAcl(account: string): AclFixResult {
  const result = spawnSync('/usr/bin/security', [
    'set-generic-password-partition-list',
    '-s', SERVICE,
    '-a', account,
    '-S', 'apple-tool:,apple:',
  ], {
    stdio: 'inherit',
    timeout: 120_000, // 2min — generous since the user is typing per call
  });
  if (result.status === 0) {
    return { account, status: 'fixed' };
  }
  return {
    account,
    status: 'failed',
    error: result.error?.message ?? `exit code ${result.status}`,
  };
}

/**
 * Plan + apply: enumerate entries, fix each in turn. Returns per-entry
 * results so the CLI can render a checklist.
 */
export function fixAllClementineEntries(): AclFixResult[] {
  const entries = listClementineKeychainEntries();
  const results: AclFixResult[] = [];
  for (const entry of entries) {
    results.push(fixAcl(entry.account));
  }
  return results;
}
