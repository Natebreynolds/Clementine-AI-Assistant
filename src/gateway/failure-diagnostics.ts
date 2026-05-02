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
  renameSync,
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

/**
 * Fields safe for one-click auto-apply. Limited to simple scalar YAML
 * fields on cron jobs — nothing multi-line (prompt, pre_check, context,
 * success_criteria), nothing structural (schedule edits would re-schedule
 * a running job, handled manually).
 */
export const EDITABLE_FIELDS = new Set([
  'tier',
  'mode',
  'max_hours',
  'max_turns',
  'max_retries',
  'enabled',
  'agentSlug',
  'work_dir',
  'model',
  'always_deliver',
  'after',
  'timeout_ms',
]);

export type FixOperation =
  | { op: 'set'; field: string; value: string | number | boolean }
  | { op: 'remove'; field: string };

/** CRON.md frontmatter edit (the original auto-apply shape). */
export interface AutoApplyCron {
  kind?: 'cron';                          // default; back-compat with the old shape
  agentSlug?: string;
  operations: FixOperation[];
}

/** Write a YAML rule to ~/.clementine/advisor-rules/user/<ruleId>.yaml */
export interface AutoApplyAdvisorRule {
  kind: 'advisor-rule';
  ruleId: string;
  yamlContent: string;
}

/** Write a markdown override to ~/.clementine/prompt-overrides/... */
export interface AutoApplyPromptOverride {
  kind: 'prompt-override';
  scope: 'global' | 'agent' | 'job';
  scopeKey?: string;     // required for scope=agent or scope=job
  content: string;       // markdown body, optional gray-matter frontmatter
}

export type AutoApply = AutoApplyCron | AutoApplyAdvisorRule | AutoApplyPromptOverride;

