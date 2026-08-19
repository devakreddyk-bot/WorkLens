/**
 * The shape a Server Action hands back to a form.
 *
 * Its own module rather than living beside the actions, because a `'use server'` file may only export
 * async functions — a type export there is erased at build time but the constraint is checked before
 * that, and the failure is a confusing one.
 *
 * `fields` is always present, never optional, so a form can index it without a guard. Validation
 * errors come from the API's own `details` array, which names the field it rejected — the dashboard
 * does not re-implement the rules, it renders the server's answer beside the input that caused it.
 */

export interface ActionOk<T> {
  status: 'ok';
  value: T;
}

export interface ActionError {
  status: 'error';
  /** Written for the person reading it, not copied from an exception. */
  message: string;
  /** Field name to message, for rendering beside the input. Empty when the failure was not a field. */
  fields: Record<string, string>;
  /** The API's request id, when there is one. The same id is in the deployment's logs. */
  requestId: string | null;
}

export type ActionResult<T> = ActionOk<T> | ActionError;

/** The initial state for a form that has not been submitted. */
export interface ActionIdle {
  status: 'idle';
}

export type FormState<T> = ActionIdle | ActionResult<T>;

export const IDLE: ActionIdle = { status: 'idle' };
