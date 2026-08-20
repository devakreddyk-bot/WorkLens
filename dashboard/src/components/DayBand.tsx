/**
 * The day-band: a day of work drawn as a measured span of time.
 *
 * # Why this component exists
 *
 * The conventional way to show a monitored day is a percentage — "78% productive" — or a stacked bar
 * of category totals. Both are summaries, and both hide the thing a timesheet is actually about:
 * *when* somebody worked. A 6-hour day worked 09:00–15:00 and a 6-hour day worked in four scattered
 * fragments are the same number and completely different facts, and only one of them is a
 * conversation worth having.
 *
 * So this draws the real axis. Midnight to midnight, left to right, with:
 *
 *   - recorded active time in ink,
 *   - recorded idle time in sage,
 *   - **and everything else left as paper.**
 *
 * That last part is the point. The gaps are visible. You can see the lunch break; you can see the
 * two hours where nothing was recorded. A surveillance dashboard would fill that space with a colour
 * and a judgement. A register leaves it blank, because blank is what it knows.
 *
 * # It is the same component in both views
 *
 * The manager viewing an employee and the employee viewing themselves render this identically, from
 * the same props. WorkLens promises an employee sees exactly what their employer sees, and building
 * two components would make that promise depend on somebody remembering to keep them in step.
 *
 * # The data it is given
 *
 * A timesheet row carries totals and first/last activity, not a minute-by-minute log — the
 * aggregation deliberately does not keep one. So the band is honest about its own resolution: with
 * only totals it renders a single span between first and last activity, proportioned by the
 * active/idle split. Given `segments` (from the activity endpoint, which does return spans) it draws
 * them individually. `resolution` says which happened, and the caller can label it.
 *
 * # Where the arithmetic lives
 *
 * Not here. `@/lib/band` holds the geometry — the local-midnight conversion and the span layout —
 * because a `'use client'` module's internals cannot be imported, which made the highest-risk code
 * in the dashboard the only code that could not be tested without rendering React. This file is now
 * what a component should be: it decides what the marks mean and how they are announced to a screen
 * reader, and it asks `band.ts` where they go.
 */

'use client';

import { useId } from 'react';

import {
  buildSpans,
  minutesFromMidnight,
  percentOfDay,
  type BandInput,
  type DaySegment,
} from '@/lib/band';
import { formatDuration, formatLocalTime } from '@/lib/format';

export type { DaySegment };

export interface DayBandProps extends BandInput {
  /** The calendar date this band represents, `YYYY-MM-DD` in the employee's timezone. */
  workDate: string;
  /** The configured work-hours window, as minutes from local midnight. Drawn as faint ticks. */
  workHoursStartMinutes?: number | null;
  workHoursEndMinutes?: number | null;
  /** Height in pixels. 28 in a dense team list, 44 on an employee's own page. */
  height?: number;
  /** Renders the 06/12/18 hour scale beneath. Once per table, not once per row. */
  showScale?: boolean;
  className?: string;
}

