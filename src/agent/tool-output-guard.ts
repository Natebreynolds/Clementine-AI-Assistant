/**
 * tool-output-guard — PostToolUse hook that bounds per-call tool output size
 * so the SDK's auto-compactor can never thrash on a runaway MCP result.
 *
 * Why this exists
 * ───────────────
 * Anthropic's Claude Agent SDK auto-compacts when context approaches the
 * model's window. When a *single* tool result is larger than the room left
 * after compaction, the next turn refills the window immediately. After 3
 * consecutive compactions that don't help, the SDK throws:
 *
 *   "Autocompact is thrashing: the context refilled to the limit within 3
 *    turns of the previous compact, 3 times in a row."
 *
 * This used to happen on outlook-email-triage and imessage-triage when their
 * MCP tools (`mcp__claude_ai_Microsoft_365__outlook_inbox`,
 * `imessage_read`) returned tens-to-hundreds of KB per call. Our own
 * Clementine MCP tools cap output at 30KB (`capOutput` in src/tools/shared.ts)
 * but third-party MCPs (Composio, claude.ai, iMessage) ignore that.
 *
 * The fix is the canonical Anthropic primitive: a `PostToolUse` hook that
 * returns `hookSpecificOutput.updatedToolOutput` to replace the result
 * before it reaches the model. From sdk.d.ts:1979 — "Replaces the tool
 * output before it is sent to the model."
 *
 * Design properties
 * ─────────────────
 * 1. Operates at the SDK boundary, once. Every runAgent caller (chat, cron,
 *    runSkill, heartbeat, team-task, hired agents) is protected for free.
 * 2. Transparent: full payload is archived to disk so the agent can
 *    `Read <path>` if it really needs the rest. Nothing is silently lost.
 * 3. Structure-aware: arrays of objects keep the first N + last 2 items
 *    plus a summary of the rest; emails/messages drop verbose body fields
 *    when they alone exceed the cap.
 * 4. Per-tool overrides via clementine.json `toolOutputGuard.perTool`.
 * 5. Adaptive: when cumulative cache-creation tokens climb >50% of the
 *    model's window, the soft cap shrinks ×0.5. Stops thrashing in the
 *    pathological "many medium-sized calls" case the static cap misses.
 * 6. Hard ceiling (default 200KB) always enforced — three back-to-back
 *    400KB outputs would thrash even at 1M context.
 *
 * Failure mode: this module never throws. A bad input, an archive write
 * failure, anything — falls back to returning the original output. The
 * caller (runAgent → SDK) is unblocked. The guard logs the issue and
 * continues. Telemetry must never break execution.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

import { BASE_DIR, TOOL_OUTPUT_GUARD } from '../config.js';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const logger = pino({ name: 'clementine.tool-output-guard' });

// ── Configuration ────────────────────────────────────────────────────

export interface ToolOutputGuardConfig {
  /** Bytes — typical soft cap before compression kicks in. */
  softLimitBytes: number;
  /** Bytes — feasibility ceiling. Never exceeded regardless of context. */
  hardLimitBytes: number;
  /** When true, the soft cap shrinks as cumulative context fills up. */
  adaptive: boolean;
  /** Tool-name → bytes overrides. Keys match the SDK `tool_name` field
   *  (MCP tools: `mcp__<server>__<tool>`; native tools: `Read`, `Bash`, …). */
  perTool: Record<string, number>;
}

/** Default config from src/config.ts; callers can override per-run via
 *  RunAgentOptions if a particular run truly needs more space. */
export function defaultGuardConfig(): ToolOutputGuardConfig {
  return {
    softLimitBytes: TOOL_OUTPUT_GUARD.softLimitBytes,
    hardLimitBytes: TOOL_OUTPUT_GUARD.hardLimitBytes,
    adaptive: TOOL_OUTPUT_GUARD.adaptive,
    perTool: { ...TOOL_OUTPUT_GUARD.perTool },
  };
}

// ── Telemetry / per-run state ─────────────────────────────────────────

export interface GuardRunStats {
  /** Tool calls inspected by the guard. */
  inspected: number;
  /** Tool calls that exceeded the soft cap and were compressed. */
  compressed: number;
  /** Tool calls that exceeded the hard ceiling. */
  ceilingHits: number;
  /** Bytes of payload deferred to the archive (i.e. not sent to the model). */
  bytesShed: number;
  /** Number of SDK auto-compactions observed for this run. */
  compactions: number;
}

function freshStats(): GuardRunStats {
  return { inspected: 0, compressed: 0, ceilingHits: 0, bytesShed: 0, compactions: 0 };
}

// ── Size estimation ───────────────────────────────────────────────────

