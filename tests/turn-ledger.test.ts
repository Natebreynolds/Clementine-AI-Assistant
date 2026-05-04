import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendTurnLedger, formatLastTurnLedger, readRecentTurnLedger } from '../src/gateway/turn-ledger.js';

describe('turn ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-turn-ledger-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records and formats the latest session-scoped turn', () => {
    appendTurnLedger({
      id: 'turn-1',
      createdAt: new Date().toISOString(),
      sessionKey: 'discord:user:123',
      channel: 'Discord DM',
      userMessagePreview: 'Perfect',
      userMessageChars: 7,
      userMessageTokensEstimate: 2,
      selectedAgent: 'clementine',
      policyReason: 'approval-followup',
      retrievalTier: 'search',
      toolsEnabled: true,
      toolBundles: ['email_outlook'],
      actionExpected: true,
      actionExpectationSource: 'approval_followup',
      actionExpectationReason: 'user approved the previous action prompt',
      toolCallsMade: 1,
      toolNames: ['mcp__clementine-tools__outlook_send_email'],
      responsePreview: 'Done. Email sent.',
      responseChars: 17,
      deliveryStatus: 'returned',
      durationMs: 1234,
    }, dir);

    expect(readRecentTurnLedger('discord:user:123', 1, dir)).toHaveLength(1);
    const formatted = formatLastTurnLedger('discord:user:123', dir);
    expect(formatted).toContain('Action expected: yes');
    expect(formatted).toContain('Tools used: 1');
    expect(formatted).toContain('approval-followup');
  });

  it('keeps sessions isolated when reading recent turns', () => {
    appendTurnLedger({
      id: 'turn-1',
      createdAt: new Date().toISOString(),
      sessionKey: 'discord:user:123',
      channel: 'Discord DM',
      userMessagePreview: 'one',
      userMessageChars: 3,
      userMessageTokensEstimate: 1,
      toolCallsMade: 0,
      toolNames: [],
      deliveryStatus: 'returned',
      durationMs: 1,
    }, dir);
    appendTurnLedger({
      id: 'turn-2',
      createdAt: new Date().toISOString(),
      sessionKey: 'discord:user:456',
      channel: 'Discord DM',
      userMessagePreview: 'two',
      userMessageChars: 3,
      userMessageTokensEstimate: 1,
      toolCallsMade: 0,
      toolNames: [],
      deliveryStatus: 'returned',
      durationMs: 1,
    }, dir);

    expect(readRecentTurnLedger('discord:user:123', 5, dir).map(e => e.id)).toEqual(['turn-1']);
  });
});
