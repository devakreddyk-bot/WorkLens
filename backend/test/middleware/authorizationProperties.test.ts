/**
 * Authorisation properties, asserted from the outside.
 *
 * Written deliberately without reference to cognitoAuth.test.ts, so it cannot inherit that suite's
 * assumptions about how the middleware is structured — it only states what must be true of it. Two
 * of the cases below (the subject-level MFA re-check, and refusing rather than narrowing a
 * cross-employee request) are the ones where a plausible implementation is silently wrong.
 */
import { describe, expect, it } from 'vitest';


import { ErrorCode, isAppError } from '../../src/shared/errors.js';
import {
  assertAdminMfaForSubject,
  authorizeRoute,
  POLICY,
  resolveEmployeeScope,
} from '../../src/middleware/cognitoAuth.js';


/**
 * Asserts a thrown AppError carries a specific code.
 *
 * Codes rather than message text, because the dashboard switches on the code to choose between the
 * forced-enrolment screen and a plain refusal — a reworded message must not change behaviour. (This
 * probe originally matched /mfa/i and missed "Multi-factor authentication" entirely, which is the
 * argument for not asserting on prose.)
 */
function expectRefusal(action: () => unknown, code: ErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (err) {
    thrown = err;
  }

  expect(isAppError(thrown), `expected an AppError, got ${String(thrown)}`).toBe(true);
  if (isAppError(thrown)) {
    expect(thrown.code).toBe(code);
  }
}

function principal(overrides: Record<string, unknown> = {}) {
  return {
    orgId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'employee' as const,
    employeeId: '33333333-3333-4333-8333-333333333333',
    email: 'user:22222222-2222-4222-8222-222222222222',
    mfa: false,
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
}

describe('an employee may not reach another employee', () => {
  it('refuses a different employee id outright rather than narrowing it to self', () => {
    const me = principal();
    const someoneElse = '99999999-9999-4999-8999-999999999999';

    // Silently rewriting this to the caller's own id would be worse than refusing: the request
    // would appear to succeed and return the wrong person's data shape.
    expectRefusal(() => resolveEmployeeScope(me, someoneElse), ErrorCode.FORBIDDEN);
  });

  it('allows an employee their own id', () => {
    const me = principal();
    expect(resolveEmployeeScope(me, me.employeeId)).toEqual({
      orgId: me.orgId,
      employeeId: me.employeeId,
    });
  });

  it('scopes an employee to self even when no id is supplied', () => {
    const me = principal();
    expect(resolveEmployeeScope(me, undefined).employeeId).toBe(me.employeeId);
  });

  it('lets an owner reach any employee in their own org', () => {
    const owner = principal({ role: 'owner', employeeId: null, mfa: true });
    const other = '99999999-9999-4999-8999-999999999999';
    expect(resolveEmployeeScope(owner, other)).toEqual({ orgId: owner.orgId, employeeId: other });
  });
});

describe('admin MFA is enforced server-side', () => {
  it('rejects an owner without a factor on an admin route', () => {
    const owner = principal({ role: 'owner', employeeId: null, mfa: false });
    expectRefusal(() => authorizeRoute(owner, POLICY.ownerWrite), ErrorCode.MFA_REQUIRED);
  });

  it('rejects a manager without a factor on an admin read', () => {
    const manager = principal({ role: 'manager', employeeId: null, mfa: false });
    expectRefusal(() => authorizeRoute(manager, POLICY.adminRead), ErrorCode.MFA_REQUIRED);
  });

  it('admits an owner with a factor', () => {
    const owner = principal({ role: 'owner', employeeId: null, mfa: true });
    expect(() => authorizeRoute(owner, POLICY.ownerWrite)).not.toThrow();
  });

  it('does not MFA-gate an employee viewing their own data', () => {
    // An employee has no admin capability to protect, and gating them would force TOTP on somebody
    // who only wants to see their own timesheet.
    const me = principal({ mfa: false });
    expect(() => authorizeRoute(me, POLICY.employeeRead)).not.toThrow();
  });

  it('refuses an employee on an owner-only route', () => {
    const me = principal();
    expectRefusal(() => authorizeRoute(me, POLICY.ownerWrite), ErrorCode.FORBIDDEN);
  });

  it('re-applies the gate when an admin without a factor targets someone else', () => {
    // The route-level gate cannot catch this: employeeRead is deliberately not adminScoped, so an
    // employee's self-view is never MFA-gated. Without the subject-level check an admin with no
    // factor could read the whole team through the per-employee routes.
    const owner = principal({ role: 'owner', employeeId: null, mfa: false });
    expectRefusal(() => assertAdminMfaForSubject(owner, '99999999-9999-4999-8999-999999999999'), ErrorCode.MFA_REQUIRED);
  });

  it('does not gate an admin reading their own data', () => {
    const owner = principal({ role: 'owner', employeeId: '44444444-4444-4444-8444-444444444444', mfa: false });
    expect(() => assertAdminMfaForSubject(owner, owner.employeeId)).not.toThrow();
  });

  it('refuses a manager on an owner-only route', () => {
    const manager = principal({ role: 'manager', employeeId: null, mfa: true });
    expectRefusal(() => authorizeRoute(manager, POLICY.ownerWrite), ErrorCode.FORBIDDEN);
  });
});

describe('the errors carry machine-readable codes, not just prose', () => {
  it('uses MFA_REQUIRED and FORBIDDEN rather than relying on the message text', () => {
    // Asserted because the dashboard switches on the code to decide between the forced-enrolment
    // screen and a plain "not allowed" — a reworded message must not change behaviour.
    const owner = principal({ role: 'owner', employeeId: null, mfa: false });
    try {
      authorizeRoute(owner, POLICY.ownerWrite);
      throw new Error('expected a throw');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe(ErrorCode.MFA_REQUIRED);
    }

    const employee = principal();
    try {
      authorizeRoute(employee, POLICY.ownerWrite);
      throw new Error('expected a throw');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe(ErrorCode.FORBIDDEN);
    }
  });
});