export function DayBand(props: DayBandProps): React.ReactElement {
  const {
    workDate,
    timezone,
    activeSeconds,
    idleSeconds,
    firstActivityAt,
    lastActivityAt,
    workHoursStartMinutes,
    workHoursEndMinutes,
    height = 28,
    showScale = false,
    className = '',
  } = props;

  const captionId = useId();
  const { spans, resolution } = buildSpans(props);

  /**
   * The text alternative. Not an afterthought: a screen-reader user and a print reader get the same
   * facts the band shows, and an employee checking their own record must not need to see a picture to
   * read it.
   */
  const summary =
    resolution === 'empty'
      ? `${workDate}: nothing recorded.`
      : `${workDate}: ${formatDuration(activeSeconds)} active, ${formatDuration(idleSeconds)} idle` +
        (firstActivityAt != null && lastActivityAt != null
          ? `, from ${formatLocalTime(firstActivityAt, timezone)} to ${formatLocalTime(lastActivityAt, timezone)} local time.`
          : '.');

  return (
    <div className={className}>
      <div
        role="img"
        aria-describedby={captionId}
        aria-label={summary}
        /* The track has its own tone rather than inheriting the row's. On a banded row `bg-paper`
           read as a lighter inset box and on an unbanded row as a darker one, so the 24-hour extent
           looked different every other line — which undermines the one thing the band is for, namely
           comparing the shape of one day against another. */
        className="relative w-full border-y border-rule bg-[color-mix(in_srgb,var(--color-band)_55%,var(--color-paper))]"
        style={{ height }}
      >
        {/* The work-hours window, as two faint uprights. Ticks rather than a filled region: shading
            "outside hours" would imply a judgement about it, and the product's position is that
            out-of-hours time is simply not collected. */}
        {workHoursStartMinutes != null && (
          <span
            aria-hidden="true"
            className="absolute top-0 bottom-0 w-px bg-rule-strong opacity-60"
            style={{ left: percentOfDay(workHoursStartMinutes) }}
          />
        )}
        {workHoursEndMinutes != null && (
          <span
            aria-hidden="true"
            className="absolute top-0 bottom-0 w-px bg-rule-strong opacity-60"
            style={{ left: percentOfDay(workHoursEndMinutes) }}
          />
        )}

        {/* Midday, so a glance can locate morning against afternoon without a scale on every row. */}
        <span
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-rule opacity-70"
          style={{ left: '50%' }}
        />

        {spans.map((span, index) => (
          <span
            key={`${span.fromMinutes}-${span.toMinutes}-${index}`}
            aria-hidden="true"
            className={span.idle ? 'absolute top-0 bottom-0 bg-idle' : 'absolute top-0 bottom-0 bg-active'}
            style={{
              left: percentOfDay(span.fromMinutes),
              width: percentOfDay(Math.max(span.toMinutes - span.fromMinutes, 1)),
            }}
          />
        ))}

        {/* End caps. A timesheet's most-asked question is "when did they start and finish", so those
            two instants get a mark of their own rather than being inferred from where the ink begins. */}
        {resolution !== 'empty' && firstActivityAt != null && (
          <Cap position={minutesFromMidnight(firstActivityAt, timezone)} />
        )}
        {resolution !== 'empty' && lastActivityAt != null && (
          <Cap position={minutesFromMidnight(lastActivityAt, timezone)} />
        )}

        {resolution === 'empty' && (
          <span className="label absolute inset-0 flex items-center justify-center text-ink-faint">
            nothing recorded
          </span>
        )}
      </div>

      <p id={captionId} className="sr-only">
        {summary}
      </p>

      {showScale && (
        <div aria-hidden="true" className="relative mt-1 h-3">
          {[6, 12, 18].map((hour) => (
            <span
              key={hour}
              className="figure absolute -translate-x-1/2 text-[10px] text-ink-faint"
              style={{ left: percentOfDay(hour * 60) }}
            >
              {String(hour).padStart(2, '0')}
            </span>
          ))}
          <span className="figure absolute left-0 text-[10px] text-ink-faint">00</span>
          <span className="figure absolute right-0 text-[10px] text-ink-faint">24</span>
        </div>
      )}
    </div>
  );
}

function Cap({ position }: { position: number | null }): React.ReactElement | null {
  if (position === null) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1 -bottom-1 w-[1.5px] bg-ink"
      style={{ left: percentOfDay(position) }}
    />
  );
}

/**
 * The legend. Rendered once per page, never per row.
 *
 * It names the paper as well as the ink, because "nothing recorded" is a state a reader has to be
 * told to look for — an unlabelled gap invites the assumption that the software missed something,
 * when in fact not recording is frequently the correct behaviour.
 */
export function DayBandLegend({ className = '' }: { className?: string }): React.ReactElement {
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 ${className}`}>
      <LegendItem swatch="bg-active" label="Active" />
      <LegendItem swatch="bg-idle" label="Idle" />
      <LegendItem swatch="bg-paper border border-rule" label="Nothing recorded" />
      <LegendItem swatch="bg-rule-strong w-px" label="Work hours" />
    </div>
  );
}

function LegendItem({ swatch, label }: { swatch: string; label: string }): React.ReactElement {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className={`inline-block h-3 ${swatch.includes('w-px') ? 'w-px' : 'w-4'} ${swatch}`} />
      <span className="label">{label}</span>
    </span>
  );
}
