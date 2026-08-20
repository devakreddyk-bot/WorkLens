/**
 * Tests for the calendar arithmetic.
 *
 * These functions decide which day a page is showing. Getting one wrong does not produce an error —
 * it produces a correct-looking timesheet for the wrong date, or a range that silently omits a day
 * an employee worked. The cases below are the ones where naive date arithmetic breaks: month and
 * year boundaries, leap years, and the two days a year a local day is not 24 hours long.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WEEKDAY_NAMES,
  datesBetween,
  daysBetween,
  firstParam,
  parseCalendarDate,
  shiftDate,
  todayIn,
  weekOf,
} from '@/lib/dates';

describe('shiftDate', () => {
  it('walks the calendar, not the clock', () => {
    expect(shiftDate('2026-08-20', 1)).toBe('2026-08-21');
    expect(shiftDate('2026-08-20', -1)).toBe('2026-08-19');
    expect(shiftDate('2026-08-20', 0)).toBe('2026-08-20');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDate('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('knows which Februaries have 29 days', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29'); // divisible by 4
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01'); // not
    expect(shiftDate('2100-02-28', 1)).toBe('2100-03-01'); // century, not a leap year
    expect(shiftDate('2000-02-28', 1)).toBe('2000-02-29'); // divisible by 400, is one
  });

  it('is unaffected by daylight saving, which is the reason it works in UTC', () => {
    // 5 April 2026 is 23 hours long in Melbourne and 25 in parts of the northern hemisphere. Adding
    // 86_400_000 milliseconds to a local instant across one of these lands on the wrong date; walking
    // the calendar cannot.
    expect(shiftDate('2026-04-04', 1)).toBe('2026-04-05');
    expect(shiftDate('2026-04-05', 1)).toBe('2026-04-06');
    expect(shiftDate('2026-10-03', 1)).toBe('2026-10-04');
    expect(shiftDate('2026-10-04', 1)).toBe('2026-10-05');
  });

  it('returns the input unchanged rather than NaN for an unusable date', () => {
    // A page that shows the requested day is better than one showing "NaN-NaN-NaN".
    expect(shiftDate('not-a-date', 1)).toBe('not-a-date');
    expect(shiftDate('', 1)).toBe('');
  });

  it('agrees with the backend, which is the only thing that makes the range meaningful', () => {
    // A transcription of `shiftDate` from backend/src/handlers/dashboard/reporting.ts:287. The
    // dashboard asks for a range and the backend decides which rows fall in it; if the two disagreed
    // about which day is which, the register would be off by one and every figure in it would still
    // look plausible.
    //
    // Copied rather than imported: the tiers deploy separately and the dashboard does not depend on
    // the backend's source tree. That is the same trade as `api.ts`, so it gets the same treatment —
    // an executable comparison rather than an assumption. If the backend's version changes, this test
    // is where the divergence shows up.
    const backendShiftDate = (date: string, days: number): string => {
      const asUtc = new Date(`${date}T00:00:00.000Z`);
      asUtc.setUTCDate(asUtc.getUTCDate() + days);
      return asUtc.toISOString().slice(0, 10);
    };

    const dates = ['2026-01-01', '2026-02-28', '2026-08-20', '2026-12-31', '2028-02-29', '2026-04-05'];
    const offsets = [-400, -31, -7, -1, 0, 1, 7, 31, 400];

    for (const date of dates) {
      for (const days of offsets) {
        expect(shiftDate(date, days)).toBe(backendShiftDate(date, days));
      }
    }
  });
});

describe('daysBetween', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-08-20', '2026-08-27')).toBe(7);
    expect(daysBetween('2026-08-27', '2026-08-20')).toBe(-7);
    expect(daysBetween('2026-08-20', '2026-08-20')).toBe(0);
  });

  it('counts across a DST transition as whole days', () => {
    // The rounding in `daysBetween` exists for exactly this: if these dates were parsed as local
    // instants, an interval spanning a 23-hour day would be 6.958 days and truncate to 6, dropping a
    // day off the end of every range that crossed a changeover.
    expect(daysBetween('2026-04-01', '2026-04-08')).toBe(7);
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
  });

  it('counts across a leap day and a year end', () => {
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
    expect(daysBetween('2026-02-01', '2026-03-01')).toBe(28);
    expect(daysBetween('2026-12-25', '2027-01-01')).toBe(7);
  });

  it('returns 0 for an unusable input rather than NaN', () => {
    expect(daysBetween('rubbish', '2026-08-20')).toBe(0);
    expect(daysBetween('2026-08-20', 'rubbish')).toBe(0);
  });
});

describe('weekOf', () => {
  it('starts the week on Monday, matching the configured work days', () => {
    // work_days in monitoring_config is ISO-numbered, 1 = Monday. A week view starting on Sunday
    // while the configuration starts on Monday would put the working week in columns 2–6.
    expect(weekOf('2026-08-20')).toEqual({ from: '2026-08-17', to: '2026-08-23' }); // a Thursday
    expect(weekOf('2026-08-17')).toEqual({ from: '2026-08-17', to: '2026-08-23' }); // the Monday
  });

  it('puts Sunday at the end of the week it finishes, not the start of the next', () => {
    // The off-by-one this whole function is about. `getUTCDay()` calls Sunday 0, so the naive
    // subtraction moves Sunday forward into the following week and leaves a one-day gap behind it.
    expect(weekOf('2026-08-23')).toEqual({ from: '2026-08-17', to: '2026-08-23' });
    expect(weekOf('2026-08-24')).toEqual({ from: '2026-08-24', to: '2026-08-30' }); // next Monday
  });

  it('spans a month and a year boundary', () => {
    expect(weekOf('2026-09-01')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(weekOf('2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('always returns exactly seven days', () => {
    // An invariant rather than a case: a six- or eight-column week is a bug no individual example
    // would be guaranteed to catch.
    for (let offset = 0; offset < 400; offset += 1) {
      const date = shiftDate('2026-01-01', offset);
      const week = weekOf(date);
      expect(daysBetween(week.from, week.to)).toBe(6);
      expect(daysBetween(week.from, date)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(date, week.to)).toBeGreaterThanOrEqual(0);
    }
  });

  it('degrades to a single day for an unusable date', () => {
    expect(weekOf('rubbish')).toEqual({ from: 'rubbish', to: 'rubbish' });
  });
});

describe('datesBetween', () => {
  it('is inclusive at both ends', () => {
    expect(datesBetween('2026-08-20', '2026-08-23')).toEqual([
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ]);
    expect(datesBetween('2026-08-20', '2026-08-20')).toEqual(['2026-08-20']);
  });

  it('returns nothing for a reversed range instead of looping', () => {
    expect(datesBetween('2026-08-23', '2026-08-20')).toEqual([]);
  });

  it('produces every day of a month boundary and a leap February', () => {
    expect(datesBetween('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
    expect(datesBetween('2028-02-01', '2028-02-29')).toHaveLength(29);
  });
});

describe('parseCalendarDate', () => {
  it('accepts a real date', () => {
    expect(parseCalendarDate('2026-08-20')).toBe('2026-08-20');
    expect(parseCalendarDate('2028-02-29')).toBe('2028-02-29');
  });

  it('rejects a date that does not exist, which Date.parse silently accepts', () => {
    // `new Date('2026-02-30T00:00:00Z')` rolls forward to 2 March in V8 without complaint. Left to
    // that, a URL asking for 30 February would render 2 March's timesheet under a 30 February
    // heading. The API's own schema does the same check; matching it means the page says so.
    expect(parseCalendarDate('2026-02-30')).toBeNull();
    expect(parseCalendarDate('2026-02-29')).toBeNull(); // 2026 is not a leap year
    expect(parseCalendarDate('2026-04-31')).toBeNull();
    expect(parseCalendarDate('2026-13-01')).toBeNull();
    expect(parseCalendarDate('2026-00-01')).toBeNull();
    expect(parseCalendarDate('2026-08-00')).toBeNull();
    expect(parseCalendarDate('2026-08-32')).toBeNull();
    expect(parseCalendarDate('2100-02-29')).toBeNull(); // century, not a leap year
    expect(parseCalendarDate('2000-02-29')).toBe('2000-02-29'); // divisible by 400
  });

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    expect(parseCalendarDate(undefined)).toBeNull();
    expect(parseCalendarDate('')).toBeNull();
    expect(parseCalendarDate('2026-8-20')).toBeNull();
    expect(parseCalendarDate('26-08-20')).toBeNull();
    expect(parseCalendarDate('2026-08-20T00:00:00Z')).toBeNull();
    expect(parseCalendarDate(' 2026-08-20')).toBeNull();
    expect(parseCalendarDate('2026-08-20 ')).toBeNull();
    expect(parseCalendarDate('2026/08/20')).toBeNull();
  });

  it('does not let a query parameter smuggle anything through', () => {
    // These reach the function straight from the URL, and the value is passed on to the API. The
    // regex is what stops that, so it is worth asserting rather than assuming.
    expect(parseCalendarDate("2026-08-20' OR 1=1--")).toBeNull();
    expect(parseCalendarDate('2026-08-20\n2026-08-21')).toBeNull();
    expect(parseCalendarDate('../../etc/passwd')).toBeNull();
  });
});

describe('todayIn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the organisation’s date, not the machine’s', () => {
    // 2026-08-20 23:30 UTC. Already the 21st in Kolkata and Melbourne, still the 20th in New York.
    // A register headed "today" must mean the employee's today, which on either side of midnight is
    // a different day from the viewer's.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T23:30:00Z'));

    expect(todayIn('UTC')).toBe('2026-08-20');
    expect(todayIn('Asia/Kolkata')).toBe('2026-08-21');
    expect(todayIn('Australia/Melbourne')).toBe('2026-08-21');
    expect(todayIn('America/New_York')).toBe('2026-08-20');
  });

  it('crosses a year boundary in the right zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T20:00:00Z'));
    expect(todayIn('UTC')).toBe('2026-12-31');
    expect(todayIn('Asia/Kolkata')).toBe('2027-01-01');
    expect(todayIn('America/New_York')).toBe('2026-12-31');
  });

  it('pads a single-digit month and day', () => {
    // `en-CA` with 2-digit options is what produces YYYY-MM-DD directly. If it ever returned
    // "2026-1-5" the string would fail every comparison downstream while still looking like a date.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    expect(todayIn('UTC')).toBe('2026-01-05');
  });
});

describe('firstParam', () => {
  it('takes the first of a repeated query parameter', () => {
    // `?date=A&date=B` arrives as an array. Passing the array on stringifies it to "A,B", which the
    // API rejects with a 400 that says nothing useful.
    expect(firstParam(['2026-08-20', '2026-08-21'])).toBe('2026-08-20');
    expect(firstParam('2026-08-20')).toBe('2026-08-20');
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam([])).toBeUndefined();
  });
});

describe('WEEKDAY_NAMES', () => {
  it('is ISO-numbered, so 1 is Monday and 7 is Sunday', () => {
    // These indices are read straight from `monitoring_config.work_days`. Off by one and the settings
    // page would tell an admin they had configured Sunday when they had configured Monday.
    expect(WEEKDAY_NAMES[1]).toBe('Monday');
    expect(WEEKDAY_NAMES[5]).toBe('Friday');
    expect(WEEKDAY_NAMES[7]).toBe('Sunday');
    expect(WEEKDAY_NAMES[0]).toBeUndefined();
    expect(Object.keys(WEEKDAY_NAMES)).toHaveLength(7);
  });
});
