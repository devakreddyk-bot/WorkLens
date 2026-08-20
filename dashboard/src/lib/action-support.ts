/**
 * The failure handling and form reading behind the Server Actions.
 *
 * # Why this is not in `actions.ts`
 *
 * A `'use server'` module may only export async functions. These are neither async nor, in one case,
 * a function — so they cannot be exported from there, which meant they could not be tested. The
 * alternative was to test them through an action, which requires mocking the whole API client to
 * assert on a two-line mapping.
 *
 * `band.ts` exists for the same reason and the rule is the same one: a pure function should not be
 * trapped behind a framework boundary that exists for something else.
 *
 * # What the failure handling is for
 *
 * A thrown error in a Server Action reaches the error boundary and takes the page with it, losing
 * whatever the person had typed into the form. Every action therefore returns rather than throws —
 * with one exception, which is the reason `isFrameworkSignal` exists.
 */

import { ApiError } from './api';
import type { ActionError, ActionResult } from './action-result';

/**
 * Whether an error is Next's control flow rather than a failure.
 *
 * `redirect()` and `notFound()` work by throwing an object carrying a `digest` the framework
 * recognises. Swallowing one turns "your session expired, sign in again" into "something went wrong"
 * and leaves the person on a page that will keep failing.
 *
 * Matched on the string rather than by importing Next's own predicate, because that helper lives in
 * internals which have moved between versions — a broken import here would be a build error, but a
 * *renamed* one would silently start returning false and swallow every redirect.
 */
export function isFrameworkSignal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return false;
  const digest: unknown = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND');
}

/**
 * Turns a failure into something worth reading.
 *
 * An `ApiError` already carries a message written for a person and, for a validation failure, the
 * field that caused it, so it is passed through rather than replaced. The request id comes with it:
 * it is the same id in the deployment's logs, which is the one thing support actually needs.
 *
 * The `fallback` is only reached by a thrown non-`Error` — which should not happen, and is exactly
 * why it must not render as "undefined".
 */
export function toActionError(error: unknown, fallback: string): ActionError {
  if (error instanceof ApiError) {
    return {
      status: 'error',
      message: error.message,
      fields: error.fieldErrors(),
      requestId: error.requestId === 'unknown' ? null : error.requestId,
    };
  }
  if (error instanceof Error) {
    return { status: 'error', message: error.message, fields: {}, requestId: null };
  }
  return { status: 'error', message: fallback, fields: {}, requestId: null };
}

/** Runs an action body, returning its failure instead of throwing it. */
export async function attempt<T>(fallback: string, run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { status: 'ok', value: await run() };
  } catch (error) {
    if (isFrameworkSignal(error)) throw error;
    return toActionError(error, fallback);
  }
}

// ---------------------------------------------------------------------------
// Reading a form
// ---------------------------------------------------------------------------

/**
 * A trimmed string field, or `''`.
 *
 * `FormData.get` returns `File | string | null`, and a `File` reaching a text field would stringify
 * to "[object File]" and be sent to the API as if somebody had typed it.
 */
export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A field the caller may leave blank, where blank means "not set" rather than "empty string". */
export function optionalText(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === '' ? null : value;
}

/**
 * An integer field, or the fallback.
 *
 * `Number.parseInt` is deliberate: an `<input type="number">` can submit "30." or "30abc" from a
 * paste, and taking the leading integer is friendlier than rejecting the form. `Number.isFinite`
 * rejects the `NaN` from a blank or non-numeric field — `Number.isInteger` would too, but this also
 * excludes the infinities.
 */
export function integer(form: FormData, name: string, fallback: number): number {
  const parsed = Number.parseInt(text(form, name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
