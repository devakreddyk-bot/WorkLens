/**
 * Dashboard authentication, RBAC, and the route table that binds the two together.
 *
 * ## Why the claims are trusted, and what "verify" means here
 *
 * Every dashboard route sits behind a `COGNITO_USER_POOLS` authorizer
 * (`infra/modules/api/main.tf`), so API Gateway has already verified the token's signature,
 * issuer, expiry and audience before this Lambda is invoked, and hands the decoded claims
 * over in `event.requestContext.authorizer.claims`. Re-verifying the signature in-handler is
 * not defence in depth, it is impossible: verification needs the pool's JWKS, the function
 * runs in a private subnet, and there is no NAT gateway (docs/PLAN.md D6) — so the fetch would
 * hang for the whole invocation and then fail. Adding a Cognito interface endpoint to buy a
 * second check of something the gateway cannot skip would be paying for nothing.
 *
 * What this module does instead is *refuse to guess*. If the authorizer context is missing,
 * the request did not come through the authorizer and is rejected rather than treated as
 * anonymous. If a `wl:` claim is absent or malformed — which is what a token issued before the
 * pre-token trigger ran looks like, or one for a Cognito account with no `users` row — the
 * request is rejected rather than defaulted. And when `COGNITO_USER_POOL_ID` /
 * `COGNITO_CLIENT_ID` are configured for this function, the issuer and audience are checked
 * again here, so a token minted by a *different* pool could not be accepted even if the
 * gateway were ever misconfigured to point at one.
 *
 * ## The claims
 *
 * `src/handlers/auth/preTokenGeneration.ts` injects them at sign-in:
 *
 *     wl:org       organisation uuid          — the tenant. Never taken from user input.
 *     wl:user      users.id                   — the actor recorded in audit_log.
 *     wl:role      owner | manager | employee
 *     wl:employee  employees.id or ""         — the ONLY employee an `employee` role may read.
 *     wl:tz        organisation timezone      — day boundaries for "today".
 *     wl:mfa       on | off                   — whether a second factor is configured (D7).
 *
 * ## RBAC is a query rewrite, not a permission check on a path parameter
 *
 * `resolveEmployeeScope` is the single place that decides *whose* rows a request may touch,
 * and it returns that answer as data (`{ orgId, employeeId }`) which every repository function
 * then takes as its arguments. An `employee` caller's scope is always the `wl:employee` claim,
 * whatever the path says — and a path that says something else is refused outright, because a
 * request for another person's timesheet is not a request to be quietly narrowed, it is one to
 * be reported as forbidden.
 *
 * ## Admin MFA (D7)
 *
 * Cognito's MFA setting is pool-wide, so "MFA for admins" cannot be pool configuration without
 * forcing TOTP on every employee who only wants to see their own timesheet. The pool is
 * `OPTIONAL`, the pre-token trigger reports whether a factor is actually configured, and
 * `authorizeRoute` rejects an `owner` or `manager` on an admin-scoped route when it is not.
 * The gate is on the role, not on the person: an admin without a factor can still reach
 * `/v1/me`, which is what the dashboard's forced-enrolment screen needs.
 */

import { UUID_PATTERN } from '../schemas/common.js';
import { config } from '../shared/config.js';
import { AppError, ErrorCode, errors } from '../shared/errors.js';
import type { ApiEvent, Handler, JsonResponse, RequestContext } from '../shared/http.js';

export type DashboardRole = 'owner' | 'manager' | 'employee';

const ROLES = new Set<string>(['owner', 'manager', 'employee']);

/** Roles for whom D7 requires a configured second factor on admin-scoped routes. */
const ADMIN_ROLES = new Set<DashboardRole>(['owner', 'manager']);

