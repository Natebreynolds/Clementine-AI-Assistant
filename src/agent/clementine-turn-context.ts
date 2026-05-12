/**
 * clementine-turn-context — the volatile per-turn context block that
 * reconstitutes Clementine's live awareness on every chat turn.
 *
 * Why this exists (1.18.184)
 * ──────────────────────────
 * The modern chat path's system prompt is the SDK's `claude_code`
 * preset + `buildChatSystemAppend()` (run-agent-context.ts). That gives
 * Clementine her identity (SOUL) and her hand-curated long-term memory
 * (MEMORY.md), but it is STATIC across turns by design — anything that
 * varies per turn must NOT live there or it would invalidate the
 * Anthropic prompt cache.
 *
 * Anything volatile — what's true right now, what just happened, what
 * the SQLite memory store has relevant to the current message — lives
 * here, in a block prepended to the user's message. The SDK treats
 * that as turn input, not as system prompt, so it doesn't break cache
 * and it gives the model fresh context every turn.
 *
 * What we put in the block
 * ────────────────────────
 * 1. Retrieved memory hits from the SQLite store (semantic + FTS),
 *    scored against the user's current message. The single highest-
 *    leverage section — this is how persistent memory of EVERYTHING
 *    actually reaches the model.
 * 2. Recent background-task headlines (last 24h, terminal status only)
 *    so the model knows what work just completed without re-asking.
 * 3. Live state — current date/time + channel/identity framing.
 * 4. Extension points for the deeper learning subsystems (decision-
 *    reflection, skill-quality, insight-engine, seed-user-model,
 *    goal-evaluator) — each one is a labeled section that returns
 *    empty today and can be wired in a follow-up ship without
 *    re-architecting.
 *
 * Hard cap on total block size — see MAX_BLOCK_CHARS. Anthropic's prompt
 * cache benefit dies if the volatile block is larger than the cacheable
 * prefix, so keep this tight.
 *
 * Aligned with Anthropic SDK best practices: per-turn dynamic context
 * in the USER message, NOT in the system prompt. See the SDK reference
 * note on prompt caching boundaries.
 */

import pino from 'pino';
import type { BackgroundTask } from '../types.js';

const logger = pino({ name: 'clementine.turn-context' });

// ── Tunables ──────────────────────────────────────────────────────────

/** Hard cap on the entire block. Keep volatile content small so the
 *  cacheable prefix stays larger than the dynamic delta. */
const MAX_BLOCK_CHARS = 4_000;

/** Per-section caps so any one section can't crowd out the others. */
const MAX_MEMORY_HITS = 6;
const MAX_MEMORY_HIT_CHARS = 320;
const MAX_BG_TASKS = 3;
const MAX_BG_TASK_LINE_CHARS = 200;
const RECENT_BG_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Shapes ────────────────────────────────────────────────────────────

export interface BuildTurnContextOptions {
  /** The user's current message — used as the query for retrieved memory. */
  userMessage: string;
  /** Session key for the active chat. Used for log breadcrumbs and to
   *  scope future per-session reads (currently unused; searchContext
   *  is intentionally cross-session for single-owner installs). */
  sessionKey: string;
  /** Where the user is reaching Clementine from. Surfaces in the
   *  identity framing block. Examples: "discord-dm", "dashboard",
   *  "slack-channel", "chat". */
  channel?: string;
  /** Owner-facing name (display name, not slug). When set, used in
   *  the identity framing block. */
  ownerName?: string | null;
  /** Active hired-agent profile if running as one. Affects the
   *  identity framing — "you are talking to Sasha right now," not
   *  "you are Clementine". */
  profileName?: string | null;
  /** Read-only memory store handle. When absent, retrieved-memory
   *  section is skipped — the rest still renders. */
  memoryStore?: {
    searchContext?: (
      query: string,
      opts?: { limit?: number },
    ) => Array<{ source_file?: string; section?: string; content: string; score?: number }>;
  } | null;
  /** Optional override: synchronous read of recent terminal-state bg
   *  tasks. Defaults to a one-time module-cached listBackgroundTasks
   *  import (lazy, since not all callers have one). */
  listBackgroundTasks?: (
    filter: { status?: BackgroundTask['status'] },
  ) => BackgroundTask[];
  /** Clock injection for tests. Defaults to Date.now(). */
  now?: () => number;
}

