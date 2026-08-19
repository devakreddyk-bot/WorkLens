import Link from 'next/link';

import { Field, Note, buttonClass, figureInputClass, selectClass } from '@/components/Fields';
import { Empty, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { Shell } from '@/components/Shell';
import type { AuditEntryRow } from '@/lib/api';
import { fetchAuditLog, fetchEmployees } from '@/lib/api';
import { firstParam, parseCalendarDate, shiftDate, todayIn } from '@/lib/dates';
import { formatLocalTime, formatShortDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Access log' };

/**
 * The actions the trail records, in the words this page uses for them.
 *
 * Written out rather than derived, because the raw values are dotted identifiers — `screenshot.view` —
 * and a log that has to be translated by its reader is a log nobody reads. The list mirrors
 * `AuditAction` in the API; an action it does not know is shown as it arrived rather than hidden.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'screenshot.list': 'Opened a screenshot gallery',
  'screenshot.view': 'Viewed a screenshot',
  'timesheet.export': 'Exported timesheets',
  'audit_log.read': 'Read this log',
  'employee.create': 'Added an employee',
  'employee.update': 'Changed an employee',
  'user.create': 'Registered a dashboard user',
  'user.update': 'Changed a dashboard user',
  'project.create': 'Added a project',
  'project.update': 'Changed a project',
  'project.deactivate': 'Retired a project',
  'project_rule.create': 'Added a project rule',
  'project_rule.delete': 'Deleted a project rule',
  'config.update': 'Changed monitoring settings',
  'enrollment_token.create': 'Issued an enrolment token',
  'device.revoke': 'Revoked a device',
  'deletion_request.create': 'Asked for an erasure',
  'deletion_request.execute': 'Ran an erasure',
};

/** The actions worth filtering by, in the order somebody looking for something would try them. */
const FILTERABLE = [
  'screenshot.view',
  'screenshot.list',
  'timesheet.export',
  'config.update',
  'deletion_request.execute',
  'device.revoke',
  'audit_log.read',
] as const;

/**
 * The metadata, rendered as the short phrase it usually is.
 *
 * The column exists because the useful detail is often in it — which date a gallery was for, which
 * fields a settings change touched — and it is deliberately not a JSON dump: a register does not print
 * braces. Values that are not scalars are stringified, which is rare and better than dropping them.
 */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return (value as unknown[]).map(render).join(' ');
  // An object here is unexpected but not impossible: `metadata` is a jsonb column and a future action
  // may nest something. Stringified rather than dropped, because a detail nobody can read is still
  // better than a detail nobody knows exists.
  return JSON.stringify(value) ?? '';
}

function describe(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    const rendered = render(value);
    if (rendered === '') continue;
    parts.push(`${key.replace(/_/g, ' ')} ${rendered}`);
  }
  return parts.join(' · ');
}

/** Whether this entry names the actor looking at their own record. */
function isSelfAccess(entry: AuditEntryRow): boolean {
  return entry.metadata['self'] === true;
}

