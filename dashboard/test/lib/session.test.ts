/**
 * Tests for session decoding.
 *
 * # What is being asserted, and what deliberately is not
 *
 * `getSession` reads an ID token that this process does not verify. That is by design — API Gateway's
 * Cognito authorizer verifies the signature on every request and
 * `backend/src/middleware/cognitoAuth.ts` makes the authorisation decision. So these tests do not
 * assert that a tampered token is rejected, because it is not: a forged cookie can change what the
 * navigation *offers*, and cannot change what the API *returns*.
 *
 * What they do assert is that the decoding is strict about the things it is responsible for. Every
 * one of these paths ends at the login page, and the failure mode of getting one wrong is a session
 * that half-works: a dashboard that renders and then 401s on every panel, which reads as a broken
 * product rather than as an expired login.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The cookie jar the mocked `next/headers` serves. Reassigned per test. */
let jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: (): Promise<{ get: (name: string) => { value: string } | undefined }> =>
    Promise.resolve({
      get: (name: string) => {
        const value = jar.get(name);
        return value === undefined ? undefined : { value };
      },
    }),
}));

const { COOKIE, getAccessToken, getSession, isAdmin, needsMfaEnrolment } = await import('@/lib/session');

/** A JWT with the given payload. The signature is a placeholder: nothing here verifies it. */
function token(payload: Record<string, unknown>): string {
  const b64 = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.not-a-real-signature`;
}

const NOW = new Date('2026-08-20T12:00:00Z');
const EXPIRES = Math.floor(NOW.getTime() / 1000) + 3600;

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exp: EXPIRES,
    'wl:org': 'org-1',
    'wl:user': 'user-1',
    'wl:role': 'manager',
    'wl:employee': 'emp-1',
    'wl:mfa': 'on',
    'wl:tz': 'Asia/Kolkata',
    email: 'manager@example.com',
    ...overrides,
  };
}

beforeEach(() => {
  jar = new Map();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getSession', () => {
  it('reads the claims the pre-token trigger put in the token', async () => {
    jar.set(COOKIE.idToken, token(claims()));

    await expect(getSession()).resolves.toEqual({
      orgId: 'org-1',
      userId: 'user-1',
      role: 'manager',
      employeeId: 'emp-1',
      mfa: true,
      timezone: 'Asia/Kolkata',
      email: 'manager@example.com',
      expiresAt: EXPIRES,
    });
  });

  it('returns null when there is no cookie', async () => {
    await expect(getSession()).resolves.toBeNull();

    jar.set(COOKIE.idToken, '');
    await expect(getSession()).resolves.toBeNull();
  });

  it('returns null for a malformed token instead of throwing', async () => {
    // Each of these is a shape a truncated or corrupted cookie takes. A throw here would surface as
    // a 500 on the layout, i.e. every page at once, rather than as a redirect to login.
    for (const value of [
      'not-a-jwt',
      'only.two',
      'a.b.c.d',
      `${Buffer.from('{}').toString('base64url')}.@@not-base64@@.sig`,
      `x.${Buffer.from('not json').toString('base64url')}.sig`,
      `x.${Buffer.from('"a string, not an object"').toString('base64url')}.sig`,
      `x.${Buffer.from('null').toString('base64url')}.sig`,
      `x.${Buffer.from('[1,2,3]').toString('base64url')}.sig`,
      '..',
    ]) {
      jar.set(COOKIE.idToken, value);
      await expect(getSession(), `for ${JSON.stringify(value)}`).resolves.toBeNull();
    }
  });

  it('decodes a payload whose base64url length needs padding', async () => {
    // base64url omits `=` padding, and a payload can land on any of the three remainders. Getting the
    // padding wrong fails for some tokens and not others — an intermittent logout that would be
    // miserable to diagnose in production.
    for (const padding of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      jar.set(COOKIE.idToken, token(claims({ 'wl:org': `org-${padding}` })));
      const session = await getSession();
      expect(session?.orgId).toBe(`org-${padding}`);
    }
  });

  it('treats a token inside its last minute as already gone', async () => {
    // The 60-second slack. Without it a token with 3 seconds left passes the check, the layout
    // renders, and every panel underneath it 401s — a page that looks broken rather than expired.
    const nowSeconds = Math.floor(NOW.getTime() / 1000);

    jar.set(COOKIE.idToken, token(claims({ exp: nowSeconds + 30 })));
    await expect(getSession()).resolves.toBeNull();

    jar.set(COOKIE.idToken, token(claims({ exp: nowSeconds + 60 })));
    await expect(getSession()).resolves.toBeNull();

    jar.set(COOKIE.idToken, token(claims({ exp: nowSeconds + 61 })));
    await expect(getSession()).resolves.not.toBeNull();
  });

  it('rejects an expired or unexpiring token', async () => {
    const nowSeconds = Math.floor(NOW.getTime() / 1000);

    jar.set(COOKIE.idToken, token(claims({ exp: nowSeconds - 1 })));
    await expect(getSession()).resolves.toBeNull();

    // A missing or non-numeric `exp` is treated as 0, i.e. expired. Defaulting the other way would
    // make a token with no expiry immortal.
    for (const exp of [undefined, 'soon', null, {}]) {
      jar.set(COOKIE.idToken, token(claims({ exp })));
      await expect(getSession(), `for exp=${JSON.stringify(exp)}`).resolves.toBeNull();
    }
  });

  it('refuses a token with no WorkLens claims', async () => {
    // This is what an invited-but-unprovisioned account looks like: Cognito authenticated them, the
    // pre-token trigger found no `users` row, and the API will refuse every request. Treated as no
    // session so they land on login with a message, not on a dashboard where everything fails.
    jar.set(COOKIE.idToken, token({ exp: EXPIRES, email: 'nobody@example.com' }));
    await expect(getSession()).resolves.toBeNull();

    for (const missing of ['wl:org', 'wl:user', 'wl:role']) {
      jar.set(COOKIE.idToken, token(claims({ [missing]: undefined })));
      await expect(getSession(), `without ${missing}`).resolves.toBeNull();

      // An empty string is not a usable identifier either, and is what an unset claim can arrive as.
      jar.set(COOKIE.idToken, token(claims({ [missing]: '' })));
      await expect(getSession(), `with empty ${missing}`).resolves.toBeNull();
    }
  });

  it('refuses a role it does not recognise', async () => {
    // The allowlist matters: an unrecognised role that fell through would be rendered by whatever
    // branch happened to be last, and "admin" is exactly the string an attacker would try.
    for (const role of ['admin', 'owner ', 'Owner', 'superuser', '', 'employee,owner']) {
      jar.set(COOKIE.idToken, token(claims({ 'wl:role': role })));
      await expect(getSession(), `for role ${JSON.stringify(role)}`).resolves.toBeNull();
    }

    for (const role of ['owner', 'manager', 'employee']) {
      jar.set(COOKIE.idToken, token(claims({ 'wl:role': role })));
      const session = await getSession();
      expect(session?.role).toBe(role);
    }
  });

  it('normalises an absent employee to null rather than an empty string', async () => {
    // An admin-only account — a bookkeeper with no monitored machine. The trigger emits an empty
    // string rather than omitting the claim, and `/me` has to be able to say "you have no record"
    // rather than requesting timesheets for employee "".
    jar.set(COOKIE.idToken, token(claims({ 'wl:employee': '' })));
    await expect(getSession()).resolves.toMatchObject({ employeeId: null });

    jar.set(COOKIE.idToken, token(claims({ 'wl:employee': undefined })));
    await expect(getSession()).resolves.toMatchObject({ employeeId: null });
  });

  it('treats any mfa value other than "on" as not enrolled', async () => {
    // Fails closed. The gate is enforced server-side regardless, so the only thing at stake here is
    // whether the notice is shown — but showing "you have MFA" to somebody who does not is a lie the
    // product should not tell.
    for (const value of ['on']) {
      jar.set(COOKIE.idToken, token(claims({ 'wl:mfa': value })));
      await expect(getSession()).resolves.toMatchObject({ mfa: true });
    }
    for (const value of ['off', 'ON', 'true', '1', 'yes', '', undefined]) {
      jar.set(COOKIE.idToken, token(claims({ 'wl:mfa': value })));
      await expect(getSession(), `for ${JSON.stringify(value)}`).resolves.toMatchObject({ mfa: false });
    }
  });

  it('falls back to UTC and a derived label rather than failing on a thin token', async () => {
    // Neither the timezone nor the email is load-bearing: one affects how a date is rendered and the
    // other is a display name. Refusing the session over either would lock somebody out of a
    // dashboard they are entitled to see.
    jar.set(COOKIE.idToken, token(claims({ 'wl:tz': undefined, email: undefined })));
    await expect(getSession()).resolves.toMatchObject({ timezone: 'UTC', email: 'user:user-1' });
  });
});

describe('getAccessToken', () => {
  it('returns the access token, and null when there is none', async () => {
    await expect(getAccessToken()).resolves.toBeNull();

    jar.set(COOKIE.accessToken, 'at-value');
    await expect(getAccessToken()).resolves.toBe('at-value');
  });

  it('reads a different cookie from the one getSession reads', async () => {
    // The ID token carries the claims; the access token is what the API accepts. Attaching the wrong
    // one produces a 401 from API Gateway with nothing in the dashboard's own logs to explain it.
    expect(COOKIE.accessToken).not.toBe(COOKIE.idToken);

    jar.set(COOKIE.idToken, token(claims()));
    await expect(getAccessToken()).resolves.toBeNull();
  });
});

describe('needsMfaEnrolment', () => {
  const base = {
    orgId: 'org-1',
    userId: 'user-1',
    employeeId: 'emp-1',
    timezone: 'UTC',
    email: 'a@example.com',
    expiresAt: EXPIRES,
  } as const;

  it('gates owners and managers without a second factor', () => {
    expect(needsMfaEnrolment({ ...base, role: 'owner', mfa: false })).toBe(true);
    expect(needsMfaEnrolment({ ...base, role: 'manager', mfa: false })).toBe(true);
  });

  it('does not gate them once enrolled', () => {
    expect(needsMfaEnrolment({ ...base, role: 'owner', mfa: true })).toBe(false);
    expect(needsMfaEnrolment({ ...base, role: 'manager', mfa: true })).toBe(false);
  });

  it('never gates an employee', () => {
    // An employee sees only their own record. Requiring a second factor to read your own timesheet
    // would be a barrier between a person and their own data, which is the opposite of the point.
    expect(needsMfaEnrolment({ ...base, role: 'employee', mfa: false })).toBe(false);
    expect(needsMfaEnrolment({ ...base, role: 'employee', mfa: true })).toBe(false);
  });

  it('mirrors POLICY.adminScoped on the server', () => {
    // Stated as a test because the two must not drift: if the server ever starts gating employees, or
    // stops gating managers, the navigation would offer links every click of which is refused.
    const gated = (['owner', 'manager', 'employee'] as const).filter((role) =>
      needsMfaEnrolment({ ...base, role, mfa: false }),
    );
    expect(gated).toEqual(['owner', 'manager']);
  });
});

describe('isAdmin', () => {
  const base = {
    orgId: 'org-1',
    userId: 'user-1',
    employeeId: 'emp-1',
    timezone: 'UTC',
    email: 'a@example.com',
    expiresAt: EXPIRES,
    mfa: true,
  } as const;

  it('is true for owner and manager, false for employee', () => {
    expect(isAdmin({ ...base, role: 'owner' })).toBe(true);
    expect(isAdmin({ ...base, role: 'manager' })).toBe(true);
    expect(isAdmin({ ...base, role: 'employee' })).toBe(false);
  });

  it('does not depend on mfa, which is a separate question', () => {
    // An unenrolled manager is still an admin; they are an admin who cannot use admin routes yet.
    // Conflating the two would send them to the employee view instead of to the enrolment page.
    expect(isAdmin({ ...base, role: 'manager', mfa: false })).toBe(true);
  });
});
