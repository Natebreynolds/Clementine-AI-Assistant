/**
 * 1.18.187 Part D — claim-verification tests.
 *
 * Pins the contract: when a bg-task's result text contains first-person
 * active-voice action claims ("I deployed X", "I sent the email"), the
 * verifier checks the run's event log for matching tool calls. If
 * absent, the verdict is `claimed-without-evidence`.
 *
 * Tests use the events-injection mode (no real filesystem) so they're
 * fast and isolated.
 */
import { describe, it, expect } from 'vitest';
import { verifyTaskClaims } from '../src/agent/claim-verification.js';
import type { RunEvent } from '../src/types.js';

function toolCall(toolName: string, input?: Record<string, unknown>): RunEvent {
  return {
    runId: 'r1',
    sessionId: 'sess-1',
    seq: 1,
    ts: new Date().toISOString(),
    kind: 'tool_call' as const,
    toolName,
    toolUseId: 'tu_1',
    ...(input ? { toolInput: input } : {}),
  };
}

describe('verifyTaskClaims — no-claims passthrough', () => {
  it('returns ok for empty result', () => {
    const verdict = verifyTaskClaims('', 'r1', { events: [] });
    expect(verdict).toEqual({ ok: true, reason: 'no-claims' });
  });

  it('returns ok for result with no action verbs', () => {
    const verdict = verifyTaskClaims(
      'I looked at the data and it has 100 rows. Want me to summarize?',
      'r1',
      { events: [] },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('no-claims');
  });

  it('returns ok for status references ("X is deployed") — not active claims', () => {
    // Passive voice — not a first-person active claim. Should NOT
    // trigger verification.
    const verdict = verifyTaskClaims(
      'The site is deployed at example.com.',
      'r1',
      { events: [] },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('no-claims');
  });
});

describe('verifyTaskClaims — deploy claims', () => {
  it('flags "I deployed X" when no deploy tool call exists', () => {
    const verdict = verifyTaskClaims(
      'I deployed the site to https://example.netlify.app — all good.',
      'r1',
      { events: [toolCall('Read', { path: '/x' })] },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.reason).toBe('claimed-without-evidence');
      expect(verdict.missingEvidence[0]?.label).toBe('deploy');
    }
  });

  it('passes "I deployed X" when netlify deploy ran in Bash', () => {
    const verdict = verifyTaskClaims(
      'I deployed the site to https://example.netlify.app',
      'r1',
      {
        events: [
          toolCall('Bash', { command: 'netlify deploy --prod --dir output' }),
        ],
      },
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok === true && verdict.reason === 'evidence-found') {
      expect(verdict.matchedClaims[0]?.label).toBe('deploy');
    }
  });

  it('passes "I published X" when project_deploy tool fired', () => {
    const verdict = verifyTaskClaims(
      'I published the report to the production site.',
      'r1',
      { events: [toolCall('project_deploy', { project_path: '/x' })] },
    );
    expect(verdict.ok).toBe(true);
  });

  it('passes "I pushed X" when git push ran', () => {
    const verdict = verifyTaskClaims(
      'I pushed the new commits to main.',
      'r1',
      { events: [toolCall('Bash', { command: 'git push origin main' })] },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('verifyTaskClaims — send claims', () => {
  it('flags "I sent the email" when no send tool ran', () => {
    const verdict = verifyTaskClaims(
      'I sent the briefing email to the team.',
      'r1',
      { events: [toolCall('Read'), toolCall('memory_search')] },
    );
    expect(verdict.ok).toBe(false);
  });

  it('passes "I sent the email" when outlook_send fired', () => {
    const verdict = verifyTaskClaims(
      'I sent the briefing email to the team.',
      'r1',
      { events: [toolCall('outlook_send', { to: 'x@y.com' })] },
    );
    expect(verdict.ok).toBe(true);
  });

  it('passes "I emailed X" when gmail_send fired', () => {
    const verdict = verifyTaskClaims(
      'I emailed the daily summary to nate@example.com',
      'r1',
      { events: [toolCall('gmail_send')] },
    );
    expect(verdict.ok).toBe(true);
  });

  it('passes "I notified X" when discord_send fired', () => {
    const verdict = verifyTaskClaims(
      'I notified the team via Discord.',
      'r1',
      { events: [toolCall('discord_channel_send')] },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('verifyTaskClaims — write/create claims', () => {
  it('flags "I created the new file" when no Write tool ran', () => {
    const verdict = verifyTaskClaims(
      'I created the new index.html in the output folder.',
      'r1',
      { events: [toolCall('Read')] },
    );
    expect(verdict.ok).toBe(false);
  });

  it('passes "I wrote the file" when Write tool fired', () => {
    const verdict = verifyTaskClaims(
      'I wrote the new index.html.',
      'r1',
      { events: [toolCall('Write', { file_path: '/x/index.html' })] },
    );
    expect(verdict.ok).toBe(true);
  });

  it('passes "I saved the file" when shell redirect occurred', () => {
    const verdict = verifyTaskClaims(
      'I saved the new file at /tmp/out.txt.',
      'r1',
      { events: [toolCall('Bash', { command: 'echo "data" > /tmp/out.txt' })] },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('verifyTaskClaims — multiple claims', () => {
  it('all claims must be supported; one missing = flag', () => {
    const verdict = verifyTaskClaims(
      'I built the report and I deployed it to Netlify.',
      'r1',
      { events: [toolCall('Write')] }, // build covered, deploy NOT covered
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.missingEvidence.some((m) => m.label === 'deploy')).toBe(true);
    }
  });

  it('all claims supported = pass', () => {
    const verdict = verifyTaskClaims(
      'I created the file and I deployed it.',
      'r1',
      {
        events: [
          toolCall('Write'),
          toolCall('Bash', { command: 'netlify deploy --prod' }),
        ],
      },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('verifyTaskClaims — exact hallucination pattern', () => {
  it('catches "site is live at URL" with zero deploy tool calls', () => {
    // Adapted slightly because "is live" is passive — the hallucination detector
    // requires active voice. The verifier catches the ACTIVE claim
    // form ("I deployed"); for passive claims, the recall block's
    // ⚠ CLAIM NOT VERIFIED warning + the dispute gate are the second
    // line of defense.
    const verdict = verifyTaskClaims(
      'I deployed the report. The site is live again at https://example-product-site.netlify.app.',
      'r-hallucinated',
      { events: [] }, // no tool calls
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.missingEvidence[0]?.label).toBe('deploy');
    }
  });
});
