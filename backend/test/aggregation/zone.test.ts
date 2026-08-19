/**
 * Tests for day-boundary arithmetic.
 *
 * Every case here corresponds to a shortcut that would have worked for most people and failed
 * silently for some: a fixed offset, a 24-hour day, or the server's own timezone.
 */

import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  isValidTimeZone,
  localDateOf,
  localDateRange,
  localDayLengthSeconds,
  offsetAt,
  startOfLocalDay,
  startOfNextLocalDay,
} from '../../src/aggregation/zone.js';

describe('offsetAt', () => {
  it('handles a half-hour offset', () => {
    // Asia/Kolkata is +05:30. A parser that assumed whole hours would be 30 minutes out for every
    // Indian employee — which is the target deployment.
    expect(offsetAt(new Date('2026-08-19T00:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3600 * 1000);
  });

  it('handles a three-quarter-hour offset', () => {
    // Nepal is +05:45. If half-hours are handled but quarter-hours are not, this is where it shows.
    expect(offsetAt(new Date('2026-08-19T00:00:00Z'), 'Asia/Kathmandu')).toBe(5.75 * 3600 * 1000);
  });

  it('handles a negative offset', () => {
    expect(offsetAt(new Date('2026-01-15T00:00:00Z'), 'America/Los_Angeles')).toBe(-8 * 3600 * 1000);
  });

  it('handles a zero offset rendered as bare GMT', () => {
    // Intl renders +00:00 as "GMT" with no sign. A parser requiring a sign returns NaN here, and
    // every UTC-configured employee gets a broken timesheet.
    expect(offsetAt(new Date('2026-08-19T00:00:00Z'), 'UTC')).toBe(0);
    expect(offsetAt(new Date('2026-08-19T00:00:00Z'), 'Atlantic/Reykjavik')).toBe(0);
  });

  it('tracks a DST transition', () => {
    // Melbourne: +10:00 in winter, +11:00 in summer. A fixed offset is wrong for half the year.
    expect(offsetAt(new Date('2026-07-01T00:00:00Z'), 'Australia/Melbourne')).toBe(10 * 3600 * 1000);
    expect(offsetAt(new Date('2026-01-01T00:00:00Z'), 'Australia/Melbourne')).toBe(11 * 3600 * 1000);
  });
});

describe('localDateOf', () => {
  it('gives the employee day, not the UTC day', () => {
    // 19:00 UTC on the 18th is already the 19th in Kolkata. Aggregating in UTC would file this
    // event under the wrong day for every Indian employee, every evening.
    const instant = new Date('2026-08-18T19:00:00Z');
    expect(localDateOf(instant, 'UTC')).toBe('2026-08-18');
    expect(localDateOf(instant, 'Asia/Kolkata')).toBe('2026-08-19');
  });

  it('gives the previous day west of Greenwich', () => {
    const instant = new Date('2026-08-19T03:00:00Z');
    expect(localDateOf(instant, 'America/Los_Angeles')).toBe('2026-08-18');
  });
});

describe('startOfLocalDay', () => {
  it('returns the instant a day begins in a half-hour zone', () => {
    // Midnight on the 19th in Kolkata is 18:30 UTC on the 18th.
    expect(startOfLocalDay('2026-08-19', 'Asia/Kolkata').toISOString()).toBe('2026-08-18T18:30:00.000Z');
  });

  it('returns midnight UTC for UTC', () => {
    expect(startOfLocalDay('2026-08-19', 'UTC').toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  it('is correct on the day DST begins', () => {
    // Melbourne springs forward 2026-10-04 at 02:00. Midnight that day is still +10:00, so 14:00 UTC
    // on the 3rd. A one-pass implementation that read the offset at "midnight as if UTC" would pick
    // up +11:00 and land an hour out.
    const start = startOfLocalDay('2026-10-04', 'Australia/Melbourne');
    expect(start.toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect(localDateOf(start, 'Australia/Melbourne')).toBe('2026-10-04');
  });

  it('is correct on the day DST ends', () => {
    // Melbourne falls back 2026-04-05 at 03:00, so midnight is still +11:00.
    const start = startOfLocalDay('2026-04-05', 'Australia/Melbourne');
    expect(start.toISOString()).toBe('2026-04-04T13:00:00.000Z');
    expect(localDateOf(start, 'Australia/Melbourne')).toBe('2026-04-05');
  });

  it('lands on the requested date in every zone tested', () => {
    // The invariant the function asserts internally, checked across a spread of offsets and both
    // transition seasons.
    const zones = [
      'UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Melbourne', 'America/Los_Angeles',
      'America/New_York', 'Europe/London', 'Pacific/Auckland', 'Pacific/Chatham', 'America/Sao_Paulo',
    ];
    const dates = ['2026-01-01', '2026-03-29', '2026-04-05', '2026-06-15', '2026-10-04', '2026-12-31'];

    for (const zone of zones) {
      for (const date of dates) {
        const start = startOfLocalDay(date, zone);
        expect(localDateOf(start, zone), `${date} in ${zone}`).toBe(date);
      }
    }
  });

  it('rejects a malformed date', () => {
    for (const bad of ['', '2026-8-19', '19-08-2026', 'yesterday', '2026-13-01T00:00']) {
      expect(() => startOfLocalDay(bad, 'UTC'), bad).toThrow();
    }
  });
});

describe('startOfNextLocalDay', () => {
  it('is exactly 24 hours later on an ordinary day', () => {
    const start = startOfLocalDay('2026-08-19', 'Asia/Kolkata');
    const next = startOfNextLocalDay('2026-08-19', 'Asia/Kolkata');
    expect(next.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it('is 23 hours later on a spring-forward day', () => {
    const start = startOfLocalDay('2026-10-04', 'Australia/Melbourne');
    const next = startOfNextLocalDay('2026-10-04', 'Australia/Melbourne');
    expect(next.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });

  it('is 25 hours later on a fall-back day', () => {
    const start = startOfLocalDay('2026-04-05', 'Australia/Melbourne');
    const next = startOfNextLocalDay('2026-04-05', 'Australia/Melbourne');
    expect(next.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
  });
});

describe('localDayLengthSeconds', () => {
  it('reports the real length of a day', () => {
    // A rollup that exceeded its own day's length would mean the arithmetic is wrong. Assuming
    // 86400 is what makes that undetectable.
    expect(localDayLengthSeconds('2026-08-19', 'UTC')).toBe(86_400);
    expect(localDayLengthSeconds('2026-10-04', 'Australia/Melbourne')).toBe(82_800);
    expect(localDayLengthSeconds('2026-04-05', 'Australia/Melbourne')).toBe(90_000);
  });
});

describe('addLocalDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addLocalDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addLocalDays('2028-02-29', 1)).toBe('2028-03-01');
    // And 2026 is not a leap year.
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('is unaffected by a DST transition', () => {
    // The reason this works in calendar terms rather than milliseconds: + 86 400 000 across a
    // 23-hour day lands at 01:00 the next day, and getting the right date from that is luck.
    expect(addLocalDays('2026-10-03', 1)).toBe('2026-10-04');
    expect(addLocalDays('2026-10-04', 1)).toBe('2026-10-05');
  });
});

describe('localDateRange', () => {
  it('is inclusive of both ends', () => {
    expect(localDateRange('2026-08-17', '2026-08-19')).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });

  it('handles a single day', () => {
    expect(localDateRange('2026-08-19', '2026-08-19')).toEqual(['2026-08-19']);
  });

  it('rejects a backwards range', () => {
    expect(() => localDateRange('2026-08-19', '2026-08-17')).toThrow(/backwards/);
  });

  it('refuses an unbounded range rather than hanging the job', () => {
    expect(() => localDateRange('2020-01-01', '2030-01-01')).toThrow(/exceeds/);
  });
});

describe('isValidTimeZone', () => {
  it('accepts real zones and rejects invented ones', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'Australia/Melbourne', 'America/New_York']) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
    for (const zone of ['', 'Mars/Olympus_Mons', 'Not a zone', 'GMT+5:30']) {
      expect(isValidTimeZone(zone), zone).toBe(false);
    }
  });
});
