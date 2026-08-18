/**
 * Turning a Zod failure into the API's error envelope.
 *
 * Every device route validates through here, so a malformed payload always comes back the
 * same shape: `VALIDATION_FAILED` with one `{ field, message }` per problem. That matters
 * more than it looks — the caller is an agent running unattended on someone's laptop, and the
 * only way its author can debug a rejected batch is from the response body. "The request
 * body failed validation" with no field is a support ticket; `events.3.window_title` with a
 * sentence explaining the idle rule is a fix.
 *
 * Nothing from the *value* is echoed back, only the path and the rule. A validation error
 * that quoted the offending value would put window titles into log-adjacent places and into
 * whatever the agent decides to do with an error message.
 */

import type { z } from 'zod';

import type { ErrorDetail } from '../shared/errors.js';
import { errors } from '../shared/errors.js';

/** Zod's path segments are strings or numbers; joined with dots, array indices included. */
function fieldPath(path: readonly (string | number)[]): string | undefined {
  if (path.length === 0) return undefined;
  return path.join('.');
}

export function issuesToDetails(issues: readonly z.ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => {
    const field = fieldPath(issue.path);
    // `exactOptionalPropertyTypes` is on, so an absent field must be absent rather than
    // present-and-undefined.
    return field === undefined ? { message: issue.message } : { field, message: issue.message };
  });
}

/**
 * Validates `input` against `schema`, throwing the API's 400 on failure.
 *
 * Returns the schema's *output* type, so transforms (an ISO string becoming a `Date`, an
 * absent `duration_seconds` becoming `0`) have already been applied by the time a handler
 * sees the value. A handler never re-parses anything.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data as z.output<S>;
  throw errors.validation(issuesToDetails(result.error.issues));
}
