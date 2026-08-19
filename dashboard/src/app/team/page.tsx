import Link from 'next/link';

import { DayBand, DayBandLegend } from '@/components/DayBand';
import { DateNav } from '@/components/DateNav';
import { Note } from '@/components/Fields';
import { Empty, Figure, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { Shell } from '@/components/Shell';
import { fetchEmployees, fetchOverview } from '@/lib/api';
import { firstParam, parseCalendarDate, todayIn } from '@/lib/dates';
import { formatDuration, formatLocalTime, formatLongDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Team' };

/**
 * The team register: one day, one row per person, drawn as the shape of their day.
 *
 * # Why the band and not a number
 *
 * A column of hours answers "how much" and hides the thing a timesheet conversation is actually about.
 * Six hours worked 09:00–15:00 and six hours worked in four fragments across twelve are the same number
 * and completely different facts. The band puts them side by side on the same axis, so a week of
 * scattered days is visible as a shape rather than having to be inferred from a total.
 *
 * # Why it is sorted by name
 *
 * Sorting by hours would make this a leaderboard, and the product does not have one. Name order also
 * means the register looks the same every day, so the row somebody is looking for is where it was
 * yesterday.
 *
 * # Where the rows come from, and why it takes two calls
 *
 * `/overview` rather than `/timesheets`. The former is a left join from `employees`, so somebody who
 * recorded nothing is a row of zeroes; the latter returns only timesheets that exist, and a missing row
 * and a quiet day read identically to somebody scanning the page. Only one of them is a reason to check
 * whether an agent has stopped reporting.
 *
 * What `/overview` does not return is each employee's timezone, and a band needs it: without one, an
 * Indian colleague's 09:00 start would be drawn at 13:30 for a manager in Melbourne. So the roster is
 * read from `/v1/employees` alongside, and the two are joined on the employee id. Both are one query
 * each and both are already scoped to this organisation by the token.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const context = await loadPage();
  const params = await searchParams;

  const organisationZone = context.me.organization.timezone;
  const date = parseCalendarDate(firstParam(params['date'])) ?? todayIn(organisationZone);

  const [overview, roster] = await Promise.all([fetchOverview(date), fetchEmployees('all')]);

  const zones = new Map(roster.employees.map((employee) => [employee.id, employee.timezone]));
  const members = [...overview.team].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const silent = members.filter((member) => member.total_seconds === 0).length;

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Team register</p>
        <div className="mt-1 border-b border-rule-strong pb-3">
          <h1 className="text-[1.9rem] leading-tight">{formatLongDate(date)}</h1>
          <p className="label mt-1 text-ink-faint">
            Each row is drawn from midnight to midnight in that person&rsquo;s own timezone
          </p>
        </div>
        <div className="mt-4">
          <DateNav date={date} timezone={organisationZone} />
        </div>
      </header>

      <Section
        label="The day"
        title={`${members.length} ${members.length === 1 ? 'person' : 'people'} on the register`}
        aside={
          <>
            <Figure value={formatDuration(overview.totals.active_seconds)} label="Active" tone="active" />
            <Figure value={formatDuration(overview.totals.idle_seconds)} label="Idle" tone="idle" />
            <Figure value={String(silent)} label="Recorded nothing" />
          </>
        }
      >
        {members.length === 0 ? (
          <Empty>
            No employees are on this organisation&rsquo;s register yet. Add them in settings before enrolling
            any machines.
          </Empty>
        ) : (
          <>
            <Register>
              <RegisterHead>
                <Th className="w-[14rem]">Person</Th>
                <Th>Shape of the day</Th>
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
                <Th numeric className="w-[5.5rem]">
                  Images
                </Th>
                <Th numeric className="w-[7rem]">
                  Last seen
                </Th>
              </RegisterHead>
              <tbody>
                {members.map((member, index) => (
                  <Tr key={member.employee_id} index={index}>
                    <Td>
                      <Link
                        href={`/employees/${member.employee_id}?date=${date}`}
                        className="underline decoration-rule underline-offset-4 hover:text-active"
                      >
                        {member.full_name}
                      </Link>
                      {member.device_count === 0 && (
                        <span className="label ml-2 text-flag" title="No machine is enrolled for this person">
                          no device
                        </span>
                      )}
                    </Td>
                    <Td className="py-2">
                      <DayBand
                        workDate={date}
                        /* The employee's own zone, from the roster. Falling back to the organisation's
                           only matters for somebody who has a timesheet and no employee row, which the
                           schema does not allow — but a band drawn in the wrong zone is a plausible
                           picture of the wrong day, so the fallback is stated rather than assumed. */
                        timezone={zones.get(member.employee_id) ?? overview.timezone}
                        activeSeconds={member.active_seconds}
                        idleSeconds={member.idle_seconds}
                        firstActivityAt={member.first_activity_at}
                        lastActivityAt={member.last_activity_at}
                        height={26}
                      />
                    </Td>
                    <Td numeric>{member.active_seconds === 0 ? '—' : formatDuration(member.active_seconds)}</Td>
                    <Td numeric>{member.idle_seconds === 0 ? '—' : formatDuration(member.idle_seconds)}</Td>
                    <Td numeric>
                      {formatLocalTime(member.first_activity_at, zones.get(member.employee_id) ?? overview.timezone)}
                    </Td>
                    <Td numeric>
                      {formatLocalTime(member.last_activity_at, zones.get(member.employee_id) ?? overview.timezone)}
                    </Td>
                    <Td numeric>
                      {member.screenshot_count === 0 ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <Link
                          href={`/employees/${member.employee_id}/screenshots?date=${date}`}
                          className="underline decoration-lens underline-offset-4 hover:text-lens"
                        >
                          {member.screenshot_count}
                        </Link>
                      )}
                    </Td>
                    <Td numeric className="text-ink-soft">
                      {formatLocalTime(member.last_seen_at, organisationZone)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Register>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
              <DayBandLegend />
              <p className="label text-ink-faint">Sorted by name, never by hours</p>
            </div>

            {silent > 0 && (
              <div className="mt-4">
                <Note>
                  {silent} {silent === 1 ? 'person' : 'people'} recorded nothing on this day. A day off, a
                  public holiday and a machine that never came online all look like this — the register
                  cannot tell them apart, and it does not guess.
                </Note>
              </div>
            )}
          </>
        )}
      </Section>
    </Shell>
  );
}
