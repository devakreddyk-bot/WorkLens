/**
 * Timezone arithmetic for day boundaries.
 *
 * A timesheet's day is the *employee's* day. That sounds obvious and is the single easiest thing to
 * get wrong in this codebase, because every plausible shortcut is wrong in a way that only shows up
 * for some people:
 *
 *  - Using the server's timezone gives an Indian employee a day that ends at 05:30 their time.
 *  - Using UTC does the same thing, just less visibly.
 *  - Adding a fixed offset breaks for anyone in a zone that observes DST, twice a year, silently.
 *  - Assuming a day is 86 400 seconds long is wrong on both transition days.
 *
 * So this module does the arithmetic properly, using `Intl` — which carries the full IANA rule set,
 * including historical changes — rather than a dependency or hand-rolled offset tables.
 *
 * No third-party library, deliberately: `Intl.DateTimeFormat` is in the standard library, is correct,
 * and cannot become unmaintained.
 */

/** A calendar date in an employee's timezone, as `YYYY-MM-DD`. */
export type LocalDate = string;

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Formatter cache.
 *
 * Constructing an `Intl.DateTimeFormat` is expensive — hundreds of microseconds — and aggregation
 * calls these functions once per event. Caching by timezone turns a per-event cost into a
 * per-timezone one, which for a single-company deployment means one.
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (formatter === undefined) {
    // en-CA renders as YYYY-MM-DD, which is the format wanted, rather than requiring the parts to be
    // reassembled by hand.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    offsetFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Validates a timezone name, so a bad value fails where it can be explained.
 *
 * `Intl` throws a `RangeError` for an unknown zone. Catching it here means the aggregation job can
 * report "employee X has timezone 'Mars/Olympus_Mons'" instead of failing with an opaque
 * `RangeError` from three frames down.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === '') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the UTC offset, in milliseconds, in force in `timeZone` at `instant`.
 *
 * Positive east of Greenwich. Parsed from the `longOffset` time-zone name, which renders as
 * `GMT+05:30`, `GMT-08:00`, or bare `GMT` for a zero offset.
 */
export function offsetAt(instant: Date, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(instant);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';

  // Bare "GMT" means +00:00. Iceland and Ghana render this way year round, and it is also what a
  // UTC-equivalent zone produces — a parser that required a sign would return NaN for all of them.
  if (name === 'GMT' || name === 'UTC') return 0;

  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (match === null) {
    throw new Error(
      `aggregation: could not parse the UTC offset for ${timeZone} (Intl reported "${name}"). ` +
        `This is a platform difference in Intl formatting rather than bad data; report it.`,
    );
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

/** Returns the calendar date `instant` falls on, in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  return dateFormatter(timeZone).format(instant);
}

/**
 * Returns the instant at which `date` begins in `timeZone`.
 *
 * The two-pass structure is the interesting part. A naive implementation reads the offset at the
 * *guessed* instant and subtracts it, which is wrong within a few hours of a DST transition: the
 * offset at "midnight as if UTC" can differ from the offset actually in force at local midnight, and
 * the result lands an hour out. Reading the offset again at the candidate and re-deriving when it
 * changed fixes that.
 *
 * Midnight itself is never a skipped or repeated hour in any current IANA zone — transitions happen
 * at 01:00, 02:00 or 03:00 local — so there is no ambiguity to resolve here. If a zone ever moved a
 * transition to midnight, this would return the first of the two possible instants, which is the
 * conventional reading.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  if (!LOCAL_DATE_RE.test(date)) {
    throw new Error(`aggregation: ${JSON.stringify(date)} is not a YYYY-MM-DD date`);
  }

  const asIfUtc = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(asIfUtc)) {
    throw new Error(`aggregation: ${date} is not a valid calendar date`);
  }

  const firstGuess = new Date(asIfUtc - offsetAt(new Date(asIfUtc), timeZone));
  const settledOffset = offsetAt(firstGuess, timeZone);
  const candidate = new Date(asIfUtc - settledOffset);

  // A cheap invariant check. If the candidate does not land on the requested date, the arithmetic
  // above has failed and silently returning a wrong boundary would corrupt every timesheet on that
  // day. Better to fail with the values in hand.
  const landed = localDateOf(candidate, timeZone);
  if (landed !== date) {
    throw new Error(
      `aggregation: could not find the start of ${date} in ${timeZone}; ` +
        `landed on ${landed} instead. This is a bug in the offset arithmetic.`,
    );
  }

  return candidate;
}

/** Returns the instant at which the day after `date` begins in `timeZone`. */
export function startOfNextLocalDay(date: LocalDate, timeZone: string): Date {
  return startOfLocalDay(addLocalDays(date, 1), timeZone);
}

/**
 * Adds days to a calendar date, working in date arithmetic rather than milliseconds.
 *
 * Using `+ 86_400_000` would be wrong on a DST transition day, when a local day is 23 or 25 hours
 * long: adding a fixed 24 hours to the 23-hour day lands at 01:00 the following day, and the date
 * derived from that is right by luck rather than by construction. Working in UTC calendar terms and
 * re-deriving the local date avoids the question.
 */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  if (!LOCAL_DATE_RE.test(date)) {
    throw new Error(`aggregation: ${JSON.stringify(date)} is not a YYYY-MM-DD date`);
  }
  const asUtc = new Date(`${date}T00:00:00.000Z`);
  asUtc.setUTCDate(asUtc.getUTCDate() + days);
  return asUtc.toISOString().slice(0, 10);
}

/**
 * Lists every calendar date from `from` to `to`, inclusive.
 *
 * Bounded so a malformed range cannot produce an unbounded loop that hangs the aggregation Lambda
 * until its timeout.
 */
export function localDateRange(from: LocalDate, to: LocalDate, maxDays = 400): LocalDate[] {
  if (from > to) {
    throw new Error(`aggregation: date range ${from}..${to} runs backwards`);
  }

  const dates: LocalDate[] = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    if (dates.length > maxDays) {
      throw new Error(
        `aggregation: date range ${from}..${to} exceeds ${maxDays} days. ` +
          `Aggregate in smaller windows rather than raising this limit.`,
      );
    }
    current = addLocalDays(current, 1);
  }
  return dates;
}

/**
 * The length of a local day in seconds.
 *
 * 86 400 on an ordinary day, 82 800 on a spring-forward day, 90 000 on a fall-back day. Used to
 * sanity-check a rollup: a day whose recorded total exceeds its own length means the arithmetic is
 * wrong, and that is worth detecting rather than shipping to a payroll export.
 */
export function localDayLengthSeconds(date: LocalDate, timeZone: string): number {
  const start = startOfLocalDay(date, timeZone);
  const end = startOfNextLocalDay(date, timeZone);
  return Math.round((end.getTime() - start.getTime()) / 1000);
}
