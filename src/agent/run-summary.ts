/**
 * Run summaries derived from the durable Clementine event log.
 *
 * The event log is the source of truth for "what actually fired" during an
 * SDK run. This module turns raw tool_call/tool_result rows into a compact,
 * provider-neutral summary that chat overflow recovery can show to the owner
 * and feed back into a fresh continuation prompt.
 */

import { EventLog } from '../gateway/event-log.js';
import type { RunEvent } from '../types.js';
import {
  classifyToolCall,
  isToolResultSuccessful,
  normalizedToolResultPayload,
  type SideEffectVerdict,
  type ToolResultSuccess,
} from './side-effect-classifier.js';

export interface SideEffectCall {
  runId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  timestamp: string;
  verdict: SideEffectVerdict;
  result?: {
    successful: boolean;
    raw: unknown;
    reason: string;
    statusCode?: number;
    error?: string;
  };
}

export interface RunSummary {
  runIds: string[];
  sessionIds: string[];
  totalEvents: number;
  successfulSideEffects: SideEffectCall[];
  failedSideEffects: SideEffectCall[];
  pendingSideEffects: SideEffectCall[];
  unknownEffectCalls: SideEffectCall[];
  successfulDelegations: SideEffectCall[];
  failedDelegations: SideEffectCall[];
  pendingDelegations: SideEffectCall[];
  readOnlyCount: number;
  errors: Array<{ runId: string; ts: string; message: string }>;
  lastAssistantText?: string;
  ended: 'session_end' | 'error' | 'in_progress';
}

type ToolCallEvent = RunEvent & {
  kind: 'tool_call';
  toolName: string;
  toolUseId: string;
};

