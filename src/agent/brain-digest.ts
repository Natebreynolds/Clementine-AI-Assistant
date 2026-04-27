/**
 * Cross-agent brain digest.
 *
 * Aggregates raw signals from across the team (memory recurrence, cron
 * activity, memory growth) and runs a single LLM synthesis pass to
 * produce a leadable markdown narrative — what the team accomplished,
 * what they learned in common, where to lead next.
 *
 * Intended caller: `clementine brain digest` CLI for v1; cron entry +
 * heartbeat-side proactive surfacing for v2.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import type { AgentManager } from './agent-manager.js';
import type { MemoryStore } from '../memory/store.js';
import type { PersonalAssistant } from './assistant.js';

const logger = pino({ name: 'clementine.brain-digest' });

export interface BrainDigestInputs {
  windowDays: number;
  agents: Array<{ slug: string; name: string }>;
  /** Clusters of similar memory chunks recurring across multiple agents. */
  crossAgentClusters: Array<{
    agents: string[];
    representativeContent: string;
    representativeSource: string;
    memberCount: number;
  }>;
  /** Per-job summary of runs in the window. */
  cronRunsByJob: Array<{
    jobName: string;
    agentSlug: string | null;
    runs: number;
    failures: number;
  }>;
  /** Chunk count growth per agent in the window — proxy for "what they worked on". */
  memoryDeltas: Array<{ agentSlug: string; chunksAdded: number }>;
}

/** Aggregate raw signals — pure data, no LLM call. */
export function gatherBrainDigestInputs(opts: {
  agentManager: AgentManager;
  memoryStore: MemoryStore;
  baseDir: string;
  windowDays: number;
}): BrainDigestInputs {
  const sinceMs = Date.now() - opts.windowDays * 86_400_000;
  const sinceIso = new Date(sinceMs).toISOString();

  const agents = opts.agentManager.listAll().map(a => ({ slug: a.slug, name: a.name }));

  // 1. Cross-agent memory recurrence — facts/topics surfaced by 2+ agents.
  let crossAgentClusters: BrainDigestInputs['crossAgentClusters'] = [];
  try {
    const clusters = opts.memoryStore.findCrossAgentRecurrence({
      threshold: 0.85,
      minAgents: 2,
      limit: 20,
    });
    crossAgentClusters = clusters.map(c => ({
      agents: c.agents,
      representativeContent: c.representative.content.slice(0, 400),
      representativeSource: `${c.representative.sourceFile}>${c.representative.section}`,
      memberCount: c.members.length,
    }));
  } catch (err) {
    logger.debug({ err }, 'Cross-agent recurrence scan failed — continuing with empty list');
  }

  // 2. Cron run summary — walk cron/runs/*.jsonl, filter to the window.
  const cronRunsByJob = gatherCronRunsByJob(opts.baseDir, sinceIso);

  // 3. Memory deltas — chunk growth per agent in the window.
  const memoryDeltas = gatherMemoryDeltas(opts.memoryStore, sinceIso);

  return {
    windowDays: opts.windowDays,
    agents,
    crossAgentClusters,
    cronRunsByJob,
    memoryDeltas,
  };
}

function gatherCronRunsByJob(baseDir: string, sinceIso: string): BrainDigestInputs['cronRunsByJob'] {
  const runsDir = path.join(baseDir, 'cron', 'runs');
  if (!existsSync(runsDir)) return [];
  const sinceMs = Date.parse(sinceIso);

  const aggregates = new Map<string, { jobName: string; agentSlug: string | null; runs: number; failures: number }>();

  for (const file of readdirSync(runsDir).filter(f => f.endsWith('.jsonl'))) {
    const jobName = file.replace(/\.jsonl$/, '');
    const filePath = path.join(runsDir, file);
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    } catch {
      continue;
    }

    let runs = 0;
    let failures = 0;
    let agentSlug: string | null = null;

    // jobNames may be agent-scoped: "<agent-slug>:<job>"
    const parts = jobName.split(':');
    if (parts.length > 1) {
      agentSlug = parts[0]!;
    }

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { startedAt?: string; finishedAt?: string; status?: string };
        const ts = entry.startedAt ?? entry.finishedAt;
        if (!ts) continue;
        if (Date.parse(ts) < sinceMs) continue;
        runs++;
        if (entry.status === 'error') failures++;
      } catch {
        continue;
      }
    }

    if (runs > 0) {
      aggregates.set(jobName, { jobName, agentSlug, runs, failures });
    }
  }

  return Array.from(aggregates.values()).sort((a, b) => b.runs - a.runs);
}

