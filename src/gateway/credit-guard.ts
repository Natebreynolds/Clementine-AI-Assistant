import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export interface CreditBlock {
  until: string;
  reason: string;
}

const CREDIT_BLOCK_FILE = path.join(BASE_DIR, 'cron', 'credit-block.json');
const DEFAULT_BLOCK_MS = 6 * 60 * 60 * 1000;

export function isCreditBalanceError(err: unknown): boolean {
  const msg = String(err ?? '');
  return /credit balance is too low|credit balance.*too low|insufficient credits?|billing.*credits?|account.*credits?.*low|monthly usage limit|org'?s monthly usage limit|organization'?s monthly usage limit|hit your .*usage limit|usage limit.*(?:reached|exceeded|hit|active)|usage or credit limit|credit limit is active|spending limit|billing limit/i.test(msg);
}

export function getBackgroundCreditBlock(nowMs = Date.now()): CreditBlock | null {
  try {
    if (!existsSync(CREDIT_BLOCK_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CREDIT_BLOCK_FILE, 'utf-8')) as CreditBlock;
    const untilMs = Date.parse(parsed.until);
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
      unlinkSync(CREDIT_BLOCK_FILE);
      return null;
    }
    return parsed;
  } catch {
    try { unlinkSync(CREDIT_BLOCK_FILE); } catch { /* ignore */ }
    return null;
  }
}

export function markBackgroundCreditBlocked(err: unknown, nowMs = Date.now()): { block: CreditBlock; created: boolean } {
  const existing = getBackgroundCreditBlock(nowMs);
  if (existing) return { block: existing, created: false };

  const reason = String(err ?? 'Claude credit balance is too low').replace(/\s+/g, ' ').slice(0, 300);
  const block: CreditBlock = {
    until: new Date(nowMs + DEFAULT_BLOCK_MS).toISOString(),
    reason,
  };
  mkdirSync(path.dirname(CREDIT_BLOCK_FILE), { recursive: true });
  writeFileSync(CREDIT_BLOCK_FILE, JSON.stringify(block, null, 2));
  return { block, created: true };
}

export function formatCreditBlock(block: CreditBlock): string {
  return `Claude account usage or credit limit is active. Background jobs are paused until ${block.until}.`;
}
