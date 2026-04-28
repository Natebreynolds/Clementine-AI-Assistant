/**
 * One-time interactive wizard that repairs ACLs on legacy clementine-agent
 * keychain entries during `clementine launch` / `clementine update`.
 *
 * Why this exists: entries written before commit 88cfd99 used
 * `add-generic-password -T ''` (no apps pre-approved), so every Clementine
 * read would trigger a per-app approval dialog. Newer writes use
 * `-T /usr/bin/security` and read silently. Existing users have legacy
 * entries that need a one-time partition-list repair to stop the prompt
 * cascade.
 *
 * macOS's `set-generic-password-partition-list` requires the login keychain
 * password to authorize the ACL change — once per entry. To avoid prompting
 * the user N times for N entries, we ask once via masked stdin, then pass
 * the password to each call via -k. End result: one password entry, all
 * entries fixed in one pass.
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

/**
 * Read a line from the TTY without echoing characters. Each keypress shows
 * an asterisk so the user has visual feedback for length. Returns the
 * collected string. Ctrl-C aborts the process.
 *
 * Uses raw mode directly because Node's readline always echoes input.
 * Exported so the manual `clementine config keychain-fix-acl` command can
 * use the same one-prompt UX.
 */
export function readPasswordFromTty(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    output.write(prompt);
    let value = '';
    const wasRaw = input.isRaw === true;
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const finish = (): void => {
      input.removeListener('data', onData);
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      resolve(value);
    };

    const onData = (chunk: string): void => {
      // Raw stdin can deliver multiple chars per chunk (paste, escape seqs).
      for (const char of chunk) {
        const code = char.charCodeAt(0);
        // Ctrl-C → abort the process entirely (user wants out).
        if (code === 0x03) {
          output.write('\n');
          process.exit(130);
        }
        // Enter (LF/CR) or Ctrl-D → submit whatever we have.
        if (code === 0x0a || code === 0x0d || code === 0x04) {
          finish();
          return;
        }
        // Backspace (DEL or BS).
        if (code === 0x7f || code === 0x08) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        // Printable ASCII + UTF-8 — skip anything else (arrow keys, escape seqs).
        if (code >= 0x20 && code !== 0x7f) {
          value += char;
          output.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}

export async function runFirstRunKeychainWizardIfNeeded(baseDir: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (!input.isTTY) return;
  if (existsSync(sentinelPath(baseDir))) return;

  const { listClementineKeychainEntries, fixAllClementineEntries } =
    await import('./keychain-fix-acl.js');

  const entries = listClementineKeychainEntries().filter((e) => e.isClementine);
  if (entries.length === 0) {
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
  console.log(`  ${DIM}silently — otherwise macOS prompts on every read.${RESET}`);
  console.log();
  console.log(`  ${DIM}You'll enter your macOS login password ONCE below —${RESET}`);
  console.log(`  ${DIM}it authorizes all ACL updates in a single pass.${RESET}`);
  console.log(`  ${DIM}Not stored. Won't ask again.${RESET}`);
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
    console.log(`  ${YELLOW}Skipped.${RESET} ${DIM}Run later: clementine config keychain-fix-acl${RESET}`);
    console.log();
    markKeychainWizardDone(baseDir);
    return;
  }

  const password = await readPasswordFromTty(`  ${BOLD}macOS login password:${RESET} `);
  if (!password) {
    console.log();
    console.log(`  ${YELLOW}Empty password — skipped.${RESET} ${DIM}Run later: clementine config keychain-fix-acl${RESET}`);
    console.log();
    markKeychainWizardDone(baseDir);
    return;
  }

  console.log();
  console.log(`  ${BOLD}Repairing ACLs...${RESET}`);
  console.log();

  const results = fixAllClementineEntries({ keychainPassword: password });
  let okCount = 0;
  let failCount = 0;
  let wrongPasswordHit = false;
  for (const r of results) {
    if (r.status === 'fixed') {
      console.log(`    ${GREEN}✓${RESET} ${r.account}`);
      okCount++;
    } else if (r.status === 'failed') {
      console.log(`    ${RED}✗${RESET} ${r.account} ${DIM}— ${r.error ?? 'unknown'}${RESET}`);
      failCount++;
      // security's stderr for a bad password contains "MAC verification failed"
      // or similar. Catch the common shapes so we can re-prompt next launch.
      if (r.error && /MAC verification|AuthFailure|UserCanceled|-25293/i.test(r.error)) {
        wrongPasswordHit = true;
      }
    }
  }

  console.log();
  if (failCount === 0) {
    console.log(`  ${GREEN}Done — ${okCount} entr${okCount === 1 ? 'y' : 'ies'} repaired.${RESET} ${DIM}Future reads silent.${RESET}`);
  } else if (wrongPasswordHit && okCount === 0) {
    console.log(`  ${RED}Wrong password — no entries repaired.${RESET}`);
    console.log(`  ${DIM}We'll ask again on next launch.${RESET}`);
  } else {
    console.log(`  ${YELLOW}${okCount} fixed, ${failCount} failed.${RESET}`);
    console.log(`  ${DIM}Failed entries can be fixed manually in Keychain Access.app:${RESET}`);
    console.log(`  ${DIM}  search "clementine-agent" → right-click → Get Info → Access Control.${RESET}`);
  }
  console.log();

  // Don't write sentinel if the password was wrong AND nothing succeeded —
  // let the user retry on the next launch. Any other outcome marks done.
  if (!(wrongPasswordHit && okCount === 0)) {
    markKeychainWizardDone(baseDir);
  }
}