function gatherMemoryDeltas(memoryStore: MemoryStore, sinceIso: string): BrainDigestInputs['memoryDeltas'] {
  // Reach into the underlying connection — same pattern memory-tools.ts uses.
  const conn = (memoryStore as unknown as { conn: import('better-sqlite3').Database }).conn;
  try {
    const rows = conn
      .prepare(
        `SELECT COALESCE(agent_slug, 'global') as agentSlug, COUNT(*) as chunksAdded
         FROM chunks
         WHERE updated_at >= ?
         GROUP BY agent_slug
         ORDER BY chunksAdded DESC`,
      )
      .all(sinceIso) as Array<{ agentSlug: string; chunksAdded: number }>;
    return rows;
  } catch (err) {
    logger.debug({ err }, 'Memory delta query failed — continuing with empty list');
    return [];
  }
}

/**
 * Format the raw inputs as a single text block the LLM can synthesize.
 * Pre-LLM compression: rank by signal-bearing fields (failures over runs,
 * agent-spread over cluster size, growth over alpha-sort) and summarize the
 * tail rather than dropping it. Same picture in fewer tokens — the model
 * still sees the long-tail counts but doesn't pay tokens for each entry.
 *
 * Inspired by the skill-chaining COMPRESS pattern: filter at the boundary,
 * synthesize in the LLM. Tail-summary lines preserve the volume signal
 * ("X more agents added Y chunks total") without per-row cost.
 */
