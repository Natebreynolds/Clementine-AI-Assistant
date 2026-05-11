export interface ComplexTaskRecommendation {
  score: number;
  reasons: string[];
  suggestedMaxMinutes: number;
  plan: string[];
  queueImmediately: boolean;
}

const SKILL_AUTHORING_RE = /\b(create|make|build|draft|write|teach|save|update)\b.{0,40}\b(skill|SKILL\.md)\b|\bskill[- ]creator\b/i;
const EXPLICIT_BACKGROUND_RE = /\b(background|deep mode|keep working|don't stop|dont stop|autonomous|long[- ]running|run overnight|take your time)\b/i;
const COMPLEX_WORK_RE = /\b(audit|research|analy[sz]e|review|scrape|crawl|extract|enrich|compile|compare|verify|cross[- ]check|triage|reconcile|draft|generate|update|sync|report back|write back)\b/i;
const BATCH_RE = /\b(all|every|each|bulk|batch|list of|contacts?|leads?|accounts?|tasks?|tickets?|records?|rows?|pages?|repos?|projects?)\b/i;
const SIDE_EFFECT_RE = /\b(update|write|create|draft|send|post|comment|reply|upload|append|sync|mark|close|move)\b/i;
const MULTI_STEP_RE = /\b(and then|then|after that|finally|from .* to |against .* and |across|compile .* into|check .* then)\b/i;

const SYSTEM_KEYWORDS = [
  'asana',
  'salesforce',
  'google sheet',
  'google sheets',
  'sheet',
  'sheets',
  'dataforseo',
  'hubspot',
  'notion',
  'github',
  'gmail',
  'outlook',
  'slack',
  'discord',
  'website',
  'websites',
  'crm',
  'spreadsheet',
  'csv',
  'airtable',
  'linear',
  'jira',
];

function countSystemMentions(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const keyword of SYSTEM_KEYWORDS) {
    if (lower.includes(keyword)) count++;
  }
  return count;
}

function estimatedMinutes(score: number, systemCount: number): number {
  if (score >= 8 || systemCount >= 4) return 90;
  if (score >= 6 || systemCount >= 3) return 60;
  return 30;
}

function buildPlan(text: string, systemCount: number): string[] {
  const lower = text.toLowerCase();
  const plan: string[] = [];
  plan.push('Confirm the exact scope, filters, and write/send permissions before making side-effecting changes.');
  if (systemCount > 0) {
    plan.push('Connect to the named systems with official MCP/API/CLI tools and use the narrowest reliable query.');
  } else {
    plan.push('Gather the source material with the available project, file, web, memory, or CLI tools.');
  }
  if (BATCH_RE.test(text)) {
    plan.push('Process records in batches, track counts, and keep skipped/error records separate.');
  }
  if (lower.includes('enrich') || lower.includes('dataforseo')) {
    plan.push('Enrich only qualified records and keep the signal used for each output row or draft.');
  }
  if (SIDE_EFFECT_RE.test(text)) {
    plan.push('Create drafts or updates first; only send or commit irreversible changes after explicit approval.');
  }
  plan.push('Return a concise final report with counts, changed locations, failures, and recommended next action.');
  return plan.slice(0, 6);
}

export function detectComplexTaskForBackground(text: string): ComplexTaskRecommendation | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (SKILL_AUTHORING_RE.test(trimmed)) return null;

  const systemCount = countSystemMentions(trimmed);
  const reasons: string[] = [];
  let score = 0;

  if (EXPLICIT_BACKGROUND_RE.test(trimmed)) {
    score += 4;
    reasons.push('explicit background/deep-work wording');
  }
  if (COMPLEX_WORK_RE.test(trimmed)) {
    score += 2;
    reasons.push('multi-step work verb');
  }
  if (BATCH_RE.test(trimmed)) {
    score += 2;
    reasons.push('batch or many-record scope');
  }
  if (SIDE_EFFECT_RE.test(trimmed)) {
    score += 1;
    reasons.push('write/draft/update side effects');
  }
  if (MULTI_STEP_RE.test(trimmed)) {
    score += 1;
    reasons.push('multi-step sequencing');
  }
  if (systemCount >= 2) {
    score += Math.min(4, systemCount);
    reasons.push(`${systemCount} named systems or data surfaces`);
  }
  if (trimmed.length > 450) {
    score += 1;
    reasons.push('long detailed request');
  }

  const queueImmediately = EXPLICIT_BACKGROUND_RE.test(trimmed) && score >= 5;
  const shouldOffer = queueImmediately || score >= 5 || (systemCount >= 2 && (BATCH_RE.test(trimmed) || SIDE_EFFECT_RE.test(trimmed)));
  if (!shouldOffer) return null;

  return {
    score,
    reasons,
    suggestedMaxMinutes: estimatedMinutes(score, systemCount),
    plan: buildPlan(trimmed, systemCount),
    queueImmediately,
  };
}
