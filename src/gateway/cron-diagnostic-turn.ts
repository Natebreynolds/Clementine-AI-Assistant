import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface CronDiagnosticRequest {
  jobName: string;
  wantsFix: boolean;
}

interface CronRunEntry {
  jobName?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  outputPreview?: string;
  terminalReason?: string;
  attempt?: number;
}

interface CronJobConfig {
  jobName: string;
  bareName: string;
  agentSlug?: string;
  scalarLines: string[];
}

const DIAGNOSTIC_RE = /\b(fix|repair|debug|diagnos(?:e|is|tic)?|what broke|why (?:did|is)|failed|failing|failure|broken|stuck|taking forever|too long|issue|problem)\b/i;

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function compactForMatch(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join('') ?? '';
}

function safeRunFileName(jobName: string): string {
  return jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function extractHyphenatedJobName(text: string): string | null {
  const match = text.match(/\b[a-z0-9]+(?:[-_:][a-z0-9]+){1,}\b/i);
  if (!match) return null;
  const candidate = match[0].replace(/_/g, '-');
  if (!candidate.includes('-') && !candidate.includes(':')) return null;
  return candidate;
}

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readCronEntriesFromFile(file: string, agentSlug?: string): CronJobConfig[] {
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf-8');
    const allLines = raw.split('\n');
    const entries: CronJobConfig[] = [];

    for (let start = 0; start < allLines.length; start++) {
      const line = allLines[start] ?? '';
      const match = line.match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
      if (!match) continue;

      const indent = match[1]!.length;
      const bareName = cleanYamlScalar(match[2]!);
      if (!bareName) continue;

      let end = allLines.length;
      for (let i = start + 1; i < allLines.length; i++) {
        const next = allLines[i] ?? '';
        const nextMatch = next.match(/^(\s*)-\s+name:\s+/);
        if (nextMatch && nextMatch[1]!.length === indent) {
          end = i;
          break;
        }
      }

      const scalarLines: string[] = [];
      for (const entryLine of allLines.slice(start, end)) {
        if (/^\s+prompt:\s*/.test(entryLine)) break;
        if (/^\s+(- name:|schedule:|enabled:|tier:|mode:|max_hours:|max_turns:|max_retries:|agentSlug:|work_dir:|model:|timeout_ms:|always_deliver:)/.test(entryLine)) {
          scalarLines.push(entryLine.trim());
        }
      }

      entries.push({
        jobName: agentSlug ? `${agentSlug}:${bareName}` : bareName,
        bareName,
        ...(agentSlug ? { agentSlug } : {}),
        scalarLines,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

function collectCronJobConfigs(baseDir: string): CronJobConfig[] {
  const configs = readCronEntriesFromFile(path.join(baseDir, 'vault', '00-System', 'CRON.md'));
  const agentsDir = path.join(baseDir, 'vault', '00-System', 'agents');
  if (!existsSync(agentsDir)) return configs;

  try {
    for (const slug of readdirSync(agentsDir)) {
      configs.push(...readCronEntriesFromFile(path.join(agentsDir, slug, 'CRON.md'), slug));
    }
  } catch {
    return configs;
  }

  return configs;
}

function configMatchesText(config: CronJobConfig, text: string): boolean {
  const compactText = compactForMatch(text);
  const compactBare = compactForMatch(config.bareName);
  const compactFull = compactForMatch(config.jobName);

  if (compactBare.length >= 5 && compactText.includes(compactBare)) return true;
  if (compactFull.length >= 5 && compactText.includes(compactFull)) return true;

  const normalized = normalizeText(text);
  const bare = config.bareName.toLowerCase();
  const full = config.jobName.toLowerCase();
  return normalized.includes(bare) || normalized.includes(full);
}

function resolveConfiguredJobName(text: string, baseDir: string): string | null {
  const matches = collectCronJobConfigs(baseDir)
    .filter((config) => configMatchesText(config, text))
    .sort((a, b) => compactForMatch(b.jobName).length - compactForMatch(a.jobName).length);
  return matches[0]?.jobName ?? null;
}

export function detectCronDiagnosticRequest(
  text: string,
  opts: { baseDir?: string } = {},
): CronDiagnosticRequest | null {
  const normalized = normalizeText(text);
  if (!DIAGNOSTIC_RE.test(normalized)) return null;

  const configuredJobName = opts.baseDir ? resolveConfiguredJobName(text, opts.baseDir) : null;
  if (configuredJobName) {
    return {
      jobName: configuredJobName,
      wantsFix: /\b(fix|repair)\b/i.test(normalized),
    };
  }

  const explicit = extractHyphenatedJobName(text);
  if (!explicit) return null;

  const hasCronContext = /\b(cron|job|task|run|runs|schedule|scheduled)\b/i.test(normalized);
  if (!hasCronContext) return null;

  return {
    jobName: explicit,
    wantsFix: /\b(fix|repair)\b/i.test(normalized),
  };
}

function readRecentRuns(baseDir: string, jobName: string, limit = 20): CronRunEntry[] {
  const file = path.join(baseDir, 'cron', 'runs', `${safeRunFileName(jobName)}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try { return JSON.parse(line) as CronRunEntry; } catch { return {}; }
      })
      .filter((entry) => Object.keys(entry).length > 0);
  } catch {
    return [];
  }
}

function summarizeDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown duration';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function oneLine(value: unknown, max = 220): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isContextThrashRun(run: CronRunEntry | undefined): boolean {
  if (!run) return false;
  const text = `${run.terminalReason ?? ''} ${run.error ?? ''} ${run.outputPreview ?? ''}`;
  return /rapid_refill_breaker|autocompact\s+is\s+thrashing|context\s+refilled\s+to\s+the\s+limit/i.test(text);
}

function isMaxTurnsRun(run: CronRunEntry | undefined): boolean {
  if (!run) return false;
  const text = `${run.terminalReason ?? ''} ${run.error ?? ''} ${run.outputPreview ?? ''}`;
  return /max_turns|maximum number of turns/i.test(text);
}

function readCronScalarConfig(baseDir: string, jobName: string): string[] {
  const bareName = jobName.includes(':') ? jobName.split(':').slice(1).join(':') : jobName;
  const config = collectCronJobConfigs(baseDir).find((entry) =>
    entry.jobName === jobName || entry.bareName === bareName);
  return config?.scalarLines ?? [];
}

export function buildCronDiagnosticResponse(
  text: string,
  opts: { baseDir: string } = { baseDir: process.env.CLEMENTINE_HOME || '' },
): string | null {
  const request = detectCronDiagnosticRequest(text, { baseDir: opts.baseDir });
  if (!request || !opts.baseDir) return null;

  const runs = readRecentRuns(opts.baseDir, request.jobName, 20);
  const latest = runs.at(-1);
  const previousSuccess = runs.slice(0, -1).reverse().find((run) => run.status === 'ok' && !isContextThrashRun(run));
  const config = readCronScalarConfig(opts.baseDir, request.jobName);

  const lines: string[] = [
    `I found ${request.jobName}. I am not running the job.`,
  ];

  if (!latest) {
    lines.push('I do not see a run history file for that job yet, so there is nothing concrete to repair from logs.');
    if (config.length > 0) lines.push(`Current config: ${config.join(' | ')}`);
    return lines.join('\n');
  }

  const latestLabel = [
    latest.startedAt ? `started ${latest.startedAt}` : 'latest run',
    latest.status ? `status ${latest.status}` : '',
    latest.terminalReason ? `terminal ${latest.terminalReason}` : '',
    summarizeDuration(latest.durationMs),
  ].filter(Boolean).join(', ');
  lines.push(`Latest run: ${latestLabel}.`);

  if (previousSuccess?.startedAt) {
    lines.push(`Last clean success I see: ${previousSuccess.startedAt} (${summarizeDuration(previousSuccess.durationMs)}).`);
  }

  if (config.length > 0) {
    lines.push(`Current config: ${config.join(' | ')}.`);
  }

  if (isContextThrashRun(latest)) {
    lines.push(
      'Root cause: context overflow/autocompact thrash, not a downstream integration failure unless the run error says so. The job or diagnostic path is letting broad file reads, run history, or raw tool output fill the context window.',
    );
    lines.push(
      'Safe fix: tighten the job prompt or add a job prompt override. Keep reads bounded, cap large record pulls to small batches, summarize raw JSON from temp files, and do not treat this as a max_turns-only fix for an unleashed job.',
    );
  } else if (isMaxTurnsRun(latest)) {
    lines.push(
      'Root cause: the job hit its turn cap before finishing. A max_turns bump can help only if the output is already bounded.',
    );
  } else if (latest.status === 'ok') {
    lines.push('The latest run is recorded as ok. I would not change the job unless the delivered result was wrong.');
  } else {
    const detail = oneLine(latest.error || latest.outputPreview);
    lines.push(`Root cause from latest run: ${detail || 'the run failed without a useful error preview.'}`);
  }

  if (request.wantsFix) {
    lines.push(
      'Next change should be a config/prompt repair, not a retry. I should return this diagnosis quickly and only apply a bounded prompt/config patch when asked.',
    );
  }

  return lines.join('\n');
}
