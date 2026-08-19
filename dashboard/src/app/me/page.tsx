import Link from 'next/link';

import { EmployeeRecord } from '@/components/EmployeeRecord';
import type { RecordView } from '@/components/EmployeeRecord';
import { Note } from '@/components/Fields';
import { Shell } from '@/components/Shell';
import { firstParam, parseCalendarDate, todayIn } from '@/lib/dates';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'My record' };

/**
 * The employee self-view.
 *
 * # It is the same page
 *
 * This renders `<EmployeeRecord>` with the same props `/employees/[id]` passes: the same figures, the
 * same day-band, the same breakdowns, the same activity register with the window titles in it. The only
 * difference is the copy — `self` changes "Priya's record" to "your record" and addresses the sentence
 * about screenshot access to the right person.
 *
 * That is not a nicety. The product's argument for being installable at all is that monitoring which
 * the monitored person can inspect is a different thing from monitoring they cannot, and a self-view
 * that showed less would quietly withdraw the argument. Anything that would need a simplified version
 * here is a sign the shared component is wrong, not that this page needs its own.
 *
 * # An account with no record
 *
 * `employee` is null for an administrative account with no monitored machine — a bookkeeper, an owner
 * who does not use a work laptop. That is a legitimate state and gets a sentence rather than an empty
 * day, because an empty day would read as "nothing was recorded" when the truth is "there is nothing
 * to record".
 */
export default async function MyRecordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const context = await loadPage();
  const query = await searchParams;

  const employee = context.me.employee;
  const view: RecordView = firstParam(query['view']) === 'week' ? 'week' : 'day';

  if (employee === null) {
    return (
      <Shell {...shellProps(context)}>
        <header className="mb-8">
          <p className="label">My record</p>
          <h1 className="mt-1 border-b border-rule-strong pb-3 text-[1.9rem] leading-tight">
            There is nothing recorded about you
          </h1>
        </header>

        <div className="max-w-[42rem] space-y-4">
          <p className="text-[1.05rem] leading-relaxed text-ink-soft">
            Your account can sign in to this dashboard, but it is not attached to a monitored employee, so
            no timesheet is produced for you and no machine reports under your name.
          </p>
          <Note>
            If that is wrong — if you do work on a machine that should be reporting — whoever administers
            this deployment needs to link your account to your employee record.
          </Note>
          <p className="text-[0.9375rem] text-ink-soft">
            <Link href="/overview" className="underline decoration-rule underline-offset-4 hover:text-active">
              Go to the overview
            </Link>{' '}
            if your account covers other people&rsquo;s records.
          </p>
        </div>
      </Shell>
    );
  }

  // The employee's own zone, so "today" is their today. A person opening their record at 00:30 should
  // see the day that has just started for them, not the one still running at head office.
  const date = parseCalendarDate(firstParam(query['date'])) ?? todayIn(employee.timezone);

  return (
    <Shell {...shellProps(context)}>
      <EmployeeRecord employeeId={employee.id} date={date} view={view} basePath="/me" self />
    </Shell>
  );
}