/** The authenticated dashboard caller. Everything downstream comes from here. */
export interface Principal {
  orgId: string;
  userId: string;
  role: DashboardRole;
  /** `employees.id` for an account with a self-view; null for an admin-only account. */
  employeeId: string | null;
  /** Organisation IANA timezone, used to resolve "today" the way the org sees it. */
  timezone: string;
  /** True when a second factor is configured on the Cognito account. */
  mfa: boolean;
  /**
   * Recorded in `audit_log.actor_email`, which is `not null`. An access token carries no
   * `email` claim, so a `user:<id>` form stands in — unambiguous, and joinable back to
   * `users`, in the same spirit as `deviceActorEmail`.
   */
  email: string;
}

/**
 * The rows a request may read or write.
 *
 * `employeeId: null` means "every employee in the organisation" and is only ever produced for
 * an `owner` or `manager`. `orgId` always comes from the verified token.
 */
export interface EmployeeScope {
  readonly orgId: string;
  readonly employeeId: string | null;
}

export interface RoutePolicy {
  /** Roles allowed to reach the route at all. */
  readonly roles: readonly DashboardRole[];
  /**
   * True for a route that exposes organisation-wide data, another person's data, or changes
   * configuration — i.e. everything an admin uses admin powers for. These are the routes D7
   * gates on MFA. `/v1/me` is the notable false: it exposes only the caller's own data, and an
   * admin locked out of it could not reach the enrolment screen that fixes their MFA state.
   */
  readonly adminScoped: boolean;
}

export const POLICY = {
  /** Any signed-in user, own data only. */
  self: { roles: ['owner', 'manager', 'employee'], adminScoped: false } as RoutePolicy,
  /** Reads across the organisation. */
  adminRead: { roles: ['owner', 'manager'], adminScoped: true } as RoutePolicy,
  /**
   * A per-employee read. Reachable by an employee for themselves; `resolveEmployeeScope`
   * refuses any other subject. `adminScoped` is false so an employee's self-view is never
   * MFA-gated — the MFA check inside `authorizeRoute` only ever applies to admin roles, and
   * for those `assertAdminMfaForSubject` re-applies it as soon as the subject is not self.
   */
  employeeRead: { roles: ['owner', 'manager', 'employee'], adminScoped: false } as RoutePolicy,
  /** Owner-only: settings, users, devices, erasure. */
  ownerWrite: { roles: ['owner'], adminScoped: true } as RoutePolicy,
} as const;

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

/**
 * Pulls the authorizer's claims out of whichever event shape this API produces.
 *
 * REST APIs put them at `requestContext.authorizer.claims`; the HTTP API / JWT authorizer
 * shape is `requestContext.authorizer.jwt.claims`. Both are handled for the same reason
 * `src/shared/http.ts` accepts both event types: the tests build the smaller shape, and a
 * future move off REST (D2 documents when that becomes possible) must not silently produce a
 * handler that sees no claims and reports everyone as unauthenticated.
 *
 * Returns `undefined` when there is no authorizer context at all, which is a different
 * failure from a token with bad claims and is reported differently.
 */
function claimsOf(event: ApiEvent): Record<string, string> | undefined {
  const requestContext = event.requestContext as unknown as
    | { authorizer?: { claims?: unknown; jwt?: { claims?: unknown } } }
    | undefined;
  const authorizer = requestContext?.authorizer;
  if (authorizer === undefined || authorizer === null) return undefined;

  const raw = (authorizer.jwt?.claims ?? authorizer.claims) as
    | Record<string, unknown>
    | undefined;
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;

  // API Gateway may deliver a claim as a string, a number or a boolean depending on how it
  // appeared in the token. Normalising to strings here means the checks below have one shape
  // to reason about; anything else (an array, an object) is dropped rather than coerced.
  const claims: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') claims[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') claims[key] = String(value);
  }
  return claims;
}

