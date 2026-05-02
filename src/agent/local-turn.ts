import type { ClementineJson } from '../config/clementine-json.js';
import { isStandaloneGreeting } from './turn-policy.js';

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
  | { kind: 'preference_update'; updates: AssistantExperienceUpdate; summary: string };

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function isStopRequest(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 5) return false;
  return /^(stop|cancel|abort|halt|pause|nevermind|never mind|wait stop|stop please|cancel that|stop that)$/.test(n);
}

export function isStatusRequest(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 8) return false;
  return /^(status|task status|deep status|progress|what'?s happening|what'?s going on|what are you doing|are you working|anything running|what'?s running|background status|check status|where are we)$/.test(n);
}

export function isTinyAcknowledgment(text: string): boolean {
  const n = normalize(text);
  if (wordCount(n) > 4) return false;
  return /^(thanks|thank you|thx|ty|nice|great|perfect|awesome|cool|ok|okay|sounds good|got it|makes sense|love it)$/.test(n);
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
