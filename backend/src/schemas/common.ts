/**
 * Primitives shared by the device-API schemas.
 *
 * Everything here is `.strict()`-friendly and mirrors a constraint that already exists in
 * `backend/migrations/0001_init.sql`. That duplication is the point: a payload that would
 * violate a CHECK constraint should be rejected at the boundary with a message naming the
 * field, not 40 milliseconds later as a Postgres error whose text mentions a constraint
 * name the agent author has never heard of and cannot act on.
 *
 * Where the two differ, this file is the stricter of the two. Never the looser.
 */

import { z } from 'zod';

/** Matches Postgres' `uuid` text form, which is what the schema's uuid columns accept. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuid = (): z.ZodString =>
  z.string().regex(UUID_PATTERN, 'must be a UUID in canonical hyphenated form');

/**
 * ISO-8601 instants only — a date, a time, and a zone.
 *
 * A bare `2026-05-01` or a zoneless `2026-05-01T09:30:00` are rejected rather than coerced,
 * because coercing them means guessing a timezone, and a guess here silently shifts an
 * employee's recorded work by hours.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * How far ahead of the server's clock a timestamp may be.
 *
 * Not zero: a laptop's clock is routinely a few seconds out, and rejecting an event because
 * the device thinks it is 09:30:02 while the server thinks 09:30:00 would drop legitimate
 * data. But bounded, because an unbounded future timestamp lets a device write into a
 * timesheet day that has not happened yet — and once aggregated, that is very hard to spot.
 * The bound matches the ±300 s window the HMAC middleware already accepts, so a device whose
 * clock is far enough out to trip this has already been told so by a clearer error.
 */
export const MAX_FUTURE_SKEW_SECONDS = 300;

/**
 * Whether the date and time components actually exist.
 *
 * This is a separate check because neither of the obvious ones catches it. The regex above
 * matches `2026-02-30T00:00:00Z` quite happily, and `Date.parse` does not reject it either — V8
 * rolls it forward to 2 March, silently moving an event into a different day and, once
 * aggregated, into a different timesheet. So the day-of-month is validated against the month's
 * real length, which is independent of whatever offset the string carries.
 */
function isRealCalendarInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (match === null) return false;

  // Defaults keep `noUncheckedIndexedAccess` happy; an empty group would fail the range checks
  // below anyway, so a missing capture can only ever mean "reject".
  const [, yearRaw = '', monthRaw = '', dayRaw = '', hourRaw = '', minuteRaw = '', secondRaw = ''] =
    match;

  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (month < 1 || month > 12) return false;
  if (Number(hourRaw) > 23 || Number(minuteRaw) > 59 || Number(secondRaw) > 59) return false;

  // Day 0 of the following month is the last day of this one, leap years included.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/**
 * An ISO-8601 instant, parsed to a `Date`.
 */
export const isoInstant = (): z.ZodType<Date, z.ZodTypeDef, unknown> =>
  z
    .string()
    .max(40, 'is too long to be a timestamp')
    .regex(
      ISO_INSTANT,
      'must be an ISO-8601 instant with a timezone, e.g. 2026-05-01T09:30:00.000Z',
    )
    .refine((value) => isRealCalendarInstant(value) && !Number.isNaN(Date.parse(value)), {
      message: 'must be a real calendar instant',
    })
    .transform((value) => new Date(value))
    .refine((value) => value.getTime() <= Date.now() + MAX_FUTURE_SKEW_SECONDS * 1000, {
      message: `must not be more than ${MAX_FUTURE_SKEW_SECONDS}s in the future — check the device clock`,
    });

/**
 * A short free-text field with a hard cap.
 *
 * `min` defaults to 1 because a present-but-empty value is almost always a bug on the agent
 * side: it should have omitted the field. Titles are the exception — a window genuinely can
 * have no title — and pass `min: 0`.
 */
export const bounded = (max: number, min = 1): z.ZodString =>
  z.string().min(min).max(max);

/**
 * The form several columns actually use: `length(btrim(x)) between min and max`.
 *
 * A value of nothing but whitespace passes a plain `min(1)` and then fails the CHECK
 * constraint, which turns an obvious client bug into a 500. Trimming first and validating the
 * trimmed value makes the two agree, and stores the trimmed form so the database never sees a
 * hostname with a stray trailing space.
 */
export const trimmedBounded = (
  max: number,
  min = 1,
): z.ZodType<string, z.ZodTypeDef, string> =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .refine((value) => value.length >= min, {
      message: min === 1 ? 'must not be blank' : `must be at least ${min} characters`,
    });

/** `devices.os` — the CHECK constraint's exact value set. */
export const osSchema = z.enum(['windows', 'darwin', 'linux']);

/** `screenshots.content_type` — the CHECK constraint's exact value set. */
export const contentTypeSchema = z.enum(['image/png', 'image/jpeg']);

/**
 * A body with no fields.
 *
 * Strict and empty rather than simply ignored, so a route that takes no input says so. An
 * agent that starts sending a field nobody reads finds out immediately instead of shipping
 * data into a void for a release cycle.
 */
export const emptyBody = z.object({}).strict();

/** SHA-256 as 64 lowercase hex characters, which is what the agent computes and sends. */
export const sha256Hex = (): z.ZodString =>
  z
    .string()
    .length(64, 'must be 64 hexadecimal characters')
    .regex(/^[0-9a-f]{64}$/, 'must be lowercase hexadecimal');
