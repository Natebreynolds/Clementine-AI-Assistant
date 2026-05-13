/**
 * Durable-work detector.
 *
 * Chat should stay live for normal multi-step work, but truly batch-heavy
 * jobs should not require the owner to know the magic phrase "run this in the
 * background." If the request clearly implies a long first pass — e.g. 100
 * businesses, multiple external systems, research/enrichment plus sheet/email
 * side effects — queue a durable background task immediately. Small project
 * builds and single targeted actions still run in chat.
 */
export interface ComplexTaskRecommendation {
  reasons: string[];
  suggestedMaxMinutes: number;
  plan: string[];
  /** Always true when this function returns a recommendation — the only
   *  trigger is the user explicitly asking for background execution. Kept
   *  on the type for back-compat with the post-overflow rescue path. */
  queueImmediately: true;
}

// Skill authoring is an interactive build-with-the-user flow; never auto-queue.
const SKILL_AUTHORING_RE = /\b(create|make|build|draft|write|teach|save|update)\b.{0,40}\b(skill|SKILL\.md)\b|\bskill[- ]creator\b/i;

const EXPLICIT_BACKGROUND_RE = /\b(background|deep mode|keep working|don't stop|dont stop|autonomous|long[- ]running|run overnight|overnight|take your time)\b/i;

const BATCH_RE = /\b(all|every|each|bulk|batch|list of|contacts?|leads?|accounts?|tasks?|tickets?|records?|rows?|pages?|repos?|projects?|firms?|metros?|prospects?|businesses|companies|domains?|websites?|sites?)\b/i;
const SIDE_EFFECT_RE = /\b(update|write|create|draft|send|post|comment|reply|upload|append|sync|mark|close|move|deploy|host|publish|put|drop|add)\b/i;
const RESEARCH_RE = /\b(research|enrich|find|compile|collect|gather|analy[sz]e|review|audit|check|scrape|crawl|look ?up|source|qualify|rank|score)\b/i;
const MULTI_STEP_RE = /\b(then|after that|when (?:that|all) is done|once (?:that|all) is done|finally|and then)\b/i;
const LARGE_BATCH_ITEM_RE = /\b(\d{2,4})\s+(businesses|companies|firms|contacts|leads|prospects|accounts|domains|websites|sites|pages|records|rows|tasks|tickets|repos|projects)\b/i;
const VAGUE_LARGE_BATCH_RE = /\b(hundreds?|dozens?|all|every|each)\b.{0,80}\b(businesses|companies|firms|contacts|leads|prospects|accounts|domains|websites|sites|pages|records|rows|tasks|tickets|repos|projects)\b/i;

// Above this many named items in one request we treat the work as durable and
// route it to background even without an explicit "run this in background"
// phrase. TODO(autonomy-profile): replace with profile.minBatchItems once the
// AutonomyProfile knob lands (Commit 4 in the orchestrator-first sequence).
const DURABLE_BATCH_THRESHOLD = 25;

const SYSTEM_GROUPS: Array<{ id: string; patterns: RegExp[] }> = [
  { id: 'asana', patterns: [/\basana\b/i] },
  { id: 'salesforce', patterns: [/\bsalesforce\b/i] },
  { id: 'google_sheets', patterns: [/\bgoogle sheets?\b/i, /\bspreadsheet\b/i, /\bsheets?\b/i] },
  { id: 'dataforseo', patterns: [/\bdataforseo\b/i] },
  { id: 'hubspot', patterns: [/\bhubspot\b/i] },
  { id: 'notion', patterns: [/\bnotion\b/i] },
  { id: 'github', patterns: [/\bgithub\b/i, /\bpull requests?\b/i, /\bprs?\b/i] },
  { id: 'gmail', patterns: [/\bgmail\b/i, /\bgoogle mail\b/i] },
  { id: 'outlook', patterns: [/\boutlook\b/i, /\bmicrosoft 365\b/i, /\bm365\b/i, /\boffice 365\b/i] },
  { id: 'slack', patterns: [/\bslack\b/i] },
  { id: 'discord', patterns: [/\bdiscord\b/i] },
  { id: 'web', patterns: [/\bwebsites?\b/i, /\bweb pages?\b/i, /\burls?\b/i] },
  { id: 'crm', patterns: [/\bcrm\b/i] },
  { id: 'csv', patterns: [/\bcsv\b/i] },
  { id: 'hosting', patterns: [/\bnetlify\b/i, /\bvercel\b/i, /\bhostinger\b/i] },
  { id: 'airtable', patterns: [/\bairtable\b/i] },
  { id: 'linear', patterns: [/\blinear\b/i] },
  { id: 'jira', patterns: [/\bjira\b/i] },
];

function countSystemMentions(text: string): number {
  return matchedSystemIds(text).length;
}

function matchedSystemIds(text: string): string[] {
  return SYSTEM_GROUPS
    .filter(group => group.patterns.some(pattern => pattern.test(text)))
    .map(group => group.id);
}

function durableBatchCount(text: string): number | null {
  const match = LARGE_BATCH_ITEM_RE.exec(text);
  if (match) return Number(match[1]);
  return null;
}

function estimatedMinutes(systemCount: number, textLength: number, batchCount: number | null): number {
  if ((batchCount ?? 0) >= 100 || systemCount >= 4 || textLength > 800) return 90;
  if ((batchCount ?? 0) >= 50 || systemCount >= 2 || textLength > 400) return 60;
  return 30;
}

function buildPlan(text: string, systemCount: number): string[] {
  const lower = text.toLowerCase();
  const plan: string[] = [];
  plan.push('Run a discovery preflight: resolve active project/folders, relevant skills, active tool connections, and missing inputs before the first heavy pass.');
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
  const batchCount = durableBatchCount(trimmed);
  const hasBatch = BATCH_RE.test(trimmed) || VAGUE_LARGE_BATCH_RE.test(trimmed) || (batchCount ?? 0) >= DURABLE_BATCH_THRESHOLD;
  const hasResearch = RESEARCH_RE.test(trimmed);
  const hasSideEffect = SIDE_EFFECT_RE.test(trimmed);
  const hasMultiStep = MULTI_STEP_RE.test(trimmed);
  const explicitBackground = EXPLICIT_BACKGROUND_RE.test(trimmed);

  const inferredDurable =
    ((batchCount ?? 0) >= DURABLE_BATCH_THRESHOLD && (hasResearch || hasSideEffect || systemCount >= 1))
    || (VAGUE_LARGE_BATCH_RE.test(trimmed) && (hasResearch || hasSideEffect || systemCount >= 1))
    || (hasBatch && systemCount >= 2 && (hasResearch || hasSideEffect || hasMultiStep))
    || (systemCount >= 3 && hasResearch && hasSideEffect && hasMultiStep);

  if (!explicitBackground && !inferredDurable) return null;

  const reasons: string[] = [];
  if (explicitBackground) reasons.push('explicit background/deep-work wording');
  if (batchCount !== null && batchCount >= DURABLE_BATCH_THRESHOLD) reasons.push(`large batch (${batchCount} items)`);
  if (VAGUE_LARGE_BATCH_RE.test(trimmed) && batchCount === null) reasons.push('large or open-ended batch');
  if (systemCount >= 2) reasons.push(`${systemCount} named systems`);
  if (hasResearch && hasSideEffect) reasons.push('research/enrichment plus write or draft side effects');
  if (reasons.length === 0) reasons.push('durable multi-step workflow');

  return {
    reasons,
    suggestedMaxMinutes: estimatedMinutes(systemCount, trimmed.length, batchCount),
    plan: buildPlan(trimmed, systemCount),
    queueImmediately: true,
  };
}