/**
 * Approximate the byte size of a tool_response as it will appear in the
 * model's context. The SDK's tool_response may be a primitive, an object,
 * a content-block array, or already-truncated string. We JSON-stringify
 * because that's how the SDK ships it onwards, then byte-length the result.
 */
export function estimateBytes(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number' || typeof value === 'boolean') {
    return Buffer.byteLength(String(value), 'utf8');
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

// ── Compression strategies ────────────────────────────────────────────

/** Tools whose response is a list-of-items shaped value. Compression for
 *  these keeps the first N items plus a summary stub for the rest. The
 *  list isn't always at the top level — Composio MCP responses commonly
 *  wrap under `data`, `items`, `messages`, `value`, or `results`. */
const LIST_FIELD_CANDIDATES = ['items', 'data', 'value', 'messages', 'results', 'records', 'entries'] as const;

/** Body-like fields that bloat email/message payloads. When the host
 *  result is still over budget after first-pass shrinking, we re-emit
 *  the items with these fields replaced by a 200-char preview. */
const VERBOSE_FIELDS = [
  'body', 'html', 'html_body', 'htmlBody', 'bodyHtml', 'content', 'text', 'snippet',
  'message', 'transcript', 'raw', 'rawBody', 'rawMessage', 'contentText', 'plainText',
] as const;

interface CompressionContext {
  toolName: string;
  archivePath: string | null;
  cap: number;
}

/** First attempt: trim the list inside the response down to head + tail items. */
function tryListShrink(value: unknown, ctx: CompressionContext): unknown | null {
  if (Array.isArray(value)) {
    return shrinkArray(value, ctx);
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const field of LIST_FIELD_CANDIDATES) {
    const candidate = obj[field];
    if (Array.isArray(candidate) && candidate.length > 4) {
      return {
        ...obj,
        [field]: shrinkArray(candidate, ctx),
        _clementine_truncated: archiveHint(ctx, `${field}[]`),
      };
    }
  }
  return null;
}

function shrinkArray(arr: unknown[], ctx: CompressionContext): unknown {
  if (arr.length <= 6) {
    // Don't trim short lists; the bloat is somewhere else (likely a fat body).
    return arr.map((it) => shrinkVerboseFields(it));
  }
  const keepHead = 5;
  const keepTail = 2;
  const head = arr.slice(0, keepHead).map((it) => shrinkVerboseFields(it));
  const tail = arr.slice(-keepTail).map((it) => shrinkVerboseFields(it));
  const dropped = arr.length - keepHead - keepTail;
  return [
    ...head,
    {
      _clementine_summary: `[${dropped} more item${dropped === 1 ? '' : 's'} omitted to fit context. ${archiveHint(ctx, 'middle items')}]`,
    },
    ...tail,
  ];
}

/** Replace heavy body fields on a single item with a short preview. */
function shrinkVerboseFields(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const field of VERBOSE_FIELDS) {
    const v = out[field];
    if (typeof v === 'string' && v.length > 300) {
      out[field] = `${v.slice(0, 200)}…[${v.length - 200} more chars, see archived payload]`;
    }
  }
  return out;
}

/** Last-resort: head+tail slice of the JSON serialization. Always produces
 *  output under the cap. */
function tryRawSliceShrink(value: unknown, ctx: CompressionContext): string {
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  if (Buffer.byteLength(raw, 'utf8') <= ctx.cap) return raw;
  // Reserve 800 bytes for the marker + archive hint
  const targetHead = Math.max(2_000, Math.floor((ctx.cap - 800) * 0.85));
  const targetTail = Math.max(500, Math.floor((ctx.cap - 800) * 0.15));
  const head = raw.slice(0, targetHead);
  const tail = raw.slice(-targetTail);
  const droppedBytes = Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return `${head}\n\n[…truncated ${formatBytes(droppedBytes)} from tool \`${ctx.toolName}\` to fit context. ${archiveHint(ctx, 'middle')}]\n\n${tail}`;
}

function archiveHint(ctx: CompressionContext, what: string): string {
  if (!ctx.archivePath) return `(${what} dropped — re-call the tool with a narrower query for the rest)`;
  return `Full payload archived at \`${ctx.archivePath}\` — call \`Read\` on that path for the ${what}.`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Archive ───────────────────────────────────────────────────────────

/** Persist the full payload so the agent can `Read` it later if needed.
 *  Returns the absolute path, or null on any failure (archive is opt-in
 *  convenience — never blocks compression). */
function archivePayload(
  baseDir: string,
  runId: string,
  toolUseId: string,
  toolName: string,
  payload: unknown,
): string | null {
  try {
    const dir = join(baseDir, 'tool-archive', runId);
    mkdirSync(dir, { recursive: true });
    const safeName = toolName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
    const file = join(dir, `${safeName}__${toolUseId}.json`);
    const body = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, null, 2);
    writeFileSync(file, body, 'utf8');
    return file;
  } catch (err) {
    logger.debug({ err, toolName, runId }, 'tool-output-guard: archive write failed (non-fatal)');
    return null;
  }
}