export interface Diagnosis {
  rootCause: string;
  confidence: 'high' | 'medium' | 'low';
  proposedFix: {
    type: 'config_change' | 'prompt_change' | 'agent_scope' | 'disable' | 'credential_refresh' | 'advisor_rule' | 'prompt_override' | 'escalate_to_owner';
    details: string;
    diff?: string;
    /**
     * When present, the fix can be applied with one click via the dashboard's
     * apply-fix endpoint. Three shapes (kind=cron|advisor-rule|prompt-override).
     * Each kind has its own validator that runs in sanitizeAutoApply before
     * the proposal is cached, and again in fix-applier before any write.
     */
    autoApply?: AutoApply;
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
    const tmp = CACHE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, CACHE_FILE);
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
    // agent-scoped: <agent-slug>:<job-name>
    candidateFiles.push(path.join(AGENTS_DIR, maybeSlug!, 'CRON.md'));
  }
  candidateFiles.push(CRON_FILE);

  for (const file of candidateFiles) {
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf-8');
      const lines = raw.split('\n');
      const start = lines.findIndex((line) => line.trim() === `- name: ${bareName}`);
      if (start === -1) continue;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^  - name:\s+/.test(lines[i] ?? '')) {
          end = i;
          break;
        }
      }
      return lines.slice(start, end).join('\n').slice(0, 6000);
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
          terminalReason?: string;
          attempt?: number;
        };
        const detailParts = [
          d.terminalReason ? `terminal=${d.terminalReason}` : '',
          d.error ? `error="${d.error.split('\n')[0]!.slice(0, 160)}"` : '',
          d.outputPreview ? `preview="${d.outputPreview.slice(0, 160).replace(/\n/g, ' ')}"` : '',
        ].filter(Boolean);
        return `${d.startedAt} ${d.status} (${Math.round(d.durationMs / 1000)}s) ${detailParts.join(' ')}`;
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
    '## Auto-apply contract',
    '',
    'When the fix is mechanical — set or remove a known scalar field, write a small advisor rule, or add prompt guidance — ALSO populate `proposedFix.autoApply`. The owner can one-click approve it. There are three KINDS of auto-apply, pick the one that matches:',
    '',
    '### kind: "cron" (default — edit CRON.md frontmatter)',
    'Use for: tier, mode, max_hours, max_turns, max_retries, enabled, agentSlug, work_dir, model, always_deliver, after, timeout_ms.',
    'Shape: { "kind": "cron", "agentSlug"?: "...", "operations": [...] }',
    'Operations: { "op": "set", "field": "<name>", "value": <scalar> } or { "op": "remove", "field": "<name>" }.',
    'If the job is agent-scoped (job name has ":"), set agentSlug to the prefix.',
    'Examples:',
    '- Remove unleashed + companion + cap turns: { "kind": "cron", "operations": [{"op":"remove","field":"mode"}, {"op":"remove","field":"max_hours"}, {"op":"set","field":"max_turns","value":25}] }',
    '- Bump maxTurns: { "kind": "cron", "operations": [{"op":"set","field":"max_turns","value":10}] }',
    '',
    '### kind: "advisor-rule" (write a YAML rule to ~/.clementine/advisor-rules/user/)',
    'Use when the fix is a behavioral rule that should affect ALL jobs matching some scope, not just one cron job. Examples: "for unleashed jobs, never bump maxTurns" or "for the inbox-triage agent, always set timeout to 900s on max_turns errors".',
    'Shape: { "kind": "advisor-rule", "ruleId": "kebab-case-id", "yamlContent": "<full yaml body>" }',
    'The YAML body must be a valid advisor rule (schemaVersion: 1, id, description, priority, when, then). User rules at priority 100+ override builtins of the same id.',
    'Example:',
    '{ "kind": "advisor-rule", "ruleId": "inbox-triage-aggressive-timeout", "yamlContent": "schemaVersion: 1\\nid: inbox-triage-aggressive-timeout\\ndescription: Bump timeout for the inbox-triage agent on recurring max_turns errors\\npriority: 105\\nappliesTo:\\n  agentSlug: inbox-triage\\nwhen:\\n  - kind: recentTimeoutHits\\n    window: 5\\n    atLeast: 1\\nthen:\\n  - kind: bumpTimeoutMs\\n    multiplier: 2.0" }',
    '',
    '### kind: "prompt-override" (write a markdown file to ~/.clementine/prompt-overrides/)',
    'Use when the fix is "give the LLM more guidance for this job/agent". Examples: a job consistently misses an edge case, an agent needs a reminder about output format.',
    'Shape: { "kind": "prompt-override", "scope": "job"|"agent"|"global", "scopeKey": "<job or agent name>", "content": "<markdown body>" }',
    'For scope=global, omit scopeKey. For scope=agent, scopeKey is the agent slug. For scope=job, scopeKey is the BARE job name (no agent prefix).',
    'Example:',
    '{ "kind": "prompt-override", "scope": "job", "scopeKey": "daily-summary", "content": "If the upstream query returns 0 rows, batch follow-up work in groups of 50 using bash heredoc loops. Do not enumerate item IDs in the prompt." }',
    '',
    '## When NOT to use autoApply',
    'For credential refreshes, multi-line CRON.md edits beyond the scalar allowlist, or any change you are not confident about: OMIT autoApply entirely. The owner will handle those manually.',
    '',
    '## Output schema (JSON only, no markdown fences):',
    '{',
    '  "rootCause": "1-2 sentences explaining WHY the job is failing",',
    '  "confidence": "high|medium|low",',
    '  "proposedFix": {',
    '    "type": "config_change|prompt_change|agent_scope|disable|credential_refresh|advisor_rule|prompt_override|escalate_to_owner",',
    '    "details": "prose description of the fix",',
    '    "diff": "optional: before/after diff",',
    '    "autoApply": "optional: one of the three shapes above"',
    '  },',
    '  "riskLevel": "low|medium|high"',
    '}',
  ].filter(Boolean).join('\n');
}

function bareJobName(jobName: string): string {
  return jobName.includes(':') ? jobName.split(':').slice(1).join(':') : jobName;
}

function promptOverrideForContextOverflow(jobName: string): AutoApplyPromptOverride {
  return {
    kind: 'prompt-override',
    scope: 'job',
    scopeKey: bareJobName(jobName),
    content: [
      '# Bounded Run Guidance',
      '',
      'Keep this job inside the context window.',
      '- Do not read full CRON.md, full run histories, or raw integration exports.',
      '- Pull records in batches of 20 or fewer unless the job prompt gives a smaller cap.',
      '- Redirect large command/API output to temp files and summarize IDs, counts, names, statuses, and next actions only.',
      '- Never paste raw integration, email, browser, tool, or other large JSON output into the conversation.',
      '- If context starts filling, stop with a concise partial summary and pending list instead of retrying broad reads.',
    ].join('\n'),
  };
}

