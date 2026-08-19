import Link from 'next/link';

import { ActionButton, ActionForm } from '@/components/ActionForm';
import { Field, Note, inputClass, selectClass } from '@/components/Fields';
import { Empty, Figure, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { requestErasure, runErasure } from '@/lib/actions';
import { fetchDeletionRequests, fetchEmployees, fetchMonitoringConfig } from '@/lib/api';
import { formatLocalTime, formatShortDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Data' };

const SCOPES: readonly { value: 'all' | 'events' | 'screenshots'; label: string; effect: string }[] = [
  {
    value: 'all',
    label: 'Everything',
    effect: 'Every activity record and every screenshot for that person is deleted, along with the image files themselves.',
  },
  {
    value: 'screenshots',
    label: 'Screenshots only',
    effect: 'The images and their rows are deleted. Timesheets and activity records stay, so the hours still reconcile.',
  },
  {
    value: 'events',
    label: 'Activity only',
    effect: 'Activity records are deleted. Screenshots stay, and so do the daily timesheets already built from the activity.',
  },
];

function moment(iso: string | null, timezone: string): string {
  if (iso === null) return '—';
  return `${formatShortDate(iso.slice(0, 10))} ${formatLocalTime(iso, timezone)}`;
}

/**
 * Retention and erasure.
 *
 * # Retention is shown here and changed elsewhere
 *
 * The two windows live in the monitoring configuration, because `PUT /v1/config` is a full replacement
 * and splitting two of its fields onto a second form would mean a save from here silently restating
 * every other setting. So this page states them and links to the one place they can be changed.
 *
 * # An erasure is two steps on purpose
 *
 * Recording a request deletes nothing. The second step is irreversible and destructive, and it is worth
 * the extra press: the reason field is the paper trail, and somebody asked to erase an employee's record
 * should have written down why before the bytes go.
 *
 * # What an erasure deliberately keeps
 *
 * The audit rows describing the erasure, and the accesses that preceded it. That is not an oversight —
 * a deletion you cannot evidence is worse than no deletion at all — and it is enforced by grant rather
 * than by intention: the application's database role has no `delete` on the audit table.
 */
export default async function DataSettingsPage(): Promise<React.ReactElement> {
  const context = await loadPage();
  const [{ config }, { deletion_requests: requests }, roster] = await Promise.all([
    fetchMonitoringConfig(),
    fetchDeletionRequests(),
    fetchEmployees('all'),
  ]);

  const timezone = context.me.organization.timezone;
  const pending = requests.filter((request) => request.status === 'pending');

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Settings</p>
        <h1 className="mt-1 text-[1.9rem] leading-tight">Data</h1>
        <div className="mt-4">
          <SettingsNav current="/settings/data" />
        </div>
      </header>

      <Section
        label="Retention"
        title="How long anything is kept"
        aside={
          <>
            <Figure value={`${config.retention_days_events}d`} label="Activity" />
            <Figure value={`${config.retention_days_screenshots}d`} label="Screenshots" />
          </>
        }
      >
        <div className="max-w-[46rem] space-y-4">
          <p className="text-[0.9375rem] leading-relaxed text-ink-soft">
            A sweep runs daily and deletes anything past its window, including the image files. Nothing has
            to be asked for and nothing is kept beyond it.
          </p>
          <Note>
            Screenshots are never kept longer than the activity that explains them &mdash; an image with no
            record of what was being done is not evidence of anything.{' '}
            <Link
              href="/settings/monitoring"
              className="underline decoration-rule underline-offset-4 hover:text-ink"
            >
              Change the windows in monitoring settings
            </Link>
            .
          </Note>
        </div>
      </Section>

      <Section
        label="Erasure"
        title={`${requests.length} ${requests.length === 1 ? 'request' : 'requests'}`}
        aside={
          pending.length > 0 ? <span className="label text-flag">{pending.length} waiting to run</span> : undefined
        }
      >
        {requests.length === 0 ? (
          <Empty>
            No erasure has been asked for. Records are deleted automatically at the end of their retention
            window without one.
          </Empty>
        ) : (
          <Register>
            <RegisterHead>
              <Th className="w-[13rem]">Person</Th>
              <Th className="w-[10rem]">Scope</Th>
              <Th numeric className="w-[9rem]">
                Asked
              </Th>
              <Th className="w-[9rem]">Status</Th>
              <Th>Reason</Th>
              <Th className="w-[18rem]">&nbsp;</Th>
            </RegisterHead>
            <tbody>
              {requests.map((request, index) => (
                <Tr key={request.id} index={index}>
                  <Td>{request.full_name ?? <span className="text-ink-faint">record already erased</span>}</Td>
                  <Td>
                    <span className="label">{request.scope}</span>
                  </Td>
                  <Td numeric className="text-ink-soft">
                    {moment(request.requested_at, timezone)}
                  </Td>
                  <Td>
                    {request.status === 'pending' ? (
                      <span className="label text-flag">Not run</span>
                    ) : request.status === 'completed' ? (
                      <span className="label">Done</span>
                    ) : (
                      <span className="label text-flag">Failed</span>
                    )}
                    {request.status === 'completed' && (
                      <span className="figure block text-[0.75rem] text-ink-faint">
                        {request.deleted_event_count ?? 0} records, {request.deleted_screenshot_count ?? 0} images
                      </span>
                    )}
                  </Td>
                  <Td className="max-w-[20rem] text-[0.875rem] text-ink-soft">
                    {request.reason ?? <span className="text-ink-faint">none given</span>}
                    {request.error !== null && (
                      <span className="mt-1 block text-flag">{request.error}</span>
                    )}
                  </Td>
                  <Td>
                    {request.status === 'pending' ? (
                      <ActionButton
                        action={runErasure.bind(null, request.id)}
                        label="Erase now"
                        pendingLabel="Erasing"
                        tone="danger"
                        confirm={{
                          question: `Erase ${request.scope === 'all' ? 'everything' : request.scope} for ${request.full_name ?? 'this person'}?`,
                          detail:
                            'This cannot be undone. The image files are deleted from storage as well as the rows. The record that this erasure happened, and of who looked at the data before it, is kept.',
                          confirmLabel: 'Erase permanently',
                        }}
                      />
                    ) : (
                      <span className="text-[0.8125rem] text-ink-faint">
                        {request.completed_at === null ? '' : moment(request.completed_at, timezone)}
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Register>
        )}
      </Section>

      <Section label="Request" title="Ask for an erasure">
        <div className="max-w-[46rem] border border-rule-strong bg-slip p-5">
          <ActionForm
            action={requestErasure}
            submitLabel="Record the request"
            pendingLabel="Recording"
            resetOnSuccess
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Whose data" htmlFor="employee_id">
                <select id="employee_id" name="employee_id" defaultValue="" className={selectClass}>
                  <option value="">Choose a person</option>
                  {roster.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.full_name}
                      {employee.status === 'inactive' ? ' (inactive)' : ''}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="What to erase" htmlFor="scope">
                <select id="scope" name="scope" defaultValue="all" className={selectClass}>
                  {SCOPES.map((scope) => (
                    <option key={scope.value} value={scope.value}>
                      {scope.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-5">
              <Field
                label="Reason"
                htmlFor="reason"
                hint="Recorded on the request. This is the paper trail for the erasure, so write it for somebody reading it in a year."
              >
                <textarea id="reason" name="reason" rows={3} maxLength={2000} className={inputClass} />
              </Field>
            </div>

            <dl className="mt-5 space-y-1.5 border-t border-rule pt-3 text-[0.8125rem]">
              {SCOPES.map((scope) => (
                <div key={scope.value} className="flex gap-3">
                  <dt className="label w-32 shrink-0 pt-0.5">{scope.label}</dt>
                  <dd className="text-ink-soft">{scope.effect}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-4 text-[0.875rem] text-ink-soft">
              Recording a request deletes nothing. It appears above with a control that runs it.
            </p>
          </ActionForm>
        </div>
      </Section>
    </Shell>
  );
}
