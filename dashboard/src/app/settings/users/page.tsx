import { ActionButton, ActionForm } from '@/components/ActionForm';
import { Field, Note, inputClass, selectClass } from '@/components/Fields';
import { Empty, Register, RegisterHead, Section, Td, Th, Tr } from '@/components/Register';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { addUser, changeUserRole, setUserStatus } from '@/lib/actions';
import { fetchEmployees, fetchUsers } from '@/lib/api';
import { formatLocalTime, formatShortDate } from '@/lib/format';
import { loadPage, shellProps } from '@/lib/page';

export const metadata = { title: 'Users' };

const ROLES: readonly { value: 'owner' | 'manager' | 'employee'; label: string; scope: string }[] = [
  { value: 'owner', label: 'Owner', scope: 'Everything, including these settings and the access log.' },
  { value: 'manager', label: 'Manager', scope: 'Every employee’s records. No settings, no user management.' },
  { value: 'employee', label: 'Employee', scope: 'Their own record only, and nothing else.' },
];

/**
 * Who can sign in to this dashboard, and what each of them can see.
 *
 * # Two things this page cannot do, and says so
 *
 * It cannot create a sign-in account. The account lives in the Cognito user pool and `admin-api` holds
 * no `cognito-idp` permission, so the flow is: create the account in the pool, then register it here
 * with its subject id. The form asks for that id rather than pretending to send an invitation.
 *
 * It cannot report whether somebody has a second factor. `users` has no such column and there is nowhere
 * to put one — MFA state lives in Cognito and reaches this API only as a claim on the *caller's* own
 * token. A blank column would imply the answer is "no"; a sentence says the truth.
 */
export default async function UsersSettingsPage(): Promise<React.ReactElement> {
  const context = await loadPage();
  const [{ users }, roster] = await Promise.all([fetchUsers(), fetchEmployees('all')]);

  const ordered = [...users].sort((a, b) => a.email.localeCompare(b.email));

  return (
    <Shell {...shellProps(context)}>
      <header className="mb-8">
        <p className="label">Settings</p>
        <h1 className="mt-1 text-[1.9rem] leading-tight">Dashboard users</h1>
        <div className="mt-4">
          <SettingsNav current="/settings/users" />
        </div>
      </header>

      <Section label="Register" title={`${ordered.length} ${ordered.length === 1 ? 'account' : 'accounts'}`}>
        {ordered.length === 0 ? (
          <Empty>No accounts are registered, which should not be possible while you are reading this page.</Empty>
        ) : (
          <Register>
            <RegisterHead>
              <Th>Email</Th>
              <Th className="w-[10rem]">Role</Th>
              <Th className="w-[12rem]">Own record</Th>
              <Th className="w-[8rem]">Status</Th>
              <Th numeric className="w-[9rem]">
                Last sign-in
              </Th>
              <Th className="w-[20rem]">&nbsp;</Th>
            </RegisterHead>
            <tbody>
              {ordered.map((user, index) => {
                const isSelf = user.id === context.me.user.id;
                return (
                  <Tr key={user.id} index={index}>
                    <Td>{user.email}</Td>
                    <Td>
                      <span className="label">{user.role}</span>
                    </Td>
                    <Td className="text-ink-soft">
                      {user.employee_name ?? <span className="text-ink-faint">not linked</span>}
                    </Td>
                    <Td>
                      {user.status === 'active' ? (
                        <span className="label">Active</span>
                      ) : (
                        <span className="label text-flag">Disabled</span>
                      )}
                    </Td>
                    <Td numeric className="text-ink-soft">
                      {user.last_login_at === null
                        ? '—'
                        : `${formatShortDate(user.last_login_at.slice(0, 10))} ${formatLocalTime(user.last_login_at, context.me.organization.timezone)}`}
                    </Td>
                    <Td>
                      {isSelf ? (
                        /* Mirrors a refusal rather than making a decision: the API rejects an owner
                           changing their own role or status, because there is no other way back in — user
                           management is owner-only. Showing the controls anyway would offer a button whose
                           only outcome is an error. */
                        <span className="text-[0.8125rem] text-ink-faint">
                          Your own account. Another owner has to change your role or disable you.
                        </span>
                      ) : (
                        <div className="space-y-3">
                          <ActionForm
                            action={changeUserRole.bind(null, user.id)}
                            submitLabel="Apply"
                            pendingLabel="Applying"
                            tone="quiet"
                          >
                            <select name="role" defaultValue={user.role} className={selectClass} aria-label={`Role for ${user.email}`}>
                              {ROLES.map((role) => (
                                <option key={role.value} value={role.value}>
                                  {role.label}
                                </option>
                              ))}
                            </select>
                          </ActionForm>

                          {user.status === 'active' ? (
                            <ActionButton
                              action={setUserStatus.bind(null, user.id, 'disabled')}
                              label="Disable"
                              pendingLabel="Disabling"
                              confirm={{
                                question: `Disable ${user.email}?`,
                                detail:
                                  'They can no longer sign in to the dashboard. Their employee record and everything collected about them is untouched.',
                                confirmLabel: 'Disable the account',
                              }}
                            />
                          ) : (
                            <ActionButton
                              action={setUserStatus.bind(null, user.id, 'active')}
                              label="Enable"
                              pendingLabel="Enabling"
                            />
                          )}
                        </div>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Register>
        )}

        <div className="mt-4 max-w-[46rem] space-y-3">
          <Note>
            Whether an account has a second factor is not shown, and cannot be: that lives in the sign-in
            directory, and this API only ever learns it about the person currently signed in. Owners and
            managers are refused every administrative page until they have one, so an admin who has not
            enrolled will know.
          </Note>
          <dl className="space-y-1.5 text-[0.8125rem]">
            {ROLES.map((role) => (
              <div key={role.value} className="flex gap-3">
                <dt className="label w-24 shrink-0 pt-0.5">{role.label}</dt>
                <dd className="text-ink-soft">{role.scope}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section label="Add" title="Register an existing sign-in account">
        <div className="max-w-[44rem] border border-rule-strong bg-slip p-5">
          <ActionForm action={addUser} submitLabel="Register account" pendingLabel="Registering" resetOnSuccess>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Subject id"
                htmlFor="cognito_sub"
                hint="The account's identifier in the sign-in directory. Create the account there first — this page cannot."
              >
                <input
                  id="cognito_sub"
                  name="cognito_sub"
                  type="text"
                  required
                  maxLength={255}
                  className={`${inputClass} font-mono text-[0.8125rem]`}
                />
              </Field>
              <Field label="Email" htmlFor="email" hint="Must match the account in the directory.">
                <input id="email" name="email" type="email" required maxLength={254} className={inputClass} />
              </Field>
              <Field label="Role" htmlFor="role">
                <select id="role" name="role" defaultValue="employee" className={selectClass}>
                  {ROLES.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Own record"
                htmlFor="employee_id"
                hint="Required for the employee role — that role grants access to exactly one person's data, so it is meaningless without naming them."
              >
                <select id="employee_id" name="employee_id" defaultValue="" className={selectClass}>
                  <option value="">Not linked</option>
                  {roster.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.full_name}
                      {employee.status === 'inactive' ? ' (inactive)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </ActionForm>
        </div>
      </Section>
    </Shell>
  );
}
