/**
 * One person's record: a day, or a week.
 *
 * # This component is the reason `/me` is a trust feature and not a courtesy
 *
 * `/employees/[id]` and `/me` both render this, with the same props and no flag that removes anything.
 * WorkLens promises an employee sees exactly what their employer sees, in the same detail — and the
 * only way to keep a promise like that is to make the two views literally the same code, so a change
 * to one is a change to both. A "simplified self-view" would be a different product.
 *
 * The only thing `self` changes is the copy. "Your record" reads differently from "Priya's record", and
 * the sentence about what opening a screenshot records is addressed to a different person. The figures,
 * the band, the breakdowns and the activity register are identical.
 *
 * # What it fetches, and why the band sometimes has less to draw
 *
 * The timesheet range gives totals and first/last activity. That is enough for a band, but only as a
 * single span — the aggregation keeps no minute-by-minute log. The activity endpoint does return
 * individual spans, so on a day view this walks its pages and hands the band real segments. If the
 * day has more events than the walk is willing to read, it passes no segments at all and says so,
 * rather than drawing a picture of a shorter day than the person worked.
 */

import Link from 'next/link';

import { DayBand, DayBandLegend } from '@/components/DayBand';
import type { DaySegment } from '@/components/DayBand';
import { Breakdown, mergeBreakdown } from '@/components/Breakdown';
import type { BreakdownItem } from '@/components/Breakdown';
import { DateNav } from '@/components/DateNav';
import { Note } from '@/components/Fields';
import { Empty, Figure, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import type { ActivityRow, TimesheetRow } from '@/lib/api';
import { fetchEmployeeActivity, fetchEmployeeTimesheets } from '@/lib/api';
import { datesBetween, weekOf } from '@/lib/dates';
import { formatDuration, formatLocalTime, formatLongDate, formatShortDate } from '@/lib/format';

export type RecordView = 'day' | 'week';

export interface EmployeeRecordProps {
  employeeId: string;
  /** The day in view, or any day inside the week in view. */
  date: string;
  view: RecordView;
  /**
   * Where this record is being read: `/me` or `/employees/{id}`. Used for the view links, so the
   * employee's own page keeps its own URL instead of bouncing them onto the admin route.
   */
  basePath: string;
  /** True when the viewer is the person the record is about. Changes the copy and nothing else. */
  self: boolean;
}

/**
 * How many pages of activity the day view will read before giving up on drawing individual spans.
 *
 * 500 is the API's per-page ceiling, so this is 2 000 events — a very busy day at a 60-second sample
 * interval is under 1 000. The cap exists because the alternative is an unbounded loop against
 * somebody else's data, and the fallback is honest rather than broken.
 */
const ACTIVITY_PAGE_LIMIT = 500;
const ACTIVITY_MAX_PAGES = 4;

/** Rows shown in the activity register. The rest are counted, not listed. */
const ACTIVITY_ROWS_SHOWN = 60;

interface DayActivity {
  events: ActivityRow[];
  /** False when the day had more events than the walk would read. */
  complete: boolean;
}

async function loadDayActivity(employeeId: string, date: string): Promise<DayActivity> {
  const events: ActivityRow[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < ACTIVITY_MAX_PAGES; page += 1) {
    const response = await fetchEmployeeActivity(employeeId, date, cursor, ACTIVITY_PAGE_LIMIT);
    events.push(...response.events);
    if (response.next_cursor === null) return { events, complete: true };
    cursor = response.next_cursor;
  }

  return { events, complete: false };
}

/** Turns recorded events into spans the band can draw. */
function toSegments(events: readonly ActivityRow[]): DaySegment[] {
  const segments: DaySegment[] = [];
  for (const event of events) {
    const started = Date.parse(event.captured_at);
    if (Number.isNaN(started) || event.duration_seconds <= 0) continue;
    segments.push({
      startedAt: event.captured_at,
      endedAt: new Date(started + event.duration_seconds * 1000).toISOString(),
      idle: event.is_idle,
    });
  }
  return segments;
}

function totals(rows: readonly TimesheetRow[]): {
  active: number;
  idle: number;
  recorded: number;
  screenshots: number;
} {
  return rows.reduce(
    (sum, row) => ({
      active: sum.active + row.active_seconds,
      idle: sum.idle + row.idle_seconds,
      recorded: sum.recorded + row.total_seconds,
      screenshots: sum.screenshots + row.screenshot_count,
    }),
    { active: 0, idle: 0, recorded: 0, screenshots: 0 },
  );
}

function projectItems(rows: readonly TimesheetRow[]): BreakdownItem[] {
  return mergeBreakdown(
    rows.map((row) => (row.breakdown?.projects ?? []).map((entry) => ({ label: entry.label, seconds: entry.seconds }))),
  );
}

export async function EmployeeRecord(props: EmployeeRecordProps): Promise<React.ReactElement> {
  const { employeeId, date, view, basePath, self } = props;
  const range = view === 'week' ? weekOf(date) : { from: date, to: date };

  const timesheets = await fetchEmployeeTimesheets(employeeId, range.from, range.to, true);
  const employee = timesheets.employee;
  const rows = timesheets.timesheets;

  const dayActivity = view === 'day' ? await loadDayActivity(employeeId, date) : null;

  const sums = totals(rows);
  const whose = self ? 'your' : `${employee.full_name}’s`;

  return (
    <>
      <header className="mb-8">
        <p className="label">{self ? 'My record' : 'Employee record'}</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-rule-strong pb-3">
          <div>
            <h1 className="text-[1.9rem] leading-tight">{employee.full_name}</h1>
            <p className="label mt-1 text-ink-faint">
              Days are measured in {employee.timezone}
            </p>
          </div>
          <ViewSwitch basePath={basePath} date={date} view={view} />
        </div>
        <div className="mt-4">
          <DateNav date={date} timezone={employee.timezone} label={view === 'week' ? 'Week containing' : 'Day'} />
        </div>
      </header>

      <Section
        label={view === 'week' ? `Week of ${formatShortDate(range.from)}` : formatLongDate(date)}
        title={view === 'week' ? 'Recorded this week' : 'Recorded this day'}
        aside={
          <>
            <Figure value={formatDuration(sums.active)} label="Active" tone="active" />
            <Figure value={formatDuration(sums.idle)} label="Idle" tone="idle" />
            <Figure value={formatDuration(sums.recorded)} label="Recorded" />
            <Figure value={String(sums.screenshots)} label="Screenshots" />
          </>
        }
      >
        {view === 'day' ? (
          <DaySheet
            date={date}
            timezone={employee.timezone}
            row={rows[0]}
            activity={dayActivity}
            employeeId={employeeId}
            self={self}
          />
        ) : (
          <WeekSheet range={range} timezone={employee.timezone} rows={rows} basePath={basePath} />
        )}
      </Section>

      <Section label="Where the time went" title={view === 'week' ? 'Across the week' : 'On this day'}>
        <div className="grid gap-x-8 gap-y-8 md:grid-cols-2">
          <Breakdown
            heading="Applications"
            columnLabel="Application"
            rows={mergeBreakdown(rows.map((row) => row.breakdown?.apps ?? []))}
            empty="No application time is recorded for this period."
          />
          <Breakdown
            heading="Sites"
            columnLabel="Host"
            rows={mergeBreakdown(rows.map((row) => row.breakdown?.sites ?? []))}
            empty="No sites are recorded. Either no browsing happened, or this organisation does not collect web addresses."
          />
          <Breakdown
            heading="Projects"
            columnLabel="Project"
            rows={projectItems(rows)}
            empty="No time matched a project rule for this period."
          />
          <Breakdown
            heading="Categories"
            columnLabel="Category"
            rows={mergeBreakdown(rows.map((row) => row.breakdown?.categories ?? []))}
            empty="No categorised time for this period."
          />
        </div>
      </Section>

      {view === 'day' && dayActivity !== null && (
        <Section
          label="Activity"
          title={`What ${whose} machine reported`}
          aside={
            <span className="label text-ink-faint">
              {dayActivity.events.length} {dayActivity.events.length === 1 ? 'record' : 'records'}
            </span>
          }
        >
          <ActivityRegister events={dayActivity.events} timezone={employee.timezone} complete={dayActivity.complete} />
        </Section>
      )}
    </>
  );
}

function ViewSwitch({
  basePath,
  date,
  view,
}: {
  basePath: string;
  date: string;
  view: RecordView;
}): React.ReactElement {
  return (
    <nav aria-label="Period" className="flex items-baseline gap-4" data-print="hide">
      {(['day', 'week'] as const).map((option) => (
        <Link
          key={option}
          href={`${basePath}?view=${option}&date=${date}`}
          aria-current={view === option ? 'page' : undefined}
          className={
            view === option
              ? 'label border-b-2 border-ink pb-1 text-ink'
              : 'label border-b-2 border-transparent pb-1 hover:border-rule-strong hover:text-ink'
          }
        >
          {option === 'day' ? 'Day' : 'Week'}
        </Link>
      ))}
    </nav>
  );
}

function DaySheet({
  date,
  timezone,
  row,
  activity,
  employeeId,
  self,
}: {
  date: string;
  timezone: string;
  row: TimesheetRow | undefined;
  activity: DayActivity | null;
  employeeId: string;
  self: boolean;
}): React.ReactElement {
  if (row === undefined) {
    return (
      <Empty>
        Nothing was recorded on this day. That is what a day off looks like, and it is also what a
        machine that stayed switched off looks like &mdash; the record cannot tell the two apart.
      </Empty>
    );
  }

  /* Individual spans only when every one of them was read. A band drawn from the first 2 000 events of
     a longer day is a picture of a shorter day, which is worse than the honest single span. */
  const segments = activity !== null && activity.complete ? toSegments(activity.events) : undefined;

  return (
    <div>
      <DayBand
        workDate={row.work_date}
        timezone={timezone}
        activeSeconds={row.active_seconds}
        idleSeconds={row.idle_seconds}
        firstActivityAt={row.first_activity_at}
        lastActivityAt={row.last_activity_at}
        {...(segments === undefined ? {} : { segments })}
        height={44}
        showScale
      />

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <DayBandLegend />
        <p className="text-[0.8125rem] text-ink-faint">
          {segments === undefined
            ? 'Drawn from the day’s totals between the first and last activity, so the shape is approximate.'
            : 'Drawn from every recorded span.'}
        </p>
      </div>

      <dl className="mt-6 grid gap-x-8 gap-y-3 border-t border-rule pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <Detail label="First activity" value={formatLocalTime(row.first_activity_at, timezone)} />
        <Detail label="Last activity" value={formatLocalTime(row.last_activity_at, timezone)} />
        <Detail label="Records aggregated" value={String(row.source_event_count)} />
        <Detail
          label="Screenshots"
          value={
            row.screenshot_count === 0 ? (
              'None'
            ) : (
              <Link
                /* Always the `/employees` route, even from `/me`. The API scopes that route to the
                   caller for an employee, so it is the same page with the same audit entry — one
                   gallery, not a second implementation for people looking at themselves. */
                href={`/employees/${employeeId}/screenshots?date=${date}`}
                className="underline decoration-lens underline-offset-4 hover:text-lens"
              >
                {row.screenshot_count} {row.screenshot_count === 1 ? 'image' : 'images'}
              </Link>
            )
          }
        />
      </dl>

      {row.screenshot_count > 0 && (
        <div className="mt-4">
          <Note tone="lens">
            {self
              ? 'These are images of your screen. Opening one records who opened it, which image and when.'
              : 'Opening a screenshot records your name, the image and the time in the access log.'}
          </Note>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="figure mt-0.5 text-[0.9375rem]">{value}</dd>
    </div>
  );
}

function WeekSheet({
  range,
  timezone,
  rows,
  basePath,
}: {
  range: { from: string; to: string };
  timezone: string;
  rows: readonly TimesheetRow[];
  basePath: string;
}): React.ReactElement {
  const byDate = new Map(rows.map((row) => [row.work_date, row]));
  const days = datesBetween(range.from, range.to);

  return (
    <div>
      <Register>
        <RegisterHead>
          <Th className="w-[9rem]">Day</Th>
          <Th className="w-auto">Shape of the day</Th>
          <Th numeric className="w-[6rem]">
            Active
          </Th>
          <Th numeric className="w-[6rem]">
            Idle
          </Th>
          <Th numeric className="w-[5.5rem]">
            First
          </Th>
          <Th numeric className="w-[5.5rem]">
            Last
          </Th>
        </RegisterHead>
        <tbody>
          {days.map((day, index) => {
            const row = byDate.get(day);
            return (
              <Tr key={day} index={index}>
                <Td>
                  <Link
                    href={`${basePath}?view=day&date=${day}`}
                    className="figure text-[0.875rem] underline decoration-rule underline-offset-4 hover:text-active"
                  >
                    {formatShortDate(day)}
                  </Link>
                </Td>
                <Td className="py-2">
                  <DayBand
                    workDate={day}
                    timezone={timezone}
                    activeSeconds={row?.active_seconds ?? 0}
                    idleSeconds={row?.idle_seconds ?? 0}
                    firstActivityAt={row?.first_activity_at ?? null}
                    lastActivityAt={row?.last_activity_at ?? null}
                    height={26}
                  />
                </Td>
                <Td numeric>{row === undefined ? '—' : formatDuration(row.active_seconds)}</Td>
                <Td numeric>{row === undefined ? '—' : formatDuration(row.idle_seconds)}</Td>
                <Td numeric>{formatLocalTime(row?.first_activity_at ?? null, timezone)}</Td>
                <Td numeric>{formatLocalTime(row?.last_activity_at ?? null, timezone)}</Td>
              </Tr>
            );
          })}
        </tbody>
      </Register>

      <div className="mt-3">
        <DayBandLegend />
      </div>
    </div>
  );
}

/**
 * The day's records, as reported.
 *
 * This is the only place in the product where a window title or a page title is displayed, and that is
 * deliberate: the overview's feed carries the application and the host but not the title, because a
 * title can name a document, a client or a diagnosis. Reading one stays a deliberate act — opening one
 * person's one day — rather than something that scrolls past on a dashboard.
 */
function ActivityRegister({
  events,
  timezone,
  complete,
}: {
  events: readonly ActivityRow[];
  timezone: string;
  complete: boolean;
}): React.ReactElement {
  if (events.length === 0) {
    return (
      <Empty>
        No activity was reported for this day. Outside working hours nothing is recorded, so an empty day
        can simply mean nobody was at the machine.
      </Empty>
    );
  }

  const shown = events.slice(0, ACTIVITY_ROWS_SHOWN);

  return (
    <div>
      <Register>
        <RegisterHead>
          <Th className="w-[5.5rem]">Time</Th>
          <Th numeric className="w-[5rem]">
            For
          </Th>
          <Th className="w-[11rem]">Application</Th>
          <Th>Window or page</Th>
          <Th className="w-[10rem]">Site</Th>
          <Th className="w-[9rem]">Project</Th>
        </RegisterHead>
        <tbody>
          {shown.map((event, index) => (
            <Tr key={event.id} index={index}>
              <Td numeric className="text-left">
                {formatLocalTime(event.captured_at, timezone)}
              </Td>
              <Td numeric>{formatDuration(event.duration_seconds)}</Td>
              <Td>
                {event.app_name ?? <span className="text-ink-faint">—</span>}
                {event.is_idle && <span className="label ml-2 text-ink-faint">idle</span>}
              </Td>
              <Td className="max-w-[28rem] truncate text-ink-soft">
                {event.window_title ?? event.url_title ?? (
                  /* An absent title is not a gap in the record: window titles are collected only when
                     the organisation has turned that on. */
                  <span className="text-ink-faint">not collected</span>
                )}
              </Td>
              <Td className="text-ink-soft">{event.url_host ?? <span className="text-ink-faint">—</span>}</Td>
              <Td>{event.project_name ?? <span className="text-ink-faint">—</span>}</Td>
            </Tr>
          ))}
        </tbody>
      </Register>

      {events.length > shown.length && (
        <p className="mt-2 text-[0.8125rem] text-ink-faint">
          Showing the first {shown.length} of {events.length} records for this day
          {complete ? '.' : ', and the day had more than could be read in one request.'}
        </p>
      )}
    </div>
  );
}
