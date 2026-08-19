/**
 * Calendar arithmetic.
 *
 * Separate from `format.ts` for the same reason that file is separate from the components: these are
 * pure functions with no `'use client'`, used by Server Components deciding which range to ask for
 * and by Client Components deciding which range to navigate to.
 *
 * Every function works on `YYYY-MM-DD` strings and does its arithmetic in UTC. That looks wrong for a
 * timezone-sensitive product and is in fact the only correct way to do it: a *local* day is 23 or 25
 * hours long twice a year, so adding `86_400_000` milliseconds to an instant lands on the wrong date
 * in any zone that observes daylight saving. A calendar date has no such problem — `setUTCDate` walks
 * the calendar, not the clock. The backend does exactly this, in `shiftDate` in
 * `handlers/dashboard/reporting.ts`, and the two have to agree about which day is which.
 */

/** Today's calendar date in a given zone. Never the viewer's zone unless the caller says so. */
export function todayIn(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/** Adds days to a calendar date. Negative goes backwards. */
export function shiftDate(workDate: string, days: number): string {
  const asUtc = new Date(`${workDate}T00:00:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return workDate;
  asUtc.setUTCDate(asUtc.getUTCDate() + days);
  return asUtc.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.round((toMs - fromMs) / 86_400_000);
}

/**
 * The Monday-to-Sunday week containing a date.
 *
 * Monday, matching the ISO weekday numbering `monitoring_config.work_days` uses — a week view whose
 * first column disagreed with the configured working days would be quietly confusing.
 */
export function weekOf(workDate: string): { from: string; to: string } {
  const asUtc = new Date(`${workDate}T00:00:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return { from: workDate, to: workDate };
  // getUTCDay: 0 = Sunday. Sunday belongs to the week that started six days earlier.
  const offset = (asUtc.getUTCDay() + 6) % 7;
  const from = shiftDate(workDate, -offset);
  return { from, to: shiftDate(from, 6) };
}

/** Every date from `from` to `to` inclusive. Bounded by the caller; ranges here are days, not years. */
export function datesBetween(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const out: string[] = [];
  for (let index = 0; index <= span; index += 1) out.push(shiftDate(from, index));
  return out;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` from untrusted input, or null.
 *
 * Checked against the month's real length rather than handed to `Date.parse`, which rolls
 * `2026-02-30` forward to 2 March without complaint. The API's own schema does the same; matching it
 * means a bad date in a URL produces a page that says so rather than a 400 from three layers down.
 */
export function parseCalendarDate(value: string | undefined): string | null {
  if (value === undefined || !CALENDAR_DATE.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return value;
}

/** The first value of a search parameter, which Next hands over as `string | string[]`. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** ISO-8601 weekday names, indexed 1–7 to match `monitoring_config.work_days`. */
export const WEEKDAY_NAMES: Readonly<Record<number, string>> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};
