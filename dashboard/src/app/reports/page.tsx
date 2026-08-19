import { ExportButton } from '@/components/ExportButton';
import { Field, Note, buttonClass, figureInputClass, selectClass } from '@/components/Fields';
import { Empty, Figure, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { Shell } from '@/components/Shell';
import type { TimesheetRow } from '@/lib/api';
import { fetchEmployees, fetchTeamTimesheets } from '@/lib/api';
import { daysBetween, firstParam, parseCalendarDate, shiftDate, todayIn } from '@/lib/dates';
import { formatDuration, formatShortDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Reports' };

/** The API's own ceiling on a scanned range, from `MAX_RANGE_DAYS` in its dashboard schemas. */
const MAX_RANGE_DAYS = 400;

/** A fortnight, because that is the most common payroll period this will be used for. */
const DEFAULT_SPAN_DAYS = 13;

interface Line {
  employeeId: string;
  fullName: string;
  days: number;
  active: number;
  idle: number;
  recorded: number;
}

/**
 * One line per person, summed over the range.
 *
 * The CSV is a row per employee per day — that is what payroll reconciles against — but a register on
 * screen with four hundred rows of it is not readable, and the question being asked before an export is
 * "does this look right", which is a per-person question.
 */
function summarise(rows: readonly TimesheetRow[]): Line[] {
  const lines = new Map<string, Line>();

  for (const row of rows) {
    const existing = lines.get(row.employee_id) ?? {
      employeeId: row.employee_id,
      fullName: row.full_name,
      days: 0,
      active: 0,
      idle: 0,
      recorded: 0,
    };

    lines.set(row.employee_id, {
      ...existing,
      days: existing.days + 1,
      active: existing.active + row.active_seconds,
      idle: existing.idle + row.idle_seconds,
      recorded: existing.recorded + row.total_seconds,
    });
  }

  return [...lines.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * The payroll export.
 *
 * The filters are a plain GET form, so the range lives in the URL and the page needs no JavaScript to
 * change it — which also means a particular fortnight is a link. Only the download itself is a Client
 * Component, because the file has to be assembled from a base64 envelope and because the export is
 * audited: it should appear in the access log when somebody asked for the file, not when they opened
 * the page.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const context = await loadPage();
  const query = await searchParams;

  const organisationZone = context.me.organization.timezone;
  const today = todayIn(organisationZone);

  const to = parseCalendarDate(firstParam(query['to'])) ?? today;
  const from = parseCalendarDate(firstParam(query['from'])) ?? shiftDate(to, -DEFAULT_SPAN_DAYS);
  const employeeId = firstParam(query['employee']) ?? '';

  const roster = await fetchEmployees('all');
  const chosen = roster.employees.find((employee) => employee.id === employeeId) ?? null;

  const span = daysBetween(from, to);
  /* Checked here rather than left to the API so the answer is a sentence on the page instead of an
     error boundary. The bound is the API's: `from`/`to` reach a range scan on an indexed column, and a
     request for a decade is a full table scan dressed up as a filter. */
  const rangeProblem =
    span < 0
      ? 'The first date is after the last one. Swap them.'
      : span > MAX_RANGE_DAYS
        ? `That range is ${span} days. The longest range this will read is ${MAX_RANGE_DAYS} days — export it in two parts.`
        : null;

  const sheets = rangeProblem === null ? await fetchTeamTimesheets(from, to, chosen?.id) : null;
  const lines = sheets === null ? [] : summarise(sheets.timesheets);
  const totals = lines.reduce(
    (sum, line) => ({
      active: sum.active + line.active,
      idle: sum.idle + line.idle,
      recorded: sum.recorded + line.recorded,
      days: sum.days + line.days,
    }),
    { active: 0, idle: 0, recorded: 0, days: 0 },
  );

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Reports</p>
        <h1 className="mt-1 border-b border-rule-strong pb-3 text-[1.9rem] leading-tight">
          Timesheet export
        </h1>
      </header>

      <Section label="Period" title="What to export">
        {/* A GET form: the range belongs in the address, so a particular fortnight can be sent to
            whoever is asking about it. No JavaScript is involved in choosing it. */}
        <form method="get" className="border border-rule-strong bg-slip p-5">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="From" htmlFor="from">
              <input id="from" name="from" type="date" defaultValue={from} max={today} className={figureInputClass} />
            </Field>
            <Field label="To" htmlFor="to">
              <input id="to" name="to" type="date" defaultValue={to} max={today} className={figureInputClass} />
            </Field>
            <Field label="Person" htmlFor="employee" hint="Leave as everyone for a payroll run.">
              <select id="employee" name="employee" defaultValue={employeeId} className={selectClass}>
                <option value="">Everyone</option>
                {roster.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.full_name}
                    {employee.status === 'inactive' ? ' (inactive)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button type="submit" className={buttonClass}>
                Show
              </button>
            </div>
          </div>
        </form>
      </Section>

      {rangeProblem !== null ? (
        <Section label="Range" title="That period cannot be read">
          <Note tone="flag">{rangeProblem}</Note>
        </Section>
      ) : (
        <>
          <Section
            label={`${formatShortDate(from)} to ${formatShortDate(to)}`}
            title={chosen === null ? 'Everyone' : chosen.full_name}
            aside={
              <>
                <Figure value={formatDuration(totals.active)} label="Active" tone="active" />
                <Figure value={formatDuration(totals.idle)} label="Idle" tone="idle" />
                <Figure value={formatDuration(totals.recorded)} label="Recorded" />
                <Figure value={String(totals.days)} label="Employee-days" />
              </>
            }
          >
            {lines.length === 0 ? (
              <Empty>
                No timesheets exist for this period. Timesheets are produced from recorded activity
                overnight, so today&rsquo;s figures usually appear tomorrow.
              </Empty>
            ) : (
              <Register>
                <RegisterHead>
                  <Th>Person</Th>
                  <Th numeric className="w-[7rem]">
                    Days
                  </Th>
                  <Th numeric className="w-[8rem]">
                    Active
                  </Th>
                  <Th numeric className="w-[8rem]">
                    Idle
                  </Th>
                  <Th numeric className="w-[8rem]">
                    Recorded
                  </Th>
                </RegisterHead>
                <tbody>
                  {lines.map((line, index) => (
                    <Tr key={line.employeeId} index={index}>
                      <Td>{line.fullName}</Td>
                      <Td numeric>{line.days}</Td>
                      <Td numeric>{formatDuration(line.active)}</Td>
                      <Td numeric>{formatDuration(line.idle)}</Td>
                      <Td numeric>{formatDuration(line.recorded)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Register>
            )}

            {sheets !== null && sheets.truncated && (
              <div className="mt-3">
                <Note tone="flag">
                  This period has more timesheets than one read returns, so the figures above are
                  incomplete. The exported file is produced separately and is not truncated, but export a
                  shorter period if you need the summary to reconcile.
                </Note>
              </div>
            )}
          </Section>

          <Section label="Export" title="The file">
            <div className="border border-rule-strong bg-slip p-5">
              <ExportButton
                from={from}
                to={to}
                employeeId={chosen?.id ?? null}
                employeeName={chosen?.full_name ?? null}
              />

              <dl className="mt-5 border-t border-rule pt-4 text-[0.875rem]">
                <div className="flex flex-wrap gap-x-3">
                  <dt className="label w-24 shrink-0 pt-0.5">Columns</dt>
                  <dd className="text-ink-soft">
                    Date, name, email, payroll reference, timezone, active, idle and total hours to two
                    decimal places, the same three as seconds, first and last activity, screenshot count,
                    and how many records each day was built from.
                  </dd>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3">
                  <dt className="label w-24 shrink-0 pt-0.5">Rows</dt>
                  <dd className="text-ink-soft">
                    One per person per day. Days with nothing recorded produce no row.
                  </dd>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3">
                  <dt className="label w-24 shrink-0 pt-0.5">Not in it</dt>
                  <dd className="text-ink-soft">
                    Window titles, sites, projects and screenshots. This is a file for paying people, and
                    payroll has no business holding a record of what anybody had open.
                  </dd>
                </div>
              </dl>
            </div>
          </Section>
        </>
      )}
    </Shell>
  );
}
