import { describe, expect, it } from 'vitest';
import {
  dateKeyInTimeZone,
  hourInTimeZone,
  isValidTimeZone,
  localTimeSnapshot,
  resolveTimeZone,
} from '../src/lib/time.js';

describe('timezone helpers', () => {
  it('computes today in the requested IANA timezone instead of UTC', () => {
    const latePacific = new Date('2026-05-11T06:30:00.000Z');
    expect(dateKeyInTimeZone(latePacific, 'America/Los_Angeles')).toBe('2026-05-10');
    expect(dateKeyInTimeZone(latePacific, 'UTC')).toBe('2026-05-11');
    expect(hourInTimeZone(latePacific, 'America/Los_Angeles')).toBe(23);
  });

  it('validates and falls back for timezone preferences', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(resolveTimeZone('Not/AZone', 'America/New_York')).toBe('America/New_York');
  });

  it('returns a dashboard-friendly local time snapshot', () => {
    const snapshot = localTimeSnapshot(new Date('2026-01-15T20:05:00.000Z'), 'America/New_York');
    expect(snapshot.timeZone).toBe('America/New_York');
    expect(snapshot.dateKey).toBe('2026-01-15');
    expect(snapshot.timeLabel).toMatch(/3:05 PM/);
    expect(snapshot.weekday).toBe('Thursday');
  });
});
