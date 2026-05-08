/**
 * Pretty cron formatting — covers every cron expression in the user's
 * real vault (audited 2026-05-08) plus the spec-defined edge cases.
 *
 * The describeCron function lives inside the served-HTML template literal
 * in src/cli/dashboard.ts (it has to ship to the browser). To test it
 * here we extract the function bodies via regex and evaluate them in a
 * scope that mirrors what the browser provides (dayNames, monthNames).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let describeCron: (expr: string) => string;

beforeAll(() => {
  const src = readFileSync(path.join(process.cwd(), 'src/cli/dashboard.ts'), 'utf-8');
  // Pull every helper used by describeCron. Order matters — the helpers
  // need to be in scope before describeCron itself is evaluated.
  const helpers = [
    'dayNames',
    'monthNames',
    'plural',
    'shortDay',
    'ordinal',
    'formatHour',
    'formatTimePretty',
    'describeCron',
  ];
  // Each helper is either `const name = ...;` or `function name(...) { ... }`.
  // Extract by finding the line that starts with the binding form.
  function extract(name: string): string {
    // Try: const NAME = [ ... ];
    const constArr = src.match(new RegExp(`^const ${name}\\s*=\\s*\\[[^;]+\\];`, 'm'));
    if (constArr) return constArr[0];
    // Try: function NAME(...) { ... }
    const fnIdx = src.indexOf(`\nfunction ${name}(`);
    if (fnIdx === -1) throw new Error(`could not find function ${name}`);
    // Find the matching closing brace by counting depth.
    let depth = 0;
    let started = false;
    let i = fnIdx;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') { depth++; started = true; }
      else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
      i++;
    }
    return src.slice(fnIdx, i);
  }
  // Build a single program: helpers in scope, then return describeCron.
  const program = helpers.map(extract).join('\n\n') + '\nreturn describeCron;';
  // The dashboard uses \\s+ inside its source (so the served JS gets \s+).
  // For the Node test we want \s+ to actually be \s+, so unescape one level.
  const programJs = program.replace(/\\\\s\+/g, '\\s+');
  describeCron = new Function(programJs)() as (expr: string) => string;
});

describe('describeCron — every schedule in the vault', () => {
  // Tuples from `grep -hE "^\s*-?\s*schedule:" CRON.md` (run 2026-05-08).
  const cases: Array<[string, string | RegExp]> = [
    // Sub-hour cadence
    ['* * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['0 */4 * * *', 'Every 4 hours'],
    // Weekdays
    ['0 15 * * 1-5', 'Weekdays at 3 PM'],
    ['0 21 * * 1-5', 'Weekdays at 9 PM'],
    // Hour ranges
    ['0 8-18 * * 1-5', 'Hourly weekdays 8 AM–6 PM'],
    // Specific weekday (pluralized)
    ['0 17 * * 5', 'Fridays at 5 PM'],
    ['0 18 * * 5', 'Fridays at 6 PM'],
    ['0 9 * * 0', 'Sundays at 9 AM'],
    // Daily
    ['0 7 * * *', 'Every day at 7 AM'],
    ['0 8 * * *', 'Every day at 8 AM'],
    ['15 14 * * *', 'Every day at 2:15 PM'],
    ['15 7 * * *', 'Every day at 7:15 AM'],
    ['30 8 * * *', 'Every day at 8:30 AM'],
    // Specific date
    ['0 17 2 3 *', 'Mar 2 at 5 PM'],
    ['0 7 25 3 *', 'Mar 25 at 7 AM'],
    ['10 16 1 3 *', 'Mar 1 at 4:10 PM'],
    ['17 9 5 5 *', 'May 5 at 9:17 AM'],
    ['20 0 3 3 *', 'Mar 3 at 12:20 AM'],
    ['37 17 1 3 *', 'Mar 1 at 5:37 PM'],
    // @aliases
    ['@daily', 'Every day at midnight'],
    ['@weekly', 'Sundays at midnight'],
    ['@hourly', 'Every hour'],
    // Multi-weekday
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri at 9 AM'],
    // Day-of-month only
    ['0 9 15 * *', '15th of every month at 9 AM'],
    ['0 9 1 * *', '1st of every month at 9 AM'],
    ['0 9 22 * *', '22nd of every month at 9 AM'],
    // Multiple hours
    ['0 8,12,16 * * *', 'Daily at 8 AM, 12 PM, 4 PM'],
    // Returns empty for inputs we don't try to summarize
    ['', ''],
    ['nonsense', ''],
    ['1 2 3', ''],
  ];

  for (const [expr, expected] of cases) {
    it(`${JSON.stringify(expr)} → ${typeof expected === 'string' ? JSON.stringify(expected) : expected}`, () => {
      const got = describeCron(expr);
      if (typeof expected === 'string') {
        expect(got).toBe(expected);
      } else {
        expect(got).toMatch(expected);
      }
    });
  }
});

describe('describeCron — specific behaviors', () => {
  it('drops :00 minutes for cleaner reading', () => {
    expect(describeCron('0 8 * * 1-5')).toBe('Weekdays at 8 AM');
  });

  it('keeps :30 minutes when not zero', () => {
    expect(describeCron('30 8 * * 1-5')).toBe('Weekdays at 8:30 AM');
  });

  it('handles midnight (00:00)', () => {
    expect(describeCron('0 0 * * *')).toBe('Every day at 12 AM');
  });

  it('handles noon (12:00)', () => {
    expect(describeCron('0 12 * * *')).toBe('Every day at 12 PM');
  });

  it('uses en-dash (not hyphen) for hour ranges', () => {
    const got = describeCron('0 8-18 * * 1-5');
    expect(got).toContain('–');  // en-dash, not '-'
    expect(got).not.toContain(' - ');
  });

  it('returns empty for too-many-fields (cron-with-seconds)', () => {
    // 6-field cron (with seconds) is not standard 5-field; we don't
    // try to interpret it.
    expect(describeCron('0 0 0 * * 1')).toBe('');
  });

  it('returns empty for null / undefined / non-string', () => {
    expect(describeCron(null as unknown as string)).toBe('');
    expect(describeCron(undefined as unknown as string)).toBe('');
    expect(describeCron(123 as unknown as string)).toBe('');
  });
});
