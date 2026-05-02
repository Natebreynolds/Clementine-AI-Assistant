import { describe, expect, it } from 'vitest';
import { applyAssistantExperienceUpdate, detectLocalTurn } from '../src/agent/local-turn.js';

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

  it('detects standalone greetings', () => {
    expect(detectLocalTurn('hey Clementine!').kind).toBe('greeting');
  });

  it('detects tiny acknowledgments but not approvals', () => {
    expect(detectLocalTurn('thanks').kind).toBe('ack');
    expect(detectLocalTurn('sounds good').kind).toBe('ack');
    expect(detectLocalTurn('yes').kind).toBe('none');
    expect(detectLocalTurn('go').kind).toBe('none');
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
