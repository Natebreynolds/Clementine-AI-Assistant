#!/usr/bin/env node
/**
 * Clementine postinstall script.
 *
 * Runs after `npm install -g clementine-agent` to:
 *   1. Rebuild native modules (better-sqlite3) for the current Node version
 *   2. Initialize ~/.clementine/ directory structure if it doesn't exist
 *   3. Copy default vault templates from package to data home
 *   4. Optionally prefetch the local dense embedding model
 *   5. Check for `claude` CLI on PATH (needed for OAuth login)
 *   6. Print first-run instructions
 *
 * Safe to re-run — skips steps already completed.
 */

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');
const DATA_HOME = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');

function readDataEnv() {
  const envPath = path.join(DATA_HOME, '.env');
  if (!existsSync(envPath)) return {};
  try {
    return Object.fromEntries(
      readFileSync(envPath, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const idx = line.indexOf('=');
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

function flagEnabled(name, envFile) {
  const raw = process.env[name] ?? envFile[name];
  return /^(1|true|yes|on)$/i.test(String(raw ?? ''));
}

// ── Step 1: Rebuild better-sqlite3 ─────────────────────────────────
try {
  process.stdout.write('Rebuilding native modules...');
  execSync('npm rebuild better-sqlite3 --quiet', {
    stdio: 'pipe',
    cwd: PKG_DIR,
  });
  process.stdout.write(' done.\n');
} catch {
  // Non-fatal — prebuild-install may have a prebuilt binary available
  process.stdout.write(' skipped (prebuilt may work).\n');
}

// ── Step 2: Create ~/.clementine directory structure ────────────────
const dirs = [
  DATA_HOME,
  path.join(DATA_HOME, 'logs'),
  path.join(DATA_HOME, 'vault'),
  path.join(DATA_HOME, 'vault', '00-System'),
  path.join(DATA_HOME, 'vault', '01-Daily-Notes'),
  path.join(DATA_HOME, 'vault', '02-People'),
  path.join(DATA_HOME, 'vault', '03-Projects'),
  path.join(DATA_HOME, 'vault', '04-Topics'),
  path.join(DATA_HOME, 'vault', '05-Tasks'),
  path.join(DATA_HOME, 'vault', '06-Templates'),
  path.join(DATA_HOME, 'vault', '07-Inbox'),
  path.join(DATA_HOME, 'agents'),
  path.join(DATA_HOME, 'self-improve'),
  path.join(DATA_HOME, 'cron'),
];

for (const dir of dirs) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Step 3: Copy default vault templates if not already present ─────
const srcVault = path.join(PKG_DIR, 'vault', '00-System');
const dstVault = path.join(DATA_HOME, 'vault', '00-System');

if (existsSync(srcVault)) {
  const files = readdirSync(srcVault).filter(f => f.endsWith('.md'));
  let copied = 0;
  for (const file of files) {
    const dst = path.join(dstVault, file);
    if (!existsSync(dst)) {
      try {
        cpSync(path.join(srcVault, file), dst);
        copied++;
      } catch { /* skip */ }
    }
  }
  if (copied > 0) {
    console.log(`Initialized ${copied} default vault files in ${dstVault}`);
  }

  // 1.18.157 — bundle Anthropic-shipped first-party skills (currently
  // just `skill-creator`). Recursive copy under skills/<name>/. We DO
  // overwrite on every install so users always get the latest version
  // when they `npm i -g clementine-agent@latest`. Custom user skills
  // are NOT touched — only the bundled-by-Anthropic ones whose name
  // appears in BUNDLED_FIRST_PARTY_SKILLS.
  const BUNDLED_FIRST_PARTY_SKILLS = ['skill-creator'];
  const srcSkillsRoot = path.join(srcVault, 'skills');
  const dstSkillsRoot = path.join(dstVault, 'skills');
  if (existsSync(srcSkillsRoot)) {
    mkdirSync(dstSkillsRoot, { recursive: true });
    let installedSkills = 0;
    for (const skillName of BUNDLED_FIRST_PARTY_SKILLS) {
      const srcSkill = path.join(srcSkillsRoot, skillName);
      const dstSkill = path.join(dstSkillsRoot, skillName);
      if (!existsSync(srcSkill)) continue;
      try {
        cpSync(srcSkill, dstSkill, { recursive: true });
        installedSkills++;
      } catch { /* skip — keep going for other skills */ }
    }
    if (installedSkills > 0) {
      console.log(`Bundled ${installedSkills} first-party skill(s) into ${dstSkillsRoot}`);
    }
  }
}

// ── Step 4: Optional local embedding model prefetch ─────────────────
// Model weights are intentionally not bundled into the npm tarball. Users
// who want repo/npm updates to keep the local dense model warm can opt in:
//   CLEMENTINE_INSTALL_EMBEDDINGS=1 npm install -g clementine-agent
// or put CLEMENTINE_PREFETCH_EMBEDDINGS=1 in ~/.clementine/.env.
const dataEnv = readDataEnv();
if (flagEnabled('CLEMENTINE_INSTALL_EMBEDDINGS', dataEnv) || flagEnabled('CLEMENTINE_PREFETCH_EMBEDDINGS', dataEnv)) {
  const cliPath = path.join(PKG_DIR, 'dist', 'cli', 'index.js');
  if (existsSync(cliPath)) {
    try {
      console.log('Prefetching Clementine local embedding model...');
      execFileSync(process.execPath, [cliPath, 'memory', 'model', 'install'], {
        cwd: PKG_DIR,
        stdio: 'inherit',
        env: { ...process.env, CLEMENTINE_HOME: DATA_HOME },
        timeout: 10 * 60_000,
      });
    } catch {
      console.log('Embedding model prefetch skipped/failed. Run `clementine memory model install` later.');
    }
  } else {
    console.log('Embedding model prefetch skipped: built CLI not found yet.');
  }
}

// ── Step 5: Check for claude CLI ────────────────────────────────────
let claudeOnPath = false;
try {
  execSync('claude --version', { stdio: 'pipe' });
  claudeOnPath = true;
} catch { /* not on PATH */ }

// ── Step 6: Print instructions ──────────────────────────────────────
const alreadyConfigured = existsSync(path.join(DATA_HOME, '.env'));

if (alreadyConfigured) {
  console.log('\n✓ Clementine already configured. Run `clementine status` to check.\n');
} else {
  const claudeNote = claudeOnPath
    ? '║  Auth: run `clementine login` (uses your Claude Code subscription) ║'
    : '║  Auth: install Claude Code CLI first, then `clementine login`      ║';

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║              Clementine installed successfully!                   ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Next steps:                                                     ║
║                                                                  ║
║  1. Run: clementine login                                        ║
║     Authenticate with your Claude Code subscription (OAuth)      ║
║                                                                  ║
║  2. Run: clementine setup                                        ║
║     Configure your channels (Discord, Slack, Telegram...)        ║
║                                                                  ║
║  3. Run: clementine launch                                       ║
║     Start the assistant as a background daemon                   ║
║                                                                  ║
║  4. Run: clementine dashboard                                    ║
║     Open the web command center at localhost:3030                ║
║                                                                  ║
║  ${claudeNote.padEnd(65)}║
║                                                                  ║
║  Data directory: ${DATA_HOME.padEnd(47)}║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`);
}
