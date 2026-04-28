/**
 * Clementine TypeScript — Seed user-model slots from existing memory.
 *
 * One-shot Haiku pass over MEMORY.md + top-salience chunks + recent session
 * summaries. Proposes initial values for the 4 user_model slots so a freshly-
 * upgraded agent has a populated mental model immediately rather than needing
 * to re-learn everything through fresh conversations.
 *
 * Returns proposals only — caller decides whether to apply (typically via the
 * dashboard "Seed from existing memory" review UI).
 */

import { existsSync, readFileSync } from 'node:fs';
import pino from 'pino';
import { MEMORY_FILE } from '../tools/shared.js';

const logger = pino({ name: 'clementine.seed-user-model' });

interface SeedSourceStore {
  searchFts(query: string, limit: number): Array<{
    chunkId: number;
    sourceFile: string;
    section: string;
    content: string;
    salience: number;
  }>;
  getRecentSummaries(limit?: number): Array<{ summary: string; createdAt: string }>;
  db: unknown;
}

export interface UserModelProposals {
  user_facts: string;
  goals: string;
  relationships: string;
  agent_persona: string;
  /** Number of distinct source items the LLM saw (chunks + summaries + MEMORY.md). */
  sourceCount: number;
  /** Raw model output, for debugging. */
  rawResponse?: string;
}

/** Size budget per source category — keeps the corpus under Haiku's
 *  prompt-cost sweet spot while preserving signal. */
const MAX_MEMORY_MD_CHARS = 4000;
const MAX_CHUNK_CHARS = 4000;
const MAX_SUMMARIES_CHARS = 1500;

