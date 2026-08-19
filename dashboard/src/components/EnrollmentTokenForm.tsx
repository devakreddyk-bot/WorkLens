'use client';

/**
 * Minting an enrolment token.
 *
 * A Client Component for one reason: the token is returned once and is not recoverable. Only its
 * SHA-256 is stored, so there is no page that can show it again and no way to recover it if the tab is
 * closed. That makes the result the most important thing on the screen after it appears, and it has to
 * appear in place rather than as a notice that scrolls past.
 *
 * The token is a bearer credential that mints device credentials, which is why the form offers a short
 * lifetime by default and why the panel says out loud that it will not be shown again.
 */

import { useActionState } from 'react';

import type { EnrollmentTokenIssued } from '@/lib/api';
import type { FormState } from '@/lib/action-result';
import { IDLE } from '@/lib/action-result';
import { issueEnrollmentToken } from '@/lib/actions';

import { SubmitButton } from './ActionForm';
import { ActionNotice, Field, figureInputClass, selectClass } from './Fields';

export function EnrollmentTokenForm({
  employees,
}: {
  employees: readonly { id: string; name: string }[];
}): React.ReactElement {
  const [state, dispatch] = useActionState<FormState<EnrollmentTokenIssued>, FormData>(
    issueEnrollmentToken,
    IDLE,
  );

  return (
    <div>
      <form action={dispatch}>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field
            label="Whose machine"
            htmlFor="employee_id"
            error={state.status === 'error' ? state.fields['employee_id'] : undefined}
          >
            <select id="employee_id" name="employee_id" defaultValue="" className={selectClass}>
              <option value="">Choose a person</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Valid for"
            htmlFor="expires_in_hours"
            hint="Hours, up to a week. This is how long a leaked token would be useful for."
          >
            <input
              id="expires_in_hours"
              name="expires_in_hours"
              type="number"
              min={1}
              max={168}
              defaultValue={24}
              className={figureInputClass}
            />
          </Field>

          <div className="flex items-end">
            <SubmitButton label="Issue token" pendingLabel="Issuing" />
          </div>
        </div>
      </form>

      <div className="mt-4">
        <ActionNotice state={state} />
      </div>

      {state.status === 'ok' && (
        <div className="mt-4 border-2 border-flag bg-slip p-4">
          <p className="label text-flag">Shown once</p>
          <p className="mt-1 text-[0.875rem] text-ink">
            Copy this now. Only a hash of it is stored, so nothing can show it again — if you lose it, issue
            another one.
          </p>

          {/* Selectable, wrapping, and mono. A token that has to be copied by hand off a screen is a
              token that gets mistyped, so it is presented as one continuous string with nothing else on
              the line. */}
          <p className="figure mt-3 border border-rule-strong bg-band px-3 py-2 text-[0.8125rem] break-all select-all">
            {state.value.token}
          </p>

          <p className="label mt-4">Run this on the machine</p>
          <p className="figure mt-1 border border-rule bg-band px-3 py-2 text-[0.8125rem] break-all select-all">
            worklens-agentctl enroll --token {state.value.token}
          </p>

          <p className="figure mt-3 text-[0.8125rem] text-ink-soft">
            Expires {state.value.expires_at}
          </p>
        </div>
      )}
    </div>
  );
}
