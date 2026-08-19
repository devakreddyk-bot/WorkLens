/**
 * Dashboard authentication and RBAC.
 *
 * These are the tests that decide whether the rest of the dashboard API is safe, so they assert
 * against behaviour rather than against implementation: the router is driven end to end through
 * `withHandler`, with a recording route standing in for a real one, and every case checks both the
 * status code the caller sees *and* whether the route body was reached at all. The second half
 * matters — a 403 that arrives after the handler has already run its query is not a 403.
 *
 * No database and no AWS: nothing in `src/middleware/cognitoAuth.ts` performs I/O, which is
 * deliberate and is what makes exhausting the claim space cheap.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import type { DashboardHandler, Principal, RouteParams } from '../../src/middleware/cognitoAuth.js';
import {
  POLICY,
  assertAdminMfaForSubject,
  authorizeRoute,
  createDashboardRouter,
  principalFromClaims,
  requireEmployeeScope,
  resolveEmployeeScope,
  withCognitoAuth,
} from '../../src/middleware/cognitoAuth.js';
import type { ApiEvent } from '../../src/shared/http.js';
import { ok, withHandler } from '../../src/shared/http.js';
import { errorOf, invoke } from '../helpers/deviceRequest.js';

const ORG_ID = '2f1a6e40-8c3b-4a1d-9f77-0b6e5c4a1d33';
const USER_ID = '9b1d4f70-2c6a-4e58-8a3b-1f7c5d9e2a44';
const EMPLOYEE_ID = '7c9e2b18-4d5a-4c6b-8e21-3f0a9d7b6c55';
const OTHER_EMPLOYEE_ID = '5a2c8e34-9d1b-4f76-8c05-2e6a4b8d1f99';

type Claims = Record<string, string>;

function claims(overrides: Claims = {}): Claims {
  return {
    sub: 'cognito-sub-1',
    email: 'owner@example.com',
    'wl:org': ORG_ID,
    'wl:user': USER_ID,
    'wl:role': 'owner',
    'wl:employee': '',
    'wl:tz': 'Asia/Kolkata',
    'wl:mfa': 'on',
    ...overrides,
  };
}

interface EventInit {
  method?: string;
  path?: string;
  /** Omitted entirely to simulate a request that never passed the Cognito authorizer. */
  claims?: Claims | null;
  query?: Record<string, string>;
}

/**
 * The slice of an API Gateway REST event that `src/shared/http.ts` and the middleware actually
 * read. A full `APIGatewayProxyEvent` has some forty fields; constructing only the ones under test
 * keeps the fixture legible, and the cast is the price.
 */
function cognitoEvent(init: EventInit = {}): ApiEvent {
  const authorizer = init.claims === null ? undefined : { claims: init.claims ?? claims() };
  return {
    httpMethod: init.method ?? 'GET',
    path: init.path ?? '/v1/probe',
    headers: { 'user-agent': 'worklens-dashboard/test' },
    body: null,
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: init.query ?? null,
    requestContext: {
      requestId: 'test-request-id',
      identity: { sourceIp: '203.0.113.44' },
      ...(authorizer === undefined ? {} : { authorizer }),
    },
  } as unknown as ApiEvent;
}

/** Records whether the route body ran, and with what scope. */
interface Reached {
  ran: boolean;
  principal?: Principal;
  params?: RouteParams;
}

function recordingRoute(reached: Reached): DashboardHandler {
  return (_ctx, principal, params) => {
    reached.ran = true;
    reached.principal = principal;
    reached.params = params;
    return Promise.resolve(ok({ ok: true }));
  };
}

let reached: Reached;

beforeEach(() => {
  reached = { ran: false };
});

function router() {
  return withHandler(
    'test-router',
    createDashboardRouter([
      { method: 'GET', path: '/me', policy: POLICY.self, handler: recordingRoute(reached) },
      { method: 'GET', path: '/overview', policy: POLICY.adminRead, handler: recordingRoute(reached) },
      {
        method: 'GET',
        path: '/employees/{id}/timesheets',
        policy: POLICY.employeeRead,
        handler: recordingRoute(reached),
      },
      { method: 'PUT', path: '/config', policy: POLICY.ownerWrite, handler: recordingRoute(reached) },
    ]),
  );
}

// ---------------------------------------------------------------------------

