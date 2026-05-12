/**
 * Provider-neutral side-effect classification for SDK tool calls.
 *
 * This module answers two intentionally small questions:
 * - Did this tool likely mutate external or durable state?
 * - Did the matching tool_result represent a successful execution?
 *
 * Provider-specific details belong in extractors/summaries. The classifier
 * keeps the global npm behavior conservative: confident read-only calls stay
 * read-only, confident mutating calls are side effects, and unclear calls are
 * surfaced as unknown rather than blocked or retried automatically.
 */

export type SideEffectVerdict =
  | { kind: 'side_effect'; reason: string }
  | { kind: 'read_only'; reason: string }
  | { kind: 'unknown'; reason: string };

const READ_ONLY_BUILTINS = new Set([
  'Agent',
  'Glob',
  'Grep',
  'LS',
  'Read',
  'Task',
  'TodoRead',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
]);

const MUTATING_BUILTINS = new Set([
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Write',
]);

const READ_ONLY_TOOL_VERBS = new Set([
  'describe',
  'fetch',
  'find',
  'get',
  'inbox',
  'list',
  'lookup',
  'query',
  'read',
  'retrieve',
  'search',
  'select',
]);

const SIDE_EFFECT_TOOL_VERBS = new Set([
  'add',
  'apply',
  'approve',
  'archive',
  'assign',
  'cancel',
  'compose',
  'create',
  'delete',
  'deploy',
  'disable',
  'enable',
  'forward',
  'insert',
  'merge',
  'move',
  'post',
  'publish',
  'push',
  'remove',
  'rename',
  'reply',
  'send',
  'set',
  'subscribe',
  'unsubscribe',
  'update',
  'upload',
  'upsert',
]);

const READ_ONLY_MCP_PATTERNS = [
  /^mcp__dataforseo__/i,
  /^mcp__bright[_-]?data__/i,
  /^mcp__.*__(?:get|list|search|find|fetch|read|query|describe|retrieve|lookup|inbox|select)(?:_|$)/i,
  /^mcp__.*__(?:.*_)?(?:get|list|search|find|fetch|read|query|describe|retrieve|lookup|inbox|select)$/i,
];

const BASH_SIDE_EFFECT_PATTERNS = [
  /\b(rm|mv|cp|mkdir|touch|chmod|chown)\b/i,
  /(^|[^>])>{1,2}[^>]/,
  /\btee\b/i,
  /\bgit\s+(commit|push|merge|rebase|tag)\b/i,
  /\bnpm\s+(install|publish|update)\b/i,
  /\b(?:sf|sfdx)\s+data\s+(update|delete|create|upsert)\b/i,
  /\b(?:sf|sfdx)\s+org\s+(create|delete)\b/i,
  /\bcurl\b.*(?:-X|--request)\s*(POST|PUT|DELETE|PATCH)\b/i,
  /\bpython3?\s+\S*(send|sender|publish|deploy|migrate|push|upload)/i,
];

const BASH_READ_ONLY_PATTERNS = [
  /^\s*(?:pwd|ls|find|rg|grep|sed|awk|cat|head|tail|wc|jq|git\s+(?:status|diff|show|log|branch|rev-parse)|npm\s+(?:view|ls|outdated))\b/i,
];

function tokensForToolName(toolName: string): string[] {
  const withCamelBreaks = toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return withCamelBreaks
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function extractBashCommand(input: Record<string, unknown> | undefined): string {
  return typeof input?.command === 'string' ? input.command : '';
}

export function classifyToolCall(
  toolName: string,
  input?: Record<string, unknown>,
): SideEffectVerdict {
  if (!toolName) return { kind: 'unknown', reason: 'missing-tool-name' };
  if (READ_ONLY_BUILTINS.has(toolName)) {
    return { kind: 'read_only', reason: 'known-readonly-builtin' };
  }
  if (MUTATING_BUILTINS.has(toolName)) {
    return { kind: 'side_effect', reason: 'known-mutating-builtin' };
  }

  if (toolName === 'Bash') {
    const command = extractBashCommand(input);
    for (const re of BASH_SIDE_EFFECT_PATTERNS) {
      if (re.test(command)) return { kind: 'side_effect', reason: 'bash-mutation-pattern' };
    }
    for (const re of BASH_READ_ONLY_PATTERNS) {
      if (re.test(command)) return { kind: 'read_only', reason: 'bash-readonly-pattern' };
    }
    return { kind: 'unknown', reason: 'bash-uncategorized' };
  }

  for (const re of READ_ONLY_MCP_PATTERNS) {
    if (re.test(toolName)) return { kind: 'read_only', reason: 'known-readonly-tool-pattern' };
  }

  const tokens = tokensForToolName(toolName);
  if (tokens.some((token) => SIDE_EFFECT_TOOL_VERBS.has(token))) {
    return { kind: 'side_effect', reason: 'side-effect-verb-match' };
  }
  if (tokens.some((token) => READ_ONLY_TOOL_VERBS.has(token))) {
    return { kind: 'read_only', reason: 'read-only-verb-match' };
  }

  return { kind: 'unknown', reason: 'unclassified-tool-name' };
}

export interface ToolResultSuccess {
  successful: boolean;
  reason: string;
  statusCode?: number;
  error?: string;
}

function parseMaybeJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{"]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeResultPayload(value: unknown): unknown {
  const parsed = parseMaybeJsonString(value);
  if (Array.isArray(parsed) && parsed.length === 1) {
    const first = parsed[0];
    if (first && typeof first === 'object') {
      const obj = first as Record<string, unknown>;
      if (typeof obj.text === 'string') return normalizeResultPayload(obj.text);
      if ('content' in obj) return normalizeResultPayload(obj.content);
    }
  }
  return parsed;
}

function findStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['status_code', 'statusCode', 'status', 'httpStatus', 'code']) {
    const raw = obj[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  for (const key of ['data', 'response', 'result']) {
    const nested = findStatusCode(obj[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['error', 'errors', 'message']) {
    const raw = obj[key];
    if (raw == null || raw === false || raw === '') continue;
    if (typeof raw === 'string') return raw;
    try {
      return JSON.stringify(raw).slice(0, 500);
    } catch {
      return String(raw);
    }
  }
  return undefined;
}

export function isToolResultSuccessful(rawResult: unknown, sdkIsError = false): ToolResultSuccess {
  if (sdkIsError) return { successful: false, reason: 'sdk-is-error' };
  const result = normalizeResultPayload(rawResult);
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (obj.is_error === true || obj.isError === true) {
      return { successful: false, reason: 'tool-result-is-error' };
    }
    if (obj.successful === false || obj.success === false || obj.ok === false) {
      return { successful: false, reason: 'tool-result-success-false', error: findError(obj) };
    }
    const error = findError(obj);
    if (error) return { successful: false, reason: 'tool-result-error-field', error };
    const statusCode = findStatusCode(obj);
    if (statusCode !== undefined) {
      return {
        successful: statusCode >= 200 && statusCode < 300,
        reason: statusCode >= 200 && statusCode < 300 ? 'status-2xx' : 'status-non-2xx',
        statusCode,
      };
    }
  }
  return { successful: true, reason: 'no-error-signal' };
}

export function normalizedToolResultPayload(value: unknown): unknown {
  return normalizeResultPayload(value);
}