// ── Adaptive cap computation ──────────────────────────────────────────

/**
 * Tighten the soft cap when cumulative context usage is already high.
 *
 * Inputs: `recentUsageRatio` is the most-recent (cache_read + input) /
 * window-size estimate from the SDK's usage block — see runAgent for how
 * it's plumbed. We don't know the exact window (200K vs 1M depends on
 * model + plan + 1m flag) so we pass a conservative 180K when nothing
 * else is known.
 *
 *   usage <50% of window:  full softLimit
 *   usage 50–75%:          softLimit × 0.6
 *   usage ≥75%:            softLimit × 0.35
 *
 * The hard ceiling is never reduced — it's already a feasibility cap.
 */
export function adaptiveSoftCap(
  baseSoftLimit: number,
  recentUsageRatio: number,
  adaptive: boolean,
): number {
  if (!adaptive || !Number.isFinite(recentUsageRatio) || recentUsageRatio <= 0.5) {
    return baseSoftLimit;
  }
  if (recentUsageRatio >= 0.75) return Math.max(4_000, Math.floor(baseSoftLimit * 0.35));
  return Math.max(6_000, Math.floor(baseSoftLimit * 0.6));
}

/** Resolve the effective cap for a given tool call. */
export function resolveCap(
  toolName: string,
  config: ToolOutputGuardConfig,
  usageRatio: number,
): { softCap: number; hardCap: number } {
  const perTool = config.perTool[toolName];
  const baseSoft = perTool ?? config.softLimitBytes;
  const adaptedSoft = adaptiveSoftCap(baseSoft, usageRatio, config.adaptive);
  return {
    softCap: Math.min(adaptedSoft, config.hardLimitBytes),
    hardCap: config.hardLimitBytes,
  };
}

// ── Core compression ──────────────────────────────────────────────────

export interface CompressOutcome {
  /** What goes back to the model. Same shape contract as the SDK
   *  tool_response — string OR an object — preserving caller intent. */
  output: unknown;
  /** Bytes of payload that didn't reach the model. */
  bytesShed: number;
  /** Did we trip the hard ceiling? */
  ceilingHit: boolean;
  /** Did the input fit under the cap (no compression done)? */
  passthrough: boolean;
}

/**
 * Compress a tool result if it exceeds the cap. Pure function — does not
 * write to disk. The caller handles archive + telemetry.
 */
export function compressToolOutput(
  _toolName: string,
  rawOutput: unknown,
  ctx: CompressionContext,
): CompressOutcome {
  const originalBytes = estimateBytes(rawOutput);
  if (originalBytes <= ctx.cap) {
    return { output: rawOutput, bytesShed: 0, ceilingHit: false, passthrough: true };
  }

  // Pass 1: list-shape shrink (preserves structure).
  const shrunk1 = tryListShrink(rawOutput, ctx);
  if (shrunk1 !== null) {
    const bytes1 = estimateBytes(shrunk1);
    if (bytes1 <= ctx.cap) {
      return {
        output: shrunk1,
        bytesShed: Math.max(0, originalBytes - bytes1),
        ceilingHit: false,
        passthrough: false,
      };
    }
  }

  // Pass 2: raw head+tail slice — always fits under cap.
  const sliced = tryRawSliceShrink(rawOutput, ctx);
  const slicedBytes = estimateBytes(sliced);
  return {
    output: sliced,
    bytesShed: Math.max(0, originalBytes - slicedBytes),
    ceilingHit: originalBytes > ctx.cap * 2, // way over → flag for telemetry
    passthrough: false,
  };
}

// ── Hook builder ──────────────────────────────────────────────────────

export interface GuardHookOptions {
  /** Stable run identifier — used to namespace the on-disk archive. */
  runId: string;
  /** Static config (env + clementine.json). */
  config?: ToolOutputGuardConfig;
  /** Optional callback fired on every compression. Used by runAgent to
   *  record an Event row for the Run detail page. */
  onCompress?: (info: {
    toolName: string;
    toolUseId: string;
    originalBytes: number;
    capBytes: number;
    bytesShed: number;
    ceilingHit: boolean;
    archivePath: string | null;
  }) => void;
  /** Optional source of the current cumulative context-usage ratio
   *  (cache_read + input) / window. Returns a number in [0,1]. The
   *  guard calls this once per tool result to adapt the cap. When
   *  absent, ratio is assumed 0 (full soft cap is always used). */
  usageRatio?: () => number;
  /** Optional archive root override for tests. Defaults to Clementine home. */
  archiveBaseDir?: string;
}