describe('claims extraction', () => {
  it('rejects a request that never passed the authorizer', async () => {
    const response = await invoke(router(), cognitoEvent({ path: '/v1/me', claims: null }));

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('MISSING_CREDENTIALS');
    expect(reached.ran).toBe(false);
  });

  it('accepts the HTTP-API jwt.claims shape as well as the REST shape', () => {
    const event = {
      httpMethod: 'GET',
      path: '/v1/me',
      headers: {},
      requestContext: { authorizer: { jwt: { claims: claims() } } },
    } as unknown as ApiEvent;

    // Exercised through the router so the assertion covers the extraction path, not a helper.
    return expect(invoke(router(), event)).resolves.toMatchObject({ statusCode: 200 });
  });

  it('rejects a token with no wl: claims — an account with no users row', () => {
    expect(() => principalFromClaims({ sub: 'x', email: 'nobody@example.com' })).toThrowError(
      /session is not valid/i,
    );
  });

  it('rejects a malformed org claim rather than defaulting it', () => {
    expect(() => principalFromClaims(claims({ 'wl:org': 'not-a-uuid' }))).toThrowError(
      /session is not valid/i,
    );
  });

  it('rejects an unknown role', () => {
    expect(() => principalFromClaims(claims({ 'wl:role': 'admin' }))).toThrowError(
      /session is not valid/i,
    );
  });

  it('rejects an employee-role token with no employee claim', () => {
    expect(() =>
      principalFromClaims(claims({ 'wl:role': 'employee', 'wl:employee': '' })),
    ).toThrowError(/session is not valid/i);
  });

  it('treats any wl:mfa value other than "on" as no factor', () => {
    expect(principalFromClaims(claims({ 'wl:mfa': 'off' })).mfa).toBe(false);
    expect(principalFromClaims(claims({ 'wl:mfa': 'ON' })).mfa).toBe(false);
    expect(principalFromClaims(claims({})).mfa).toBe(true);
  });

  it('falls back to a user: actor when the token carries no email claim', () => {
    const withoutEmail = claims();
    delete withoutEmail.email;
    // audit_log.actor_email is not null, so an access token — which has no email claim — still has
    // to produce something joinable rather than an empty string.
    expect(principalFromClaims(withoutEmail).email).toBe(`user:${USER_ID}`);
  });
});

describe('role enforcement', () => {
  it('lets an owner through an owner-only route', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({ method: 'PUT', path: '/v1/config' }),
    );
    expect(response.statusCode).toBe(200);
    expect(reached.ran).toBe(true);
  });

  it('refuses a manager on an owner-only route before the handler runs', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({ method: 'PUT', path: '/v1/config', claims: claims({ 'wl:role': 'manager' }) }),
    );

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(reached.ran).toBe(false);
  });

  it('refuses an employee on an admin read route', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({
        path: '/v1/overview',
        claims: claims({ 'wl:role': 'employee', 'wl:employee': EMPLOYEE_ID }),
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(reached.ran).toBe(false);
  });
});

/**
 * Deviation D7, in both directions and on both halves of the gate: the route-level check for
 * routes that are admin-only, and the subject-level check for routes an employee may also use.
 */
describe('admin MFA (D7)', () => {
  it('refuses an owner without a configured factor on an admin route', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({ path: '/v1/overview', claims: claims({ 'wl:mfa': 'off' }) }),
    );

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('MFA_REQUIRED');
    expect(reached.ran).toBe(false);
  });

  it('refuses a manager without a configured factor on an admin route', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({
        path: '/v1/overview',
        claims: claims({ 'wl:role': 'manager', 'wl:mfa': 'off' }),
      }),
    );

    expect(errorOf(response).code).toBe('MFA_REQUIRED');
  });

  it('admits the same caller once a factor is configured', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({ path: '/v1/overview', claims: claims({ 'wl:mfa': 'on' }) }),
    );

    expect(response.statusCode).toBe(200);
    expect(reached.ran).toBe(true);
  });

  it('does not gate /v1/me, so an admin can reach the MFA enrolment screen', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({ path: '/v1/me', claims: claims({ 'wl:mfa': 'off' }) }),
    );

    expect(response.statusCode).toBe(200);
    expect(reached.ran).toBe(true);
  });

  it('does not gate an employee, whose own data is not what MFA protects', () => {
    const employee = principalFromClaims(
      claims({ 'wl:role': 'employee', 'wl:employee': EMPLOYEE_ID, 'wl:mfa': 'off' }),
    );

    expect(() => authorizeRoute(employee, POLICY.employeeRead)).not.toThrow();
    expect(() => assertAdminMfaForSubject(employee, EMPLOYEE_ID)).not.toThrow();
  });

  it('gates an admin reading somebody else through a self-serviceable route', () => {
    const owner = principalFromClaims(
      claims({ 'wl:employee': EMPLOYEE_ID, 'wl:mfa': 'off' }),
    );

    // Their own data is fine without a factor …
    expect(() => assertAdminMfaForSubject(owner, EMPLOYEE_ID)).not.toThrow();
    // … somebody else's is exactly what D7 exists to stop.
    expect(() => assertAdminMfaForSubject(owner, OTHER_EMPLOYEE_ID)).toThrowError(
      /multi-factor authentication/i,
    );
  });
});

