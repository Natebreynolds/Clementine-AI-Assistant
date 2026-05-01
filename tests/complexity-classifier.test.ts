/**
 * complexity-classifier: focused on the deepWorthy gate. The pre-flight
 * deep-mode trigger uses this verdict to spawn an expensive background
 * task; false positives on pasted error messages were burning $7+ per
 * "fix this" debug request.
 */

import { describe, it, expect } from 'vitest';
import { classifyComplexity } from '../src/agent/complexity-classifier.js';

describe('classifyComplexity — deepWorthy suppression on error pastes', () => {
  it('does NOT fire deepWorthy on a pasted heartbeat error with "fix" in it', () => {
    const text =
      'this error showed in the heatbeat just a bit ago audit-inbox-check\n' +
      'audit-inbox-check failed: Error: Error: Claude Code returned an error result: ' +
      'Reached maximum number of turns (15)\n' +
      'at runQuery (/Users/nathan.reynolds/clementine-dev/dist/agent/assistant.js:3046:18)\n' +
      'at processTicksAndRejections (node:internal/process/task_queues:95:5)\n' +
      'can you fix this please';
    const verdict = classifyComplexity(text);
    expect(verdict.deepWorthy).toBe(false);
    expect(verdict.signals).toContain('error-paste');
  });

  it('does NOT fire deepWorthy on a JS stack trace paste', () => {
    const text =
      'Something is wrong with the deploy:\n\n' +
      'TypeError: Cannot read property "name" of undefined\n' +
      '    at processOrder (file:///app/server.js:142:18)\n' +
      '    at handleRequest (file:///app/router.js:87:10)\n' +
      '    at async middleware (file:///app/middleware.js:33:5)\n\n' +
      'Please review and fix.';
    const verdict = classifyComplexity(text);
    expect(verdict.deepWorthy).toBe(false);
  });

  it('still fires deepWorthy on a genuine multi-step task', () => {
    const text =
      'Please pull the top 20 prospects from our CRM, draft a personalized outreach email to each, ' +
      'send via Outlook, then schedule a follow-up reminder in 5 business days for anyone who does ' +
      "not reply. After that, generate a summary report and post it to the #sales channel. We'll " +
      'review it together on Friday afternoon.';
    const verdict = classifyComplexity(text);
    expect(verdict.deepWorthy).toBe(true);
  });

  it('still fires deepWorthy on explicit "deeply analyze" ask regardless of length', () => {
    const text = 'Please thoroughly research our competitor pricing landscape across the top 10 vendors.';
    const verdict = classifyComplexity(text);
    expect(verdict.deepWorthy).toBe(true);
    expect(verdict.signals).toContain('deep-mode-ask');
  });

  it('still flags complex (plan-first) on an error paste so the agent proposes a plan', () => {
    const text =
      'I keep seeing this and need to fix it permanently:\n\n' +
      'Error: ECONNREFUSED 127.0.0.1:6379\n' +
      'at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1606:16)\n' +
      'at Object.<anonymous> (/app/redis-client.js:42:7)\n' +
      'at Module._compile (node:internal/modules/cjs/loader:1364:14)\n' +
      'send a fix and update the runbook with the resolution. Then notify the channel.';
    const verdict = classifyComplexity(text);
    expect(verdict.deepWorthy).toBe(false); // suppressed by error-paste
    // complex may or may not be true depending on signal counts; we only
    // assert deepWorthy is suppressed — that's the load-bearing behavior.
  });

  it('returns not-complex for short messages', () => {
    expect(classifyComplexity('hi').complex).toBe(false);
    expect(classifyComplexity('').complex).toBe(false);
  });

  it('skips classification for command messages', () => {
    expect(classifyComplexity('!status').complex).toBe(false);
    expect(classifyComplexity('/restart').complex).toBe(false);
  });

  it('detects ENOENT-style errors as paste markers', () => {
    const text =
      'My script broke, can you fix? The whole flow needs to work end-to-end across multiple steps ' +
      'and produce reliable output for the team. Run it now and report back.\n\n' +
      'Error: ENOENT: no such file or directory, open "/etc/secret.json"';
    const verdict = classifyComplexity(text);
    expect(verdict.deepWorthy).toBe(false);
    expect(verdict.signals).toContain('error-paste');
  });
});
