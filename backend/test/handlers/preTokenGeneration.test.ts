/**
 * Tests for the Cognito pre-token-generation trigger.
 *
 * This function sits on the critical path of every login and decides what the API is allowed
 * to believe about the caller. The cases that matter are the ones where a mistake is
 * invisible: a token issued without `wl:mfa` for an admin, or claims written into the wrong
 * half of a response shape so they silently never reach the token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const send = vi.fn();

vi.mock('../../src/shared/db.js', () => ({
  queryOne: (...args: unknown[]): unknown => queryOne(...args) as unknown,
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    send = send;
  },
  AdminGetUserCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { handler } = await import('../../src/handlers/auth/preTokenGeneration.js');

const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  org_id: '22222222-2222-4222-8222-222222222222',
  role: 'owner' as const,
  employee_id: null,
  status: 'active' as const,
  org_timezone: 'Asia/Kolkata',
};

const EMPLOYEE = {
  ...OWNER,
  id: '33333333-3333-4333-8333-333333333333',
  role: 'employee' as const,
  employee_id: '44444444-4444-4444-8444-444444444444',
};

/** V2_0 trigger shape: the response has claimsAndScopeOverrideDetails. */
function v2Event(sub = 'cognito-sub-1') {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_TESTPOOL',
    userName: 'asha@example.com',
    callerContext: { awsSdkVersion: '3', clientId: 'client' },
    request: { userAttributes: { sub }, groupConfiguration: {} },
    response: { claimsAndScopeOverrideDetails: null },
  } as never;
}

/** V1 trigger shape: the response has claimsOverrideDetails. */
function v1Event(sub = 'cognito-sub-1') {
  return {
    version: '1',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_TESTPOOL',
    userName: 'asha@example.com',
    callerContext: { awsSdkVersion: '3', clientId: 'client' },
    request: { userAttributes: { sub }, groupConfiguration: {} },
    response: { claimsOverrideDetails: null },
  } as never;
}

function claimsOf(result: unknown): Record<string, string> {
  const response = (result as { response: Record<string, unknown> }).response;

  const v2 = response.claimsAndScopeOverrideDetails as
    | { idTokenGeneration?: { claimsToAddOrOverride?: Record<string, string> } }
    | null
    | undefined;
  if (v2?.idTokenGeneration?.claimsToAddOrOverride !== undefined) {
    return v2.idTokenGeneration.claimsToAddOrOverride;
  }

  const v1 = response.claimsOverrideDetails as
    | { claimsToAddOrOverride?: Record<string, string> }
    | null
    | undefined;
  return v1?.claimsToAddOrOverride ?? {};
}

beforeEach(() => {
  queryOne.mockReset();
  send.mockReset();
});

describe('claim injection', () => {
  it('injects org, user, role, employee, timezone and mfa for an employee', async () => {
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });

    const claims = claimsOf(await handler(v2Event()));

    expect(claims).toEqual({
      'wl:org': EMPLOYEE.org_id,
      'wl:user': EMPLOYEE.id,
      'wl:role': 'employee',
      'wl:employee': EMPLOYEE.employee_id,
      'wl:tz': 'Asia/Kolkata',
      'wl:mfa': 'off',
    });
  });

  it('namespaces every claim, so none can collide with a reserved Cognito claim', async () => {
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });
    const claims = claimsOf(await handler(v2Event()));
    expect(Object.keys(claims).every((k) => k.startsWith('wl:'))).toBe(true);
  });

  it('emits an empty string rather than omitting employee for an admin with no employee row', async () => {
    // An absent key is indistinguishable from a key the trigger failed to set.
    queryOne.mockResolvedValueOnce(OWNER).mockResolvedValue({ id: OWNER.id });
    send.mockResolvedValue({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] });

    expect(claimsOf(await handler(v2Event()))['wl:employee']).toBe('');
  });

  it('looks the user up by cognito sub, not by username', async () => {
    // sub is immutable; an email address is not. Matching on email would detach a user from
    // their row the moment their address changed.
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });
    await handler(v2Event('the-immutable-sub'));

    const [spec] = queryOne.mock.calls[0] as [{ text: string; values: unknown[] }];
    expect(spec.text).toContain('cognito_sub = $1');
    expect(spec.values).toEqual(['the-immutable-sub']);
  });
});

