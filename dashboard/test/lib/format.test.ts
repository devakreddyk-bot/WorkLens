/**
 * Tests for the formatters.
 *
 * These produce the text a payroll figure is read from, so the cases that matter are the boundaries
 * where a rounding or a fallback changes what somebody gets paid for, and the timezone cases where a
 * correct number is displayed against the wrong clock.
 */

import { describe, expect, it } from 'vitest';

import {
  ABSENT,
  formatDuration,
  formatDurationOrAbsent,
  formatLocalTime,
  formatLongDate,
  formatShortDate,
  minutesFromTimeString,
} from '@/lib/format';

describe('formatDuration', () => {
  it('formats the way a timesheet reads', () => {
    expect(formatDuration(7 * 3600 + 24 * 60)).toBe('7h 24m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(24 * 60)).toBe('24m');
  });

  it('drops a zero component rather than printing "7h 0m"', () => {
    expect(formatDuration(7 * 3600)).toBe('7h');
    expect(formatDuration(60)).toBe('1m');
  });

  it('says 0m for nothing, never an em dash', () => {
    // Deliberately different from `formatDurationOrAbsent`. In a total row, "0m" is a measurement —
    // the day was monitored and nothing was recorded. An em dash means "no figure", which is a
    // different claim, and conflating them would hide a day the agent never reported.
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(-1)).toBe('0m');
  });

  it('rounds to the nearest minute, and rounds a sub-minute figure up to 1m', () => {
    expect(formatDuration(29)).toBe('0m');
    expect(formatDuration(30)).toBe('1m');
    expect(formatDuration(89)).toBe('1m');
    expect(formatDuration(90)).toBe('2m');
  });

  it('carries 59.5 minutes into the hour rather than printing 60m', () => {
    // `Math.round` on the total minutes is what makes this work: rounding hours and minutes
    // separately would produce "0h 60m", which looks like a bug to whoever reads it.
    expect(formatDuration(3569)).toBe('59m'); // 59.48m → 59m
    expect(formatDuration(3570)).toBe('1h'); //  59.50m → 60m → carried into the hour
    expect(formatDuration(3599)).toBe('1h'); //  59.98m → 60m
    expect(formatDuration(3601)).toBe('1h');
    expect(formatDuration(3630)).toBe('1h 1m');
  });

  it('does not overflow a long total', () => {
    // A month's timesheet total, and a full year. Nothing here rolls over into days.
    expect(formatDuration(160 * 3600)).toBe('160h');
    expect(formatDuration(2000 * 3600 + 30 * 60)).toBe('2000h 30m');
  });
});

describe('formatLocalTime', () => {
  it('renders the employee’s wall clock, 24-hour', () => {
    const nineAmKolkata = '2026-08-20T03:30:00Z';
    expect(formatLocalTime(nineAmKolkata, 'Asia/Kolkata')).toBe('09:00');
    expect(formatLocalTime(nineAmKolkata, 'UTC')).toBe('03:30');
    expect(formatLocalTime(nineAmKolkata, 'Australia/Melbourne')).toBe('13:30');
  });

  it('uses 24-hour time with no am/pm and no locale surprises', () => {
    // `en-GB` with hour12:false, so a 13:00 finish never reads as "1:00" — which in a column of
    // start and finish times is ambiguous by twelve hours.
    expect(formatLocalTime('2026-08-20T13:00:00Z', 'UTC')).toBe('13:00');
    expect(formatLocalTime('2026-08-20T00:00:00Z', 'UTC')).toBe('00:00');
    expect(formatLocalTime('2026-08-20T23:59:00Z', 'UTC')).toBe('23:59');
  });

  it('returns an em dash for absent or unusable input', () => {
    expect(formatLocalTime(null, 'UTC')).toBe(ABSENT);
    expect(formatLocalTime('rubbish', 'UTC')).toBe(ABSENT);
    expect(formatLocalTime('', 'UTC')).toBe(ABSENT);
  });
});

describe('formatShortDate and formatLongDate', () => {
  it('formats a calendar date without shifting it', () => {
    // Both parse the date at UTC midnight and format it in UTC. Formatting in the machine's zone
    // would render 2026-08-20 as "Wed 19 Aug" for any reader west of Greenwich — a column heading
    // off by one from the data underneath it.
    expect(formatShortDate('2026-08-20')).toBe('Thu 20 Aug');
    // No comma after the weekday. `Intl.format()` inserts one for en-AU; this is assembled from
    // parts precisely so the register's column headings stay terse and ICU cannot change them.
    expect(formatShortDate('2026-08-20')).not.toContain(',');
    expect(formatLongDate('2026-08-20')).toBe('Thursday 20 August 2026');
  });

  it('formats the first and last day of a year correctly', () => {
    expect(formatShortDate('2026-01-01')).toBe('Thu 1 Jan');
    expect(formatShortDate('2026-12-31')).toBe('Thu 31 Dec');
    expect(formatLongDate('2028-02-29')).toBe('Tuesday 29 February 2028');
  });

  it('falls back to the raw string rather than showing "Invalid Date"', () => {
    expect(formatShortDate('rubbish')).toBe('rubbish');
    expect(formatLongDate('rubbish')).toBe('rubbish');
  });
});

describe('minutesFromTimeString', () => {
  it('reads the HH:MM and HH:MM:SS forms the database stores', () => {
    expect(minutesFromTimeString('09:00')).toBe(540);
    expect(minutesFromTimeString('09:00:00')).toBe(540);
    expect(minutesFromTimeString('17:30:00')).toBe(1050);
    expect(minutesFromTimeString('00:00')).toBe(0);
    expect(minutesFromTimeString('23:59')).toBe(1439);
    expect(minutesFromTimeString('9:00')).toBe(540); // single-digit hour
  });

  it('tolerates surrounding whitespace', () => {
    expect(minutesFromTimeString('  09:00  ')).toBe(540);
  });

  it('returns null rather than guessing at a malformed value', () => {
    // A null draws no work-hours tick. A guess would draw one in the wrong place, which is worse
    // than drawing none: the tick is what an admin checks their configuration against.
    expect(minutesFromTimeString(null)).toBeNull();
    expect(minutesFromTimeString(undefined)).toBeNull();
    expect(minutesFromTimeString('')).toBeNull();
    expect(minutesFromTimeString('24:00')).toBeNull();
    expect(minutesFromTimeString('09:60')).toBeNull();
    expect(minutesFromTimeString('9am')).toBeNull();
    expect(minutesFromTimeString('09')).toBeNull();
    expect(minutesFromTimeString('09:00 PM')).toBeNull();
    expect(minutesFromTimeString('-09:00')).toBeNull();
  });
});

describe('formatDurationOrAbsent', () => {
  it('distinguishes a measured zero from no figure at all', () => {
    expect(formatDurationOrAbsent(0)).toBe(ABSENT);
    expect(formatDurationOrAbsent(-1)).toBe(ABSENT);
    expect(formatDurationOrAbsent(60)).toBe('1m');
    expect(formatDurationOrAbsent(7 * 3600 + 24 * 60)).toBe('7h 24m');
  });

  it('uses an em dash, so a column of figures has no ambiguous blanks', () => {
    expect(ABSENT).toBe('—');
    expect(ABSENT).not.toBe('-');
    expect(ABSENT).not.toBe('');
  });
});
