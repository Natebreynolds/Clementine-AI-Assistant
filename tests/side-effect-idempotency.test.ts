import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

vi.hoisted(() => {
  process.env.CLEMENTINE_HOME = `/private/tmp/clementine-idempotency-${process.pid}`;
});

import {
  appendSideEffectRecord,
  buildSideEffectFingerprint,
  buildSideEffectIdempotencyHook,
  findPriorSuccessfulSideEffect,
  readRecentSideEffectRecords,
  type SideEffectIdempotencyRecord,
} from '../src/agent/side-effect-idempotency.js';

const BASE_NOW = Date.parse('2026-05-12T21:00:00.000Z');
const emailInput = {
  to: 'Kevin <kevin@example.com>',
  subject: 'Denver legal search',
  body: '<p>Hello Kevin</p>',
};

function record(overrides: Partial<SideEffectIdempotencyRecord> = {}): SideEffectIdempotencyRecord {
  const fp = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', emailInput)!;
  return {
    version: 1,
    ts: '2026-05-12T21:00:00.000Z',
    runId: 'run-a',
    toolName: 'mcp__gmail__GMAIL_SEND_EMAIL',
    toolUseId: 'send-1',
    kind: fp.kind,
    fingerprint: fp.fingerprint,
    ttlMs: fp.ttlMs,
    summary: fp.summary,
    details: fp.details,
    result: { successReason: 'status-2xx', statusCode: 202, logId: 'log_1' },
    ...overrides,
  };
}

function preHook(hook = buildSideEffectIdempotencyHook({ runId: 'run-b', now: () => BASE_NOW + 60_000 })) {
  return hook.hooks.PreToolUse![0]!.hooks[0]!;
}

function postHook(hook = buildSideEffectIdempotencyHook({ runId: 'run-a', now: () => BASE_NOW })) {
  return hook.hooks.PostToolUse![0]!.hooks[0]!;
}

function idempotencyFile(): string {
  return path.join(process.env.CLEMENTINE_HOME!, 'idempotency', 'recent-side-effects.jsonl');
}

