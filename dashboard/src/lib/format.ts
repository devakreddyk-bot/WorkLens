/**
 * Formatting helpers.
 *
 * A plain module with no `'use client'`, so both Server and Client Components can use it. That is the
 * reason it exists separately from the components: these were originally exported from `DayBand.tsx`,
 * which is a Client Component, and importing them into a Server Component — which is what every
 * register table is — fails at run time with "it's not possible to invoke a client function from the
 * server". Pure functions have no business living behind that boundary.
 *
 * Every function here is timezone-explicit. There is no overload that falls back to the machine's
 * local zone, because the machine in question is the viewer's: a manager in Melbourne reading an
 * Indian employee's day must see 09:00 rendered as 09:00, not 13:30.
 */

/** Formats a duration the way a timesheet does: `7h 24m`. Zero is `0m`, never an em dash. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** A wall-clock time in the employee's zone, 24-hour. */
export function formatLocalTime(iso: string | null, timezone: string): string {
  if (iso === null) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

/**
 * A calendar date as `Thu 20 Aug`, for column headings and day pickers.
 *
 * Assembled from parts rather than taken from `format()`, which inserts a comma after the weekday —
 * `en-AU` yields "Thu, 20 Aug". In a week's worth of column headings that comma is four characters of
 * punctuation carrying no information, and the register's whole visual argument is that it is terse.
 *
 * Building the string deliberately also means ICU's punctuation conventions cannot change the output
 * from under this. That is not hypothetical: the mismatch between this function's documented format
 * and what it actually returned is what prompted the rewrite.
 */
export function formatShortDate(workDate: string): string {
  const instant = new Date(`${workDate}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) return workDate;

  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = value('weekday');
  const day = value('day');
  const month = value('month');
  // Falls back to the locale's own rendering if any part is missing, rather than returning a string
  // with a hole in it.
  if (weekday === '' || day === '' || month === '') return parts.map((part) => part.value).join('');
  return `${weekday} ${day} ${month}`;
}

/** A calendar date as `Friday 17 August 2026`, for page titles. */
export function formatLongDate(workDate: string): string {
  const instant = new Date(`${workDate}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) return workDate;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}

/**
 * Minutes from local midnight for a `HH:MM` or `HH:MM:SS` time, as `monitoring_config` stores it.
 *
 * Returns null rather than guessing, so a malformed configuration draws no work-hours tick instead of
 * drawing one in the wrong place.
 */
export function minutesFromTimeString(value: string | null | undefined): number | null {
  if (value == null) return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** An em dash for an absent figure, so a column of numbers has no ambiguous blanks. */
export const ABSENT = '—';

/** A duration, or an em dash when there is nothing recorded. */
export function formatDurationOrAbsent(seconds: number): string {
  return seconds <= 0 ? ABSENT : formatDuration(seconds);
}
