/**
 * Session handling for the dashboard.
 *
 * # The tokens never reach client JavaScript
 *
 * Cognito's authorisation-code flow is completed on the server, and the resulting tokens are held in
 * `httpOnly` cookies. Client components never see them; every call to the WorkLens API goes through a
 * Server Component or a Server Action that reads the cookie and attaches the header.
 *
 * The alternative — the shape most Cognito examples show — keeps tokens in `localStorage` and calls
 * the API from the browser. It is simpler and it means any script that manages to run on the page can
 * read a token good for an hour of access to every employee's timesheet and screenshots. For a
 * product whose whole argument is that the data is handled carefully, that is not a trade worth
 * making.
 *
 * # What the session is, and is not
 *
 * `getSession` decodes the ID token to read the claims the pre-token-generation trigger put there
 * (`wl:org`, `wl:role`, `wl:employee`, `wl:mfa`). It does **not** verify the signature, and it must
 * never be treated as an authorisation decision:
 *
 *   - The signature is verified by API Gateway's Cognito authorizer on every request, and
 *     authorisation is decided by `backend/src/middleware/cognitoAuth.ts`.
 *   - Everything here is presentation: which navigation to render, which page to land on, whether to
 *     show the MFA notice. A tampered cookie can change what the UI *offers*; it cannot change what
 *     the API *returns*.
 *
 * Keeping that boundary explicit is the point. A dashboard that made its own authorisation decisions
 * would eventually disagree with the server, and the disagreement would be discovered by a user
 * seeing data they should not.
 */

import { cookies } from 'next/headers';

/** Cookie names. Prefixed so they cannot collide with anything else on a shared hostname. */
export const COOKIE = {
  idToken: 'wl_id',
  accessToken: 'wl_at',
  refreshToken: 'wl_rt',
  state: 'wl_state',
  verifier: 'wl_pkce',
} as const;

export type DashboardRole = 'owner' | 'manager' | 'employee';

export interface Session {
  orgId: string;
  userId: string;
  role: DashboardRole;
  /** `employees.id` for an account with a self-view; null for an admin-only account. */
  employeeId: string | null;
  /** True when a second factor is configured. Drives the MFA notice, never an access decision. */
  mfa: boolean;
  /** The organisation's IANA timezone, for rendering "today" the way the org sees it. */
  timezone: string;
  email: string;
  /** Seconds since the epoch at which the ID token expires. */
  expiresAt: number;
}

/**
 * Decodes a JWT payload without verifying it.
 *
 * Named to make the omission impossible to miss at a call site. Verification belongs to API Gateway;
 * doing it here as well would mean shipping a JWKS fetch and a signature check into a Next.js server
 * for a decision that is made again, authoritatively, one hop later.
 */
function decodeUnverifiedPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const payload = parts[1];
  if (payload === undefined) return null;

  try {
    // base64url → base64, then pad. Buffer tolerates missing padding but being explicit avoids
    // depending on that.
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function claimString(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isRole(value: string | null): value is DashboardRole {
  return value === 'owner' || value === 'manager' || value === 'employee';
}

/**
 * Reads the current session, or null when there is not a usable one.
 *
 * Returns null rather than throwing for every failure — absent cookie, malformed token, missing
 * claims, expired — because they all lead to the same place, which is the login page. Distinguishing
 * them would only give a caller more ways to get the redirect wrong.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const idToken = store.get(COOKIE.idToken)?.value;
  if (idToken === undefined || idToken === '') return null;

  const claims = decodeUnverifiedPayload(idToken);
  if (claims === null) return null;

  const expiresAt = typeof claims['exp'] === 'number' ? claims['exp'] : 0;
  // A minute of slack, so a token about to lapse mid-render is treated as gone rather than producing
  // a page that half-loads and then 401s.
  if (expiresAt <= Math.floor(Date.now() / 1000) + 60) return null;

  const orgId = claimString(claims, 'wl:org');
  const userId = claimString(claims, 'wl:user');
  const role = claimString(claims, 'wl:role');

  // A token with no `wl:` claims is what an invited-but-unprovisioned account looks like: Cognito
  // authenticated them, the pre-token trigger found no `users` row, and the API will refuse every
  // request. Treated as no session, so they land on login with a message rather than on a dashboard
  // where everything fails.
  if (orgId === null || userId === null || !isRole(role)) return null;

  const employeeId = claimString(claims, 'wl:employee');

  return {
    orgId,
    userId,
    role,
    // The trigger emits an empty string rather than omitting the claim, so an absent employee is
    // normalised to null here.
    employeeId,
    mfa: claimString(claims, 'wl:mfa') === 'on',
    timezone: claimString(claims, 'wl:tz') ?? 'UTC',
    email: claimString(claims, 'email') ?? `user:${userId}`,
    expiresAt,
  };
}

/** The access token, for attaching to an API call. Server-side only. */
export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE.accessToken)?.value ?? null;
}

/**
 * Whether this session is subject to the admin MFA gate.
 *
 * Mirrors `POLICY.adminScoped` on the server: an `owner` or `manager` without a second factor is
 * refused on every admin route. Used to render the notice and to keep the navigation honest — the
 * refusal itself happens server-side regardless.
 */
export function needsMfaEnrolment(session: Session): boolean {
  return (session.role === 'owner' || session.role === 'manager') && !session.mfa;
}

/** Whether this session may see other people's data at all. */
export function isAdmin(session: Session): boolean {
  return session.role === 'owner' || session.role === 'manager';
}
