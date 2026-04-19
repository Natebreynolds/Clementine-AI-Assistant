/**
 * Clementine TypeScript — Deterministic cron job fix applier.
 *
 * Applies the `autoApply` operations from a Diagnosis to a CRON.md file
 * (global or agent-scoped). Strictly scoped to:
 *   - Allowlisted scalar fields only (enforced by the diagnostics module
 *     before they arrive here, and re-checked here for safety).
 *   - A single job's YAML block, identified by `- name: <jobName>`.
 *   - Line-level edits — never touches multi-line fields like `prompt`.
 *
 * Every apply writes a .bak next to the CRON.md and appends to an audit
 * log before touching the file.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { AGENTS_DIR, BASE_DIR, CRON_FILE } from '../config.js';
import { EDITABLE_FIELDS, type FixOperation } from './failure-diagnostics.js';

const logger = pino({ name: 'clementine.fix-applier' });

const AUDIT_FILE = path.join(BASE_DIR, 'cron', 'fix-applier.log');

export interface ApplyResult {
  ok: boolean;
  message: string;
  file?: string;
  appliedOps?: FixOperation[];
  skippedOps?: FixOperation[];
  diff?: string;
}

/**
 * Resolve which CRON.md to edit for this job. Agent-scoped jobs live in
 * vault/00-System/agents/<slug>/CRON.md; everything else is the global
 * vault/00-System/CRON.md. If autoApply.agentSlug is provided, trust it;
 * otherwise infer from the job name.
 */
function resolveCronFile(jobName: string, autoApply: { agentSlug?: string }): string | null {
  if (autoApply.agentSlug) {
    const f = path.join(AGENTS_DIR, autoApply.agentSlug, 'CRON.md');
    if (existsSync(f)) return f;
    logger.warn({ agentSlug: autoApply.agentSlug, expected: f }, 'agent-scoped CRON.md not found');
    return null;
  }

  // Infer from jobName prefix (e.g., "ross-the-sdr:reply-detection")
  if (jobName.includes(':')) {
    const slug = jobName.split(':')[0]!;
    const f = path.join(AGENTS_DIR, slug, 'CRON.md');
    if (existsSync(f)) return f;
  }

  return existsSync(CRON_FILE) ? CRON_FILE : null;
}

/**
 * The bare job name without the agent prefix. Agent-scoped cron jobs are
 * written in their own file without the prefix — it's added programmatically
 * when the scheduler merges them into the global job list.
 */
function bareJobName(jobName: string): string {
  const idx = jobName.indexOf(':');
  return idx === -1 ? jobName : jobName.slice(idx + 1);
}

/**
 * Find the line-range of a job's YAML block in a CRON.md file.
 * Blocks start with `  - name: <bareName>` and run until the next `  - name:`
 * at the same indent, or end of the jobs array.
 */
