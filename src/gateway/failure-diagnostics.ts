/**
 * Clementine TypeScript — Broken-job diagnostic agent.
 *
 * When the failure monitor flags a job, this runs a cheap Haiku-level
 * analysis over the job definition, agent profile, and recent runs to
 * propose a root cause and a specific fix. Read-only: it never writes
 * anything except its own cache.
 *
 * Output surfaces in the Broken Jobs dashboard panel and the owner DM
 * so the response to a silent failure is "here's what's wrong and
 * here's what to change" rather than "go investigate."
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { AGENTS_DIR, BASE_DIR, CRON_FILE } from '../config.js';
import type { Gateway } from './router.js';
import type { BrokenJob } from './failure-monitor.js';

const logger = pino({ name: 'clementine.failure-diagnostics' });

const CACHE_FILE = path.join(BASE_DIR, 'cron', 'failure-diagnostics.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');

export interface Diagnosis {
  rootCause: string;
  confidence: 'high' | 'medium' | 'low';
  proposedFix: {
    type: 'config_change' | 'prompt_change' | 'agent_scope' | 'disable' | 'credential_refresh' | 'escalate_to_owner';
    details: string;
    diff?: string;
  };
  riskLevel: 'low' | 'medium' | 'high';
  generatedAt: string;
}

interface DiagnosisCache {
  [jobName: string]: Diagnosis;
}

function loadCache(): DiagnosisCache {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as DiagnosisCache;
    return raw;
  } catch {
    return {};
  }
}

function saveCache(cache: DiagnosisCache): void {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to persist diagnostic cache');
  }
}

/**
 * Pull the raw YAML entry for a cron job from CRON.md (global or agent-scoped).
 * Returns the text of the entry, not the parsed object, so the diagnostic
 * agent sees the exact fields the user edits.
 */
