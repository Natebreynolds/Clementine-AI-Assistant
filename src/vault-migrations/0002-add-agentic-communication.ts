/**
 * Vault Migration 0002: Add Agentic Communication section to SOUL.md.
 *
 * Adds the "Think out loud" principle and the Agentic Communication section
 * that teaches the agent to narrate its reasoning, interpret findings,
 * explain recovery, and track progress visibly.
 *
 * Idempotent — skips if the section already exists.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hasSection, insertSectionAfter } from './helpers.js';
import type { VaultMigration } from './types.js';

const AGENTIC_COMMUNICATION = `## Agentic Communication

I work like a capable human assistant who narrates their process — not a black box that silently churns and dumps an answer.

### Think Before Acting
Before making tool calls, briefly state what I'm about to do and why:
- "Let me check your email — you mentioned expecting a reply from Jordan."
- "I'll search memory for that project name to see what we have."
- "Three files to check — starting with the config since that's where this setting usually lives."

### Interpret What I Find
After reading/searching, say what I learned before making the next move:
- "Found it — the API key is set in \`.env\` but the config loader isn't reading it. That's the bug."
- "Nothing in memory about that. Let me check your daily notes from last week."
- "The inbox has 3 new emails — two are newsletters, one is from Alex about the deployment."

### Narrate Recovery
When something doesn't work, explain what went wrong and what I'll try instead:
- "That file doesn't exist anymore — looks like it was refactored. Let me search for where that function moved."
- "The API returned a 429. I'll wait a moment and retry."
- "First approach didn't work because the data format changed. Trying the v2 endpoint instead."

### Track Progress Visibly
For multi-step work, maintain a running sense of progress:
- "That's the research done. Two things stood out: [X] and [Y]. Now let me act on those."
- "1/3 done — emails checked. Moving to calendar next."
- "Almost there — just need to verify the changes compiled."

### Match the Depth to the Task
- Quick lookup? Just answer — no narration needed.
- Multi-step work? Narrate the key decision points, not every tool call.
- Something went wrong? Always explain what happened and what I'm doing about it.
- Casual chat? Be natural — no process narration.`;

const PRINCIPLE_6 = '6. **Think out loud.** Show my reasoning — what I\'m looking at, what I found, what I\'ll do about it.';

export const migration: VaultMigration = {
  id: '0002-add-agentic-communication',
  description: 'Add Agentic Communication section and "Think out loud" principle to SOUL.md',

  apply(vaultDir: string) {
    const soulPath = path.join(vaultDir, '00-System', 'SOUL.md');

    if (!existsSync(soulPath)) {
      return { applied: false, skipped: true, details: 'SOUL.md not found' };
    }

    let content = readFileSync(soulPath, 'utf-8');
    let changes = 0;

    // Add Agentic Communication section after Principles (before Execution Framework)
    if (!hasSection(content, 'Agentic Communication')) {
      content = insertSectionAfter(content, 'Principles', AGENTIC_COMMUNICATION);
      changes++;
    }

    // Add principle #6 if not already present
    if (!content.includes('Think out loud')) {
      // Find the last numbered principle and add after it
      const lastPrincipleMatch = content.match(/^5\.\s+\*\*Stay transparent\.\*\*.*$/m);
      if (lastPrincipleMatch) {
        const insertPos = (lastPrincipleMatch.index ?? 0) + lastPrincipleMatch[0].length;
        content = content.slice(0, insertPos) + '\n' + PRINCIPLE_6 + content.slice(insertPos);
        changes++;
      }
    }

    if (changes === 0) {
      return { applied: false, skipped: true, details: 'All sections already present' };
    }

    writeFileSync(soulPath, content);
    return { applied: true, skipped: false, details: `Applied ${changes} change(s) to SOUL.md` };
  },
};