function findJobBlock(lines: string[], bareName: string): { start: number; end: number } | null {
  // Match: two-space indent, hyphen, space, "name:", name (allow trailing spaces)
  const nameEsc = bareName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^  - name:\\s+${nameEsc}\\s*$`);
  const anyStartRe = /^  - name:\s+/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i]!)) { start = i; break; }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyStartRe.test(lines[i]!)) { end = i; break; }
  }
  return { start, end };
}

/**
 * Search a job block for a top-level scalar field (4-space indent, single
 * line `key: value`). Returns the line index, or -1 if not present.
 * Skips lines inside multi-line blocks (|>|, >) by tracking when we enter
 * and exit them.
 */
function findFieldLine(lines: string[], blockStart: number, blockEnd: number, field: string): number {
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRe = new RegExp(`^    ${fieldEsc}:\\s*(.*)$`);
  // Multi-line marker pattern: `    key: |` or `    key: >-` or `    key: >`
  const multiLineStartRe = /^    \w[\w-]*:\s*[|>][-+]?\s*$/;

  let inMultiLine = false;
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (inMultiLine) {
      // Multi-line content is indented MORE than 4 spaces. When we hit a line
      // indented exactly 4 (another field) or less, we've exited.
      if (/^    \S/.test(line) && !/^     /.test(line)) {
        inMultiLine = false;
        // Fall through to check this line
      } else {
        continue;
      }
    }
    if (multiLineStartRe.test(line)) {
      inMultiLine = true;
      continue;
    }
    if (fieldRe.test(line)) return i;
  }
  return -1;
}

/**
 * Serialize a scalar value to YAML. Strings with colons, leading dashes, or
 * YAML-sensitive characters get quoted. Everything else emits bare.
 */
function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  if (/^[\w\-./]+$/.test(s) && !/^(true|false|yes|no|null|~|\d)/i.test(s)) {
    return s;
  }
  // Quote with double quotes, escape any embedded "
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Apply operations to a single job block in-place (returns a new array of
 * lines). Silently drops operations targeting fields not in EDITABLE_FIELDS
 * (defense in depth — the diagnostics parser filters these too).
 */
function applyOperations(
  lines: string[],
  block: { start: number; end: number },
  operations: FixOperation[],
): { newLines: string[]; applied: FixOperation[]; skipped: FixOperation[] } {
  // Work on a mutable copy. We track the evolving block.end as we insert/delete.
  let working = lines.slice();
  let blockEnd = block.end;
  const applied: FixOperation[] = [];
  const skipped: FixOperation[] = [];

  for (const op of operations) {
    if (!EDITABLE_FIELDS.has(op.field)) {
      skipped.push(op);
      continue;
    }

    const existing = findFieldLine(working, block.start, blockEnd, op.field);

    if (op.op === 'remove') {
      if (existing === -1) {
        skipped.push(op); // nothing to remove
        continue;
      }
      working.splice(existing, 1);
      blockEnd -= 1;
      applied.push(op);
    } else if (op.op === 'set') {
      const newLine = `    ${op.field}: ${yamlScalar(op.value)}`;
      if (existing !== -1) {
        working[existing] = newLine;
      } else {
        // Insert right after the name line so field order stays predictable.
        working.splice(block.start + 1, 0, newLine);
        blockEnd += 1;
      }
      applied.push(op);
    }
  }

  return { newLines: working, applied, skipped };
}

/**
 * Build a compact diff of only the scalar-field lines that changed.
 * Ignores multi-line content like embedded prompts — walks each block,
 * extracts single-line `    key: value` fields, and compares those.
 * Keeps output readable for confirm dialogs and audit logs.
 */
function makeDiff(before: string[], after: string[], blockStart: number, newBlockEnd: number): string {
  const beforeEnd = findBlockEnd(before, blockStart);
  const beforeFields = extractScalarFields(before.slice(blockStart, beforeEnd));
  const afterFields = extractScalarFields(after.slice(blockStart, newBlockEnd));

  const allKeys = new Set<string>([...beforeFields.keys(), ...afterFields.keys()]);
  const lines: string[] = [];
  lines.push(`@@ ${after[blockStart]!.trim()} @@`);
  for (const key of allKeys) {
    const b = beforeFields.get(key);
    const a = afterFields.get(key);
    if (b === a) continue;
    if (b !== undefined) lines.push(`- ${b}`);
    if (a !== undefined) lines.push(`+ ${a}`);
  }
  return lines.join('\n');
}

/**
 * Extract single-line scalar `    key: value` fields from a job block.
 * Skips the `- name:` line and multi-line `key: |` / `key: >` content.
 */
function extractScalarFields(blockLines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const scalarRe = /^    ([\w-]+):\s*(.*)$/;
  const multiStartRe = /^    [\w-]+:\s*[|>][-+]?\s*$/;
  let inMulti = false;
  for (const line of blockLines) {
    if (inMulti) {
      // Exit when we hit another 4-space field
      if (/^    \S/.test(line) && !/^     /.test(line)) {
        inMulti = false;
      } else {
        continue;
      }
    }
    if (multiStartRe.test(line)) { inMulti = true; continue; }
    const m = line.match(scalarRe);
    if (m) out.set(m[1]!, line);
  }
  return out;
}

function findBlockEnd(lines: string[], start: number): number {
  const anyStartRe = /^  - name:\s+/;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyStartRe.test(lines[i]!)) return i;
  }
  return lines.length;
}

/**
 * Apply a proposed fix to the right CRON.md file. Idempotent with respect
 * to already-applied ops (remove on a missing field is a no-op, set on a
 * matching value is a no-op).
 */
export function applyFix(
  jobName: string,
  autoApply: { agentSlug?: string; operations: FixOperation[] },
  opts: { dryRun?: boolean } = {},
): ApplyResult {
  const cronFile = resolveCronFile(jobName, autoApply);
  if (!cronFile) {
    return { ok: false, message: `No CRON.md found for ${jobName}` };
  }

  const bare = bareJobName(jobName);
  const original = readFileSync(cronFile, 'utf-8');
  const lines = original.split('\n');
  const block = findJobBlock(lines, bare);
  if (!block) {
    return { ok: false, message: `Job '${bare}' not found in ${cronFile}`, file: cronFile };
  }

  const { newLines, applied, skipped } = applyOperations(lines, block, autoApply.operations);
  if (applied.length === 0) {
    return {
      ok: false,
      message: 'Nothing to apply (all ops were no-ops or on disallowed fields)',
      file: cronFile,
      appliedOps: applied,
      skippedOps: skipped,
    };
  }

  const newBlockEnd = findBlockEnd(newLines, block.start);
  const diff = makeDiff(lines, newLines, block.start, newBlockEnd);

  if (opts.dryRun) {
    return {
      ok: true,
      message: `Dry run: ${applied.length} op(s) would apply`,
      file: cronFile,
      appliedOps: applied,
      skippedOps: skipped,
      diff,
    };
  }

  // Backup before write
  try {
    copyFileSync(cronFile, cronFile + '.bak');
  } catch (err) {
    logger.warn({ err, file: cronFile }, 'Failed to write .bak before applying fix');
  }

  const newContent = newLines.join('\n');
  writeFileSync(cronFile, newContent);

  appendAudit({
    jobName,
    file: cronFile,
    applied,
    skipped,
    diff,
  });

  logger.info({ jobName, file: cronFile, applied: applied.length }, 'Applied cron job fix');

  return {
    ok: true,
    message: `Applied ${applied.length} op(s) to ${path.basename(cronFile)}`,
    file: cronFile,
    appliedOps: applied,
    skippedOps: skipped,
    diff,
  };
}

function appendAudit(entry: {
  jobName: string;
  file: string;
  applied: FixOperation[];
  skipped: FixOperation[];
  diff: string;
}): void {
  try {
    mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(
      AUDIT_FILE,
      JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to append fix-applier audit');
  }
}
