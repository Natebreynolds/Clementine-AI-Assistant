/**
 * Small timezone helpers for user-facing time. Keep this dependency-free so
 * config, schedulers, tools, and the dashboard can share one interpretation
 * of "today" without pulling in a date library.
 */

export interface LocalTimeSnapshot {
  iso: string;
  timeZone: string;
  dateKey: string;
  dateLabel: string;
  timeLabel: string;
  dateTimeLabel: string;
  weekday: string;
  hour: number;
  offsetLabel: string;
  zoneLabel: string;
}

export function systemTimeZone(): string {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimeZone(detected)) return detected;
  } catch {
    // Fall through to stable default.
  }
  return 'UTC';
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate.trim();
  }
  return systemTimeZone();
}

export function dateKeyInTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  const parts = partsMap(date, timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function hourInTimeZone(date = new Date(), timeZone = systemTimeZone()): number {
  const parts = partsMap(date, timeZone, {
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const hour = Number(parts.hour);
  return Number.isFinite(hour) ? hour : date.getUTCHours();
}

export function formatDateInTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatShortDateInTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatTimeInTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatTime24InTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDateTimeInTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

export function weekdayInTimeZone(date = new Date(), timeZone = systemTimeZone()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
}

export function timeZoneOffsetLabel(date = new Date(), timeZone = systemTimeZone()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export function timeZoneNameLabel(date = new Date(), timeZone = systemTimeZone()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export function localTimeSnapshot(date = new Date(), timeZone = systemTimeZone()): LocalTimeSnapshot {
  const resolved = resolveTimeZone(timeZone);
  return {
    iso: date.toISOString(),
    timeZone: resolved,
    dateKey: dateKeyInTimeZone(date, resolved),
    dateLabel: formatDateInTimeZone(date, resolved),
    timeLabel: formatTimeInTimeZone(date, resolved),
    dateTimeLabel: formatDateTimeInTimeZone(date, resolved),
    weekday: weekdayInTimeZone(date, resolved),
    hour: hourInTimeZone(date, resolved),
    offsetLabel: timeZoneOffsetLabel(date, resolved),
    zoneLabel: timeZoneNameLabel(date, resolved),
  };
}

function partsMap(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const resolved = resolveTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: resolved, ...options }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}
