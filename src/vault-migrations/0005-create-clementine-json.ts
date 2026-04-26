/**
 * Migration 0005: Create ~/.clementine/clementine.json with sane defaults.
 *
 * First config-kind migration — uses MigrationContext.baseDir, not vaultDir.
 * Reads the existing .env (already loaded into process at module init via
 * config.ts, so we re-read here to be safe) and writes the equivalent
 * canonical config file with comments explaining precedence rules.
 *
 * Idempotent: skips entirely if the file already exists. Users who edit
 * the file post-migration are not at risk of having their edits overwritten.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

/** Re-parse .env independently of config.ts's module-level cache. */
function readEnv(baseDir: string): Record<string, string> {
  const envPath = path.join(baseDir, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const migration: Migration = {
  kind: 'config',
  id: '0005-create-clementine-json',
  description: 'Create clementine.json with current effective config as defaults',

  apply(ctx: MigrationContext): MigrationResult {
    const targetPath = path.join(ctx.baseDir, 'clementine.json');
    if (existsSync(targetPath)) {
      return { applied: false, skipped: true, details: 'clementine.json already exists' };
    }

    const env = readEnv(ctx.baseDir);

    // Build the canonical JSON. Only include fields we actually have values
    // for — empty/missing fields are omitted so the file documents what was
    // explicitly configured (not a wall of nulls).
    const out: Record<string, unknown> = { schemaVersion: 1 };

    if (env['OWNER_NAME']) out.ownerName = env['OWNER_NAME'];
    if (env['ASSISTANT_NAME']) out.assistantName = env['ASSISTANT_NAME'];
    if (env['TIMEZONE']) out.timezone = env['TIMEZONE'];

    const models: Record<string, string> = {};
    if (env['DEFAULT_MODEL_TIER']) models.default = env['DEFAULT_MODEL_TIER'];
    if (env['HAIKU_MODEL']) models.haiku = env['HAIKU_MODEL'];
    if (env['SONNET_MODEL']) models.sonnet = env['SONNET_MODEL'];
    if (env['OPUS_MODEL']) models.opus = env['OPUS_MODEL'];
    if (Object.keys(models).length > 0) out.models = models;

    const budgets: Record<string, number> = {};
    const bH = num(env['BUDGET_HEARTBEAT_USD']);
    const bT1 = num(env['BUDGET_CRON_T1_USD']);
    const bT2 = num(env['BUDGET_CRON_T2_USD']);
    const bC = num(env['BUDGET_CHAT_USD']);
    if (bH !== undefined) budgets.heartbeat = bH;
    if (bT1 !== undefined) budgets.cronT1 = bT1;
    if (bT2 !== undefined) budgets.cronT2 = bT2;
    if (bC !== undefined) budgets.chat = bC;
    if (Object.keys(budgets).length > 0) out.budgets = budgets;

    // Write as JSON with a leading comment-as-docstring isn't valid JSON.
    // Instead we ship a sibling README that explains, and keep the JSON pure.
    const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    renameSync(tmp, targetPath);

    // Also ship a README.md sibling explaining what this file is.
    const readmePath = path.join(ctx.baseDir, 'README.md');
    if (!existsSync(readmePath)) {
      writeFileSync(readmePath, [
        '# ~/.clementine/',
        '',
        'This is your Clementine data home. Updates to the engine (`npm update -g clementine-agent`)',
        'replace the engine code but never touch this directory.',
        '',
        '## Editable config files',
        '',
        '- `clementine.json` — canonical user config (created by migration 0005)',
        '- `.env` — secrets and per-machine overrides; takes precedence over `clementine.json`',
        '- `vault/00-System/CRON.md` — cron jobs (YAML frontmatter)',
        '- `vault/00-System/SOUL.md` — assistant personality / values',
        '- `vault/00-System/agents/<slug>/agent.md` — per-agent definitions',
        '- `advisor-rules/user/*.yaml` — custom advisor rules (overrides shipped builtins)',
        '- `prompt-overrides/{_global.md,jobs/<name>.md,agents/<slug>.md}` — prompt augmentation',
        '',
        '## Config precedence (highest first)',
        '',
        '1. `process.env` — runtime overrides',
        '2. `.env` in this dir — explicit per-machine config',
        '3. `clementine.json` — canonical config',
        '4. Compiled defaults',
        '',
        '## State and cache',
        '',
        'Other files in this directory are runtime state (sessions, heartbeat, logs)',
        'or caches (memory.db, tool inventory). They are not for editing by hand.',
      ].join('\n') + '\n');
    }

    return {
      applied: true,
      skipped: false,
      details: `Created clementine.json with ${Object.keys(out).length - 1} field(s) populated`,
    };
  },
};
