/**
 * Deterministic learning hooks for explicit user corrections.
 *
 * The LLM auto-memory extractor still handles broad extraction, but short
 * correction turns often skip that path as "too short." This catches the
 * high-signal behavioral feedback that should affect Clementine immediately.
 */

export interface ConversationCorrection {
  correction: string;
  category: 'verbosity' | 'tone' | 'workflow' | 'format' | 'accuracy' | 'proactivity' | 'scope';
  strength: 'explicit' | 'implicit';
}

export interface ConversationLearningSignal {
  corrections: ConversationCorrection[];
  preferences: string[];
  frictionSignals: string[];
}

interface MemoryLearningStore {
  getUserModelBlock?: (slot: string, agentSlug?: string | null) => { content: string } | null;
  appendUserModelBlock?: (opts: { slot: string; content: string; agentSlug?: string | null }) => unknown;
  logFeedback?: (feedback: {
    sessionKey?: string;
    channel: string;
    messageSnippet?: string;
    rating: 'positive' | 'negative' | 'mixed';
    comment?: string;
  }) => void;
  saveSessionReflection?: (reflection: {
    sessionKey: string;
    exchangeCount: number;
    frictionSignals: string[];
    qualityScore: number;
    behavioralCorrections: ConversationCorrection[];
    preferencesLearned: Array<{ preference: string; confidence: string }>;
    agentSlug?: string;
  }) => void;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function pushUnique<T extends { correction: string }>(items: T[], item: T): void {
  const key = normalize(item.correction);
  if (!items.some((existing) => normalize(existing.correction) === key)) items.push(item);
}

export function detectConversationLearning(text: string): ConversationLearningSignal | null {
  const corrections: ConversationCorrection[] = [];
  const preferences: string[] = [];
  const frictionSignals: string[] = [];
  const lower = normalize(text);

  if (/\b(no band.?aid|bandaid|band aid|entire global repo|global repo|root cause)\b/i.test(text)) {
    pushUnique(corrections, {
      correction: 'Prefer root-cause, repo-wide fixes over narrow symptom patches; call out temporary mitigations explicitly.',
      category: 'workflow',
      strength: 'explicit',
    });
    preferences.push('Nate prefers root-cause, repo-wide fixes over bandaid patches.');
  }

  if (/\b(chatbot|amateur|all knowing|ever evolving|memory retrieval|remember|remind(?:er|ing)?|should have known|should have context|proactive)\b/i.test(text)) {
    pushUnique(corrections, {
      correction: 'Use chat history, session memory, logs, and operational state proactively before asking the user to repeat context.',
      category: 'proactivity',
      strength: lower.includes('should') || lower.includes('proactive') ? 'explicit' : 'implicit',
    });
    preferences.push('Nate expects Clementine to proactively retrieve relevant chat history and session memory.');
  }

  if (/\b(useless information|immediate replies|stale status|heartbeat|already logged|already shown|not helpful)\b/i.test(text)) {
    pushUnique(corrections, {
      correction: 'Do not lead casual replies with stale heartbeat, cron, or background-task status; surface operational details only when requested or newly urgent.',
      category: 'verbosity',
      strength: 'explicit',
    });
    preferences.push('Nate prefers lightweight casual replies unless he asks for status or a fix.');
  }

  if (/\b(had to remind|last couple turns|kept reminding|repeat myself|shouldn.t have to)\b/i.test(text)) {
    frictionSignals.push('user had to repeat context across turns');
  }
  if (/\b(chatbot|amateur|not helpful|useless information)\b/i.test(text)) {
    frictionSignals.push('user found the reply style low-quality or noisy');
  }
  if (/\b(no band.?aid|bandaid|band aid)\b/i.test(text)) {
    frictionSignals.push('user objected to a bandaid fix');
  }

  if (corrections.length === 0 && preferences.length === 0 && frictionSignals.length === 0) return null;
  return {
    corrections,
    preferences: [...new Set(preferences)],
    frictionSignals: [...new Set(frictionSignals)],
  };
}

function userModelContains(store: MemoryLearningStore, content: string): boolean {
  try {
    const existing = store.getUserModelBlock?.('user_facts', null)?.content ?? '';
    return normalize(existing).includes(normalize(content).slice(0, 120));
  } catch {
    return false;
  }
}

export function persistConversationLearning(
  sessionKey: string,
  userText: string,
  store: MemoryLearningStore | null | undefined,
): ConversationLearningSignal | null {
  const signal = detectConversationLearning(userText);
  if (!signal || !store) return signal;

  try {
    store.saveSessionReflection?.({
      sessionKey,
      exchangeCount: 1,
      frictionSignals: signal.frictionSignals,
      qualityScore: signal.frictionSignals.length > 0 ? 2 : 3,
      behavioralCorrections: signal.corrections,
      preferencesLearned: signal.preferences.map((preference) => ({ preference, confidence: 'high' })),
    });
  } catch { /* learning is best-effort */ }

  for (const correction of signal.corrections) {
    try {
      store.logFeedback?.({
        sessionKey,
        channel: 'behavioral-correction',
        messageSnippet: userText.slice(0, 500),
        rating: 'negative',
        comment: `[${correction.category}] ${correction.correction} (${correction.strength})`,
      });
    } catch { /* telemetry only */ }
  }

  for (const preference of signal.preferences) {
    try {
      const line = `- Assistant behavior preference (${new Date().toISOString()}): ${preference}`;
      if (!userModelContains(store, preference)) {
        store.appendUserModelBlock?.({ slot: 'user_facts', content: line });
      }
      store.logFeedback?.({
        sessionKey,
        channel: 'preference-learned',
        messageSnippet: userText.slice(0, 500),
        rating: 'positive',
        comment: `[high] ${preference}`,
      });
    } catch { /* user model write is best-effort */ }
  }

  return signal;
}

