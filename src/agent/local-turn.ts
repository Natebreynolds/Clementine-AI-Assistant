import type { ClementineJson } from '../config/clementine-json.js';
import { isStandaloneGreeting } from './turn-policy.js';
import { normalizeToolsetName, type ToolsetName } from './toolsets.js';

export type ProactivityMode = 'quiet' | 'balanced' | 'proactive' | 'operator';
export type ResponseStyle = 'concise' | 'balanced' | 'detailed';
export type ProgressVisibility = 'quiet' | 'normal' | 'detailed';
export type AutonomyMode = 'ask_first' | 'balanced' | 'act_when_safe';

export interface AssistantExperienceUpdate {
  proactivity?: ProactivityMode;
  responseStyle?: ResponseStyle;
  progressVisibility?: ProgressVisibility;
  autonomy?: AutonomyMode;
}

export type LocalTurnIntent =
  | { kind: 'none' }
  | { kind: 'ack' }
  | { kind: 'greeting' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'last_action' }
  | { kind: 'compress_context' }
  | { kind: 'debug_status' }
  | { kind: 'toolset'; toolset: ToolsetName }
  | { kind: 'preference_update'; updates: AssistantExperienceUpdate; summary: string };

export type ApprovalReply = true | false | 'always' | null;

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function isStopRequest(text: string): boolean {
  const n = normalize(text);
  if (/\bbg-[a-z0-9]+-[a-f0-9]{6}\b/i.test(n) && /^(stop|cancel|abort)\b/.test(n)) return true;
  if (wordCount(n) > 5) return false;
  return /^(stop|cancel|abort|halt|pause|nevermind|never mind|wait stop|stop please|cancel that|stop that|cancel it|stop it|cancel task|stop task|cancel the task|stop the task|cancel background|stop background)$/.test(n);
}

export function isStatusRequest(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 12) return false;
  if (/\bbg-[a-z0-9]+-[a-f0-9]{6}\b/i.test(n) && /\b(status|progress|check|update|running|done|finished)\b/.test(n)) {
    return true;
  }
  return /^(status|task status|deep status|progress|progress update|what'?s happening|what'?s going on|what are you doing|what are you working on|what are you running|are you working|anything running|what'?s runnin?g?(?: now| right now)?|what is runnin?g?(?: now| right now)?|background status|check status|where are we|any update|any updates|can i get an update|do you have an update|update me|is it done|is it done yet|is it finished|is it finished yet|done yet|did it finish|still running|is it still running|are we done|how'?s (?:it|that|this|the task|the job|the run|the background task) (?:coming along|progressing)|how is (?:it|that|this|the task|the job|the run|the background task) (?:coming along|progressing)|how'?s (?:the task|the job|the run|the background task) going|how is (?:the task|the job|the run|the background task) going)$/.test(n);
}

export function isLastActionRequest(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 10) return false;
  return /^(last action|last turn|what happened last turn|what did you do|did you do it|did that actually run|did you actually do it|why didn'?t you do it|why did that not run|what happened)$/.test(n);
}

export function isCompressContextRequest(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 8) return false;
  return /^(compress context|compact context|compress session|compact session|context compact|context compress|save and reset context|reset context but keep memory)$/.test(n);
}

export function isDebugStatusRequest(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 6) return false;
  return /^(debug|debug status|session debug|agent debug|diagnostics|show diagnostics)$/.test(n);
}

function parseToolsetRequest(text: string): ToolsetName | null {
  const n = normalize(text);
  const match = n.match(/^(?:set |switch |use |enable )?(?:toolset|tool set|tools mode|tool mode)(?: to|:)? ([a-z _-]+)$/)
    ?? n.match(/^toolset ([a-z _-]+)$/);
  return match ? normalizeToolsetName(match[1]) : null;
}

export function isTinyAcknowledgment(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 4) return false;
  return /^(thanks|thank you|thx|ty|nice|great|perfect|awesome|cool|ok|okay|sounds good|got it|makes sense|love it)$/.test(n);
}