function readJobDefinition(jobName: string): string | null {
  const [maybeSlug, ...rest] = jobName.split(':');
  const bareName = rest.length > 0 ? rest.join(':') : maybeSlug!;
  const candidateFiles: string[] = [];

  if (rest.length > 0) {
    // agent-scoped: ross-the-sdr:reply-detection
    candidateFiles.push(path.join(AGENTS_DIR, maybeSlug!, 'CRON.md'));
  }
  candidateFiles.push(CRON_FILE);

  for (const file of candidateFiles) {
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf-8');
      // Find the YAML block for "- name: bareName" and return until the next
      // "- name:" at the same indent or end of file.
      const pattern = new RegExp(
        `^(  - name: ${bareName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$[\\s\\S]*?)(?=^  - name: |\\z)`,
        'm',
      );
      const m = raw.match(pattern);
      if (m) return m[1]!.slice(0, 6000);
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Read the agent profile markdown if this job is scoped to an agent.
 * Returns the first 2K chars which covers name/description/tier/allowedTools.
 */
function readAgentProfile(agentSlug: string): string | null {
  const profile = path.join(AGENTS_DIR, agentSlug, 'agent.md');
  if (!existsSync(profile)) return null;
  try {
    return readFileSync(profile, 'utf-8').slice(0, 2500);
  } catch {
    return null;
  }
}

/** Last N cron run entries for the job, oldest → newest for the prompt. */
function readRecentRuns(jobName: string, limit = 10): string {
  const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(RUNS_DIR, `${safe}.jsonl`);
  if (!existsSync(file)) return '(no run log)';
  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    const summaries = recent.map(line => {
      try {
        const d = JSON.parse(line) as {
          startedAt: string;
          status: string;
          durationMs: number;
          error?: string;
          outputPreview?: string;
          attempt?: number;
        };
        const detail = d.status === 'ok'
          ? `preview="${(d.outputPreview ?? '').slice(0, 120).replace(/\n/g, ' ')}"`
          : `error="${(d.error ?? '').split('\n')[0]!.slice(0, 160)}"`;
        return `${d.startedAt} ${d.status} (${Math.round(d.durationMs / 1000)}s) ${detail}`;
      } catch {
        return line.slice(0, 160);
      }
    });
    return summaries.join('\n');
  } catch {
    return '(failed to read run log)';
  }
}

function buildPrompt(broken: BrokenJob, jobDef: string | null, agentProfile: string | null, recentRuns: string): string {
  const breakerLine = broken.circuitBreakerEngagedAt
    ? `Circuit breaker engaged at ${broken.circuitBreakerEngagedAt}.`
    : 'No active circuit breaker.';
  return [
    `You are a reliability engineer diagnosing a cron job that's been failing in Clementine (a personal AI assistant framework).`,
    `Your output must be a single JSON object with the schema shown at the end. No preamble, no postscript.`,
    '',
    `## Job name: ${broken.jobName}`,
    broken.agentSlug ? `## Agent scope: ${broken.agentSlug}` : '## Scope: global (no agent)',
    `## Failure stats: ${broken.errorCount48h}/${broken.totalRuns48h} runs failed in last 48h. ${breakerLine}`,
    broken.lastAdvisorOpinion ? `## Advisor notes: ${broken.lastAdvisorOpinion}` : '',
    '',
    '## Job definition (CURRENT state of CRON.md):',
    jobDef ?? '(not found in CRON.md — may be a heartbeat pseudo-job like insight-check)',
    '',
    agentProfile ? '## Agent profile (agent.md, truncated):\n' + agentProfile + '\n' : '',
    '## Recent runs (oldest → newest):',
    recentRuns,
    '',
    broken.lastErrors.length > 0 ? '## Distinct recent errors:\n' + broken.lastErrors.map(e => '- ' + e.slice(0, 400)).join('\n') : '',
    '',
    '## Critical reasoning rules',
    '',
    '**The CURRENT job definition above may differ from the config at the time of past failures.** If you see old errors (e.g. "timeout kill") but the current config ALREADY contains the fields that would have caused those errors, treat those errors as resolved by a recent fix — do NOT propose re-adding the fields that caused them.',
    '',
    '**Look at the MOST RECENT runs specifically.** If the last 2+ runs succeeded, the job has recovered — propose `escalate_to_owner` with "appears recovered, no fix needed" as details, confidence: high, risk: low.',
    '',
    '**Don\'t propose reverting a fix.** If the current config does NOT contain `mode: unleashed` but recent runs show "Claude Code process aborted by user", do NOT propose adding `mode: unleashed` back. That error pattern occurs in BOTH unleashed (hit max_hours) and standard (hit timeoutMs) modes. Without strong evidence the current config is wrong, prefer raising `timeoutMs` or adding `max_turns` over toggling `mode`.',
    '',
    '## Diagnostic patterns (use these as priors)',
    '',
    '- **"API 400 input_schema"** → external MCP server exposes a malformed tool. Propose checking claude_desktop_config.json and ~/.claude.json for recently-updated packages. Type: escalate_to_owner.',
    '- **401/403 errors** → credential refresh needed. Type: credential_refresh. Name the specific service if possible.',
    '- **"Claude Code process aborted by user" with long durations (>60s)** → timeout kill. If current config has `mode: unleashed`, propose removing it + adding `max_turns: 25`. If current config is already standard, propose raising `timeoutMs` or investigating the prompt for infinite loops.',
    '- **"Reached maximum number of turns (N)"** → maxTurns set too low for the job\'s tool fan-out. Propose raising `max_turns` to 3×N.',
    '- **Output preview contains BLOCKED / "no local bash" / "permission denied"** → agent picked the wrong tool. Propose either scoping the job to an agent whose allowedTools excludes the bad MCP, or adding explicit tool-choice guidance in the prompt.',
    '- **No clear pattern** → escalate_to_owner with what you would need to know.',
    '',
    '## Output schema (JSON only, no markdown fences):',
    '{',
    '  "rootCause": "1-2 sentences explaining WHY the job is failing, referencing specific fields or error patterns from the CURRENT config",',
    '  "confidence": "high|medium|low",',
    '  "proposedFix": {',
    '    "type": "config_change|prompt_change|agent_scope|disable|credential_refresh|escalate_to_owner",',
    '    "details": "prose description of the fix, citing the exact field(s) to change",',
    '    "diff": "optional: exact before/after diff if it is a small config edit"',
    '  },',
    '  "riskLevel": "low|medium|high"',
    '}',
  ].filter(Boolean).join('\n');
}

function parseResponse(raw: string): Diagnosis | null {
  try {
    // The model sometimes wraps the JSON in markdown fences; extract the
    // first top-level {...} object.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<Diagnosis>;
    if (!parsed.rootCause || !parsed.proposedFix) return null;
    return {
      rootCause: String(parsed.rootCause).slice(0, 500),
      confidence: (parsed.confidence ?? 'medium') as Diagnosis['confidence'],
      proposedFix: {
        type: (parsed.proposedFix.type ?? 'escalate_to_owner') as Diagnosis['proposedFix']['type'],
        details: String(parsed.proposedFix.details ?? '').slice(0, 800),
        diff: parsed.proposedFix.diff ? String(parsed.proposedFix.diff).slice(0, 1000) : undefined,
      },
      riskLevel: (parsed.riskLevel ?? 'medium') as Diagnosis['riskLevel'],
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to parse diagnostic JSON');
    return null;
  }
}

/**
 * Diagnose one broken job. Returns a cached diagnosis if one exists and is
 * fresher than 24h; otherwise invokes the LLM. Always best-effort — returns
 * null instead of throwing so failure detection stays robust.
 */
export async function diagnoseBrokenJob(
  broken: BrokenJob,
  gateway: Gateway,
): Promise<Diagnosis | null> {
  const cache = loadCache();
  const cached = cache[broken.jobName];
  if (cached) {
    const age = Date.now() - Date.parse(cached.generatedAt);
    if (Number.isFinite(age) && age < CACHE_TTL_MS) {
      logger.debug({ job: broken.jobName, ageMin: Math.round(age / 60000) }, 'Using cached diagnosis');
      return cached;
    }
  }

  const jobDef = readJobDefinition(broken.jobName);
  const agentProfile = broken.agentSlug ? readAgentProfile(broken.agentSlug) : null;
  const recentRuns = readRecentRuns(broken.jobName, 10);
  const prompt = buildPrompt(broken, jobDef, agentProfile, recentRuns);

  let rawResponse: string;
  try {
    rawResponse = await gateway.handleCronJob(
      `diagnose:${broken.jobName}`,
      prompt,
      1,        // tier 1 — cheap
      5,        // maxTurns — diagnosis doesn't need tools typically
      'haiku',  // model — keep cost negligible
    );
  } catch (err) {
    logger.warn({ err, job: broken.jobName }, 'Diagnostic LLM call failed');
    return null;
  }

  const diagnosis = parseResponse(rawResponse);
  if (!diagnosis) {
    logger.warn({ job: broken.jobName, rawHead: rawResponse.slice(0, 200) }, 'Diagnosis returned unparseable response');
    return null;
  }

  cache[broken.jobName] = diagnosis;
  saveCache(cache);
  logger.info({
    job: broken.jobName,
    confidence: diagnosis.confidence,
    fixType: diagnosis.proposedFix.type,
  }, 'Broken-job diagnosis generated');
  return diagnosis;
}

/**
 * Clear cached diagnosis for a job (e.g., after the owner applies a fix).
 * Called opportunistically when a broken job disappears from the live set.
 */
export function clearDiagnosis(jobName: string): void {
  const cache = loadCache();
  if (cache[jobName]) {
    delete cache[jobName];
    saveCache(cache);
  }
}

/** Read-only accessor for the dashboard. */
export function getDiagnosisIfFresh(jobName: string): Diagnosis | null {
  const cache = loadCache();
  const d = cache[jobName];
  if (!d) return null;
  const age = Date.now() - Date.parse(d.generatedAt);
  if (!Number.isFinite(age) || age >= CACHE_TTL_MS) return null;
  return d;
}