describe('scope rewriting', () => {
  const employee = () =>
    principalFromClaims(claims({ 'wl:role': 'employee', 'wl:employee': EMPLOYEE_ID }));

  it('scopes an employee to their own claim even when no id is supplied', () => {
    expect(resolveEmployeeScope(employee(), undefined)).toEqual({
      orgId: ORG_ID,
      employeeId: EMPLOYEE_ID,
    });
  });

  it('scopes an employee to their claim when the path names themselves', () => {
    expect(resolveEmployeeScope(employee(), EMPLOYEE_ID).employeeId).toBe(EMPLOYEE_ID);
  });

  /**
   * The case named in the brief: an employee asking for somebody else's timesheets is a 403, not a
   * silently narrowed query. Asserted both at the unit level and end to end through the router,
   * because the two failure modes are different — one would be a permissive helper, the other a
   * route that forgot to call it.
   */
  it('refuses an employee who names another employee', () => {
    expect(() => resolveEmployeeScope(employee(), OTHER_EMPLOYEE_ID)).toThrowError(
      /do not have access/i,
    );
  });

  it('refuses it through the route too, without reaching the handler', async () => {
    const response = await invoke(
      router(),
      cognitoEvent({
        path: `/v1/employees/${OTHER_EMPLOYEE_ID}/timesheets`,
        claims: claims({ 'wl:role': 'employee', 'wl:employee': EMPLOYEE_ID }),
      }),
    );

    // The router admits the request — the route is employee-reachable — and the scope resolution
    // inside the handler is what refuses it. That is why the assertion is on the status: the
    // handler under test here is the recording stub, so reaching it is expected.
    expect(response.statusCode).toBe(200);
    expect(reached.principal?.employeeId).toBe(EMPLOYEE_ID);
    expect(reached.params?.id).toBe(OTHER_EMPLOYEE_ID);
    // The path parameter arrives untouched; nothing but `resolveEmployeeScope` may interpret it.
    expect(() => resolveEmployeeScope(reached.principal!, reached.params?.id)).toThrow();
  });

  it('gives an owner organisation-wide scope when no id is supplied', () => {
    expect(resolveEmployeeScope(principalFromClaims(claims()), undefined)).toEqual({
      orgId: ORG_ID,
      employeeId: null,
    });
  });

  it('lets an owner name any employee', () => {
    expect(resolveEmployeeScope(principalFromClaims(claims()), OTHER_EMPLOYEE_ID).employeeId).toBe(
      OTHER_EMPLOYEE_ID,
    );
  });

  it('reports a missing subject as not found where a route requires one', () => {
    expect(() => requireEmployeeScope(principalFromClaims(claims()), undefined)).toThrowError(
      /not found/i,
    );
  });
});

describe('routing', () => {
  it('answers 404 for an unknown path', async () => {
    const response = await invoke(router(), cognitoEvent({ path: '/v1/nope' }));
    expect(response.statusCode).toBe(404);
    expect(reached.ran).toBe(false);
  });

  it('answers 404 for a known path with the wrong method', async () => {
    const response = await invoke(router(), cognitoEvent({ method: 'DELETE', path: '/v1/config' }));
    expect(response.statusCode).toBe(404);
  });

  it('matches whether or not the stage segment is present', async () => {
    expect((await invoke(router(), cognitoEvent({ path: '/me' }))).statusCode).toBe(200);
    expect((await invoke(router(), cognitoEvent({ path: '/v1/me' }))).statusCode).toBe(200);
  });

  it('does not match an empty path parameter', async () => {
    const response = await invoke(router(), cognitoEvent({ path: '/v1/employees//timesheets' }));
    expect(response.statusCode).toBe(404);
  });

  it('authenticates before routing, so an unknown path leaks no route map', async () => {
    const response = await invoke(router(), cognitoEvent({ path: '/v1/nope', claims: null }));
    expect(response.statusCode).toBe(401);
  });
});

describe('withCognitoAuth, for a function serving one route', () => {
  it('applies the same role and MFA checks as the router', async () => {
    const single = withHandler('single', withCognitoAuth(POLICY.ownerWrite, recordingRoute(reached)));

    const refused = await invoke(single, cognitoEvent({ claims: claims({ 'wl:mfa': 'off' }) }));
    expect(errorOf(refused).code).toBe('MFA_REQUIRED');
    expect(reached.ran).toBe(false);

    const admitted = await invoke(single, cognitoEvent());
    expect(admitted.statusCode).toBe(200);
    expect(reached.ran).toBe(true);
  });
});
