/**
 * Tests for the Server Actions' failure handling and form reading.
 *
 * Two things here are worth more than the rest. `isFrameworkSignal` decides whether a redirect
 * happens at all — get it wrong and an expired session renders "something went wrong" forever
 * instead of sending somebody to the login page. And `toActionError` decides whether a validation
 * message lands beside the input that caused it or nowhere at all.
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import { attempt, integer, isFrameworkSignal, optionalText, text, toActionError } from '@/lib/action-support';

/** An `ApiError` as the client constructs one from a response body. */
function apiError(
  status: number,
  code: string,
  message: string,
  details?: { field?: string; message: string }[],
  requestId = 'req-1',
): ApiError {
  // `details` is spread rather than assigned: with `exactOptionalPropertyTypes`, an optional property
  // set explicitly to `undefined` is a different type from an absent one — and an absent `details` is
  // what a non-validation error actually looks like on the wire.
  return new ApiError(status, {
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  });
}

/** What Next throws for `redirect()` / `notFound()`. */
function frameworkSignal(digest: string): Error & { digest: string } {
  return Object.assign(new Error(digest), { digest });
}

describe('isFrameworkSignal', () => {
  it('recognises a redirect and a not-found', () => {
    expect(isFrameworkSignal(frameworkSignal('NEXT_REDIRECT;replace;/login;307;'))).toBe(true);
    expect(isFrameworkSignal(frameworkSignal('NEXT_NOT_FOUND'))).toBe(true);
  });

  it('does not mistake an ordinary failure for control flow', () => {
    // A false positive here is worse than a false negative: the error would be rethrown out of the
    // action, reach the error boundary, and destroy the form the person was filling in.
    expect(isFrameworkSignal(new Error('network unreachable'))).toBe(false);
    expect(isFrameworkSignal(apiError(422, 'VALIDATION_FAILED', 'bad'))).toBe(false);
    expect(isFrameworkSignal('a string')).toBe(false);
    expect(isFrameworkSignal(null)).toBe(false);
    expect(isFrameworkSignal(undefined)).toBe(false);
    expect(isFrameworkSignal({})).toBe(false);
    expect(isFrameworkSignal({ digest: 12345 })).toBe(false);
    expect(isFrameworkSignal({ digest: 'SOMETHING_ELSE' })).toBe(false);
    // A near-miss: right prefix, wrong signal. NEXT_NOT_FOUND is matched exactly, not by prefix.
    expect(isFrameworkSignal({ digest: 'NEXT_NOT_FOUND_SOMETHING' })).toBe(false);
  });

  it('matches a redirect by prefix, because the digest carries a payload', () => {
    // The redirect digest is `NEXT_REDIRECT;<kind>;<url>;<status>;`. Matching it exactly would work
    // for one Next version and then quietly stop.
    expect(isFrameworkSignal({ digest: 'NEXT_REDIRECT' })).toBe(true);
    expect(isFrameworkSignal({ digest: 'NEXT_REDIRECT;push;/mfa-required;303;' })).toBe(true);
  });
});

describe('toActionError', () => {
  it('puts a validation message on the field that caused it', () => {
    // The whole reason `details` is carried through: the dashboard does not re-implement the API's
    // validation rules, it renders the server's answer beside the right input.
    const error = apiError(422, 'VALIDATION_FAILED', 'The configuration was rejected.', [
      { field: 'screenshot_interval_seconds', message: 'Must be at least 60.' },
      { field: 'work_days', message: 'Select at least one day.' },
    ]);

    expect(toActionError(error, 'fallback')).toEqual({
      status: 'error',
      message: 'The configuration was rejected.',
      fields: {
        screenshot_interval_seconds: 'Must be at least 60.',
        work_days: 'Select at least one day.',
      },
      requestId: 'req-1',
    });
  });

  it('keeps a detail that names no field out of the field map', () => {
    // A whole-request complaint has no input to sit beside. Left in the map under `undefined` it
    // would render against nothing, or against whichever field the form looked up first.
    const error = apiError(422, 'VALIDATION_FAILED', 'Rejected.', [
      { message: 'The range is too long.' },
      { field: 'to', message: 'Must be after from.' },
    ]);
    expect(toActionError(error, 'fallback').fields).toEqual({ to: 'Must be after from.' });
  });

  it('carries the request id through, and drops the "unknown" placeholder', () => {
    // The id is the one thing support can act on. But rendering "Reference: unknown" beside an error
    // is worse than rendering nothing — it invites somebody to quote it.
    expect(toActionError(apiError(500, 'INTERNAL', 'Failed.', undefined, 'req-abc'), 'f').requestId).toBe('req-abc');
    expect(toActionError(apiError(500, 'INTERNAL', 'Failed.', undefined, 'unknown'), 'f').requestId).toBeNull();
  });

  it('passes an API message through rather than replacing it', () => {
    // The API's messages are written for a person to read. Substituting a generic sentence here
    // would discard the only accurate description of what went wrong.
    const error = apiError(409, 'CONFLICT', 'That employee already has an active device.');
    expect(toActionError(error, 'Something went wrong.').message).toBe(
      'That employee already has an active device.',
    );
  });

  it('uses an ordinary Error’s message, and the fallback for anything else', () => {
    expect(toActionError(new Error('fetch failed'), 'fallback')).toEqual({
      status: 'error',
      message: 'fetch failed',
      fields: {},
      requestId: null,
    });

    // A thrown non-Error should not happen, which is exactly why the fallback must not be "undefined".
    for (const thrown of ['a string', null, undefined, 42, { message: 'not an Error' }]) {
      const result = toActionError(thrown, 'The change was not saved.');
      expect(result.message, `for ${JSON.stringify(thrown)}`).toBe('The change was not saved.');
      expect(result.fields).toEqual({});
    }
  });

  it('always returns a fields object, so a form can index it without a guard', () => {
    // `fields` is non-optional in `ActionError` for this reason. An undefined here would be a crash
    // in every form that reads `state.fields[name]`.
    for (const thrown of [new Error('x'), apiError(500, 'INTERNAL', 'y'), 'z']) {
      expect(toActionError(thrown, 'f').fields).toEqual({});
    }
  });
});

