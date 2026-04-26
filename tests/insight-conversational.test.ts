/**
 * Phase 10 — conversational insight signal detectors.
 *
 * Pure-function tests for detectFrustrationSignals + detectRepeatedTopics.
 * No DB or daemon required.
 */

import { describe, expect, it } from 'vitest';
import { detectFrustrationSignals, detectRepeatedTopics } from '../src/agent/insight-engine.js';

interface Entry { sessionKey: string; role: string; content: string; createdAt: string }
const now = new Date().toISOString();

function user(sessionKey: string, content: string): Entry {
  return { sessionKey, role: 'user', content, createdAt: now };
}
function assistant(sessionKey: string, content: string): Entry {
  return { sessionKey, role: 'assistant', content, createdAt: now };
}

describe('detectFrustrationSignals', () => {
  it('returns no signal when no corrections present', () => {
    const activity = [
      user('s1', 'Can you summarize the email?'),
      assistant('s1', 'Sure! Here is...'),
      user('s1', 'Thanks, that helps.'),
    ];
    expect(detectFrustrationSignals(activity)).toEqual([]);
  });

  it('returns no signal when fewer than 3 corrections', () => {
    const activity = [
      user('s1', 'No, that\'s not what I meant'),
      user('s2', 'actually I want X instead'),
    ];
    expect(detectFrustrationSignals(activity)).toEqual([]);
  });

  it('flags 3+ corrections in 24h window', () => {
    const activity = [
      user('s1', 'No that\'s wrong'),
      user('s1', 'Actually I meant the other thing'),
      user('s2', 'Stop, that\'s not the file I asked for'),
      user('s2', 'You misunderstood'),
    ];
    const signals = detectFrustrationSignals(activity);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toContain('4 user correction');
    expect(signals[0]).toContain('2 session');
  });

  it('only counts patterns at message start, not mid-message', () => {
    const activity = [
      user('s1', 'Yeah I think no actually that works'),  // "no" mid-message — ignored
      user('s2', 'I was telling you no'),                  // "no" mid-message — ignored
      user('s3', 'Maybe stop trying that approach'),       // "stop" mid-message — ignored
    ];
    expect(detectFrustrationSignals(activity)).toEqual([]);
  });

  it('ignores assistant messages even if they look like corrections', () => {
    const activity = [
      assistant('s1', 'No, that won\'t work'),
      assistant('s1', 'Actually I should reconsider'),
      assistant('s1', 'Wait, let me think'),
    ];
    expect(detectFrustrationSignals(activity)).toEqual([]);
  });

  it('counts each session once for sessionsAffected even if multiple corrections', () => {
    const activity = [
      user('s1', 'No'),
      user('s1', 'Actually no wait'),
      user('s1', 'Stop, you\'re wrong'),
    ];
    const signals = detectFrustrationSignals(activity);
    expect(signals[0]).toContain('1 session');
  });
});

describe('detectRepeatedTopics', () => {
  it('returns nothing when no topic appears in 3+ sessions', () => {
    const activity = [
      user('s1', 'Tell me about the salesforce migration'),
      user('s2', 'How does the discord bot work'),
      user('s3', 'Update the README'),
    ];
    expect(detectRepeatedTopics(activity)).toEqual([]);
  });

  it('flags a keyword recurring across 3+ sessions', () => {
    const activity = [
      user('s1', 'How is the migration going'),
      user('s2', 'Status of the migration'),
      user('s3', 'When will the migration be done'),
      user('s4', 'thanks!'),
    ];
    const signals = detectRepeatedTopics(activity);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0]).toContain('migration');
    expect(signals[0]).toContain('3 sessions');
  });

  it('does not double-count the same keyword within one session', () => {
    const activity = [
      user('s1', 'salesforce salesforce salesforce salesforce'),
      user('s2', 'salesforce stuff'),
    ];
    expect(detectRepeatedTopics(activity)).toEqual([]); // only 2 distinct sessions
  });

  it('skips short words and stopwords', () => {
    const activity = [
      user('s1', 'thanks please okay'),
      user('s2', 'thanks please okay'),
      user('s3', 'thanks please okay'),
    ];
    expect(detectRepeatedTopics(activity)).toEqual([]);
  });

  it('caps output at 2 signals to avoid flooding', () => {
    const activity: Entry[] = [];
    // 5 distinct keywords each appearing in 3 sessions → only top 2 returned
    const keywords = ['migration', 'pipeline', 'dashboard', 'redaction', 'salesforce'];
    for (let i = 0; i < keywords.length; i++) {
      for (let s = 0; s < 3; s++) {
        activity.push(user(`s-${i}-${s}`, `tell me about the ${keywords[i]}`));
      }
    }
    const signals = detectRepeatedTopics(activity);
    expect(signals.length).toBeLessThanOrEqual(2);
  });

  it('ranks by session count descending', () => {
    const activity: Entry[] = [];
    // 'migration' appears in 5 sessions, 'pipeline' in 3.
    // No shared keyword across both groups so rank is unambiguous.
    for (let s = 0; s < 5; s++) activity.push(user(`s-m-${s}`, 'tell me about migration'));
    for (let s = 0; s < 3; s++) activity.push(user(`s-p-${s}`, 'mention pipeline'));
    const signals = detectRepeatedTopics(activity);
    expect(signals[0]).toContain('migration');
  });
});
