/**
 * Memory extraction event bus — 1.18.127.
 *
 * Lets the dashboard surface "📝 Noted: <fact>" toasts when the
 * background auto-extraction Haiku writes to MEMORY.md / user_model
 * after a chat exchange. Today extraction is fully silent: the user
 * sees nothing happen, even though the agent may have just learned
 * something important.
 *
 * Pattern: a single module-level listener slot. Dashboard registers
 * one callback at startup; assistant.ts emits when an extraction tool
 * call lands. Zero ordering guarantees, zero retention — fire-and-
 * forget, just like the extraction itself.
 *
 * Why not EventEmitter: a single listener is enough today and a class
 * import would be dead weight. Trivially upgrade-able if we ever need
 * a fan-out.
 */

export interface MemoryExtractionEvent {
  /** Source session that produced the extraction (e.g. "discord:dm:owner",
   *  "dashboard:web", "cron:morning-briefing"). */
  sessionKey: string;
  /** The MCP tool the extractor called — memory_write, note_create,
   *  task_add, note_take, user_model. */
  toolName: string;
  /** A short human-readable summary of what was learned. Built from the
   *  tool input by the emitter — typically the `content` or `text` field
   *  truncated to ~120 chars. Empty string when the input shape is unknown. */
  summary: string;
  /** Active hired-agent slug, when applicable. null = Clementine herself. */
  agentSlug: string | null;
  /** ISO timestamp of when the extraction landed. */
  at: string;
}

type Listener = (event: MemoryExtractionEvent) => void;

let listener: Listener | null = null;

/** Register the dashboard's SSE broadcaster. Calling again replaces the
 *  previous listener (one-shot slot). Pass `null` to clear. */
export function setMemoryExtractionListener(fn: Listener | null): void {
  listener = fn;
}

/** Emit an extraction event. Errors thrown by the listener are
 *  swallowed — visibility must never block the actual write. */
export function emitMemoryExtraction(event: MemoryExtractionEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    /* never throw out of the extraction path */
  }
}

/**
 * Pull a short, user-facing summary out of an MCP tool input payload.
 * Each tool stores its content in a different key, so we look at the
 * usual suspects in priority order and truncate.
 */
export function summarizeExtractionInput(toolInput: Record<string, unknown>): string {
  const candidates = ['content', 'text', 'fact', 'value', 'note', 'message', 'task'];
  for (const key of candidates) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.trim()) {
      return v.trim().length > 120 ? v.trim().slice(0, 120) + '…' : v.trim();
    }
  }
  return '';
}
