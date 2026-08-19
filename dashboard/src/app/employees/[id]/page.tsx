import { EmployeeRecord } from '@/components/EmployeeRecord';
import type { RecordView } from '@/components/EmployeeRecord';
import { Shell } from '@/components/Shell';
import { firstParam, parseCalendarDate, todayIn } from '@/lib/dates';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Employee record' };

/**
 * One employee's record, as an owner or a manager reads it.
 *
 * The page itself is thin on purpose: everything it renders is `<EmployeeRecord>`, which `/me` renders
 * too. That is what makes the product's central promise — an employee sees exactly what their employer
 * sees — a property of the code rather than of somebody remembering to keep two views in step.
 *
 * There is no role check here. An employee who follows a link to somebody else's id is refused by
 * `resolveEmployeeScope` on the server and the error boundary states the refusal. A check here would be
 * a second opinion that could eventually disagree with the first.
 */
export default async function EmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const context = await loadPage();
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const view: RecordView = firstParam(query['view']) === 'week' ? 'week' : 'day';
  /* The organisation's zone for the default day, not the employee's — the employee's is not known
     until the record is fetched, and the day is what selects the fetch. A colleague whose day has
     already turned over is one press of Later away. */
  const date = parseCalendarDate(firstParam(query['date'])) ?? todayIn(context.me.organization.timezone);

  return (
    <Shell {...shellProps(context)}>
      <EmployeeRecord
        employeeId={id}
        date={date}
        view={view}
        basePath={`/employees/${id}`}
        self={context.session.employeeId === id}
      />
    </Shell>
  );
}