export function formatRawMaterial(inputs: BrainDigestInputs): string {
  const sections: string[] = [];

  sections.push(`## Window\nLast ${inputs.windowDays} days.`);

  // Team roster — split active vs. quiet so the synthesis prompt naturally
  // weights active agents in "per-agent highlights" without confabulating
  // about agents that did nothing this window.
  const activeSlugSet = new Set<string>([
    ...inputs.cronRunsByJob.map(r => r.agentSlug).filter((s): s is string => !!s),
    ...inputs.memoryDeltas.filter(d => d.agentSlug !== 'global').map(d => d.agentSlug),
  ]);
  const activeAgents = inputs.agents.filter(a => activeSlugSet.has(a.slug));
  const quietAgents = inputs.agents.filter(a => !activeSlugSet.has(a.slug));
  if (inputs.agents.length === 0) {
    sections.push(`## Team roster\n(no specialist agents)`);
  } else {
    const lines: string[] = [];
    if (activeAgents.length > 0) {
      lines.push(`Active this window:\n${activeAgents.map(a => `- ${a.name} (${a.slug})`).join('\n')}`);
    }
    if (quietAgents.length > 0) {
      lines.push(`Quiet this window: ${quietAgents.map(a => a.slug).join(', ')}`);
    }
    sections.push(`## Team roster\n${lines.join('\n\n')}`);
  }

  // Cron activity — failures-first ranking so the synthesis prompt sees the
  // problem signal early, with a tail summary preserving total volume.
  if (inputs.cronRunsByJob.length === 0) {
    sections.push(`## Cron activity\n(no autonomous runs in window)`);
  } else {
    const ranked = [...inputs.cronRunsByJob].sort((a, b) => {
      // Failures dominate; ties broken by run count (busier jobs more important).
      if (b.failures !== a.failures) return b.failures - a.failures;
      return b.runs - a.runs;
    });
    const TOP_N = 12;
    const top = ranked.slice(0, TOP_N);
    const tail = ranked.slice(TOP_N);
    const lines = top.map(r => {
      const tag = r.agentSlug ? ` [${r.agentSlug}]` : '';
      const failTag = r.failures > 0 ? ` — ${r.failures} failure${r.failures === 1 ? '' : 's'}` : '';
      return `- ${r.jobName}${tag}: ${r.runs} run${r.runs === 1 ? '' : 's'}${failTag}`;
    });
    if (tail.length > 0) {
      const tailRuns = tail.reduce((s, r) => s + r.runs, 0);
      const tailFailures = tail.reduce((s, r) => s + r.failures, 0);
      lines.push(`- _…and ${tail.length} more job${tail.length === 1 ? '' : 's'}: ${tailRuns} runs, ${tailFailures} failures total_`);
    }
    sections.push(`## Cron activity\n${lines.join('\n')}`);
  }

  // Memory growth — top-N by delta, summarize rest. The LLM doesn't need a
  // 30-line list of every agent that wrote one chunk; it needs to know who
  // wrote a lot.
  if (inputs.memoryDeltas.length === 0) {
    sections.push(`## Memory growth\n(no new chunks in window)`);
  } else {
    const TOP_N = 8;
    const top = inputs.memoryDeltas.slice(0, TOP_N);
    const tail = inputs.memoryDeltas.slice(TOP_N);
    const lines = top.map(d => `- ${d.agentSlug}: +${d.chunksAdded} chunks`);
    if (tail.length > 0) {
      const tailTotal = tail.reduce((s, d) => s + d.chunksAdded, 0);
      lines.push(`- _…and ${tail.length} other agent${tail.length === 1 ? '' : 's'}: +${tailTotal} chunks combined_`);
    }
    sections.push(`## Memory growth\n${lines.join('\n')}`);
  }

  // Cross-agent recurrence — widest-spread clusters first (most agents
  // touched), with cluster size as tiebreaker. Spread is the signal of
  // "this is genuinely team knowledge" — a 3-cluster touching 4 agents
  // matters more than a 10-cluster touching 2.
  if (inputs.crossAgentClusters.length === 0) {
    sections.push(`## Cross-agent recurrence\n(no facts surfaced from 2+ agents)`);
  } else {
    const ranked = [...inputs.crossAgentClusters].sort((a, b) => {
      if (b.agents.length !== a.agents.length) return b.agents.length - a.agents.length;
      return b.memberCount - a.memberCount;
    });
    const TOP_N = 8;
    const top = ranked.slice(0, TOP_N);
    const tail = ranked.slice(TOP_N);
    const lines = top.map((c, i) => {
      const preview = c.representativeContent.replace(/\n/g, ' ').slice(0, 200);
      return `${i + 1}. agents: ${c.agents.join(', ')} (${c.memberCount} chunks)\n   "${preview}${preview.length >= 200 ? '…' : ''}"`;
    });
    if (tail.length > 0) {
      lines.push(`_…and ${tail.length} more cross-agent cluster${tail.length === 1 ? '' : 's'} (smaller spread, not surfaced individually)._`);
    }
    sections.push(`## Cross-agent recurrence\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

const SYNTHESIS_SYSTEM_PROMPT = `You are Clementine, the master assistant. Your team of specialist agents has been working autonomously, and you need to write a **brain digest** — a leadable summary of what happened over the window, what the team learned in common, and where you should lead them next.

Format the digest as markdown:

# Brain Digest — last {N} days

## What happened
2-3 sentence overview of activity. Be specific about who did what.

## What we learned together
The cross-agent recurrence section shows facts/topics that surfaced from MULTIPLE agents — these are the team's emerging shared knowledge. List the 3-5 most meaningful patterns. If empty, say "Nothing recurred across agents this window — the team's still working in parallel silos."

## Where to lead
2-3 concrete priorities or follow-ups based on what you see. What's the team's biggest opportunity? What's at risk? What's a clear next move?

## Per-agent highlights
One bullet per active agent — what they worked on, status (healthy / quiet / failing). Skip agents with no activity.

**Style rules:**
- Lead with what matters. Don't list raw data — synthesize.
- Be honest about sparse data. If the window is quiet, say so. Don't pad.
- Under 400 words total. Cut anything that doesn't help you lead the team.
- No greeting, no sign-off — this is a working document.
`;

export async function runBrainDigest(opts: {
  assistant: PersonalAssistant;
  agentManager: AgentManager;
  memoryStore: MemoryStore;
  baseDir: string;
  windowDays?: number;
  model?: string;
}): Promise<{ markdown: string; inputs: BrainDigestInputs }> {
  const windowDays = opts.windowDays ?? 7;
  const inputs = gatherBrainDigestInputs({
    agentManager: opts.agentManager,
    memoryStore: opts.memoryStore,
    baseDir: opts.baseDir,
    windowDays,
  });

  const rawMaterial = formatRawMaterial(inputs);
  const prompt = `${SYNTHESIS_SYSTEM_PROMPT.replace('{N}', String(windowDays))}\n\n---\n\n# Raw signals\n\n${rawMaterial}`;

  logger.info({ windowDays, agents: inputs.agents.length, clusters: inputs.crossAgentClusters.length, jobs: inputs.cronRunsByJob.length }, 'Running brain digest synthesis');

  const markdown = await opts.assistant.runPlanStep(
    'brain-digest',
    prompt,
    {
      tier: 1,
      maxTurns: 3,
      model: opts.model ?? 'sonnet',
      disableTools: true, // synthesis only — no tool calls
    },
  );

  return { markdown: markdown.trim(), inputs };
}