function gatherCorpus(store: SeedSourceStore, memoryFilePath: string): { corpus: string; sourceCount: number } {
  const parts: string[] = [];
  let sourceCount = 0;

  // 1. MEMORY.md — highest-signal source, the agent's curated profile note
  if (existsSync(memoryFilePath)) {
    try {
      const md = readFileSync(memoryFilePath, 'utf-8').slice(0, MAX_MEMORY_MD_CHARS);
      if (md.trim()) {
        parts.push(`## MEMORY.md\n${md}`);
        sourceCount++;
      }
    } catch { /* non-fatal */ }
  }

  // 2. Top-salience chunks — what the agent has been actively retrieving
  // We don't have a "list by salience" method on the store directly, but
  // searchFts with a generic query that matches almost everything works as
  // a coarse top-N proxy. Better: query the underlying db handle.
  try {
    const db = store.db as { prepare: (sql: string) => { all: (...args: unknown[]) => unknown } };
    const rows = db.prepare(
      `SELECT c.source_file, c.section, c.content, c.salience
       FROM chunks c
       LEFT JOIN chunk_soft_deletes sd ON sd.chunk_id = c.id
       WHERE sd.chunk_id IS NULL AND length(c.content) > 50
       ORDER BY c.salience DESC, c.last_outcome_score DESC, c.updated_at DESC
       LIMIT 40`,
    ).all() as Array<{ source_file: string; section: string; content: string; salience: number }>;
    if (rows.length > 0) {
      let chunkBlock = '## High-salience memory chunks\n';
      let used = 0;
      for (const r of rows) {
        const entry = `\n--- [${r.source_file} · ${r.section}]\n${r.content.slice(0, 500)}\n`;
        if (used + entry.length > MAX_CHUNK_CHARS) break;
        chunkBlock += entry;
        used += entry.length;
        sourceCount++;
      }
      parts.push(chunkBlock);
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to gather salience chunks');
  }

  // 3. Recent session summaries — surfaces current goals and active context
  try {
    const summaries = store.getRecentSummaries(8);
    if (summaries.length > 0) {
      let block = '## Recent session summaries\n';
      let used = 0;
      for (const s of summaries) {
        const entry = `\n[${s.createdAt}]\n${s.summary.slice(0, 400)}\n`;
        if (used + entry.length > MAX_SUMMARIES_CHARS) break;
        block += entry;
        used += entry.length;
        sourceCount++;
      }
      parts.push(block);
    }
  } catch { /* getRecentSummaries may be missing or empty */ }

  return { corpus: parts.join('\n\n---\n\n'), sourceCount };
}

const SEED_PROMPT = (corpus: string) => `Analyze the memory corpus below and propose initial values for the agent's "user model" — coherent always-in-context facts about the user that load into every conversation.

The user model has 4 slots, each capped at 2000 chars:

1. **user_facts** — Who they are. Name, role, location, lasting preferences (writing style, tools, communication style). Stable identifiers and personality traits.
2. **goals** — What they're actively working toward right now. Current projects, deadlines, immediate intents. Skip vague long-term aspirations.
3. **relationships** — People, projects, channels they regularly interact with. One line each, who-is-what.
4. **agent_persona** — How the agent (Clementine) should think of itself in relation to the user. Skip if no signal.

Rules:
- Only include facts with direct evidence in the corpus
- Be terse. Bullet fragments, not full sentences. Skip filler.
- If a slot has no good signal, output exactly: "(no clear signal)"
- Never invent details — if uncertain, leave it out
- Don't repeat the same fact across slots

Output exactly this format (markdown headings, no other text before or after):

## user_facts
- bullet
- bullet

## goals
- bullet

## relationships
- bullet

## agent_persona
- bullet

---

Memory corpus to analyze:

${corpus}`;

function parseProposals(raw: string): {
  user_facts: string;
  goals: string;
  relationships: string;
  agent_persona: string;
} {
  const slots = ['user_facts', 'goals', 'relationships', 'agent_persona'] as const;
  const out: Record<string, string> = {
    user_facts: '', goals: '', relationships: '', agent_persona: '',
  };

  // Tolerant parser: split on any "## slot_name" header (case-insensitive),
  // anchored at line start. Whatever follows up to the next slot header is
  // that slot's content.
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const next = slots[i + 1];
    const startRe = new RegExp(`^\\s*##\\s+${slot}\\b.*$`, 'mi');
    const m = startRe.exec(raw);
    if (!m) continue;
    let endIdx: number = raw.length;
    if (next) {
      const endRe = new RegExp(`^\\s*##\\s+${next}\\b.*$`, 'mi');
      const e = endRe.exec(raw);
      if (e && e.index > m.index) endIdx = e.index;
    }
    let body = raw.slice(m.index + m[0].length, endIdx).trim();
    // Treat "(no clear signal)" as empty so the slot stays unset
    if (/^\s*\(?no\s+clear\s+signal\)?\s*$/i.test(body)) body = '';
    out[slot] = body.slice(0, 2000);
  }

  return out as { user_facts: string; goals: string; relationships: string; agent_persona: string };
}

export async function seedUserModelFromMemory(
  store: SeedSourceStore,
  llmCall: (prompt: string) => Promise<string>,
  opts: { memoryFilePath?: string } = {},
): Promise<UserModelProposals> {
  const memFile = opts.memoryFilePath ?? MEMORY_FILE;
  const { corpus, sourceCount } = gatherCorpus(store, memFile);

  if (!corpus.trim() || sourceCount === 0) {
    return {
      user_facts: '', goals: '', relationships: '', agent_persona: '',
      sourceCount: 0,
      rawResponse: 'No source material found — vault may be empty.',
    };
  }

  const prompt = SEED_PROMPT(corpus);
  let raw = '';
  try {
    raw = await llmCall(prompt);
  } catch (err) {
    logger.warn({ err }, 'Seed LLM call failed');
    return {
      user_facts: '', goals: '', relationships: '', agent_persona: '',
      sourceCount, rawResponse: `LLM call failed: ${String(err)}`,
    };
  }

  const parsed = parseProposals(raw);
  return { ...parsed, sourceCount, rawResponse: raw };
}