describe('side-effect idempotency guard', () => {
  beforeEach(() => {
    rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
  });

  describe('email fingerprints', () => {
    it('normalizes to/cc/bcc by lowercase and sort order', () => {
      const a = buildSideEffectFingerprint('mcp__outlook__OUTLOOK_SEND_EMAIL', {
        to: ['Zoe <ZOE@example.com>', 'amy@example.com'],
        cc: ['boss@example.com', 'ALPHA@example.com'],
        bcc: ['hidden2@example.com', 'hidden1@example.com'],
        subject: 'Denver legal search',
        body: 'Hello Kevin',
      });
      const b = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', {
        toRecipients: ['AMY@example.com', 'zoe@example.com'],
        ccRecipients: ['alpha@example.com', 'boss@example.com'],
        bccRecipients: ['hidden1@example.com', 'hidden2@example.com'],
        title: 'Denver legal search',
        htmlBody: 'Hello Kevin',
      });

      expect(a?.kind).toBe('email_send');
      expect(b?.fingerprint).toBe(a?.fingerprint);
      expect(a?.details).toMatchObject({
        to: ['amy@example.com', 'zoe@example.com'],
        cc: ['alpha@example.com', 'boss@example.com'],
        bcc: ['hidden1@example.com', 'hidden2@example.com'],
      });
    });

    it('keeps harmless body whitespace and subject case from changing the fingerprint', () => {
      const a = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', {
        to: 'kevin@example.com',
        subject: 'Denver Legal Search',
        body: 'Hi Kevin,\n\nBest,\nAlex',
      });
      const b = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', {
        to: 'KEVIN@example.com',
        subject: 'denver legal search',
        body: 'Hi   Kevin, Best, Alex',
      });

      expect(b?.fingerprint).toBe(a?.fingerprint);
    });

    it('changes the fingerprint when body content changes', () => {
      const a = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', emailInput);
      const b = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', {
        ...emailInput,
        body: '<p>Hello Kevin, different follow-up.</p>',
      });

      expect(a?.fingerprint).not.toBe(b?.fingerprint);
    });

    it('requires recipient, subject, and body', () => {
      expect(buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', { to: 'kevin@example.com', subject: 'x' })).toBeNull();
      expect(buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', { subject: 'x', body: 'y' })).toBeNull();
      expect(buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', { to: 'kevin@example.com', body: 'y' })).toBeNull();
    });

    it('supports flat and nested provider shapes', () => {
      const flat = buildSideEffectFingerprint('mcp__composio__OUTLOOK_SEND_EMAIL', {
        to: 'kevin@example.com',
        subject: 'Denver legal search',
        body: 'Hello Kevin',
      });
      const nested = buildSideEffectFingerprint('mcp__outlook__OUTLOOK_SEND_EMAIL', {
        recipients: [{ emailAddress: { address: 'Kevin@Example.com' } }],
        message: {
          subject: 'Denver legal search',
          body: { content: 'Hello Kevin' },
        },
      });

      expect(flat?.kind).toBe('email_send');
      expect(nested?.fingerprint).toBe(flat?.fingerprint);
    });
  });

  describe('CRM fingerprints', () => {
    it('hashes Salesforce updates deterministically from object, recordId, and fields', () => {
      const a = buildSideEffectFingerprint('mcp__salesforce__UPDATE_RECORD', {
        object: 'Contact',
        recordId: '003abc',
        fields: { Outreach_Status__c: 'Sent', Touch__c: 2 },
      });
      const b = buildSideEffectFingerprint('mcp__salesforce__UPDATE_RECORD', {
        record_id: '003ABC',
        objectName: 'contact',
        values: { Touch__c: 2, Outreach_Status__c: 'Sent' },
      });

      expect(a?.kind).toBe('crm_mutation');
      expect(b?.fingerprint).toBe(a?.fingerprint);
      expect(a?.summary).toContain('Contact 003abc');
    });

    it('requires record identity for update/delete/upsert but not create', () => {
      expect(buildSideEffectFingerprint('mcp__salesforce__UPDATE_RECORD', {
        object: 'Contact',
        fields: { x: 1 },
      })).toBeNull();
      expect(buildSideEffectFingerprint('mcp__salesforce__CREATE_RECORD', {
        object: 'Task',
        fields: { Subject: 'Touch 2', WhoId: '003abc' },
      })?.kind).toBe('crm_mutation');
    });

    it('detects provider-neutral CRM mutation tools', () => {
      expect(buildSideEffectFingerprint('mcp__hubspot__UPDATE_CONTACT', {
        object: 'Contact',
        recordId: '123',
        properties: { lifecycleStage: 'lead' },
      })?.kind).toBe('crm_mutation');
      expect(buildSideEffectFingerprint('mcp__pipedrive__DELETE_DEAL', {
        object: 'Deal',
        id: '456',
      })?.kind).toBe('crm_mutation');
    });
  });

  describe('Salesforce CLI Bash fingerprints', () => {
    it('matches narrow sf/sfdx data mutation commands', () => {
      for (const command of [
        'sf data update record --sobject Contact --record-id 003abc --values Status=Sent',
        'sf data delete record --sobject Contact --record-id 003abc',
        'sf data create record --sobject Task --values Subject=Touch2',
        'sf data upsert bulk --sobject Contact --file contacts.csv',
        'sfdx data update record --sobject Contact --record-id 003abc --values Status=Sent',
      ]) {
        expect(buildSideEffectFingerprint('Bash', { command })?.kind).toBe('crm_mutation');
      }
    });

    it('does not match read-only sf data query commands', () => {
      expect(buildSideEffectFingerprint('Bash', { command: 'sf data query --query "SELECT Id FROM Contact LIMIT 1"' })).toBeNull();
    });
  });

  describe('PreToolUse hook', () => {
    it('allows novel calls and non-fingerprinted tools', async () => {
      const hook = buildSideEffectIdempotencyHook({ runId: 'run-a', now: () => BASE_NOW });
      const pre = preHook(hook);

      const novel = await pre({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__gmail__GMAIL_SEND_EMAIL',
        tool_input: emailInput,
        tool_use_id: 'send-1',
      } as never, undefined, {} as never);
      const readOnly = await pre({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__dataforseo__SEARCH',
        tool_input: { q: 'denver lawyers' },
        tool_use_id: 'search-1',
      } as never, undefined, {} as never);

      expect(novel).toEqual({});
      expect(readOnly).toEqual({});
      expect(hook.stats.guarded).toBe(1);
      expect(hook.stats.skipped).toBe(1);
    });

    it('blocks duplicate successful side effects within TTL with structured guidance', async () => {
      appendSideEffectRecord(record());
      const hook = buildSideEffectIdempotencyHook({ runId: 'run-b', now: () => BASE_NOW + 60_000 });
      const output = await preHook(hook)({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
        tool_input: emailInput,
        tool_use_id: 'send-2',
      } as never, undefined, {} as never);

      expect(hook.stats.blocked).toBe(1);
      expect(output.hookSpecificOutput && 'permissionDecision' in output.hookSpecificOutput
        ? output.hookSpecificOutput.permissionDecision
        : undefined).toBe('deny');
      const reason = output.hookSpecificOutput && 'permissionDecisionReason' in output.hookSpecificOutput
        ? String(output.hookSpecificOutput.permissionDecisionReason)
        : '';
      expect(reason).toContain('"operation_already_succeeded":true');
      expect(reason).toContain('"duplicate-of-prior-call"');
      expect(reason).toContain('Continue with remaining follow-up');
    });

    it('allows the same operation after the TTL expires', async () => {
      appendSideEffectRecord(record());
      const hook = buildSideEffectIdempotencyHook({ runId: 'run-b', now: () => BASE_NOW + (25 * 60 * 60 * 1000) });
      const output = await preHook(hook)({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__gmail__GMAIL_SEND_EMAIL',
        tool_input: emailInput,
        tool_use_id: 'send-2',
      } as never, undefined, {} as never);

      expect(output).toEqual({});
      expect(hook.stats.blocked).toBe(0);
    });
  });

  describe('PostToolUse hook', () => {
    it('records successful tool results and extracts provider log IDs', async () => {
      const hook = buildSideEffectIdempotencyHook({ runId: 'run-a', now: () => BASE_NOW });
      await postHook(hook)({
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
        tool_input: emailInput,
        tool_response: { successful: true, error: null, data: { status_code: 202 }, logId: 'log_1' },
        tool_use_id: 'send-1',
      } as never, undefined, {} as never);

      const records = readRecentSideEffectRecords(undefined, BASE_NOW + 1);
      expect(hook.stats.recorded).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]!.result).toMatchObject({ statusCode: 202, logId: 'log_1' });
    });

    it('does not record failed tool results', async () => {
      const cases = [
        { is_error: true },
        { successful: false, error: 'bad request', data: { status_code: 400 } },
        { successful: true, error: null, data: { status_code: 500 } },
      ];
      for (const tool_response of cases) {
        const hook = buildSideEffectIdempotencyHook({ runId: 'run-a', now: () => BASE_NOW });
        await postHook(hook)({
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__outlook__OUTLOOK_SEND_EMAIL',
          tool_input: emailInput,
          tool_response,
          tool_use_id: `send-${hook.stats.failedNotRecorded + 1}`,
        } as never, undefined, {} as never);
        expect(hook.stats.failedNotRecorded).toBe(1);
      }
      expect(readRecentSideEffectRecords(undefined, BASE_NOW + 1)).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('persists JSONL records and filters TTL-expired entries', () => {
      const fp = buildSideEffectFingerprint('mcp__gmail__GMAIL_SEND_EMAIL', emailInput)!;
      appendSideEffectRecord(record());

      expect(existsSync(idempotencyFile())).toBe(true);
      expect(readFileSync(idempotencyFile(), 'utf-8')).toContain('"fingerprint"');
      expect(readRecentSideEffectRecords(undefined, BASE_NOW + 60_000)).toHaveLength(1);
      expect(findPriorSuccessfulSideEffect(fp, { now: BASE_NOW + 60_000 })?.runId).toBe('run-a');
      expect(readRecentSideEffectRecords(undefined, BASE_NOW + (25 * 60 * 60 * 1000))).toHaveLength(0);
      expect(findPriorSuccessfulSideEffect(fp, { now: BASE_NOW + (25 * 60 * 60 * 1000) })).toBeNull();
    });

    it('prunes the JSONL store to the most recent records after overflow', () => {
      const padded = 'x'.repeat(600);
      mkdirSync(path.dirname(idempotencyFile()), { recursive: true });
      const seededLines: string[] = [];
      for (let i = 0; i < 5105; i += 1) {
        seededLines.push(JSON.stringify(record({
          ts: new Date(BASE_NOW + i).toISOString(),
          runId: `run-${i}`,
          toolUseId: `send-${i}`,
          details: { ...record().details, padded, index: i },
          fingerprint: `email_send:${i}`,
          summary: `email send ${i}`,
        })));
      }
      writeFileSync(idempotencyFile(), seededLines.join('\n') + '\n');

      appendSideEffectRecord(record({
        ts: new Date(BASE_NOW + 5105).toISOString(),
        runId: 'run-final',
        toolUseId: 'send-final',
        details: { ...record().details, padded, index: 5105 },
        fingerprint: 'email_send:final',
        summary: 'email send final',
      }));

      const lines = readFileSync(idempotencyFile(), 'utf-8').trim().split('\n');
      expect(lines.length).toBeLessThanOrEqual(5000);
      expect(lines.at(-1)).toContain('"runId":"run-final"');
    });
  });
});
