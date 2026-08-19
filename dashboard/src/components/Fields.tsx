/**
 * Form furniture, in the register's voice.
 *
 * A field on this product's pages is drawn the way a field on a form is drawn: a label above, a hint
 * beneath where the setting has a consequence worth stating, and a rule around the input. No module
 * here declares `'use client'` — these are markup and class names, so both a Server Component
 * rendering a `<form action={serverAction}>` and a Client Component managing a draft can use them.
 * That is the whole reason they are extracted: the settings page and the audit-log filter must look
 * like the same form even though only one of them ships JavaScript.
 */

import type { ActionResult } from '@/lib/action-result';

/**
 * The input's own styling, exported as a string rather than wrapped in a component.
 *
 * A `<TextInput>` wrapper would have to forward every native attribute — `step`, `min`, `pattern`,
 * `inputMode` — and those attributes are exactly what makes each of these fields correct. So the
 * class list is shared and the element stays native.
 */
export const inputClass =
  'w-full border border-rule-strong bg-slip px-2.5 py-1.5 text-[0.9rem] text-ink placeholder:text-ink-faint';

/** For a duration, a count, a date or a time: mono, so a column of inputs aligns like a column of figures. */
export const figureInputClass = `${inputClass} figure`;

export const selectClass = `${inputClass} appearance-none pr-8`;

export const buttonClass =
  'label border border-ink bg-ink px-4 py-2 text-paper transition-colors hover:border-active hover:bg-active disabled:border-rule-strong disabled:bg-rule-strong disabled:text-slip';

export const quietButtonClass =
  'label border border-rule-strong bg-slip px-4 py-2 text-ink transition-colors hover:border-ink disabled:text-ink-faint';

/**
 * A destructive control. The only place `flag` appears on a button.
 *
 * Reserved by the palette for a revoked device, a missing second factor, a retention warning or a
 * confirmation that cannot be undone — so when it appears it means something.
 */
export const dangerButtonClass =
  'label border border-flag bg-flag px-4 py-2 text-paper transition-colors hover:bg-flag/90 disabled:border-rule-strong disabled:bg-rule-strong';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** What this setting does, or what it will start collecting. Stated inline, not in a tooltip. */
  hint?: React.ReactNode;
  error?: string | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <label className="label block" htmlFor={htmlFor}>
        {label}
      </label>
      {hint !== undefined && <p className="mt-1 text-[0.8125rem] leading-snug text-ink-soft">{hint}</p>}
      <div className="mt-1.5">{children}</div>
      {error !== undefined && error !== '' && (
        <p className="mt-1 text-[0.8125rem] text-flag">{error}</p>
      )}
    </div>
  );
}

/**
 * A checkbox with its consequence beside it.
 *
 * The consequence is not optional in the type by accident. On the monitoring page every switch
 * changes what is taken off an employee's machine, and a switch whose effect is not written down is
 * how a product ends up collecting more than anyone decided to collect.
 */
export function Switch({
  name,
  label,
  consequence,
  checked,
  onChange,
  disabled = false,
}: {
  name: string;
  label: string;
  consequence: React.ReactNode;
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div className="flex gap-3">
      <input
        id={name}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange === undefined ? undefined : (event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-active"
      />
      <div>
        <label htmlFor={name} className="label block">
          {label}
        </label>
        <p className="mt-0.5 text-[0.8125rem] leading-snug text-ink-soft">{consequence}</p>
      </div>
    </div>
  );
}

/**
 * The result of a submission, stated where the person can see it.
 *
 * Success is quiet — a rule and a line of text. Failure carries the API's own message, the field it
 * named, and the request id, because that id is the same one in the deployment's logs and is the only
 * thing support can act on.
 */
export function ActionNotice<T>({
  state,
  successMessage,
}: {
  state: { status: 'idle' } | ActionResult<T>;
  /** Used when the action's value is not itself a sentence. */
  successMessage?: string;
}): React.ReactElement | null {
  if (state.status === 'idle') return null;

  if (state.status === 'ok') {
    const message = typeof state.value === 'string' ? state.value : successMessage;
    if (message === undefined) return null;
    return (
      <p role="status" className="border-l-2 border-active bg-band px-3 py-2 text-[0.875rem] text-ink">
        {message}
      </p>
    );
  }

  const fields = Object.entries(state.fields);

  return (
    <div role="alert" className="border-l-2 border-flag bg-flag-soft px-3 py-2 text-[0.875rem]">
      <p className="text-ink">{state.message}</p>
      {fields.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {fields.map(([field, message]) => (
            <li key={field} className="text-ink-soft">
              <span className="figure">{field}</span> {message}
            </li>
          ))}
        </ul>
      )}
      {state.requestId !== null && (
        <p className="figure mt-1 text-[0.75rem] text-ink-faint">Reference {state.requestId}</p>
      )}
    </div>
  );
}

/**
 * A short passage that states a rule of the product rather than a fact about the data.
 *
 * Used for the audit notices — "opening an image is recorded" — which have to be near the control they
 * describe and must not look like an error.
 */
export function Note({
  tone = 'plain',
  children,
}: {
  tone?: 'plain' | 'lens' | 'flag';
  children: React.ReactNode;
}): React.ReactElement {
  const border = tone === 'lens' ? 'border-lens' : tone === 'flag' ? 'border-flag' : 'border-rule-strong';
  const background = tone === 'flag' ? 'bg-flag-soft' : 'bg-slip';
  return (
    <p className={`border-l-2 ${border} ${background} px-3 py-2 text-[0.875rem] leading-snug text-ink-soft`}>
      {children}
    </p>
  );
}