function uniqueRunIds(runIds: string | string[]): string[] {
  const raw = Array.isArray(runIds) ? runIds : [runIds];
  const out: string[] = [];
  for (const id of raw) {
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function asInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isToolCall(event: RunEvent): event is ToolCallEvent {
  return event.kind === 'tool_call'
    && typeof event.toolName === 'string'
    && typeof event.toolUseId === 'string'
    && !!event.toolName
    && !!event.toolUseId;
}

function resultForToolUse(events: RunEvent[], toolUseId: string): RunEvent | undefined {
  return events.find((event) => event.kind === 'tool_result' && event.toolUseId === toolUseId);
}

function summarizeResult(result: RunEvent | undefined): ToolResultSuccess | undefined {
  if (!result) return undefined;
  return isToolResultSuccessful(result.toolResult, !!result.toolError);
}

function makeCall(call: ToolCallEvent, result: RunEvent | undefined, verdict: SideEffectVerdict): SideEffectCall {
  const success = summarizeResult(result);
  return {
    runId: call.runId,
    toolName: call.toolName,
    toolUseId: call.toolUseId,
    input: asInput(call.toolInput),
    timestamp: call.ts,
    verdict,
    ...(success ? {
      result: {
        successful: success.successful,
        raw: normalizedToolResultPayload(result?.toolResult),
        reason: success.reason,
        ...(success.statusCode !== undefined ? { statusCode: success.statusCode } : {}),
        ...(success.error ? { error: success.error } : {}),
      },
    } : {}),
  };
}

export function summarizeRunSideEffects(
  runIds: string | string[],
  eventLog: EventLog = new EventLog(),
): RunSummary {
  const ids = uniqueRunIds(runIds);
  const events = ids.flatMap((runId) => eventLog.readByRun(runId));
  const sessionIds = Array.from(new Set(events.map((event) => event.sessionId).filter((id): id is string => !!id)));
  const successfulSideEffects: SideEffectCall[] = [];
  const failedSideEffects: SideEffectCall[] = [];
  const pendingSideEffects: SideEffectCall[] = [];
  const unknownEffectCalls: SideEffectCall[] = [];
  const successfulDelegations: SideEffectCall[] = [];
  const failedDelegations: SideEffectCall[] = [];
  const pendingDelegations: SideEffectCall[] = [];
  let readOnlyCount = 0;

  for (const call of events.filter(isToolCall)) {
    const verdict = classifyToolCall(call.toolName, asInput(call.toolInput));
    const result = resultForToolUse(events, call.toolUseId);
    const item = makeCall(call, result, verdict);
    if (call.toolName === 'Agent') {
      if (!result) pendingDelegations.push(item);
      else if (item.result?.successful) successfulDelegations.push(item);
      else failedDelegations.push(item);
      continue;
    }
    if (verdict.kind === 'read_only') {
      readOnlyCount += 1;
      continue;
    }
    if (verdict.kind === 'unknown') {
      unknownEffectCalls.push(item);
      continue;
    }
    if (!result) {
      pendingSideEffects.push(item);
      continue;
    }
    if (item.result?.successful) successfulSideEffects.push(item);
    else failedSideEffects.push(item);
  }

  const errors = events
    .filter((event) => event.kind === 'error' || event.toolError)
    .map((event) => ({
      runId: event.runId,
      ts: event.ts,
      message: String(event.toolError ?? event.text ?? 'error').slice(0, 500),
    }));
  const lastAssistantText = [...events]
    .reverse()
    .find((event) => event.kind === 'llm_text' && typeof event.text === 'string' && event.text.trim())
    ?.text;
  const ended = events.some((event) => event.kind === 'session_end')
    ? 'session_end'
    : errors.length > 0 ? 'error' : 'in_progress';

  return {
    runIds: ids,
    sessionIds,
    totalEvents: events.length,
    successfulSideEffects,
    failedSideEffects,
    pendingSideEffects,
    unknownEffectCalls,
    successfulDelegations,
    failedDelegations,
    pendingDelegations,
    readOnlyCount,
    errors,
    ...(lastAssistantText ? { lastAssistantText } : {}),
    ended,
  };
}

export function hasOperationalActivity(summary: RunSummary): boolean {
  return summary.successfulSideEffects.length > 0
    || summary.failedSideEffects.length > 0
    || summary.pendingSideEffects.length > 0
    || summary.unknownEffectCalls.length > 0
    || summary.successfulDelegations.length > 0
    || summary.failedDelegations.length > 0
    || summary.pendingDelegations.length > 0;
}

function toolKindLabel(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes('email') || lower.includes('gmail') || lower.includes('outlook') || lower.includes('send_email')) {
    return 'email sends';
  }
  if (lower.includes('salesforce') || lower.includes('__sf_') || lower.includes('sfdc')) {
    return 'CRM mutations';
  }
  if (toolName === 'Bash') return 'Bash commands';
  return toolName;
}

function groupCounts(calls: SideEffectCall[]): Array<{ label: string; count: number; calls: SideEffectCall[] }> {
  const map = new Map<string, SideEffectCall[]>();
  for (const call of calls) {
    const label = toolKindLabel(call.toolName);
    map.set(label, [...(map.get(label) ?? []), call]);
  }
  return Array.from(map.entries()).map(([label, grouped]) => ({ label, count: grouped.length, calls: grouped }));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        return [firstString(obj.email, obj.address, obj.mail, obj.name)].filter((v): v is string => !!v);
      }
      return [];
    })
    .filter(Boolean);
}

export function extractRecipients(input: Record<string, unknown>): string[] {
  const direct = [
    ...arrayStrings(input.to),
    ...arrayStrings(input.toRecipients),
    ...arrayStrings(input.recipients),
    ...arrayStrings(input.cc),
    ...arrayStrings(input.bcc),
  ];
  const singles = [
    firstString(input.to, input.recipient, input.email, input.to_email, input.toEmail),
  ].filter((v): v is string => !!v);
  return Array.from(new Set([...direct, ...singles]));
}

function extractSubject(input: Record<string, unknown>): string | undefined {
  return firstString(input.subject, input.title);
}

