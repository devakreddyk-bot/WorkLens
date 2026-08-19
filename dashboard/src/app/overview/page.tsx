import Link from 'next/link';

import { DateNav } from '@/components/DateNav';
import { Note } from '@/components/Fields';
import { Empty, Figure, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { Shell } from '@/components/Shell';
import { TrendChart } from '@/components/TrendChart';
import { fetchOverview } from '@/lib/api';
import { parseCalendarDate, todayIn, firstParam } from '@/lib/dates';
import { formatDuration, formatLocalTime, formatLongDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Overview' };

/**
 * The first screen an owner or manager sees.
 *
 * Four questions, in the order somebody actually asks them: what has the team recorded today, is that
 * more or less than the rest of the week, who is at a machine right now, and what has come in recently.
 * Deliberately not on this page: any per-person figure that could be read as a ranking. The team
 * register is one click away and it is organised by name, not by hours.
 *
 * The recent feed carries the application and the site but no window titles. That is the API's decision
 * as much as this page's — `listRecentActivity` does not select them — and it is the right one: a live
 * ticker of every title in the organisation, on the first screen an admin opens, is not something this
 * product offers.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const context = await loadPage();
  const params = await searchParams;

  const organisationZone = context.me.organization.timezone;
  const date = parseCalendarDate(firstParam(params['date'])) ?? todayIn(organisationZone);

  const overview = await fetchOverview(date);
  const isToday = date === todayIn(organisationZone);

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Overview</p>
        <div className="mt-1 border-b border-rule-strong pb-3">
          <h1 className="text-[1.9rem] leading-tight">{formatLongDate(date)}</h1>
          <p className="label mt-1 text-ink-faint">
            Days are measured in {overview.timezone}
          </p>
        </div>
        <div className="mt-4">
          <DateNav date={date} timezone={organisationZone} />
        </div>
      </header>

      <Section
        label={isToday ? 'Today' : 'That day'}
        title="What the team recorded"
        aside={
          <>
            <Figure value={formatDuration(overview.totals.active_seconds)} label="Active" tone="active" />
            <Figure value={formatDuration(overview.totals.idle_seconds)} label="Idle" tone="idle" />
            <Figure value={formatDuration(overview.totals.total_seconds)} label="Recorded" />
            <Figure
              value={`${overview.totals.employees_with_activity} of ${overview.team.length}`}
              label="People recorded"
            />
            <Figure value={String(overview.totals.screenshot_count)} label="Screenshots" />
          </>
        }
      >
        {overview.totals.total_seconds === 0 ? (
          <Empty>
            Nothing was recorded on this day. On a weekend or a public holiday that is what the register
            should look like; on a working day it is worth checking that the agents are running.
          </Empty>
        ) : (
          <p className="text-[0.9375rem] text-ink-soft">
            {overview.team.length - overview.totals.employees_with_activity === 0 ? (
              <>Everyone on the register recorded time.</>
            ) : (
              <>
                {overview.team.length - overview.totals.employees_with_activity} of {overview.team.length}{' '}
                people recorded nothing. A day off and a machine that stayed switched off look the same
                here.
              </>
            )}{' '}
            <Link
              href={`/team?date=${date}`}
              className="underline decoration-rule underline-offset-4 hover:text-active"
            >
              Open the team register for this day
            </Link>
            .
          </p>
        )}
      </Section>

      <Section label="Seven days" title="Recorded time to this day">
        {overview.trend.length === 0 ? (
          <Empty>No timesheets have been produced for this period yet.</Empty>
        ) : (
          <TrendChart trend={overview.trend} />
        )}
      </Section>

      <Section
        label="Working now"
        title="Machines that have checked in recently"
        aside={<span className="label text-ink-faint">{overview.active_now.length} reporting</span>}
      >
        {overview.active_now.length === 0 ? (
          <Empty>
            No machine has checked in within the last ten minutes. Outside working hours that is what the
            product is supposed to look like.
          </Empty>
        ) : (
          <Register>
            <RegisterHead>
              <Th>Person</Th>
              <Th>Machine</Th>
              <Th>Agent</Th>
              <Th numeric>Last check-in</Th>
            </RegisterHead>
            <tbody>
              {overview.active_now.map((device, index) => (
                <Tr key={device.device_id} index={index}>
                  <Td>
                    <Link
                      href={`/employees/${device.employee_id}?date=${date}`}
                      className="underline decoration-rule underline-offset-4 hover:text-active"
                    >
                      {device.full_name}
                    </Link>
                  </Td>
                  <Td className="figure text-[0.875rem] text-ink-soft">{device.hostname}</Td>
                  <Td className="figure text-[0.875rem] text-ink-faint">{device.agent_version}</Td>
                  {/* The organisation's zone, because this column is being read against the reader's
                      own clock rather than against the employee's working day. */}
                  <Td numeric>{formatLocalTime(device.last_seen_at, organisationZone)}</Td>
                </Tr>
              ))}
            </tbody>
          </Register>
        )}
      </Section>

      <Section label="Recent" title="What has come in">
        {overview.recent_activity.length === 0 ? (
          <Empty>Nothing has been reported recently.</Empty>
        ) : (
          <>
            <Register>
              <RegisterHead>
                <Th numeric className="w-[6rem]">
                  Time
                </Th>
                <Th className="w-[14rem]">Person</Th>
                <Th className="w-[14rem]">Application</Th>
                <Th>Site</Th>
                <Th numeric className="w-[6rem]">
                  For
                </Th>
              </RegisterHead>
              <tbody>
                {overview.recent_activity.map((row, index) => (
                  <Tr key={row.id} index={index}>
                    <Td numeric className="text-left">
                      {formatLocalTime(row.captured_at, organisationZone)}
                    </Td>
                    <Td>
                      <Link
                        href={`/employees/${row.employee_id}?date=${date}`}
                        className="underline decoration-rule underline-offset-4 hover:text-active"
                      >
                        {row.full_name}
                      </Link>
                    </Td>
                    <Td>
                      {row.app_name ?? <span className="text-ink-faint">—</span>}
                      {row.is_idle && <span className="label ml-2 text-ink-faint">idle</span>}
                    </Td>
                    <Td className="text-ink-soft">{row.url_host ?? <span className="text-ink-faint">—</span>}</Td>
                    <Td numeric>{formatDuration(row.duration_seconds)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Register>

            <div className="mt-3">
              <Note>
                This feed names the application and the site, never the window or page title. Reading what
                somebody had open stays a deliberate act: open their day, where it is recorded that you
                did.
              </Note>
            </div>
          </>
        )}
      </Section>
    </Shell>
  );
}