export interface BuildTurnContextResult {
  /** The full ready-to-prepend context block, INCLUDING outer
   *  `[Context...]\n...\n[/Context]\n\n` fence. Empty string when no
   *  sections produced output (e.g., builder sessions or completely
   *  empty stores) — caller can treat empty as "no prefix needed". */
  block: string;
  /** Telemetry — which sections contributed, for the dashboard
   *  "what Clementine sees this turn" panel. */
  sections: {
    retrievedMemory: number;
    recentBgTasks: number;
    liveState: boolean;
    identityFrame: boolean;
  };
  /** Final character count of the block. Useful for logging + the
   *  Anthropic prompt-cache-health analysis. */
  totalChars: number;
}

// ── The builder ───────────────────────────────────────────────────────

export function buildClementineTurnContext(
  opts: BuildTurnContextOptions,
): BuildTurnContextResult {
  const sections = {
    retrievedMemory: 0,
    recentBgTasks: 0,
    liveState: false,
    identityFrame: false,
  };

  const parts: string[] = [];
  const nowMs = (opts.now ?? Date.now)();
  const nowDate = new Date(nowMs);

  // ── 1. Retrieved memory hits ──────────────────────────────────────
  // The single most important section. Pulls the top semantic + FTS
  // hits from the SQLite memory store, scored against the user's
  // current message. Without this, Clementine has no automatic recall
  // — she'd have to spontaneously call memory_search every turn.
  if (opts.memoryStore?.searchContext && opts.userMessage.trim().length > 0) {
    try {
      const hits = opts.memoryStore.searchContext(opts.userMessage, {
        limit: MAX_MEMORY_HITS,
      });
      if (hits && hits.length > 0) {
        const lines: string[] = ['### Possibly relevant from persistent memory'];
        for (const h of hits.slice(0, MAX_MEMORY_HITS)) {
          const label = h.section
            ? h.section
            : (h.source_file ? h.source_file.split('/').pop() ?? h.source_file : 'memory');
          const content = (h.content ?? '').slice(0, MAX_MEMORY_HIT_CHARS).trim();
          if (!content) continue;
          lines.push(`- **${label}**: ${content}`);
          sections.retrievedMemory += 1;
        }
        if (sections.retrievedMemory > 0) {
          parts.push(lines.join('\n'));
        }
      }
    } catch (err) {
      // Never block on memory failure — log and continue.
      logger.debug({ err, sessionKey: opts.sessionKey }, 'turn-context: searchContext failed (non-fatal)');
    }
  }

  // ── 2. Recent background task headlines ───────────────────────────
  // Last 24h of terminal-state bg tasks. So when the owner asks "what
  // happened with that job?" she knows without re-asking.
  if (opts.listBackgroundTasks) {
    try {
      const TERMINAL: Array<BackgroundTask['status']> = ['done', 'failed', 'interrupted', 'aborted'];
      const recent: BackgroundTask[] = [];
      for (const status of TERMINAL) {
        const tasks = opts.listBackgroundTasks({ status });
        for (const task of tasks) {
          const stamp = task.completedAt ?? task.interruptedAt ?? task.startedAt ?? task.createdAt;
          if (!stamp) continue;
          if (nowMs - Date.parse(stamp) > RECENT_BG_WINDOW_MS) continue;
          recent.push(task);
        }
      }
      // Newest first, capped.
      recent.sort((a, b) => {
        const aStamp = a.completedAt ?? a.startedAt ?? a.createdAt ?? '';
        const bStamp = b.completedAt ?? b.startedAt ?? b.createdAt ?? '';
        return bStamp.localeCompare(aStamp);
      });

      if (recent.length > 0) {
        const lines: string[] = ['### Recently completed background work (last 24h)'];
        for (const task of recent.slice(0, MAX_BG_TASKS)) {
          const promptPreview = (task.prompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
          const tail = task.status === 'done'
            ? (task.result ?? task.deliverableNote ?? 'done').slice(0, 100).replace(/\s+/g, ' ').trim()
            : (task.error ?? task.status).slice(0, 100).replace(/\s+/g, ' ').trim();
          const line = `- **${task.status}**: ${promptPreview} → ${tail}`;
          lines.push(line.slice(0, MAX_BG_TASK_LINE_CHARS));
          sections.recentBgTasks += 1;
        }
        if (sections.recentBgTasks > 0) {
          parts.push(lines.join('\n'));
        }
      }
    } catch (err) {
      logger.debug({ err, sessionKey: opts.sessionKey }, 'turn-context: listBackgroundTasks failed (non-fatal)');
    }
  }

  // ── 3. Identity framing ───────────────────────────────────────────
  // "Who is the user, where are they reaching you, which agent are
  // you running as." Anchors the model's voice + addressing.
  const identityLine = buildIdentityLine(opts);
  if (identityLine) {
    parts.push(`### Right now\n${identityLine}`);
    sections.identityFrame = true;
  }

  // ── 4. Live state ─────────────────────────────────────────────────
  // Current date/time so the model never says "I don't know what
  // today is." Cheap, high-signal.
  const liveLine = `Current time: ${nowDate.toISOString()} (UTC)`;
  if (sections.identityFrame) {
    // Fold into the same "Right now" section to avoid an extra header.
    parts[parts.length - 1] = `${parts[parts.length - 1]}\n${liveLine}`;
  } else {
    parts.push(`### Right now\n${liveLine}`);
  }
  sections.liveState = true;

  // ── 5. Extension points for deeper learning subsystems ───────────
  // These are intentionally empty today. The architecture is set up
  // so adding a new subsystem = adding a new builder function +
  // calling it here. Each follow-up ship can wire one at a time
  // without re-touching the rest of the module.
  //
  // TODO(1.18.185+): wire these in:
  //   - decision-reflection: latest formatReflectionSummary() if <24h old
  //   - skill-quality: skills flagged 'underperforming' or 'stale'
  //   - insight-engine: most recent generated insights not yet ack'd
  //   - seed-user-model: latest persisted snapshot of the owner profile
  //   - goal-evaluator: active goals and last 3 goal-check results
  //
  // For each, the pattern is: read fast, cap output, log non-fatally on error.

  if (parts.length === 0) {
    return { block: '', sections, totalChars: 0 };
  }

  const body = parts.join('\n\n');
  // Hard cap on the whole block to protect cache health.
  const truncated = body.length > MAX_BLOCK_CHARS
    ? body.slice(0, MAX_BLOCK_CHARS - 3) + '...'
    : body;

  // Mirror the existing securityAnnotation envelope shape so the chat
  // path can concatenate cleanly.
  const block = `[Context — read this for continuity, then respond to the user message below]\n${truncated}\n[/Context]\n\n`;

  return {
    block,
    sections,
    totalChars: block.length,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildIdentityLine(opts: BuildTurnContextOptions): string {
  const parts: string[] = [];
  if (opts.ownerName) {
    parts.push(`You're talking to ${opts.ownerName}`);
  }
  if (opts.channel) {
    parts.push(`via ${opts.channel}`);
  }
  if (opts.profileName) {
    parts.push(`as ${opts.profileName}`);
  } else if (parts.length > 0) {
    parts.push('as Clementine');
  }
  return parts.length > 0 ? parts.join(' ') + '.' : '';
}