function extractFilePath(input: Record<string, unknown>, raw?: unknown): string | undefined {
  return firstString(input.file_path, input.filePath, input.path, input.target_path, input.targetPath)
    ?? (raw && typeof raw === 'object'
      ? firstString(
          (raw as Record<string, unknown>).filePath,
          (raw as Record<string, unknown>).file_path,
          (raw as Record<string, unknown>).path,
        )
      : undefined);
}

function extractProviderLogId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  return firstString(obj.logId, obj.log_id, obj.id)
    ?? (obj.data && typeof obj.data === 'object' ? extractProviderLogId(obj.data) : undefined);
}

function statusPhrase(call: SideEffectCall): string {
  const status = call.result?.statusCode;
  if (status && toolKindLabel(call.toolName) === 'email sends') return `accepted (${status})`;
  if (status) return `succeeded (${status})`;
  return 'succeeded';
}

function recipientPreview(calls: SideEffectCall[], max = 3): string {
  const recipients = calls.flatMap((call) => extractRecipients(call.input));
  if (recipients.length === 0) return '';
  const shown = recipients.slice(0, max);
  const rest = recipients.length - shown.length;
  return ` (${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''})`;
}

function formatGroupedLines(prefix: string, calls: SideEffectCall[]): string[] {
  return groupCounts(calls).map((group) => `- ${group.count} ${group.label} ${prefix}${recipientPreview(group.calls)}`);
}

function collectResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectResultText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  return ['text', 'content', 'result', 'message']
    .map((key) => collectResultText(obj[key]))
    .filter(Boolean)
    .join('\n');
}