export interface GuardHookHandles {
  /** Hook map suitable for SDK `query({ options: { hooks } })`. */
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Aggregated telemetry — read after the run completes. */
  stats: GuardRunStats;
}

/**
 * Build the hook handles that runAgent will hand to the SDK.
 *
 * Returns one PostToolUse hook (does the work), one PreCompact hook
 * (logs the compaction request), and one PostCompact hook (logs the
 * summary length so we can correlate with the next turn's behavior).
 *
 * If `TOOL_OUTPUT_GUARD.enabled` is false, returns empty handles —
 * a noop merge with whatever the caller already had.
 */
export function buildGuardHooks(opts: GuardHookOptions): GuardHookHandles {
  const stats = freshStats();

  if (!TOOL_OUTPUT_GUARD.enabled) {
    return { hooks: {}, stats };
  }

  const config = opts.config ?? defaultGuardConfig();

  const postToolUse: HookCallback = async (input, toolUseID) => {
    // We only react to PostToolUse — the hook list is keyed by event,
    // but the callback signature is shared, so guard the cast.
    if (input.hook_event_name !== 'PostToolUse') {
      return {} as HookJSONOutput;
    }
    const evt = input as PostToolUseHookInput;
    const toolName = String(evt.tool_name ?? 'unknown');
    const toolUseId = String(toolUseID ?? evt.tool_use_id ?? 'unknown');
    const rawOutput = evt.tool_response;
    stats.inspected += 1;

    const usageRatio = opts.usageRatio ? safeRatio(opts.usageRatio) : 0;
    const { softCap } = resolveCap(toolName, config, usageRatio);

    const originalBytes = estimateBytes(rawOutput);
    if (originalBytes <= softCap) {
      return {} as HookJSONOutput;
    }

    // Archive BEFORE compressing so the hint we embed actually points to
    // a real file. We don't fail compression if archive fails — the
    // payload just becomes irretrievable; the model still gets a
    // truncation marker and can re-call the tool.
    const archivePath = archivePayload(opts.archiveBaseDir ?? BASE_DIR, opts.runId, toolUseId, toolName, rawOutput);

    const outcome = compressToolOutput(toolName, rawOutput, {
      toolName,
      toolUseId,
      archivePath,
      cap: softCap,
    } as unknown as CompressionContext);

    stats.compressed += 1;
    stats.bytesShed += outcome.bytesShed;
    if (outcome.ceilingHit) stats.ceilingHits += 1;

    logger.info({
      toolName,
      toolUseId,
      originalBytes,
      capBytes: softCap,
      bytesShed: outcome.bytesShed,
      archivePath,
      usageRatio: Number(usageRatio.toFixed(3)),
    }, 'tool-output-guard: compressed tool result');

    if (opts.onCompress) {
      try {
        opts.onCompress({
          toolName,
          toolUseId,
          originalBytes,
          capBytes: softCap,
          bytesShed: outcome.bytesShed,
          ceilingHit: outcome.ceilingHit,
          archivePath,
        });
      } catch { /* best-effort */ }
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse' as const,
        updatedToolOutput: outcome.output,
      },
    } as HookJSONOutput;
  };

  const preCompact: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreCompact') return {} as HookJSONOutput;
    const evt = input as PreCompactHookInput;
    stats.compactions += 1;
    logger.info({ trigger: evt.trigger, compactionNo: stats.compactions }, 'tool-output-guard: SDK compaction starting');
    return {} as HookJSONOutput;
  };

  const postCompact: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostCompact') return {} as HookJSONOutput;
    const evt = input as PostCompactHookInput;
    const summaryBytes = typeof evt.compact_summary === 'string'
      ? Buffer.byteLength(evt.compact_summary, 'utf8')
      : 0;
    logger.info({ trigger: evt.trigger, summaryBytes }, 'tool-output-guard: SDK compaction complete');
    return {} as HookJSONOutput;
  };

  return {
    hooks: {
      PostToolUse: [{ hooks: [postToolUse] }],
      PreCompact: [{ hooks: [preCompact] }],
      PostCompact: [{ hooks: [postCompact] }],
    },
    stats,
  };
}

function safeRatio(fn: () => number): number {
  try {
    const v = fn();
    if (!Number.isFinite(v) || v < 0) return 0;
    if (v > 1) return 1;
    return v;
  } catch { return 0; }
}