export function diagnoseKnownFailurePattern(
  broken: BrokenJob,
  jobDef: string | null,
  recentRuns: string,
): Diagnosis | null {
  const haystack = [
    broken.jobName,
    broken.lastAdvisorOpinion ?? '',
    ...broken.lastErrors,
    recentRuns,
  ].join('\n').toLowerCase();

  if (/rapid_refill_breaker|autocompact.*thrash|context refilled|prompt is too long|prompt too long|context.?length|maximum context|input is too long/.test(haystack)) {
    const autoApply = jobDef ? promptOverrideForContextOverflow(broken.jobName) : undefined;
    return {
      rootCause: 'The job is overflowing the Claude context window. This is usually caused by broad file reads, full run-history reads, or raw integration output being pulled into the prompt.',
      confidence: 'high',
      proposedFix: {
        type: autoApply ? 'prompt_override' : 'prompt_change',
        details: 'Bound the job/diagnostic prompt: read tight chunks, cap batches at 20 records, summarize raw API output from temp files, and stop with a partial summary instead of retrying when context gets tight.',
        ...(autoApply ? { autoApply } : {}),
      },
      riskLevel: 'low',
      generatedAt: new Date().toISOString(),
    };
  }

  const maxTurns = haystack.match(/maximum number of turns\s*\(?(\d+)?\)?|max_turns/i);
  if (maxTurns) {
    const observed = Number(maxTurns[1]);
    const next = Number.isFinite(observed) && observed > 0 ? Math.min(90, Math.max(15, observed * 3)) : 30;
    return {
      rootCause: 'The job reached its turn cap before finishing.',
      confidence: 'high',
      proposedFix: {
        type: 'config_change',
        details: `Raise max_turns to ${next} only if the prompt already keeps tool output bounded. If output is large, add bounded-output guidance first.`,
        ...(jobDef ? {
          autoApply: {
            kind: 'cron',
            operations: [{ op: 'set', field: 'max_turns', value: next }],
          } satisfies AutoApplyCron,
        } : {}),
      },
      riskLevel: 'medium',
      generatedAt: new Date().toISOString(),
    };
  }

  if (/\b(401|403)\b|not authenticated|invalid api key|credential|please run \/login|does not have access/.test(haystack)) {
    return {
      rootCause: 'The latest failures look credential-related.',
      confidence: 'high',
      proposedFix: {
        type: 'credential_refresh',
        details: 'Refresh the affected integration credentials, then run a small probe before re-enabling full job volume.',
      },
      riskLevel: 'low',
      generatedAt: new Date().toISOString(),
    };
  }

  if (/no local bash|permission denied|blocked|task_blocked/.test(haystack)) {
    const autoApply: AutoApplyPromptOverride | undefined = jobDef ? {
      kind: 'prompt-override',
      scope: 'job',
      scopeKey: bareJobName(broken.jobName),
      content: 'Use only tools available to this agent. If local shell access is unavailable, report BLOCKED with the missing capability and do not retry the same unavailable tool.',
    } : undefined;
    return {
      rootCause: 'The job appears to be selecting a tool or capability that is unavailable in its current agent scope.',
      confidence: 'medium',
      proposedFix: {
        type: autoApply ? 'prompt_override' : 'agent_scope',
        details: 'Tighten the job prompt or agent scope so it only uses available tools, and make unavailable-tool failures stop instead of looping.',
        ...(autoApply ? { autoApply } : {}),
      },
      riskLevel: 'medium',
      generatedAt: new Date().toISOString(),
    };
  }

  return null;
}

