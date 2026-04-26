/**
 * Migration 0004: Backfill `schemaVersion: 1` into CRON.md and agent.md frontmatter.
 *
 * First multi-target migration — uses the new MigrationContext shape
 * shipped in Phase 7a. Establishes the convention so future format changes
 * (a v2 migration) can target files known to be at v1.
 *
 * Idempotent: parses with gray-matter, only writes when schemaVersion is
 * missing or not equal to 1.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

function backfillFile(filePath: string): 'updated' | 'already-set' | 'invalid' | 'missing' {
  if (!existsSync(filePath)) return 'missing';
  let parsed;
  try {
    parsed = matter(readFileSync(filePath, 'utf-8'));
  } catch {
    return 'invalid';
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  if (data.schemaVersion === 1) return 'already-set';
  data.schemaVersion = 1;
  // gray-matter's stringify preserves the original frontmatter style.
  writeFileSync(filePath, matter.stringify(parsed.content, data));
  return 'updated';
}

function findAgentMdFiles(vaultDir: string): string[] {
  const out: string[] = [];
  const agentsDir = path.join(vaultDir, '00-System', 'agents');
  if (!existsSync(agentsDir)) return out;
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(agentsDir, entry.name, 'agent.md');
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

export const migration: Migration = {
  kind: 'vault',
  id: '0004-backfill-schema-versions',
  description: 'Backfill schemaVersion: 1 into CRON.md and agent.md frontmatter',

  apply(ctx: MigrationContext): MigrationResult {
    const targets: string[] = [];
    const cronPath = path.join(ctx.vaultDir, '00-System', 'CRON.md');
    if (existsSync(cronPath)) targets.push(cronPath);
    targets.push(...findAgentMdFiles(ctx.vaultDir));

    if (targets.length === 0) {
      return { applied: false, skipped: true, details: 'No CRON.md or agent.md files found' };
    }

    const stats = { updated: 0, alreadySet: 0, invalid: 0, missing: 0 };
    for (const f of targets) {
      const r = backfillFile(f);
      if (r === 'updated') stats.updated++;
      else if (r === 'already-set') stats.alreadySet++;
      else if (r === 'invalid') stats.invalid++;
      else stats.missing++;
    }

    if (stats.updated === 0) {
      return {
        applied: false,
        skipped: true,
        details: `All ${targets.length} files already have schemaVersion (alreadySet=${stats.alreadySet}, invalid=${stats.invalid})`,
      };
    }
    return {
      applied: true,
      skipped: false,
      details: `Updated ${stats.updated}/${targets.length} files (alreadySet=${stats.alreadySet}, invalid=${stats.invalid})`,
    };
  },
};
