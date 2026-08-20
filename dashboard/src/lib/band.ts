/**
 * The geometry behind `DayBand`: where the ink goes on a 24-hour axis.
 *
 * # Why this is not inside the component
 *
 * `DayBand.tsx` is a `'use client'` module, and a Client Component's internals cannot be imported
 * by anything else — which in practice meant this arithmetic could not be tested without rendering
 * React. `formatDuration` left that file for the same reason. The rule the two cases share: a pure
 * function has no business living behind the client boundary.
 *
 * That matters more here than it did for the formatters, because this is the highest-risk code in
 * the dashboard. Every other bug in a register announces itself — a missing column, a crash, an
 * obviously empty page. A timezone bug here draws a **plausible** picture that is wrong: an
 * employee's day rendered four and a half hours from where it happened, with nothing on screen to
 * suggest it. A manager would read it, believe it, and act on it.
 *
 * # Everything is minutes from local midnight
 *
 * The axis is 0–1440 in the *employee's* zone, never the viewer's. `Intl` does the conversion, not
 * `Date.prototype.getHours()`, which silently uses the machine's zone — so a manager in Melbourne
 * reading an Indian employee's 09:00 start would see it drawn at 13:30. That single substitution is
 * the most likely way this file could go wrong, which is why the conversion happens in exactly one
 * function and that function is tested against half a dozen zones.
 */

/** One recorded span within a day. Times are instants; the geometry converts them to local offsets. */
export interface DaySegment {
  startedAt: string;
  endedAt: string;
  idle: boolean;
}

/** What `buildSpans` needs. A subset of `DayBandProps`, so the geometry does not depend on the component. */
export interface BandInput {
  timezone: string;
  activeSeconds: number;
  idleSeconds: number;
  firstActivityAt?: string | null;
  lastActivityAt?: string | null;
  segments?: readonly DaySegment[];
}

/** A drawn span, in minutes from local midnight. */
export interface Span {
  fromMinutes: number;
  toMinutes: number;
  idle: boolean;
}

/**
 * How the spans were derived, so a caller can label what it is showing.
 *
 * `'segments'` is real recorded spans. `'totals'` is a day laid out from totals alone, which is a
 * simplification the caller must be able to disclose rather than imply a precision the data lacks.
 */
export type BandResolution = 'segments' | 'totals' | 'empty';

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes from local midnight for an instant, in a given zone.
 *
 * Returns null for an unparseable input rather than 0, because 0 is midnight — a legitimate value —
 * and a bad timestamp drawn at midnight is indistinguishable from a real one.
 */
export function minutesFromMidnight(iso: string, timezone: string): number | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(instant);
  } catch {
    // An invalid IANA zone throws a RangeError. Null draws nothing, which is the honest outcome:
    // with no usable zone there is no such thing as the right position for this mark.
    return null;
  }

  const hourPart = parts.find((part) => part.type === 'hour')?.value;
  const minutePart = parts.find((part) => part.type === 'minute')?.value;
  if (hourPart === undefined || minutePart === undefined) return null;

  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

  // Defensive, not observed here: `hour12: false` is documented to be able to yield "24" for
  // midnight rather than "00", and Node 22's ICU gives "00". Left unhandled on an ICU that does
  // return 24, a midnight mark would be positioned at 1440 — off the right-hand edge of the axis.
  return (hour % 24) * 60 + minute;
}

/** A percentage of the 24-hour axis, for a CSS offset or width. */
export function percentOfDay(minutes: number): string {
  return `${((minutes / MINUTES_PER_DAY) * 100).toFixed(4)}%`;
}

/**
 * Where a span ends on the axis, given where it starts.
 *
 * Three cases, and the middle one is a bug this function exists to prevent:
 *
 *   - `to > from` — ordinary. Ends where it ends.
 *   - `to < from` — the span ran past local midnight and wrapped to a small number. Drawn literally
 *     that is a negative width, which renders as nothing at all: a night shift that looks unworked.
 *     Clamped to the end of the day, and the following day carries the remainder because the
 *     aggregation splits events at the boundary.
 *   - `to === from` — **not** a wrap. It is a span with no measurable extent on this axis: a day
 *     with a single activity event, so first and last activity are the same instant, or the two
 *     halves of a repeated hour at a DST changeover, which are genuinely the same wall-clock minute.
 *
 * The original code tested `to <= from` and clamped all of both latter cases to midnight. For a
 * five-minute single-event day at 09:00 that drew nine hundred minutes of solid active ink running
 * to the end of the day — a manager reading it saw a full shift. A zero-width span is the honest
 * answer, and the component floors its rendered width at one minute, so it appears as a tick rather
 * than as a day.
 */
function clampEnd(from: number, to: number): number {
  if (to === from) return from;
  return to < from ? MINUTES_PER_DAY : to;
}

/**
 * Works out what to draw.
 *
 * With segments, each becomes a span. Without them, the totals are laid out between first and last
 * activity — active first, then idle — and `resolution` reports that this is what happened.
 */
export function buildSpans(input: BandInput): { spans: Span[]; resolution: BandResolution } {
  const { timezone, segments, firstActivityAt, lastActivityAt, activeSeconds, idleSeconds } = input;

  if (segments !== undefined && segments.length > 0) {
    const spans: Span[] = [];
    for (const segment of segments) {
      const from = minutesFromMidnight(segment.startedAt, timezone);
      const to = minutesFromMidnight(segment.endedAt, timezone);
      if (from === null || to === null) continue;
      spans.push({ fromMinutes: from, toMinutes: clampEnd(from, to), idle: segment.idle });
    }
    if (spans.length > 0) return { spans, resolution: 'segments' };
  }

  if (firstActivityAt == null || lastActivityAt == null || activeSeconds + idleSeconds === 0) {
    return { spans: [], resolution: 'empty' };
  }

  const from = minutesFromMidnight(firstActivityAt, timezone);
  const to = minutesFromMidnight(lastActivityAt, timezone);
  if (from === null || to === null) return { spans: [], resolution: 'empty' };

  const end = clampEnd(from, to);
  const width = end - from;
  const recorded = activeSeconds + idleSeconds;
  const activeWidth = width * (activeSeconds / recorded);

  const spans: Span[] = [{ fromMinutes: from, toMinutes: from + activeWidth, idle: false }];
  if (idleSeconds > 0) {
    spans.push({ fromMinutes: from + activeWidth, toMinutes: end, idle: true });
  }

  return { spans, resolution: 'totals' };
}