function claim(claims: Record<string, string>, name: string): string | undefined {
  const value = claims[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * A token whose claims cannot be interpreted.
 *
 * One code and one message for every variant, deliberately: the difference between "no
 * `wl:org`" and "`wl:role` is not a known role" tells a caller something about how the system
 * is wired, and the actionable version of that information is in the log, keyed by the same
 * request id the caller was given.
 */
function invalidToken(reason: string, logContext: Record<string, unknown> = {}): AppError {
  return new AppError(
    ErrorCode.INVALID_TOKEN,
    'Your session is not valid for this API. Sign out and sign in again.',
    { logContext: { ...logContext, reason } },
  );
}

/**
 * Issuer and audience are re-checked when this function knows which pool and client to expect.
 *
 * The gateway checks both, so this is belt and braces — but it is cheap belt and braces
 * against the one misconfiguration that would matter, an authorizer pointed at the wrong pool,
 * and it costs nothing when the variables are not set (they are not, for these functions
 * today: `infra/modules/lambda` passes them only to the pre-token trigger).
 */
function assertTokenOrigin(claims: Record<string, string>): void {
  const poolId = config.COGNITO_USER_POOL_ID;
  if (poolId !== undefined && poolId !== '') {
    const issuer = claim(claims, 'iss');
    if (issuer !== undefined && !issuer.endsWith(`/${poolId}`)) {
      throw invalidToken('issuer_mismatch');
    }
  }

  const clientId = config.COGNITO_CLIENT_ID;
  if (clientId !== undefined && clientId !== '') {
    // `aud` on an ID token, `client_id` on an access token. Absent on neither, but an absent
    // value is not evidence of a wrong client, so it is not treated as one.
    const audience = claim(claims, 'aud') ?? claim(claims, 'client_id');
    if (audience !== undefined && audience !== clientId) {
      throw invalidToken('audience_mismatch');
    }
  }
}

/**
 * Builds the principal from the verified claims.
 *
 * Exported for the middleware test, which is the only caller outside this module.
 */
export function principalFromClaims(claims: Record<string, string>): Principal {
  assertTokenOrigin(claims);

  const orgId = claim(claims, 'wl:org');
  const userId = claim(claims, 'wl:user');
  const role = claim(claims, 'wl:role');

  // A token with no wl: claims is exactly what the pre-token trigger issues for a Cognito
  // account that has no `users` row — an invited-but-unprovisioned user. Rejecting it here is
  // the other half of that design: the token exists so the dashboard can show something
  // meaningful, and it authorises nothing.
  if (orgId === undefined || !UUID_PATTERN.test(orgId)) throw invalidToken('org_claim_missing');
  if (userId === undefined || !UUID_PATTERN.test(userId)) throw invalidToken('user_claim_missing');
  if (role === undefined || !ROLES.has(role)) throw invalidToken('role_claim_missing');

  const employeeRaw = claim(claims, 'wl:employee');
  if (employeeRaw !== undefined && !UUID_PATTERN.test(employeeRaw)) {
    throw invalidToken('employee_claim_malformed');
  }

  // `users_employee_role_chk` makes `employee_id` mandatory for the employee role in the
  // database, so an employee token without it means the claim was lost in transit rather than
  // that the account is odd. Failing closed is the only safe reading: the alternative is a
  // caller with no scope at all, and "no scope" must never widen into "every scope".
  if (role === 'employee' && employeeRaw === undefined) {
    throw invalidToken('employee_claim_missing_for_employee_role');
  }

  const timezone = claim(claims, 'wl:tz') ?? 'UTC';

  return {
    orgId,
    userId,
    role: role as DashboardRole,
    employeeId: employeeRaw ?? null,
    timezone,
    // Anything other than the exact string is treated as "no factor". A typo, a stale claim
    // shape, or a future value must fail closed on a control that gates admin data.
    mfa: claim(claims, 'wl:mfa') === 'on',
    email: claim(claims, 'email') ?? `user:${userId}`,
  };
}

/** Authenticates a dashboard request, or throws. */
export function authenticateDashboard(event: ApiEvent): Principal {
  const claims = claimsOf(event);
  if (claims === undefined) {
    // No authorizer context means the request did not pass the Cognito authorizer — a direct
    // invocation, or a route wired with `authorization = NONE` by mistake. Neither is a caller
    // to be treated as anonymous-but-harmless.
    throw new AppError(
      ErrorCode.MISSING_CREDENTIALS,
      'This endpoint requires a signed-in dashboard session.',
      { logContext: { reason: 'no_authorizer_context' } },
    );
  }
  return principalFromClaims(claims);
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/** Applies the route's role list and, for admin roles on admin routes, D7. */
export function authorizeRoute(principal: Principal, policy: RoutePolicy): void {
  if (!policy.roles.includes(principal.role)) {
    throw errors.forbidden({
      reason: 'role_not_permitted',
      role: principal.role,
      userId: principal.userId,
    });
  }

  if (policy.adminScoped && ADMIN_ROLES.has(principal.role) && !principal.mfa) {
    throw errors.mfaRequired();
  }
}

/**
 * The D7 gate for a route whose scope is only known once the subject has been resolved.
 *
 * `/v1/employees/{id}/timesheets` is reachable by an employee for themselves, so its policy
 * cannot be `adminScoped` — but an owner reading *somebody else's* timesheet on that same route
 * is unambiguously an administrative act, and must be behind MFA like every other one. Calling
 * this after `resolveEmployeeScope` closes what would otherwise be a hole big enough to drive
 * the whole of D7 through: an admin without a factor reading the entire team's data through the
 * per-employee routes.
 */
export function assertAdminMfaForSubject(principal: Principal, subjectEmployeeId: string | null): void {
  if (!ADMIN_ROLES.has(principal.role)) return;
  if (principal.mfa) return;
  if (subjectEmployeeId !== null && subjectEmployeeId === principal.employeeId) return;
  throw errors.mfaRequired();
}

/**
 * Rewrites the requested subject into the scope this caller is actually allowed.
 *
 * For an `employee` the answer is always the `wl:employee` claim. A path parameter naming
 * anyone else is refused with 403 rather than silently narrowed, because the two are different
 * events: one is a dashboard bug, the other is somebody trying their luck, and only the second
 * is worth an audit trail's attention.
 */
export function resolveEmployeeScope(
  principal: Principal,
  requestedEmployeeId?: string,
): EmployeeScope {
  if (principal.role === 'employee') {
    if (principal.employeeId === null) {
      // Unreachable via `principalFromClaims`, which rejects this shape. Kept because the
      // consequence of it ever becoming reachable is an unscoped query.
      throw errors.forbidden({ reason: 'employee_without_employee_claim', userId: principal.userId });
    }

    if (requestedEmployeeId !== undefined && requestedEmployeeId !== principal.employeeId) {
      throw errors.forbidden({
        reason: 'employee_scope_mismatch',
        userId: principal.userId,
        requestedEmployeeId,
      });
    }

    return { orgId: principal.orgId, employeeId: principal.employeeId };
  }

  return { orgId: principal.orgId, employeeId: requestedEmployeeId ?? null };
}

/**
 * The scope for a route that requires a specific employee, e.g. a screenshot gallery.
 *
 * Distinguished from `resolveEmployeeScope` because "all employees" is a meaningful answer for
 * `/v1/timesheets` and a meaningless one for `/v1/employees/{id}/screenshots`.
 */
export function requireEmployeeScope(
  principal: Principal,
  requestedEmployeeId: string | undefined,
): string {
  const scope = resolveEmployeeScope(principal, requestedEmployeeId);
  if (scope.employeeId === null) {
    throw errors.notFound('Employee');
  }
  return scope.employeeId;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type RouteParams = Readonly<Record<string, string>>;

export type DashboardHandler = (
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
) => Promise<JsonResponse>;

export interface RouteDefinition {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Template after the stage, with `{name}` placeholders, e.g. `/employees/{id}/timesheets`. */
  readonly path: string;
  readonly policy: RoutePolicy;
  readonly handler: DashboardHandler;
}

/**
 * The stage name, which is also the first path segment of the public URL.
 *
 * `event.path` on a REST API can arrive with or without it depending on how the integration is
 * wired and on how a test constructs the event, and the agent-facing halves of this codebase
 * sign the form *with* it. Stripping one leading `v1` rather than "the first segment" is
 * deliberate: a route genuinely called `/v1/...` twice over is a bug worth seeing as a 404, not
 * one worth papering over.
 */
const STAGE_SEGMENT = 'v1';

function segmentsOf(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts[0] === STAGE_SEGMENT) parts.shift();
  return parts;
}

/** Matches one route template against a request's path segments. */
function matchTemplate(template: string, segments: readonly string[]): RouteParams | undefined {
  const expected = template.split('/').filter((part) => part !== '');
  if (expected.length !== segments.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const spec = expected[index] ?? '';
    const actual = segments[index] ?? '';
    if (spec.startsWith('{') && spec.endsWith('}')) {
      // An empty path parameter (`/employees//timesheets`) is not a match: it would otherwise
      // become an empty string that a repository would happily use as a uuid.
      if (actual === '') return undefined;
      params[spec.slice(1, -1)] = decodeURIComponent(actual);
    } else if (spec !== actual) {
      return undefined;
    }
  }
  return params;
}

/**
 * Wraps a single dashboard route, for a function that serves exactly one.
 *
 * Used by handlers outside this directory — `POST /v1/aggregation/run` is routed straight at
 * the aggregation function rather than proxied through `admin-api`, because an in-VPC Lambda
 * cannot reach the Lambda control plane without a NAT gateway (D6) — so that route gets the
 * same authentication, the same role check and the same D7 gate as every other one.
 */
export function withCognitoAuth(policy: RoutePolicy, handler: DashboardHandler): Handler {
  return async (ctx: RequestContext, event: ApiEvent): Promise<JsonResponse> => {
    const principal = authenticateDashboard(event);
    authorizeRoute(principal, policy);
    return handler(boundContext(ctx, principal), principal, ctx.pathParameters as RouteParams);
  };
}

function boundContext(ctx: RequestContext, principal: Principal): RequestContext {
  return {
    ...ctx,
    log: ctx.log.child({
      orgId: principal.orgId,
      userId: principal.userId,
      role: principal.role,
    }),
  };
}

/**
 * Builds the method-and-path router for a multi-route dashboard function.
 *
 * The route table is where a route's authorization *lives*, not where it is looked up: a
 * `RouteDefinition` cannot be written without a policy, so adding a route without deciding who
 * may call it is a type error rather than an omission nobody notices until it is in production.
 *
 * Authentication runs once, before matching, so an unknown path from an unauthenticated caller
 * is a 401 rather than a map of which routes exist.
 */
export function createDashboardRouter(routes: readonly RouteDefinition[]): Handler {
  return async (ctx: RequestContext, event: ApiEvent): Promise<JsonResponse> => {
    const principal = authenticateDashboard(event);
    const segments = segmentsOf(ctx.path);

    let pathMatched = false;

    for (const route of routes) {
      const params = matchTemplate(route.path, segments);
      if (params === undefined) continue;
      pathMatched = true;
      if (route.method !== ctx.method) continue;

      authorizeRoute(principal, route.policy);

      const bound = boundContext(ctx, principal);
      bound.log.debug('route matched', { route: `${route.method} ${route.path}` });
      return route.handler(bound, principal, params);
    }

    // A known path with the wrong method would properly be a 405, but the error vocabulary in
    // `src/shared/errors.ts` has no code for it and inventing one at a call site would defeat
    // the point of a single enum. Both answer 404; the log distinguishes them.
    ctx.log.warn('no route matched', {
      reason: pathMatched ? 'method_not_allowed' : 'unknown_path',
    });
    throw errors.notFound('The requested endpoint');
  };
}