describe('admin MFA enforcement (D7)', () => {
  it('sets wl:mfa on when an owner has a factor configured', async () => {
    queryOne.mockResolvedValueOnce(OWNER).mockResolvedValue({ id: OWNER.id });
    send.mockResolvedValue({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] });

    expect(claimsOf(await handler(v2Event()))['wl:mfa']).toBe('on');
  });

  it('sets wl:mfa off — and still issues a token — when an admin has no factor', async () => {
    // The token is needed to reach the enrolment screen. `off` is what stops it opening
    // admin data in the meantime.
    queryOne.mockResolvedValueOnce(OWNER).mockResolvedValue({ id: OWNER.id });
    send.mockResolvedValue({ UserMFASettingList: [] });

    const claims = claimsOf(await handler(v2Event()));
    expect(claims['wl:mfa']).toBe('off');
    expect(claims['wl:role']).toBe('owner');
  });

  it('treats a missing UserMFASettingList as no factor', async () => {
    queryOne.mockResolvedValueOnce(OWNER).mockResolvedValue({ id: OWNER.id });
    send.mockResolvedValue({});

    expect(claimsOf(await handler(v2Event()))['wl:mfa']).toBe('off');
  });

  it('does not call Cognito for an employee', async () => {
    // The answer changes nothing for a non-admin, and this is the login hot path.
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });
    await handler(v2Event());
    expect(send).not.toHaveBeenCalled();
  });

  it('checks MFA for a manager as well as an owner', async () => {
    queryOne
      .mockResolvedValueOnce({ ...OWNER, role: 'manager' })
      .mockResolvedValue({ id: OWNER.id });
    send.mockResolvedValue({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] });

    expect(claimsOf(await handler(v2Event()))['wl:mfa']).toBe('on');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails the login when the MFA check itself fails', async () => {
    // Failing closed. Issuing a token whose wl:mfa could not be established would let an
    // admin past the gate on an unverifiable claim.
    queryOne.mockResolvedValueOnce(OWNER).mockResolvedValue({ id: OWNER.id });
    send.mockRejectedValue(new Error('cognito-idp unreachable'));

    await expect(handler(v2Event())).rejects.toThrow('cognito-idp unreachable');
  });
});

describe('accounts that must not get claims', () => {
  it('refuses a disabled user', async () => {
    // Cognito may still hold a valid password; the users table is the authority on whether
    // the account may be used.
    queryOne.mockResolvedValueOnce({ ...OWNER, status: 'disabled' });
    await expect(handler(v2Event())).rejects.toThrow(/disabled/i);
  });

  it('issues a token with no claims when there is no users row', async () => {
    // The deliberate exception to failing closed: this is what an invited-but-unprovisioned
    // account looks like, and the API rejects every request made with such a token anyway.
    queryOne.mockResolvedValueOnce(undefined);

    const result = await handler(v2Event());
    expect(claimsOf(result)).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it('fails the login when the user lookup itself fails', async () => {
    queryOne.mockRejectedValueOnce(new Error('connection refused'));
    await expect(handler(v2Event())).rejects.toThrow('connection refused');
  });
});

describe('trigger response shapes', () => {
  it('writes into both token sections for a V2_0 trigger', async () => {
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });

    const result = (await handler(v2Event())) as unknown as {
      response: {
        claimsAndScopeOverrideDetails: {
          idTokenGeneration: { claimsToAddOrOverride: Record<string, string> };
          accessTokenGeneration: { claimsToAddOrOverride: Record<string, string> };
        };
      };
    };

    // The API reads the access token, the dashboard reads the ID token. Populating only one
    // produces a mysterious 403 on every request.
    const details = result.response.claimsAndScopeOverrideDetails;
    expect(details.idTokenGeneration.claimsToAddOrOverride['wl:org']).toBe(EMPLOYEE.org_id);
    expect(details.accessTokenGeneration.claimsToAddOrOverride['wl:org']).toBe(EMPLOYEE.org_id);
  });

  it('writes claimsOverrideDetails for a V1 trigger', async () => {
    // The pool's trigger version is Terraform configuration; a handler that silently no-ops
    // when it changes would issue claimless tokens.
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });

    const result = (await handler(v1Event())) as unknown as {
      response: { claimsOverrideDetails: { claimsToAddOrOverride: Record<string, string> } };
    };
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride['wl:role']).toBe('employee');
  });
});

describe('last_login_at bookkeeping', () => {
  it('records the login', async () => {
    queryOne.mockResolvedValueOnce(EMPLOYEE).mockResolvedValue({ id: EMPLOYEE.id });
    await handler(v2Event());

    const texts = queryOne.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('last_login_at'))).toBe(true);
  });

  it('still signs the user in when that write fails', async () => {
    // Bookkeeping must not be able to lock anyone out.
    queryOne
      .mockResolvedValueOnce(EMPLOYEE)
      .mockRejectedValueOnce(new Error('audit table is read-only'));

    const claims = claimsOf(await handler(v2Event()));
    expect(claims['wl:org']).toBe(EMPLOYEE.org_id);
  });
});