/**
 * Who has looked at whose data.
 *
 * # Reading this is itself recorded
 *
 * Every load of this page writes an `audit_log.read` entry, filters included. That is not circular
 * busywork: the question "who has been reviewing who has been looking at whose data" has an answer, and
 * without the entry it would not. Nor can the read be hidden — the application's database role has no
 * `delete` on this table.
 *
 * # The filters are a plain form
 *
 * A GET form, so a particular slice of the log is a link, and no JavaScript is involved in narrowing it.
 * The dates are calendar dates in the organisation's timezone, converted to instants by the API — which
 * matters, because comparing a `timestamptz` against a bare date would apply UTC boundaries to an
 * Indian working day.
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const context = await loadPage();
  const query = await searchParams;

  const timezone = context.me.organization.timezone;
  const today = todayIn(timezone);

  const to = parseCalendarDate(firstParam(query['to'])) ?? today;
  const from = parseCalendarDate(firstParam(query['from'])) ?? shiftDate(to, -13);
  const action = firstParam(query['action']) ?? '';
  const employee = firstParam(query['employee']) ?? '';
  const cursor = firstParam(query['cursor']);

  const [log, roster] = await Promise.all([
    fetchAuditLog({
      from,
      to,
      action: action === '' ? undefined : action,
      employeeId: employee === '' ? undefined : employee,
      cursor,
    }),
    fetchEmployees('all'),
  ]);

  /** The filters as they are, for building the next-page link without losing them. */
  const carried = new URLSearchParams({ from, to });
  if (action !== '') carried.set('action', action);
  if (employee !== '') carried.set('employee', employee);

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Access log</p>
        <h1 className="mt-1 text-[1.9rem] leading-tight">Who looked at whose data</h1>
        <p className="mt-3 max-w-[46rem] text-[0.9375rem] leading-relaxed text-ink-soft">
          Every screenshot opened, every gallery listed, every export taken and every change to what is
          collected. Entries cannot be edited or removed by anything in this product.
        </p>
      </header>

      <Section label="Filter" title="Narrow the trail">
        <form method="get" className="border border-rule-strong bg-slip p-5">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="From" htmlFor="from">
              <input id="from" name="from" type="date" defaultValue={from} max={today} className={figureInputClass} />
            </Field>
            <Field label="To" htmlFor="to">
              <input id="to" name="to" type="date" defaultValue={to} max={today} className={figureInputClass} />
            </Field>
            <Field label="Action" htmlFor="action">
              <select id="action" name="action" defaultValue={action} className={selectClass}>
                <option value="">Everything</option>
                {FILTERABLE.map((value) => (
                  <option key={value} value={value}>
                    {ACTION_LABELS[value] ?? value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="About" htmlFor="employee" hint="Entries concerning one person.">
              <select id="employee" name="employee" defaultValue={employee} className={selectClass}>
                <option value="">Anyone</option>
                {roster.employees.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name}
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

      <Section
        label={`${formatShortDate(from)} to ${formatShortDate(to)}`}
        title={cursor === undefined ? 'Entries' : 'Earlier entries'}
        aside={<span className="label text-ink-faint">{log.count} on this page</span>}
      >
        {log.entries.length === 0 ? (
          <Empty>
            No entries match. Over a period when nobody opened anybody&rsquo;s record, this page being empty
            is the product working rather than a gap in the trail.
          </Empty>
        ) : (
          <Register>
            <RegisterHead>
              <Th numeric className="w-[9rem]">
                When
              </Th>
              <Th className="w-[15rem]">Who</Th>
              <Th className="w-[15rem]">Did what</Th>
              <Th className="w-[12rem]">About</Th>
              <Th>Detail</Th>
              <Th numeric className="w-[9rem]">
                From
              </Th>
            </RegisterHead>
            <tbody>
              {log.entries.map((entry, index) => (
                <Tr key={entry.id} index={index}>
                  <Td numeric className="text-left text-ink-soft">
                    {formatShortDate(entry.created_at.slice(0, 10))} {formatLocalTime(entry.created_at, timezone)}
                  </Td>
                  <Td>
                    {entry.actor_email}
                    <span className="label ml-2 text-ink-faint">{entry.actor_role}</span>
                  </Td>
                  <Td>{ACTION_LABELS[entry.action] ?? entry.action}</Td>
                  <Td className="text-ink-soft">
                    {entry.subject_employee_name ??
                      (entry.subject_employee_id !== null ? (
                        <span className="text-ink-faint">an erased record</span>
                      ) : (
                        <span className="text-ink-faint">{entry.subject_type.replace(/_/g, ' ')}</span>
                      ))}
                    {/* Worth marking: an employee reading their own record is a different event from a
                        manager reading it, and a trail that did not distinguish them would make the
                        common case look like surveillance. */}
                    {isSelfAccess(entry) && <span className="label ml-2 text-ink-faint">their own</span>}
                  </Td>
                  <Td className="figure max-w-[24rem] truncate text-[0.8125rem] text-ink-soft">
                    {describe(entry.metadata)}
                  </Td>
                  <Td numeric className="text-[0.8125rem] text-ink-faint">
                    {entry.ip ?? '—'}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Register>
        )}

        {log.next_cursor !== null && (
          <p className="mt-5" data-print="hide">
            <Link
              href={`/audit-log?${carried.toString()}&cursor=${encodeURIComponent(log.next_cursor)}`}
              className="label border border-rule-strong bg-slip px-4 py-2 hover:border-ink"
            >
              Earlier entries
            </Link>
          </p>
        )}

        {cursor !== undefined && (
          <p className="mt-3 text-[0.8125rem]" data-print="hide">
            <Link
              href={`/audit-log?${carried.toString()}`}
              className="underline decoration-rule underline-offset-4 hover:text-ink"
            >
              Back to the most recent entries
            </Link>
          </p>
        )}

        <div className="mt-5 max-w-[46rem]">
          <Note>
            Opening this page has been recorded, with the filters you used. So has every previous read of
            it, by anybody.
          </Note>
        </div>
      </Section>
    </Shell>
  );
}
