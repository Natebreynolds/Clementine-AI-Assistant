/**
 * Cross-run idempotency guard for high-confidence external side effects.
 *
 * The classifier answers "is this mutating?". This module answers the
 * narrower operational question: "is this the same external mutation we
 * already saw succeed recently?" It intentionally fingerprints only calls
 * with stable identity fields. Unknown or weakly-identified mutations are
 * observed by the event log, not blocked.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { BASE_DIR } from '../config.js';
import { isToolResultSuccessful, normalizedToolResultPayload } from './side-effect-classifier.js';

const logger = pino({ name: 'clementine.side-effect-idempotency' });

const EMAIL_SEND_TTL_MS = 24 * 60 * 60 * 1000;
const CRM_MUTATION_TTL_MS = 60 * 60 * 1000;
const MAX_STORE_BYTES = 2_000_000;
const MAX_STORE_LINES = 5000;

const EMAIL_ADDRESS_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_BODY_KEYS = ['body', 'htmlBody', 'bodyHtml', 'html', 'text', 'plainText', 'message', 'content'];
const EMAIL_SUBJECT_KEYS = ['subject', 'title'];
const EMAIL_TO_KEYS = ['to', 'toEmail', 'to_email', 'recipient', 'recipients', 'toRecipients', 'to_recipients'];
const EMAIL_CC_KEYS = ['cc', 'ccRecipients', 'cc_recipients'];
const EMAIL_BCC_KEYS = ['bcc', 'bccRecipients', 'bcc_recipients'];

const CRM_PROVIDER_TOKENS = new Set([
  'crm',
  'salesforce',
  'sfdc',
  'hubspot',
  'pipedrive',
  'zoho',
  'dynamics',
]);

const CRM_MUTATION_TOKENS = new Set(['create', 'update', 'upsert', 'delete', 'insert', 'set']);
const CRM_OBJECT_KEYS = ['object', 'objectName', 'object_name', 'sobject', 'sObject', 's_object', 'entity', 'module'];
const CRM_RECORD_ID_KEYS = ['recordId', 'record_id', 'id', 'contactId', 'contact_id', 'leadId', 'lead_id', 'accountId', 'account_id', 'externalId', 'external_id'];
const CRM_FIELD_KEYS = ['fields', 'values', 'data', 'properties', 'record', 'payload', 'input'];

export type IdempotencyKind = 'email_send' | 'crm_mutation';

export interface SideEffectFingerprint {
  kind: IdempotencyKind;
  fingerprint: string;
  ttlMs: number;
  summary: string;
  guidance: string;
  details: Record<string, unknown>;
}

export interface SideEffectIdempotencyRecord {
  version: 1;
  ts: string;
  runId: string;
  sessionKey?: string;
  toolName: string;
  toolUseId?: string;
  kind: IdempotencyKind;
  fingerprint: string;
  ttlMs: number;
  summary: string;
  details: Record<string, unknown>;
  result: {
    successReason: string;
    statusCode?: number;
    logId?: string;
  };
}

export interface SideEffectIdempotencyStats {
  inspected: number;
  guarded: number;
  blocked: number;
  recorded: number;
  skipped: number;
  failedNotRecorded: number;
}

export interface SideEffectIdempotencyHookOptions {
  runId: string;
  sessionKey?: string;
  baseDir?: string;
  now?: () => number;
  onDecision?: (info: {
    decision: 'allow' | 'block' | 'record' | 'skip' | 'failed';
    toolName: string;
    kind?: IdempotencyKind;
    fingerprint?: string;
    summary?: string;
    prior?: SideEffectIdempotencyRecord;
    reason?: string;
  }) => void;
}

export interface SideEffectIdempotencyHookHandles {
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  stats: SideEffectIdempotencyStats;
}

function activeBaseDir(baseDir?: string): string {
  return baseDir ?? process.env.CLEMENTINE_HOME ?? BASE_DIR;
}

function storePath(baseDir?: string): string {
  return path.join(activeBaseDir(baseDir), 'idempotency', 'recent-side-effects.jsonl');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = (v as Record<string, unknown>)[k];
      }
      return out;
    }
    return v;
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shortHash(value: string, chars = 20): string {
  return sha256(value).slice(0, chars);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokensForToolName(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function findFirstStringByKey(input: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const lowerMap = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const actual = lowerMap.get(key.toLowerCase());
    const value = actual ? obj[actual] : undefined;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findFirstStringByKey(value, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function findFirstValueByKey(input: unknown, keys: string[], depth = 0): unknown {
  if (depth > 4) return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const lowerMap = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const actual = lowerMap.get(key.toLowerCase());
    if (actual && obj[actual] != null) return obj[actual];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findFirstValueByKey(value, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function collectEmails(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    const matches = value.match(EMAIL_ADDRESS_RE) ?? [];
    for (const m of matches) out.add(m.toLowerCase());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEmails(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['email', 'address', 'emailAddress']) {
      if (key in obj) collectEmails(obj[key], out, depth + 1);
    }
    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === 'object') collectEmails(nested, out, depth + 1);
    }
  }
  return out;
}

function emailsForKeys(input: Record<string, unknown>, keys: string[]): string[] {
  const value = findFirstValueByKey(input, keys);
  return Array.from(collectEmails(value)).sort();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function preview(value: string, max = 80): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function isEmailSendTool(toolName: string): boolean {
  const tokens = tokensForToolName(toolName);
  const hasSend = tokens.includes('send') || /send_?email/i.test(toolName);
  const hasEmailSurface = tokens.some((t) => t === 'email' || t === 'mail' || t === 'gmail' || t === 'outlook');
  return hasSend && hasEmailSurface;
}

function buildEmailFingerprint(toolName: string, input: Record<string, unknown>): SideEffectFingerprint | null {
  if (!isEmailSendTool(toolName)) return null;
  const to = emailsForKeys(input, EMAIL_TO_KEYS);
  const cc = emailsForKeys(input, EMAIL_CC_KEYS);
  const bcc = emailsForKeys(input, EMAIL_BCC_KEYS);
  const subject = findFirstStringByKey(input, EMAIL_SUBJECT_KEYS);
  const body = findFirstStringByKey(input, EMAIL_BODY_KEYS);
  if (to.length === 0 || !subject || !body) return null;

  const normalizedSubject = normalizeWhitespace(subject).toLowerCase();
  // Collapse whitespace before hashing so harmless HTML/plain-text wrapping
  // changes don't evade duplicate-send protection.
  const bodyHash = shortHash(normalizeWhitespace(body));
  const identity = {
    kind: 'email_send',
    to,
    cc,
    bcc,
    subject: normalizedSubject,
    bodyHash,
  };
  const recipientText = to.length <= 3 ? to.join(', ') : `${to.slice(0, 3).join(', ')} +${to.length - 3} more`;
  return {
    kind: 'email_send',
    fingerprint: `email_send:${shortHash(stableJson(identity), 32)}`,
    ttlMs: EMAIL_SEND_TTL_MS,
    summary: `email send to ${recipientText} ("${preview(subject, 72)}")`,
    guidance: `This email send to ${recipientText} was already accepted by the provider. Do not retry it. Continue with remaining follow-up work such as CRM stamping, task creation, or a concise status update.`,
    details: {
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject: normalizeWhitespace(subject),
      bodyHash,
    },
  };
}

function isCrmMutationTool(toolName: string): boolean {
  const tokens = tokensForToolName(toolName);
  return tokens.some((t) => CRM_PROVIDER_TOKENS.has(t))
    && tokens.some((t) => CRM_MUTATION_TOKENS.has(t));
}

function mutationVerb(toolName: string): string | undefined {
  return tokensForToolName(toolName).find((t) => CRM_MUTATION_TOKENS.has(t));
}

function pickCrmFields(input: Record<string, unknown>): unknown {
  const fromKnownKey = findFirstValueByKey(input, CRM_FIELD_KEYS);
  if (fromKnownKey !== undefined) return fromKnownKey;
  const shallow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if ([...CRM_OBJECT_KEYS, ...CRM_RECORD_ID_KEYS].some((known) => known.toLowerCase() === k.toLowerCase())) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) shallow[k] = v;
  }
  return shallow;
}

function buildCrmFingerprint(toolName: string, input: Record<string, unknown>): SideEffectFingerprint | null {
  if (!isCrmMutationTool(toolName)) return null;
  const verb = mutationVerb(toolName);
  const objectName = findFirstStringByKey(input, CRM_OBJECT_KEYS);
  const recordId = findFirstStringByKey(input, CRM_RECORD_ID_KEYS);
  const fields = pickCrmFields(input);
  if (!verb || !objectName) return null;
  if (verb !== 'create' && !recordId) return null;
  const fieldsHash = shortHash(stableJson(fields ?? {}));
  const identity = {
    kind: 'crm_mutation',
    verb,
    objectName: objectName.toLowerCase(),
    recordId: recordId?.toLowerCase() ?? null,
    fieldsHash,
  };
  const target = `${objectName}${recordId ? ` ${recordId}` : ''}`;
  return {
    kind: 'crm_mutation',
    fingerprint: `crm_mutation:${shortHash(stableJson(identity), 32)}`,
    ttlMs: CRM_MUTATION_TTL_MS,
    summary: `CRM ${verb} on ${target}`,
    guidance: `This CRM ${verb} already succeeded for ${target}. Do not retry the same mutation. Continue with the remaining records or report completion/pending work.`,
    details: {
      verb,
      objectName,
      ...(recordId ? { recordId } : {}),
      fieldsHash,
    },
  };
}

function buildSfBashFingerprint(input: Record<string, unknown>): SideEffectFingerprint | null {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  // Narrow first pass: only Salesforce CLI data mutations with exact command
  // identity. Known gaps to evaluate later: legacy
  // `sfdx force:data:record:*`, `sf apex run`, direct REST/curl calls, and
  // custom Python sender scripts. Those need per-pattern confidence before
  // they can safely block across runs.
  if (!/\b(?:sf|sfdx)\s+data\s+(?:update|delete|create|upsert)\b/i.test(command)) return null;
  const normalizedCommand = normalizeWhitespace(command);
  return {
    kind: 'crm_mutation',
    fingerprint: `crm_mutation:${shortHash(`bash:${normalizedCommand}`, 32)}`,
    ttlMs: CRM_MUTATION_TTL_MS,
    summary: `CRM CLI mutation (${preview(normalizedCommand, 88)})`,
    guidance: `This CRM CLI mutation already succeeded recently. Do not retry the same command. Continue with remaining records or report completion/pending work.`,
    details: {
      verb: 'cli',
      commandHash: shortHash(normalizedCommand),
      commandPreview: preview(normalizedCommand, 160),
    },
  };
}

export function buildSideEffectFingerprint(toolName: string, input: unknown): SideEffectFingerprint | null {
  const rec = asRecord(input);
  if (!rec) return null;
  // Fingerprints intentionally omit agent identity. Idempotency is scoped to
  // the external operation: if two agents try the same send/update, the
  // second should continue the workflow instead of duplicating the effect.
  if (toolName === 'Bash') return buildSfBashFingerprint(rec);
  return buildEmailFingerprint(toolName, rec) ?? buildCrmFingerprint(toolName, rec);
}

function parseRecord(line: string): SideEffectIdempotencyRecord | null {
  try {
    const raw = JSON.parse(line) as Partial<SideEffectIdempotencyRecord>;
    if (raw.version !== 1 || !raw.fingerprint || !raw.kind || !raw.ts || !raw.runId) return null;
    return raw as SideEffectIdempotencyRecord;
  } catch {
    return null;
  }
}

export function readRecentSideEffectRecords(baseDir?: string, now = Date.now()): SideEffectIdempotencyRecord[] {
  const file = storePath(baseDir);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const records = lines.map(parseRecord).filter((r): r is SideEffectIdempotencyRecord => r !== null);
    return records.filter((r) => now - Date.parse(r.ts) <= r.ttlMs);
  } catch {
    return [];
  }
}

function maybePruneStore(baseDir?: string, now = Date.now()): void {
  const file = storePath(baseDir);
  if (!existsSync(file)) return;
  try {
    const st = statSync(file);
    if (st.size <= MAX_STORE_BYTES) return;
    const recent = readRecentSideEffectRecords(baseDir, now).slice(-MAX_STORE_LINES);
    writeFileSync(file, recent.map((r) => JSON.stringify(r)).join('\n') + (recent.length ? '\n' : ''));
  } catch {
    // non-critical
  }
}

export function appendSideEffectRecord(record: SideEffectIdempotencyRecord, baseDir?: string): void {
  const file = storePath(baseDir);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // Records are small JSONL rows; appendFileSync keeps each write atomic in
    // practice for this size, and malformed lines are ignored on read.
    appendFileSync(file, JSON.stringify(record) + '\n');
    maybePruneStore(baseDir, Date.parse(record.ts));
  } catch (err) {
    logger.warn({ err, kind: record.kind, runId: record.runId }, 'Failed to append side-effect idempotency record');
  }
}

export function findPriorSuccessfulSideEffect(
  fingerprint: SideEffectFingerprint,
  opts: { baseDir?: string; now?: number } = {},
): SideEffectIdempotencyRecord | null {
  const now = opts.now ?? Date.now();
  const records = readRecentSideEffectRecords(opts.baseDir, now);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i]!;
    if (rec.fingerprint === fingerprint.fingerprint && now - Date.parse(rec.ts) <= fingerprint.ttlMs) {
      return rec;
    }
  }
  return null;
}

function findLogId(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value == null) return undefined;
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['logId', 'log_id', 'requestId', 'request_id', 'id']) {
    const raw = obj[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  for (const nested of Object.values(obj)) {
    const found = findLogId(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function duplicateReason(fingerprint: SideEffectFingerprint, prior: SideEffectIdempotencyRecord, now: number): string {
  const ageMinutes = Math.max(0, Math.round((now - Date.parse(prior.ts)) / 60_000));
  return JSON.stringify({
    successful: false,
    blocked_by: 'idempotency_guard',
    operation_already_succeeded: true,
    error: 'duplicate-of-prior-call',
    operation: fingerprint.summary,
    prior_call: {
      ts: prior.ts,
      runId: prior.runId,
      toolName: prior.toolName,
      status_code: prior.result.statusCode,
      log_id: prior.result.logId,
    },
    guidance: `${fingerprint.guidance} Prior success was ${ageMinutes} minute(s) ago.`,
  });
}

export function buildSideEffectIdempotencyHook(opts: SideEffectIdempotencyHookOptions): SideEffectIdempotencyHookHandles {
  const stats: SideEffectIdempotencyStats = {
    inspected: 0,
    guarded: 0,
    blocked: 0,
    recorded: 0,
    skipped: 0,
    failedNotRecorded: 0,
  };
  const now = opts.now ?? (() => Date.now());

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {} as HookJSONOutput;
    const evt = input as PreToolUseHookInput;
    const toolName = String(evt.tool_name ?? 'unknown');
    stats.inspected += 1;
    const fingerprint = buildSideEffectFingerprint(toolName, evt.tool_input);
    if (!fingerprint) {
      stats.skipped += 1;
      opts.onDecision?.({ decision: 'skip', toolName, reason: 'no-confident-fingerprint' });
      return {} as HookJSONOutput;
    }

    stats.guarded += 1;
    const ts = now();
    const prior = findPriorSuccessfulSideEffect(fingerprint, { baseDir: opts.baseDir, now: ts });
    if (!prior) {
      opts.onDecision?.({
        decision: 'allow',
        toolName,
        kind: fingerprint.kind,
        fingerprint: fingerprint.fingerprint,
        summary: fingerprint.summary,
      });
      return {} as HookJSONOutput;
    }

    stats.blocked += 1;
    logger.warn({
      runId: opts.runId,
      toolName,
      kind: fingerprint.kind,
      priorRunId: prior.runId,
      summary: fingerprint.summary,
    }, 'side-effect-idempotency: blocking duplicate successful side effect');
    opts.onDecision?.({
      decision: 'block',
      toolName,
      kind: fingerprint.kind,
      fingerprint: fingerprint.fingerprint,
      summary: fingerprint.summary,
      prior,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: duplicateReason(fingerprint, prior, ts),
      },
    } as HookJSONOutput;
  };

  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {} as HookJSONOutput;
    const evt = input as PostToolUseHookInput;
    const toolName = String(evt.tool_name ?? 'unknown');
    const fingerprint = buildSideEffectFingerprint(toolName, evt.tool_input);
    if (!fingerprint) return {} as HookJSONOutput;
    const result = isToolResultSuccessful(evt.tool_response, false);
    if (!result.successful) {
      stats.failedNotRecorded += 1;
      opts.onDecision?.({
        decision: 'failed',
        toolName,
        kind: fingerprint.kind,
        fingerprint: fingerprint.fingerprint,
        summary: fingerprint.summary,
        reason: result.reason,
      });
      return {} as HookJSONOutput;
    }
    const payload = normalizedToolResultPayload(evt.tool_response);
    const record: SideEffectIdempotencyRecord = {
      version: 1,
      ts: new Date(now()).toISOString(),
      runId: opts.runId,
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      toolName,
      toolUseId: evt.tool_use_id,
      kind: fingerprint.kind,
      fingerprint: fingerprint.fingerprint,
      ttlMs: fingerprint.ttlMs,
      summary: fingerprint.summary,
      details: fingerprint.details,
      result: {
        successReason: result.reason,
        ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
        ...(findLogId(payload) ? { logId: findLogId(payload) } : {}),
      },
    };
    appendSideEffectRecord(record, opts.baseDir);
    stats.recorded += 1;
    opts.onDecision?.({
      decision: 'record',
      toolName,
      kind: fingerprint.kind,
      fingerprint: fingerprint.fingerprint,
      summary: fingerprint.summary,
    });
    return {} as HookJSONOutput;
  };

  return {
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
    },
    stats,
  };
}
