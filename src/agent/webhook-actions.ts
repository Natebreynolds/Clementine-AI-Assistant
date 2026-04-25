/**
 * Clementine TypeScript — Webhook → action dispatch.
 *
 * External services (Salesforce, GitHub, calendar, email) POST events
 * to /webhook-action/:source. This module turns those events into
 * agentic actions:
 *
 *   - `wake_agent`            → write wake sentinel; agent ticks within ~3s
 *   - `start_background_task` → create a pending task; cron-scheduler picks
 *                                it up and runs unleashed
 *
 * Configuration: ~/.clementine/webhook-actions.json
 *
 *   {
 *     "hooks": [
 *       {
 *         "source": "github",
 *         "secretEnv": "GITHUB_WEBHOOK_SECRET",
 *         "on": [
 *           {
 *             "match": { "action": "opened", "pull_request": "*" },
 *             "do": "wake_agent",
 *             "agent": "ross-the-sdr",
 *             "reason": "PR opened — review needed"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Match values: literal strings/numbers/booleans for exact match, or "*"
 * to require the field be present (any value, non-null/undefined). Dot
 * notation supported for nested fields ("payload.user.id"). All conditions
 * in a `match` block must hold (AND).
 *
 * Templating: `prompt` and `reason` strings can interpolate payload
 * fields with `{{ field.path }}`. Missing fields render as empty string.
 *
 * Every dispatched event is logged to ~/.clementine/webhook-actions/log.jsonl
 * (rotated at 1MB / 1000 lines, 30-day retention).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { createBackgroundTask } from './background-tasks.js';

// ── Types ────────────────────────────────────────────────────────────

export type WebhookActionVerb = 'wake_agent' | 'start_background_task';

export interface WebhookActionRule {
  /** Field/value conditions, all must match. Use "*" for "field present". */
  match?: Record<string, string | number | boolean>;
  do: WebhookActionVerb;
  agent: string;
  /** For wake_agent — short reason annotated on the wake sentinel. */
  reason?: string;
  /** For start_background_task — the prompt template. Supports {{ field.path }}. */
  prompt?: string;
  /** For start_background_task — wall-clock cap. Default 30. */
  maxMinutes?: number;
}

export interface WebhookActionSource {
  source: string;
  /** Env var holding the HMAC secret. Required unless `secret` is set inline. */
  secretEnv?: string;
  /** Inline secret (for tests / local-only setups). Prefer secretEnv in prod. */
  secret?: string;
  on: WebhookActionRule[];
}

export interface WebhookActionConfig {
  hooks: WebhookActionSource[];
}

export interface DispatchResult {
  matched: number;
  dispatched: number;
  errors: string[];
  log: Array<{ rule: WebhookActionRule; ok: boolean; message: string }>;
}

// ── Storage paths ────────────────────────────────────────────────────

const CONFIG_PATH = path.join(BASE_DIR, 'webhook-actions.json');
const LOG_DIR = path.join(BASE_DIR, 'webhook-actions');
const LOG_PATH = path.join(LOG_DIR, 'log.jsonl');
const WAKE_DIR = path.join(BASE_DIR, 'heartbeat', 'wake');

const LOG_MAX_BYTES = 1_000_000;
const LOG_MAX_LINES = 1000;
const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ── Config I/O ───────────────────────────────────────────────────────

export function loadWebhookActionConfig(opts?: { configPath?: string }): WebhookActionConfig {
  const file = opts?.configPath ?? CONFIG_PATH;
  if (!existsSync(file)) return { hooks: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WebhookActionConfig>;
    if (!Array.isArray(raw.hooks)) return { hooks: [] };
    return { hooks: raw.hooks as WebhookActionSource[] };
  } catch {
    return { hooks: [] };
  }
}

export function getSourceConfig(source: string, opts?: { configPath?: string }): WebhookActionSource | null {
  return loadWebhookActionConfig(opts).hooks.find((h) => h.source === source) ?? null;
}

// ── Matcher ──────────────────────────────────────────────────────────