describe('attempt', () => {
  it('wraps a success', async () => {
    await expect(attempt('fallback', () => Promise.resolve({ id: 'p-1' }))).resolves.toEqual({
      status: 'ok',
      value: { id: 'p-1' },
    });
  });

  it('returns a failure instead of throwing it', async () => {
    // The point of the whole module: a thrown error in an action reaches the error boundary and takes
    // the page down, losing whatever was typed. This returns, so the message appears beside the form.
    const result = await attempt('fallback', () =>
      Promise.reject(apiError(422, 'VALIDATION_FAILED', 'Rejected.', [{ field: 'name', message: 'Required.' }])),
    );
    expect(result).toEqual({
      status: 'error',
      message: 'Rejected.',
      fields: { name: 'Required.' },
      requestId: 'req-1',
    });
  });

  it('rethrows a redirect so the redirect actually happens', async () => {
    // The one thing that must keep propagating. Swallowed, an expired session becomes a permanently
    // failing page rather than a trip to the login screen.
    const signal = frameworkSignal('NEXT_REDIRECT;replace;/login;307;');
    await expect(attempt('fallback', () => Promise.reject(signal))).rejects.toBe(signal);

    const notFound = frameworkSignal('NEXT_NOT_FOUND');
    await expect(attempt('fallback', () => Promise.reject(notFound))).rejects.toBe(notFound);
  });

  it('catches a synchronous throw from the body, not just a rejection', async () => {
    // `run()` is called inside the try, so a body that throws before returning a promise is caught
    // too. Worth pinning: moving the call outside the try would compile and pass every other test.
    const result = await attempt('fallback', () => {
      throw new Error('thrown, not rejected');
    });
    expect(result).toMatchObject({ status: 'error', message: 'thrown, not rejected' });
  });
});

describe('text, optionalText and integer', () => {
  function form(entries: Record<string, string | File>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.append(key, value);
    return data;
  }

  it('trims, and treats an absent field as empty', () => {
    const data = form({ name: '  Night shift  ', blank: '   ' });
    expect(text(data, 'name')).toBe('Night shift');
    expect(text(data, 'blank')).toBe('');
    expect(text(data, 'missing')).toBe('');
  });

  it('does not let a File stringify into a text field', () => {
    // `FormData.get` returns `File | string | null`. A File coerced to a string becomes
    // "[object File]" and would be sent to the API as though somebody had typed it.
    const data = form({ name: new File(['bytes'], 'upload.png', { type: 'image/png' }) });
    expect(text(data, 'name')).toBe('');
    expect(optionalText(data, 'name')).toBeNull();
  });

  it('distinguishes blank from unset', () => {
    // `optionalText` returning null is what lets a PATCH clear a field rather than set it to "".
    const data = form({ blank: '   ', filled: 'x' });
    expect(optionalText(data, 'blank')).toBeNull();
    expect(optionalText(data, 'missing')).toBeNull();
    expect(optionalText(data, 'filled')).toBe('x');
  });

  it('parses an integer and falls back rather than sending NaN', () => {
    const data = form({ n: '30', padded: ' 45 ', trailing: '30.', junk: 'abc', blank: '', neg: '-5' });
    expect(integer(data, 'n', 7)).toBe(30);
    expect(integer(data, 'padded', 7)).toBe(45);
    expect(integer(data, 'trailing', 7)).toBe(30);
    expect(integer(data, 'neg', 7)).toBe(-5);

    // The fallback cases. `NaN` reaching the API serialises to `null` in JSON, which is a different
    // request from the one the person submitted.
    expect(integer(data, 'junk', 7)).toBe(7);
    expect(integer(data, 'blank', 7)).toBe(7);
    expect(integer(data, 'missing', 7)).toBe(7);
  });

  it('takes the leading integer of a pasted value', () => {
    // `<input type="number">` can submit "30 seconds" from a paste. Taking the 30 is friendlier than
    // silently substituting the default, which would look like the form ignored the entry.
    const data = form({ n: '30 seconds', hex: '0x10', exp: '1e3' });
    expect(integer(data, 'n', 7)).toBe(30);
    expect(integer(data, 'hex', 7)).toBe(0);
    expect(integer(data, 'exp', 7)).toBe(1);
  });
});
