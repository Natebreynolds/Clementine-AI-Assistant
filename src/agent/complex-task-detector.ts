/**
 * Explicit background-intent detector.
 *
 * Returns a recommendation ONLY when the user explicitly asks for background
 * / autonomous / overnight execution. We deliberately do not classify "this
 * looks complex" anymore — chat now stays in the live SDK loop, with
 * automatic compaction and inline subagent delegation (Agent → planner /
 * researcher / etc.) for context isolation, just like Claude Code itself.
 * Big work that genuinely blows past the SDK's auto-compact is caught by the
 * gateway's overflow → retry → promote-to-background fallback, which is the
 * *real* escape hatch instead of a regex pre-classifier.
 *
 * The narrow detection here is what lets a user say "go research this
 * overnight" and have it actually queue as a durable background task.
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

// The ONLY trigger. Matches "in the background", "overnight", "keep working",
// "don't stop", "autonomous", "long-running", "take your time", "deep mode".
const EXPLICIT_BACKGROUND_RE = /\b(background|deep mode|keep working|don't stop|dont stop|autonomous|long[- ]running|run overnight|overnight|take your time)\b/i;

// Light scope hints used only for the duration estimate + plan text. None of
// these alter whether the function fires — they shape the recommendation
// once the explicit-intent gate has already opened.
const BATCH_RE = /\b(all|every|each|bulk|batch|list of|contacts?|leads?|accounts?|tasks?|tickets?|records?|rows?|pages?|repos?|projects?|firms?|metros?|prospects?)\b/i;
const SIDE_EFFECT_RE = /\b(update|write|create|draft|send|post|comment|reply|upload|append|sync|mark|close|move|deploy|host|publish)\b/i;

const SYSTEM_KEYWORDS = [
  'asana', 'salesforce', 'google sheet', 'google sheets', 'sheet', 'sheets',
  'dataforseo', 'hubspot', 'notion', 'github', 'gmail', 'outlook', 'slack',
  'discord', 'website', 'websites', 'crm', 'spreadsheet', 'csv', 'netlify',
  'vercel', 'airtable', 'linear', 'jira',
];

function countSystemMentions(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const keyword of SYSTEM_KEYWORDS) {
    if (lower.includes(keyword)) count++;
  }
  return count;
}

function estimatedMinutes(systemCount: number, textLength: number): number {
  if (systemCount >= 4 || textLength > 800) return 90;
  if (systemCount >= 2 || textLength > 400) return 60;
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
  if (!EXPLICIT_BACKGROUND_RE.test(trimmed)) return null;

  const systemCount = countSystemMentions(trimmed);
  const reasons: string[] = ['explicit background/deep-work wording'];
  if (systemCount >= 2) reasons.push(`${systemCount} named systems`);

  return {
    reasons,
    suggestedMaxMinutes: estimatedMinutes(systemCount, trimmed.length),
    plan: buildPlan(trimmed, systemCount),
    queueImmediately: true,
  };
}