/** Read a dot-path from a JSON-ish object. Returns undefined if any segment is missing. */
function readPath(obj: unknown, dotPath: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  let cursor: unknown = obj;
  for (const segment of dotPath.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** All match conditions hold. "*" means "field is present (non-null/undefined)". */
export function ruleMatches(rule: WebhookActionRule, payload: unknown): boolean {
  const conds = rule.match;
  if (!conds || Object.keys(conds).length === 0) return true; // empty match = match-all
  for (const [pathSpec, expected] of Object.entries(conds)) {
    const actual = readPath(payload, pathSpec);
    if (expected === '*') {
      if (actual === undefined || actual === null) return false;
      continue;
    }
    // Loose equality: 1 == "1", true == "true". Real users put strings in JSON; loose is friendlier.
    // eslint-disable-next-line eqeqeq
    if (actual == expected) continue;
    return false;
  }
  return true;
}

/** Replace {{ dot.path }} in a template with payload values. Missing → "". */
export function renderTemplate(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, dotPath: string) => {
    const v = readPath(payload, dotPath);
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────

interface DispatchEnv {
  /** Override BASE_DIR for tests. */
  baseDir?: string;
}

function wakeSentinelPath(slug: string, baseDir: string): string {
  return path.join(baseDir, 'heartbeat', 'wake', `${slug}.json`);
}

function dispatchOne(rule: WebhookActionRule, source: string, payload: unknown, env: DispatchEnv): { ok: boolean; message: string } {
  const baseDir = env.baseDir ?? BASE_DIR;

  if (rule.do === 'wake_agent') {
    try {
      const wakeDir = path.join(baseDir, 'heartbeat', 'wake');
      mkdirSync(wakeDir, { recursive: true });
      const reason = rule.reason ? renderTemplate(rule.reason, payload) : `webhook:${source}`;
      const sentinel = {
        targetSlug: rule.agent,
        fromSlug: `webhook:${source}`,
        reason: reason.slice(0, 200),
        requestedAt: new Date().toISOString(),
      };
      writeFileSync(wakeSentinelPath(rule.agent, baseDir), JSON.stringify(sentinel, null, 2));
      return { ok: true, message: `Woke ${rule.agent} (${reason})` };
    } catch (err) {
      return { ok: false, message: `wake_agent failed: ${String(err).slice(0, 200)}` };
    }
  }

  if (rule.do === 'start_background_task') {
    if (!rule.prompt) {
      return { ok: false, message: 'start_background_task: rule has no `prompt` template' };
    }
    try {
      const prompt = renderTemplate(rule.prompt, payload);
      const task = createBackgroundTask(
        {
          fromAgent: rule.agent,
          prompt,
          maxMinutes: rule.maxMinutes ?? 30,
        },
        env.baseDir ? { dir: path.join(env.baseDir, 'background-tasks') } : undefined,
      );
      return { ok: true, message: `Queued background task ${task.id} for ${rule.agent}` };
    } catch (err) {
      return { ok: false, message: `start_background_task failed: ${String(err).slice(0, 200)}` };
    }
  }

  // Exhaustiveness check — should never hit at runtime if types are honored.
  return { ok: false, message: `Unknown action verb: ${(rule as { do: string }).do}` };
}

/**
 * Match the payload against every rule in the source config and dispatch
 * all matches. Each rule is independent — multiple matches all fire.
 */
export function dispatchWebhookActions(
  source: string,
  payload: unknown,
  opts?: { configPath?: string; baseDir?: string },
): DispatchResult {
  const cfg = getSourceConfig(source, opts);
  const result: DispatchResult = { matched: 0, dispatched: 0, errors: [], log: [] };
  if (!cfg) {
    result.errors.push(`No webhook-action config for source "${source}"`);
    return result;
  }
  for (const rule of cfg.on) {
    if (!ruleMatches(rule, payload)) continue;
    result.matched++;
    const r = dispatchOne(rule, source, payload, { baseDir: opts?.baseDir });
    result.log.push({ rule, ok: r.ok, message: r.message });
    if (r.ok) result.dispatched++;
    else result.errors.push(r.message);
  }
  return result;
}

// ── Receipt log ──────────────────────────────────────────────────────

export interface WebhookEventLogEntry {
  timestamp: string;
  source: string;
  verified: boolean;
  matched: number;
  dispatched: number;
  errors: string[];
  payloadPreview: string;
}

function rotateLogIfNeeded(opts?: { logPath?: string }): void {
  const file = opts?.logPath ?? LOG_PATH;
  try {
    if (!existsSync(file)) return;
    const { size } = statSync(file);
    if (size <= LOG_MAX_BYTES) return;
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length <= LOG_MAX_LINES) return;
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    const kept: string[] = [];
    for (const line of lines.slice(-LOG_MAX_LINES)) {
      try {
        const e = JSON.parse(line) as WebhookEventLogEntry;
        const ts = new Date(e.timestamp).getTime();
        if (Number.isFinite(ts) && ts >= cutoff) kept.push(line);
      } catch { /* drop malformed */ }
    }
    writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''));
  } catch { /* non-fatal */ }
}

export function logWebhookEvent(entry: WebhookEventLogEntry, opts?: { logPath?: string; logDir?: string }): void {
  try {
    const dir = opts?.logDir ?? LOG_DIR;
    const file = opts?.logPath ?? LOG_PATH;
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n');
    setImmediate(() => rotateLogIfNeeded(opts));
  } catch { /* non-fatal */ }
}

export function recentWebhookEvents(limit = 50, opts?: { logPath?: string }): WebhookEventLogEntry[] {
  try {
    const file = opts?.logPath ?? LOG_PATH;
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    const out: WebhookEventLogEntry[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        out.push(JSON.parse(line) as WebhookEventLogEntry);
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Test-only ────────────────────────────────────────────────────────

export const _internals = { CONFIG_PATH, LOG_PATH, LOG_DIR, WAKE_DIR };
