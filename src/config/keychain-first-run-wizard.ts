/**
 * One-time interactive wizard that repairs ACLs on legacy clementine-agent
 * keychain entries during `clementine launch`.
 *
 * Why this exists: entries written before commit 88cfd99 used
 * `add-generic-password -T ''` (no apps pre-approved), so every Clementine
 * read would trigger a per-app approval dialog. Newer writes use
 * `-T /usr/bin/security` and read silently. Existing users have legacy
 * entries that need a one-time partition-list repair to stop the prompt
 * cascade.
 *
 * The manual fix is `clementine config keychain-fix-acl`. This wizard runs
 * the same fix automatically on the next `clementine launch` (where we
 * know we have a TTY for the macOS login-keychain password prompt), then
 * writes a sentinel so we never prompt again on this machine.
 *
 * Skipped when:
 *   - non-darwin platform (no keychain),
 *   - non-TTY stdin (launchd, systemd, CI — no way to prompt),
 *   - sentinel already exists (already offered + decided),
 *   - no clementine-agent entries exist (nothing to repair).
 */

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const SENTINEL_FILE = '.keychain-acl-wizard-done';

function sentinelPath(baseDir: string): string {
  return path.join(baseDir, SENTINEL_FILE);
}

/** Write the sentinel so the wizard skips on subsequent launches. */
export function markKeychainWizardDone(baseDir: string): void {
  try {
    writeFileSync(sentinelPath(baseDir), new Date().toISOString() + '\n');
  } catch {
    // Best-effort. If we can't write the sentinel the user gets re-prompted
    // next launch — annoying but not broken.
  }
}

export async function runFirstRunKeychainWizardIfNeeded(baseDir: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (!input.isTTY) return;
  if (existsSync(sentinelPath(baseDir))) return;

  const { listClementineKeychainEntries, fixAllClementineEntries } =
    await import('./keychain-fix-acl.js');

  const entries = listClementineKeychainEntries().filter((e) => e.isClementine);
  if (entries.length === 0) {
    // Nothing to fix — write sentinel so we don't re-scan every launch.
    markKeychainWizardDone(baseDir);
    return;
  }

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const YELLOW = '\x1b[0;33m';
  const GREEN = '\x1b[0;32m';
  const RED = '\x1b[0;31m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${BOLD}One-time keychain setup${RESET}`);
  console.log(`  ${DIM}${entries.length} keychain entr${entries.length === 1 ? 'y' : 'ies'} from a previous version need an${RESET}`);
  console.log(`  ${DIM}access-control update so Clementine can read them${RESET}`);
  console.log(`  ${DIM}silently — otherwise macOS will prompt on every read.${RESET}`);
  console.log();
  console.log(`  ${DIM}macOS will ask once for your login-keychain password.${RESET}`);
  console.log(`  ${DIM}After that, no more prompts. We won't ask again.${RESET}`);
  console.log();

  const rl = readline.createInterface({ input, output });
  let answer: string;
  try {
    answer = (await rl.question(`  Repair now? ${DIM}[Y/n]${RESET} `)).trim().toLowerCase();
  } finally {
    rl.close();
  }

  if (answer === 'n' || answer === 'no') {
    console.log();
    console.log(`  ${YELLOW}Skipped.${RESET} ${DIM}Run later with: clementine config keychain-fix-acl${RESET}`);
    console.log();
    markKeychainWizardDone(baseDir);
    return;
  }

  console.log();
  console.log(`  ${BOLD}Repairing ACLs...${RESET}`);
  console.log();

  const results = fixAllClementineEntries();
  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.status === 'fixed') {
      console.log(`    ${GREEN}✓${RESET} ${r.account}`);
      okCount++;
    } else if (r.status === 'failed') {
      console.log(`    ${RED}✗${RESET} ${r.account} ${DIM}— ${r.error ?? 'unknown'}${RESET}`);
      failCount++;
    }
  }

  console.log();
  if (failCount === 0) {
    console.log(`  ${GREEN}Done — ${okCount} entr${okCount === 1 ? 'y' : 'ies'} repaired.${RESET} ${DIM}Future reads silent.${RESET}`);
  } else {
    console.log(`  ${YELLOW}${okCount} fixed, ${failCount} failed.${RESET}`);
    console.log(`  ${DIM}Failed entries can be fixed manually in Keychain Access.app:${RESET}`);
    console.log(`  ${DIM}  search "clementine-agent" → right-click → Get Info → Access Control.${RESET}`);
  }
  console.log();

  // Always mark done — even on partial failure we don't want to re-prompt
  // every launch. The user can re-run the manual command if they want.
  markKeychainWizardDone(baseDir);
}
