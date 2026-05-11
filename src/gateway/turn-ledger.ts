import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BASE_DIR } from '../config.js';

export type TurnDeliveryStatus = 'returned' | 'failed';

export interface TurnLedgerEntry {
  id: string;
  createdAt: string;
  sessionKey: string;
  channel: string;
  userMessagePreview: string;
  userMessageChars: number;
  userMessageTokensEstimate: number;
  selectedAgent?: string;
  toolset?: string;
  policyReason?: string;
  retrievalTier?: string;
  toolsEnabled?: boolean;
  toolBundles?: string[];
  actionExpected?: boolean;
  actionExpectationSource?: string;
  actionExpectationReason?: string;
  runId?: string;
  permissionModeApplied?: string;
  allowedToolsApplied?: string[];
  builtinToolsApplied?: string[];
  mcpServersApplied?: string[];
  toolCallsMade: number;
  toolNames: string[];
  responsePreview?: string;
  responseChars?: number;
  deliveryStatus: TurnDeliveryStatus;
  errorPreview?: string;
  durationMs: number;
}

// 1.18.149 — estimateTokensApprox consolidated into the canonical estimateTokens helper.
// Re-exported under the legacy name to keep existing callers working.
import { estimateTokens } from '../lib/format.js';
export const estimateTokensApprox = estimateTokens;

export function turnLedgerPath(baseDir = BASE_DIR): string {
  return path.join(baseDir, 'logs', 'turn-ledger.jsonl');
}

export function appendTurnLedger(entry: TurnLedgerEntry, baseDir = BASE_DIR): void {
  const file = turnLedgerPath(baseDir);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function readRecentTurnLedger(
  sessionKey: string,
  limit = 5,
  baseDir = BASE_DIR,
): TurnLedgerEntry[] {
  const file = turnLedgerPath(baseDir);
  if (!existsSync(file)) return [];
  const out: TurnLedgerEntry[] = [];
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]) as TurnLedgerEntry;
      if (entry.sessionKey === sessionKey) out.push(entry);
    } catch { /* skip malformed entries */ }
  }
  return out;
}

export function formatLastTurnLedger(sessionKey: string, baseDir = BASE_DIR): string {
  const last = readRecentTurnLedger(sessionKey, 1, baseDir)[0];
  if (!last) return "I don't have a recorded previous turn for this chat yet.";

  const action = last.actionExpected
    ? `Action expected: yes (${last.actionExpectationSource ?? 'unknown'}).`
    : 'Action expected: no.';
  const tools = last.toolCallsMade > 0
    ? `Tools used: ${last.toolCallsMade} (${last.toolNames.slice(0, 6).join(', ')}${last.toolNames.length > 6 ? ', ...' : ''}).`
    : 'Tools used: none.';
  const execution = last.permissionModeApplied || last.mcpServersApplied?.length
    ? `Execution: ${last.permissionModeApplied ?? 'unknown'}${last.mcpServersApplied?.length ? `; MCP: ${last.mcpServersApplied.slice(0, 6).join(', ')}${last.mcpServersApplied.length > 6 ? ', ...' : ''}` : ''}.`
    : '';
  const response = last.responsePreview
    ? `Last response: "${last.responsePreview.replace(/\s+/g, ' ').slice(0, 240)}${last.responsePreview.length > 240 ? '...' : ''}"`
    : last.errorPreview
      ? `Error: ${last.errorPreview.slice(0, 240)}`
      : 'No response preview recorded.';

  return [
    `Last turn status: ${last.deliveryStatus}.`,
    action,
    tools,
    `Toolset: ${last.toolset ?? 'auto'}.`,
    `Policy: ${last.policyReason ?? 'unknown'}; tools ${last.toolsEnabled ? 'enabled' : 'disabled'}.`,
    execution,
    response,
  ].filter(Boolean).join('\n');
}
