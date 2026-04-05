/**
 * Vault Migration 0003: Update Execution Framework pipeline to include narration.
 *
 * Updates the Research/Plan/Execute/Verify pipeline steps to emphasize
 * the observe-reason-act cycle with narration at each phase.
 *
 * Idempotent — skips if the narration phrases are already present.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { VaultMigration } from './types.js';

// Marker phrase that indicates the migration has already been applied
const MARKER = 'observe → reason → act';

// Old pipeline text (exact match for replacement)
const OLD_PIPELINE_HEADER = '### The Pipeline: Research → Plan → Execute → Verify';

const OLD_RESEARCH = '1. **Research.** Gather what I need. Read files, check memory, search the web. Get the facts before committing to an approach. But don\'t research forever — 5 reads without acting means I need to move.';
const NEW_RESEARCH = '1. **Research.** Gather what I need. Read files, check memory, search the web. After each lookup, say what I found and what it means for the approach. But don\'t research forever — 5 reads without acting means I need to move.';

const OLD_PLAN = '2. **Plan.** Break the work into atomic chunks. Each chunk is self-contained, completable without quality degradation, and verifiable. If the task needs 5+ steps across different domains, I trigger the orchestrator — it runs steps in parallel with fresh context per worker.';
const NEW_PLAN = '2. **Plan.** Break the work into atomic chunks. Each chunk is self-contained, completable without quality degradation, and verifiable. If the task needs 5+ steps across different domains, I trigger the orchestrator — it runs steps in parallel with fresh context per worker. Share the plan briefly before diving in.';

const OLD_EXECUTE = '3. **Execute.** Do the work. Each chunk runs in a fresh context when possible (sub-agents don\'t inherit context rot from my main conversation). Ship something real — stubs and placeholders don\'t count.';
const NEW_EXECUTE = '3. **Execute.** Do the work. Each chunk runs in a fresh context when possible (sub-agents don\'t inherit context rot from my main conversation). Ship something real — stubs and placeholders don\'t count. When something fails, explain why and what I\'m trying instead.';

const OLD_VERIFY = '4. **Verify.** Check goal-backward: what SHOULD be true now? Does it exist? Is it substantive? Is it wired up? If not, fix it or flag it.';
const NEW_VERIFY = '4. **Verify.** Check goal-backward: what SHOULD be true now? Does it exist? Is it substantive? Is it wired up? If not, fix it or flag it. Share the verification result.';

const NEW_PIPELINE_INTRO = `Each phase follows an **observe → reason → act** cycle — and I narrate the reasoning.`;

export const migration: VaultMigration = {
  id: '0003-update-execution-pipeline-narration',
  description: 'Update Execution Framework pipeline steps to include narration guidance',

  apply(vaultDir: string) {
    const soulPath = path.join(vaultDir, '00-System', 'SOUL.md');

    if (!existsSync(soulPath)) {
      return { applied: false, skipped: true, details: 'SOUL.md not found' };
    }

    let content = readFileSync(soulPath, 'utf-8');

    // Check if already applied
    if (content.includes(MARKER)) {
      return { applied: false, skipped: true, details: 'Pipeline narration already present' };
    }

    // Check if the Execution Framework exists at all
    if (!content.includes(OLD_PIPELINE_HEADER)) {
      return { applied: false, skipped: true, details: 'Execution Framework pipeline header not found' };
    }

    let changes = 0;

    // Add the observe-reason-act intro after the pipeline header
    const headerEnd = content.indexOf(OLD_PIPELINE_HEADER) + OLD_PIPELINE_HEADER.length;
    const afterHeader = content.slice(headerEnd);
    if (!afterHeader.startsWith('\n\n' + NEW_PIPELINE_INTRO)) {
      content = content.slice(0, headerEnd) + '\n\n' + NEW_PIPELINE_INTRO + afterHeader;
      changes++;
    }

    // Update each pipeline step (only if the old version is present)
    if (content.includes(OLD_RESEARCH)) {
      content = content.replace(OLD_RESEARCH, NEW_RESEARCH);
      changes++;
    }
    if (content.includes(OLD_PLAN)) {
      content = content.replace(OLD_PLAN, NEW_PLAN);
      changes++;
    }
    if (content.includes(OLD_EXECUTE)) {
      content = content.replace(OLD_EXECUTE, NEW_EXECUTE);
      changes++;
    }
    if (content.includes(OLD_VERIFY)) {
      content = content.replace(OLD_VERIFY, NEW_VERIFY);
      changes++;
    }

    if (changes === 0) {
      return { applied: false, skipped: true, details: 'No matching content to update (may have been manually modified)' };
    }

    writeFileSync(soulPath, content);
    return { applied: true, skipped: false, details: `Updated ${changes} part(s) of the Execution Framework pipeline` };
  },
};
