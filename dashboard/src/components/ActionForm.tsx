'use client';

/**
 * The two ways this dashboard submits something.
 *
 * `ActionForm` for a form with fields; `ActionButton` for a control whose only input is the decision
 * to press it. Both hold the result in place rather than navigating: a failure that replaced the page
 * would throw away whatever had been typed, and on the settings and erasure pages the typing is the
 * expensive part.
 *
 * They take a Server Action as a prop, which is what keeps the pages that use them as Server
 * Components. A page renders `retireProject.bind(null, project.id)` and ships no data-fetching
 * JavaScript to do it.
 */

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/lib/action-result';
import { IDLE } from '@/lib/action-result';

import { ActionNotice, buttonClass, dangerButtonClass, quietButtonClass } from './Fields';

export type BoundAction<T> = (previous: FormState<T>, form: FormData) => Promise<FormState<T>>;

/**
 * The submit control.
 *
 * `useFormStatus` rather than the action's own state, because "in flight" is a property of the form
 * and reading it from the button means the button cannot disagree with it. The label changes rather
 * than a spinner appearing: this design has no floating elements, and a word is clearer anyway.
 */
export function SubmitButton({
  label,
  pendingLabel,
  tone = 'primary',
  disabled = false,
}: {
  label: string;
  pendingLabel: string;
  tone?: 'primary' | 'quiet' | 'danger';
  disabled?: boolean;
}): React.ReactElement {
  const { pending } = useFormStatus();
  const className =
    tone === 'danger' ? dangerButtonClass : tone === 'quiet' ? quietButtonClass : buttonClass;

  return (
    <button type="submit" className={className} disabled={pending || disabled}>
      {pending ? pendingLabel : label}
    </button>
  );
}

export function ActionForm<T>({
  action,
  children,
  submitLabel,
  pendingLabel,
  successMessage,
  tone = 'primary',
  /** Clears the inputs once the server has accepted them. Wrong for a settings form, right for "add". */
  resetOnSuccess = false,
  className = '',
}: {
  action: BoundAction<T>;
  children: React.ReactNode;
  submitLabel: string;
  pendingLabel: string;
  successMessage?: string;
  tone?: 'primary' | 'quiet' | 'danger';
  resetOnSuccess?: boolean;
  className?: string;
}): React.ReactElement {
  const [state, dispatch] = useActionState<FormState<T>, FormData>(action, IDLE);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state.status === 'ok') form.current?.reset();
  }, [resetOnSuccess, state]);

  return (
    <form ref={form} action={dispatch} className={className}>
      {children}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <SubmitButton label={submitLabel} pendingLabel={pendingLabel} tone={tone} />
        <div className="min-w-0 flex-1">
          <ActionNotice state={state} {...(successMessage === undefined ? {} : { successMessage })} />
        </div>
      </div>
    </form>
  );
}

/**
 * A single control, optionally behind a stated consequence.
 *
 * When `confirm` is given the first press does not act: it replaces the button with the sentence
 * describing what will happen and a control that carries it out. A native `confirm()` dialog would be
 * shorter to write and would put the most important sentence in this product — "this cannot be undone"
 * — in a browser chrome the design has no control over.
 */
export function ActionButton<T>({
  action,
  label,
  pendingLabel,
  tone = 'quiet',
  confirm,
  successMessage,
}: {
  action: BoundAction<T>;
  label: string;
  pendingLabel: string;
  tone?: 'primary' | 'quiet' | 'danger';
  confirm?: { question: string; detail: React.ReactNode; confirmLabel: string };
  successMessage?: string;
}): React.ReactElement {
  const [state, dispatch] = useActionState<FormState<T>, FormData>(action, IDLE);
  const [asked, setAsked] = useState(false);

  // Once it has been done, the control goes away and the outcome stays. Leaving a live "Erase" button
  // beside "Erased 412 records" invites a second press against a request that is already finished.
  if (state.status === 'ok') {
    return <ActionNotice state={state} {...(successMessage === undefined ? {} : { successMessage })} />;
  }

  if (confirm !== undefined && !asked) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={tone === 'danger' ? dangerButtonClass : quietButtonClass} onClick={() => setAsked(true)}>
          {label}
        </button>
        <ActionNotice state={state} />
      </div>
    );
  }

  return (
    <form action={dispatch}>
      {confirm !== undefined && (
        <div className="mb-2 border-l-2 border-flag bg-flag-soft px-3 py-2">
          <p className="text-[0.875rem] text-ink">{confirm.question}</p>
          <p className="mt-0.5 text-[0.8125rem] text-ink-soft">{confirm.detail}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          label={confirm === undefined ? label : confirm.confirmLabel}
          pendingLabel={pendingLabel}
          tone={tone}
        />
        {confirm !== undefined && (
          <button type="button" className="label underline decoration-rule underline-offset-4" onClick={() => setAsked(false)}>
            Cancel
          </button>
        )}
        <ActionNotice state={state} />
      </div>
    </form>
  );
}