export function detectApprovalReply(text: string): ApprovalReply {
  const n = normalize(text);
  if (wordCount(n) > 4) return null;
  if (/^(always)$/.test(n)) return 'always';
  if (/^(no|nope|deny|denied|skip)$/.test(n)) return false;
  if (/^(yes|y|yep|yeah|ok|okay|approve|approved|go|go ahead|do it|send it|perfect|sounds good|looks good|lgtm)$/.test(n)) {
    return true;
  }
  return null;
}

export function looksLikeApprovalPrompt(text: string): boolean {
  const n = normalize(text);
  return /\b(good to go|okay to send|ok to send|ready to send|should i send|want me to send|approve|confirm|fire it off)\b/.test(n)
    || /\b(send|email|message|post|publish|delete|change|update|run|execute)\b[\s\S]{0,120}\?$/i.test(text.trim());
}

function parseProactivity(text: string): ProactivityMode | undefined {
  if (/\b(operator mode|operator)\b/i.test(text)) return 'operator';
  if (/\b(more proactive|be proactive|proactive mode|set proactivity to proactive)\b/i.test(text)) return 'proactive';
  if (/\b(less proactive|quieter|quiet mode|be quiet|only urgent|do not interrupt)\b/i.test(text)) return 'quiet';
  if (/\b(balanced proactivity|balanced mode|normal proactivity)\b/i.test(text)) return 'balanced';
  return undefined;
}

function parseResponseStyle(text: string): ResponseStyle | undefined {
  if (/\b(be concise|keep it concise|shorter replies|brief replies|reply briefly|less verbose)\b/i.test(text)) return 'concise';
  if (/\b(more detail|detailed replies|be detailed|explain more|more verbose)\b/i.test(text)) return 'detailed';
  if (/\b(balanced replies|normal replies|balanced detail)\b/i.test(text)) return 'balanced';
  return undefined;
}

function parseProgressVisibility(text: string): ProgressVisibility | undefined {
  if (/\b(show more progress|keep me posted|more updates|detailed progress|tell me what'?s happening)\b/i.test(text)) return 'detailed';
  if (/\b(less progress|fewer updates|quiet progress|don'?t narrate)\b/i.test(text)) return 'quiet';
  if (/\b(normal progress|balanced progress)\b/i.test(text)) return 'normal';
  return undefined;
}

function parseAutonomy(text: string): AutonomyMode | undefined {
  if (/\b(ask first|ask me first|ask before acting|do not act without asking)\b/i.test(text)) return 'ask_first';
  if (/\b(act when safe|more autonomous|use your judgment|handle it when safe)\b/i.test(text)) return 'act_when_safe';
  if (/\b(balanced autonomy|normal autonomy)\b/i.test(text)) return 'balanced';
  return undefined;
}

export function detectLocalTurn(text: string): LocalTurnIntent {
  if (isStopRequest(text)) return { kind: 'stop' };
  if (isStatusRequest(text)) return { kind: 'status' };
  if (isLastActionRequest(text)) return { kind: 'last_action' };
  if (isCompressContextRequest(text)) return { kind: 'compress_context' };
  if (isDebugStatusRequest(text)) return { kind: 'debug_status' };
  const toolset = parseToolsetRequest(text);
  if (toolset) return { kind: 'toolset', toolset };
  if (isStandaloneGreeting(text)) return { kind: 'greeting' };
  if (isTinyAcknowledgment(text)) return { kind: 'ack' };

  const updates: AssistantExperienceUpdate = {};
  const proactivity = parseProactivity(text);
  const responseStyle = parseResponseStyle(text);
  const progressVisibility = parseProgressVisibility(text);
  const autonomy = parseAutonomy(text);
  if (proactivity) updates.proactivity = proactivity;
  if (responseStyle) updates.responseStyle = responseStyle;
  if (progressVisibility) updates.progressVisibility = progressVisibility;
  if (autonomy) updates.autonomy = autonomy;

  const entries = Object.entries(updates);
  if (entries.length === 0) return { kind: 'none' };
  const summary = entries.map(([k, v]) => `${k}: ${v}`).join(', ');
  return { kind: 'preference_update', updates, summary };
}

export function applyAssistantExperienceUpdate(
  cfg: ClementineJson,
  updates: AssistantExperienceUpdate,
): ClementineJson {
  return {
    ...cfg,
    schemaVersion: 1,
    assistant: {
      ...(cfg.assistant ?? {}),
      ...updates,
    },
  };
}