function parseResponse(raw: string): Diagnosis | null {
  try {
    // The model sometimes wraps the JSON in markdown fences; extract the
    // first top-level {...} object.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<Diagnosis> & {
      proposedFix?: Partial<Diagnosis['proposedFix']> & {
        autoApply?: { agentSlug?: unknown; operations?: unknown };
      };
    };
    if (!parsed.rootCause || !parsed.proposedFix) return null;

    const autoApply = sanitizeAutoApply(parsed.proposedFix.autoApply);

    return {
      rootCause: String(parsed.rootCause).slice(0, 500),
      confidence: (parsed.confidence ?? 'medium') as Diagnosis['confidence'],
      proposedFix: {
        type: (parsed.proposedFix.type ?? 'escalate_to_owner') as Diagnosis['proposedFix']['type'],
        details: String(parsed.proposedFix.details ?? '').slice(0, 800),
        diff: parsed.proposedFix.diff ? String(parsed.proposedFix.diff).slice(0, 1000) : undefined,
        ...(autoApply ? { autoApply } : {}),
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
 * Strictly validate and filter autoApply. Dispatches on `kind` (default 'cron'
 * for back-compat). Returns null if validation fails for the chosen kind.
 */
function sanitizeAutoApply(raw: unknown): AutoApply | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { kind?: unknown };
  const kind = typeof obj.kind === 'string' ? obj.kind : 'cron';

  if (kind === 'cron') return sanitizeAutoApplyCron(obj);
  if (kind === 'advisor-rule') return sanitizeAutoApplyAdvisorRule(obj);
  if (kind === 'prompt-override') return sanitizeAutoApplyPromptOverride(obj);
  return null;
}

function sanitizeAutoApplyCron(raw: object): AutoApplyCron | null {
  const obj = raw as { agentSlug?: unknown; operations?: unknown };
  if (!Array.isArray(obj.operations)) return null;

  const operations: FixOperation[] = [];
  for (const op of obj.operations) {
    if (!op || typeof op !== 'object') continue;
    const r = op as { op?: unknown; field?: unknown; value?: unknown };
    if (typeof r.field !== 'string') continue;
    if (!EDITABLE_FIELDS.has(r.field)) continue;

    if (r.op === 'remove') {
      operations.push({ op: 'remove', field: r.field });
    } else if (r.op === 'set') {
      const v = r.value;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        operations.push({ op: 'set', field: r.field, value: v });
      }
    }
  }
  if (operations.length === 0) return null;

  const agentSlug = typeof obj.agentSlug === 'string' && /^[a-z0-9-]+$/i.test(obj.agentSlug)
    ? obj.agentSlug
    : undefined;
  return { kind: 'cron', operations, ...(agentSlug ? { agentSlug } : {}) };
}

function sanitizeAutoApplyAdvisorRule(raw: object): AutoApplyAdvisorRule | null {
  const obj = raw as { ruleId?: unknown; yamlContent?: unknown };
  if (typeof obj.ruleId !== 'string' || !obj.ruleId.trim()) return null;
  if (!/^[a-z0-9-]+$/.test(obj.ruleId)) return null; // safe filename
  if (typeof obj.yamlContent !== 'string' || !obj.yamlContent.trim()) return null;
  if (obj.yamlContent.length > 10_000) return null; // sanity bound
  return {
    kind: 'advisor-rule',
    ruleId: obj.ruleId,
    yamlContent: obj.yamlContent,
  };
}

function sanitizeAutoApplyPromptOverride(raw: object): AutoApplyPromptOverride | null {
  const obj = raw as { scope?: unknown; scopeKey?: unknown; content?: unknown };
  if (obj.scope !== 'global' && obj.scope !== 'agent' && obj.scope !== 'job') return null;
  if (typeof obj.content !== 'string' || !obj.content.trim()) return null;
  if (obj.content.length > 20_000) return null; // sanity bound

  if (obj.scope === 'global') {
    return { kind: 'prompt-override', scope: 'global', content: obj.content };
  }
  // agent or job — require scopeKey, validate as safe filename
  if (typeof obj.scopeKey !== 'string' || !obj.scopeKey) return null;
  if (!/^[a-zA-Z0-9_:-]+$/.test(obj.scopeKey)) return null;
  return {
    kind: 'prompt-override',
    scope: obj.scope,
    scopeKey: obj.scopeKey,
    content: obj.content,
  };
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

  const knownDiagnosis = diagnoseKnownFailurePattern(broken, jobDef, recentRuns);
  if (knownDiagnosis) {
    cache[broken.jobName] = knownDiagnosis;
    saveCache(cache);
    logger.info({
      job: broken.jobName,
      confidence: knownDiagnosis.confidence,
      fixType: knownDiagnosis.proposedFix.type,
    }, 'Broken-job diagnosis generated from known pattern');
    return knownDiagnosis;
  }

  const prompt = buildPrompt(broken, jobDef, agentProfile, recentRuns);

  let rawResponse: string;
  try {
    rawResponse = await gateway.handleCronJob(
      `diagnose:${broken.jobName}`,
      prompt,
      1,        // tier 1 — cheap
      5,        // maxTurns — diagnosis doesn't need tools typically
      'haiku',  // model — keep cost negligible
      undefined,
      'standard',
      undefined,
      undefined,
      undefined,
      undefined,
      { disableAllTools: true },
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
