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
  toolCallsMade: number;
  toolNames: string[];
  responsePreview?: string;
  responseChars?: number;
  deliveryStatus: TurnDeliveryStatus;
  errorPreview?: string;
  durationMs: number;
}

export function estimateTokensApprox(text: string): number {
  return Math.ceil(text.length / 4);
}

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
    response,
  ].join('\n');
}
