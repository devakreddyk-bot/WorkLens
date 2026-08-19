'use client';

/**
 * The seven-day trend.
 *
 * The one chart in the product. A register prefers a table almost everywhere — a table gives exact
 * figures, prints, and reads aloud — but "is the team recording more or less time than last week" is a
 * question about a *shape*, and seven numbers in a row do not have a shape until you draw them.
 *
 * What it is not: a productivity graph. The bars are recorded active and idle time in hours, stacked,
 * with the total printed above each one. There is no target line, no comparison against a quota and no
 * colour that means good or bad — `--color-active` is ink and `--color-idle` is sage, and idle time is
 * part of an honest day.
 *
 * The exact figures follow in a table that is visually hidden. A chart is a picture, and an employee or
 * an auditor reading this page with a screen reader is entitled to the same numbers a sighted reader
 * can estimate from the bars.
 */

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts';

import type { TrendDay } from '@/lib/api';
import { formatDuration, formatShortDate } from '@/lib/format';

interface Point {
  workDate: string;
  weekday: string;
  activeHours: number;
  idleHours: number;
  totalLabel: string;
  activeSeconds: number;
  idleSeconds: number;
  employees: number;
}

/** Two decimals, because the axis is in hours and a bar of 0 must not round to the same height as 0.4. */
function toHours(seconds: number): number {
  return Number((seconds / 3600).toFixed(2));
}

export function TrendChart({ trend }: { trend: readonly TrendDay[] }): React.ReactElement {
  const points: Point[] = trend.map((day) => ({
    workDate: day.work_date,
    // Weekday only on the axis: seven full dates do not fit, and the pattern being looked for is
    // usually a weekday one.
    weekday: formatShortDate(day.work_date).split(' ')[0] ?? day.work_date,
    activeHours: toHours(day.active_seconds),
    idleHours: toHours(day.idle_seconds),
    totalLabel: formatDuration(day.active_seconds + day.idle_seconds),
    activeSeconds: day.active_seconds,
    idleSeconds: day.idle_seconds,
    employees: day.employees_with_activity,
  }));

  return (
    <div>
      <div className="border border-rule-strong bg-slip px-2 pt-4 pb-1">
        {/* A fixed height rather than an aspect ratio: the register's rhythm is vertical, and a chart
            that grows taller on a wide screen pushes the tables that matter below the fold. */}
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
              {/* Horizontal only. Vertical gridlines in a bar chart draw boxes, and this design has
                  no boxes — every division is a single hairline rule. */}
              <CartesianGrid stroke="var(--color-rule)" strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="weekday"
                stroke="var(--color-rule-strong)"
                tickLine={false}
                tick={{ fill: 'var(--color-ink-soft)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
              />
              <YAxis
                stroke="var(--color-rule-strong)"
                tickLine={false}
                width={34}
                tick={{ fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                tickFormatter={(value: number) => `${value}h`}
              />
              <Bar dataKey="activeHours" stackId="day" fill="var(--color-active)" isAnimationActive={false} />
              <Bar dataKey="idleHours" stackId="day" fill="var(--color-idle)" isAnimationActive={false}>
                {/* The total above the stack, so the exact figure is on the page rather than behind a
                    hover — which also means it survives being printed. */}
                <LabelList
                  dataKey="totalLabel"
                  position="top"
                  fill="var(--color-ink-soft)"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <table className="sr-only">
        <caption>Recorded time per day, over the last seven days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Active</th>
            <th scope="col">Idle</th>
            <th scope="col">People who recorded time</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.workDate}>
              <th scope="row">{formatShortDate(point.workDate)}</th>
              <td>{formatDuration(point.activeSeconds)}</td>
              <td>{formatDuration(point.idleSeconds)}</td>
              <td>{point.employees}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