function extractAgentArchivePath(text: string): string | undefined {
  return text.match(/Full payload archived at `([^`]+)`/)?.[1]
    ?? text.match(/Full output:\s*([^\n]+)/)?.[1]?.trim();
}

function extractAgentId(text: string): string | undefined {
  return text.match(/\bagentId:\s*([a-zA-Z0-9_-]+)/)?.[1];
}

function formatDelegationCall(call: SideEffectCall, status: string): string {
  const description = firstString(call.input.description, call.input.task, call.input.prompt)?.slice(0, 120);
  const subagentType = firstString(call.input.subagent_type, call.input.subagentType);
  const resultText = call.result ? collectResultText(call.result.raw) : '';
  const agentId = extractAgentId(resultText);
  const archivePath = extractAgentArchivePath(resultText);
  const pieces = [
    subagentType ? `${subagentType} subagent` : 'subagent',
    status,
    description ? `for "${description}"` : undefined,
    agentId ? `agentId ${agentId}` : undefined,
    archivePath ? `archive ${archivePath}` : undefined,
  ].filter(Boolean);
  return `- ${pieces.join(' · ')}`;
}

export function formatOverflowRecoveryMessage(summary: RunSummary): string {
  const lines: string[] = [
    'That run hit the context limit after some work had already happened.',
    '',
  ];
  if (summary.successfulSideEffects.length > 0) {
    lines.push('Completed before overflow:');
    lines.push(...formatGroupedLines('completed', summary.successfulSideEffects));
    lines.push('');
  }
  if (summary.successfulDelegations.length > 0) {
    lines.push('Delegated work completed before overflow:');
    for (const call of summary.successfulDelegations.slice(0, 5)) lines.push(formatDelegationCall(call, 'completed'));
    if (summary.successfulDelegations.length > 5) lines.push(`- ...and ${summary.successfulDelegations.length - 5} more completed subagent calls`);
    lines.push('');
  }
  if (
    summary.failedSideEffects.length > 0
    || summary.pendingSideEffects.length > 0
    || summary.unknownEffectCalls.length > 0
    || summary.failedDelegations.length > 0
    || summary.pendingDelegations.length > 0
  ) {
    lines.push('Needs attention:');
    if (summary.failedSideEffects.length > 0) lines.push(...formatGroupedLines('failed', summary.failedSideEffects));
    if (summary.pendingSideEffects.length > 0) lines.push(...formatGroupedLines('started, no confirmation', summary.pendingSideEffects));
    for (const call of summary.failedDelegations.slice(0, 5)) lines.push(formatDelegationCall(call, 'failed'));
    for (const call of summary.pendingDelegations.slice(0, 5)) lines.push(formatDelegationCall(call, 'started, no confirmation'));
    if (summary.unknownEffectCalls.length > 0) lines.push(`- ${summary.unknownEffectCalls.length} tool call(s) had unknown external effect`);
    lines.push('');
  }
  if (summary.readOnlyCount > 0) {
    lines.push(`Read-only tool calls before overflow: ${summary.readOnlyCount}`);
    lines.push('');
  }
  lines.push('Reply `continue` within 30 minutes to resume from this state, or `done` to stop here.');
  return lines.join('\n').slice(0, 1900);
}

function formatDetailedCall(call: SideEffectCall): string {
  const recipients = extractRecipients(call.input);
  const subject = extractSubject(call.input);
  const filePath = extractFilePath(call.input, call.result?.raw);
  const logId = call.result ? extractProviderLogId(call.result.raw) : undefined;
  const parts = [
    toolKindLabel(call.toolName),
    filePath ? `file ${filePath}` : undefined,
    recipients.length ? `to ${recipients.join(', ')}` : undefined,
    subject ? `subject "${subject}"` : undefined,
    call.result ? statusPhrase(call) : 'started, no confirmation',
    logId ? `logId ${logId}` : undefined,
    `run ${call.runId}`,
  ].filter(Boolean);
  return `- ${parts.join(' · ')}`;
}

export function buildContinuationPrompt(summary: RunSummary, originalRequest: string): string {
  const lines: string[] = [];
  lines.push('[Resume context — read this before taking any action]');
  lines.push(`The previous SDK run(s) hit a context limit: ${summary.runIds.join(', ')}`);
  lines.push('Some tool calls may already have changed external state. DO NOT re-run completed side effects.');
  lines.push('');
  if (summary.successfulSideEffects.length > 0) {
    lines.push('Completed side effects:');
    for (const call of summary.successfulSideEffects.slice(0, 80)) lines.push(formatDetailedCall(call));
    if (summary.successfulSideEffects.length > 80) lines.push(`- ...and ${summary.successfulSideEffects.length - 80} more completed side effects in the event log.`);
    lines.push('');
  }
  if (summary.successfulDelegations.length > 0) {
    lines.push('Completed delegated work. Do not repeat discovery/research already done unless the archive is insufficient:');
    for (const call of summary.successfulDelegations.slice(0, 20)) lines.push(formatDelegationCall(call, 'completed'));
    lines.push('');
  }
  if (summary.failedSideEffects.length > 0) {
    lines.push('Failed side effects that may need retry or reconciliation:');
    for (const call of summary.failedSideEffects.slice(0, 30)) lines.push(formatDetailedCall(call));
    lines.push('');
  }
  if (summary.pendingSideEffects.length > 0) {
    lines.push('Side-effect calls that started but had no confirmation. Check before retrying:');
    for (const call of summary.pendingSideEffects.slice(0, 30)) lines.push(formatDetailedCall(call));
    lines.push('');
  }
  if (summary.unknownEffectCalls.length > 0) {
    lines.push(`Unknown-effect tool calls: ${summary.unknownEffectCalls.length}. Treat these cautiously and inspect if relevant.`);
    lines.push('');
  }
  lines.push('Original owner request:');
  lines.push(originalRequest);
  lines.push('');
  lines.push('Continue from where the previous run stopped. Focus on remaining follow-up, cleanup, reconciliation, or status reporting. DO NOT re-find inputs or re-execute completed sends/updates/deletes.');
  lines.push('[/Resume context]');
  return lines.join('\n');
}
