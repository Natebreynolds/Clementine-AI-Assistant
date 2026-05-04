import { describe, expect, it } from 'vitest';
import { applyAssistantExperienceUpdate, detectApprovalReply, detectLocalTurn, isCompressContextRequest, isLastActionRequest, looksLikeApprovalPrompt } from '../src/agent/local-turn.js';

describe('local turn detection', () => {
  it('detects stop requests without sending them through the SDK', () => {
    expect(detectLocalTurn('stop').kind).toBe('stop');
    expect(detectLocalTurn('never mind').kind).toBe('stop');
    expect(detectLocalTurn('stop by the store later and get milk').kind).toBe('none');
  });

  it('detects status requests', () => {
    expect(detectLocalTurn("what's going on").kind).toBe('status');
    expect(detectLocalTurn('anything running?').kind).toBe('status');
  });

  it('detects last-action diagnostics', () => {
    expect(detectLocalTurn('last action').kind).toBe('last_action');
    expect(detectLocalTurn('did you actually do it?').kind).toBe('last_action');
    expect(isLastActionRequest('what happened last turn')).toBe(true);
  });

  it('detects context and toolset controls', () => {
    expect(detectLocalTurn('compress context').kind).toBe('compress_context');
    expect(isCompressContextRequest('reset context but keep memory')).toBe(true);
    const turn = detectLocalTurn('toolset diagnostic');
    expect(turn.kind).toBe('toolset');
    if (turn.kind === 'toolset') expect(turn.toolset).toBe('diagnostic');
  });

  it('detects standalone greetings', () => {
    expect(detectLocalTurn('hey Clementine!').kind).toBe('greeting');
  });

  it('detects tiny acknowledgments but not approvals', () => {
    expect(detectLocalTurn('thanks').kind).toBe('ack');
    expect(detectLocalTurn('sounds good').kind).toBe('ack');
    expect(detectLocalTurn('yes').kind).toBe('none');
    expect(detectLocalTurn('go').kind).toBe('none');
  });

  it('classifies approval replies separately from generic acknowledgments', () => {
    expect(detectApprovalReply('perfect')).toBe(true);
    expect(detectApprovalReply('sounds good')).toBe(true);
    expect(detectApprovalReply('okay')).toBe(true);
    expect(detectApprovalReply('send it')).toBe(true);
    expect(detectApprovalReply('always')).toBe('always');
    expect(detectApprovalReply('nope')).toBe(false);
    expect(detectApprovalReply('thanks')).toBeNull();
  });

  it('detects assistant prompts asking for approval', () => {
    expect(looksLikeApprovalPrompt('Good to go?')).toBe(true);
    expect(looksLikeApprovalPrompt("Before I fire it off, here's what I'd send.\n\nGood to go?")).toBe(true);
    expect(looksLikeApprovalPrompt('Done. Email sent and queued.')).toBe(false);
  });

  it('extracts assistant experience preferences', () => {
    const turn = detectLocalTurn('be more proactive and keep me posted with more updates');
    expect(turn.kind).toBe('preference_update');
    if (turn.kind !== 'preference_update') return;
    expect(turn.updates.proactivity).toBe('proactive');
    expect(turn.updates.progressVisibility).toBe('detailed');
  });

  it('applies experience updates without dropping existing assistant prefs', () => {
    const next = applyAssistantExperienceUpdate(
      { schemaVersion: 1, assistant: { responseStyle: 'concise' } },
      { proactivity: 'operator' },
    );
    expect(next.assistant?.responseStyle).toBe('concise');
    expect(next.assistant?.proactivity).toBe('operator');
  });
});
